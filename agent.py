import os
import sys
import datetime
import json
import glob
import time
import threading
import uuid
import shutil
import hashlib
import webview

# On Windows the default console/file encoding is cp1252, which can't handle
# Unicode characters the LLM emits (arrows, checkmarks, em-dashes, etc.).
# Force UTF-8 on stdout/stderr so print() and console output never crash.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")


from llm import ask_llm, get_full_system_prompt
from docker_sandbox import setup_sandbox
from tool_registry import registry
import planning
import tools  # Triggers the __init__.py which loads all tool categories

WORKSPACE_DIR = "./workspace"
MEMORY_DIR = "./memory"
MAX_STEPS_BEFORE_SUMMARY = 500
# The target model has a 1M-token context window (~4M chars at 4 chars/token).
# Only reset once we've consumed most of it, leaving headroom for the system
# prompt and the next assistant response. The old 80k-char limit only used ~2%
# of the window and cut off long jobs prematurely.
CONTEXT_CHAR_LIMIT = 3_200_000

# --- Tool budget / loop protection -------------------------------------------
SOFT_TOOL_NUDGE = 200
MAX_CONSECUTIVE_TOOLS = 400
MAX_SUMMARY_RESETS = 8
LOOP_REPEAT_THRESHOLD = 3

# --- Plan-and-execute workflow -----------------------------------------------
# Tools allowed to run BEFORE a plan exists for the current task (creating or
# just inspecting a plan doesn't need one to already exist).
PLAN_TOOL_NAMES = {"plan_create", "plan_view"}
# If this many tool calls happen in a row without touching the plan (add/update/
# reorder), nudge the model to keep it synchronized rather than silently
# working ahead of it.
PLAN_TOUCH_NUDGE = 8

# Dirs to skip when building the workspace file tree for the frontend.
_TREE_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "__pycache__", "dist", "build"}
_TREE_MAX_DEPTH = 6

# --- Workspace import/export -------------------------------------------------
# Metadata file recording where an imported project's files originally came
# from, plus a content-hash baseline captured at import time so a later
# export can compute an exact diff instead of blindly mirroring everything.
IMPORT_META_FILENAME = ".omniagent_import.json"
# Directories/files excluded from the import baseline and export diff — these
# are the agent's own bookkeeping (analysis caches, emulator logs, test
# artifacts), not project source the user would want mirrored externally.
_EXPORT_EXCLUDE_DIRS = {".git", ".codegraph", ".emulator", "screenshots", "test_reports", "__pycache__"}
_EXPORT_EXCLUDE_FILES = {IMPORT_META_FILENAME}


def estimate_context_chars(messages):
    """Rough estimate of total message content size in characters."""
    return sum(len(m.get("content", "")) for m in messages)


def summarize_memory(messages, memory_dir, original_task=None):
    """Condenses memory to save tokens while preserving the original task.

    The active plan (planning.get_active_plan()) is NOT rebuilt here — it
    lives outside the message history entirely (a module-level singleton
    persisted to plan_current.json) and survives a context reset untouched.
    It's still recorded in the saved summary file so a plan's history shows
    up in project logs/reports, and the caller is expected to re-append the
    live plan section to the fresh system prompt via AgentApi._refresh_system_prompt.
    """
    summary_prompt = messages + [{
        "role": "user",
        "content": (
            "Summarize our work so far so we can continue after a context reset. "
            "Include ALL of the following sections:\n"
            "1. ORIGINAL TASK: What the user asked (quote if possible).\n"
            "2. COMPLETED STEPS: What we have done, in order.\n"
            "3. FILES MODIFIED/CREATED: Every file path we changed, created, or deleted.\n"
            "4. KEY FINDINGS: Important discoveries, values, addresses, offsets, decisions.\n"
            "5. CURRENT STATE: What is done and what is pending.\n"
            "6. IMMEDIATE NEXT STEPS: The exact next 1-3 actions to take.\n"
            "Be concise but RETAIN all technical artifacts: file paths, function names, "
            "hex offsets, symbol names, APK filenames, and error messages. "
            'Respond with {"type": "final_answer", "content": "<summary text>"} only.'
        )
    }]

    raw_summary = ask_llm(summary_prompt)
    response_type, summary_text = parse_response(raw_summary)

    if response_type != "final_answer":
        summary_text = raw_summary

    plan = planning.get_active_plan()
    plan_markdown = plan.to_markdown() if plan else None

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    summary_path = os.path.join(memory_dir, f"summary_{timestamp}.txt")
    try:
        with open(summary_path, "w", encoding="utf-8") as f:
            if original_task:
                f.write(f"=== ORIGINAL TASK ===\n{original_task}\n\n")
            if plan_markdown:
                f.write(f"=== PLAN SNAPSHOT ===\n{plan_markdown}\n\n")
            f.write(f"=== PROGRESS SUMMARY ===\n{summary_text}\n")
    except OSError as e:
        print(f"[WARNING] Could not save memory summary to {summary_path}: {e}")

    new_messages = [
        {"role": "system", "content": get_full_system_prompt()},
        {"role": "assistant", "content": f"[MEMORY SUMMARY]: {summary_text}"},
    ]
    if original_task:
        new_messages.append({"role": "user", "content": original_task})
    return new_messages


def parse_response(response_text):
    """Parses the LLM JSON response and returns a (type, payload) tuple."""
    text = response_text.strip()

    start_idx = text.find("{")
    end_idx = text.rfind("}")

    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        text = text[start_idx:end_idx + 1]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return ("error", f"LLM returned non-JSON content: {response_text[:300]}")

    response_type = data.get("type")

    if response_type != "tool_call" and response_type != "final_answer":
        if "args" in data or "tool" in data:
            data["tool"] = data.get("tool", response_type)
            response_type = "tool_call"

    if response_type == "tool_call":
        return ("tool_call", data)
    elif response_type == "final_answer":
        return ("final_answer", data.get("content", ""))
    else:
        return ("error", f"Unknown response type '{response_type}': {response_text[:300]}")


def execute_tool(tool_data, last_tool_call=None, repeat_threshold=LOOP_REPEAT_THRESHOLD):
    """Executes a tool from a parsed tool_call dict and returns a feedback string."""
    tool_name = tool_data.get("tool")
    tool_args = tool_data.get("args", {})

    if last_tool_call:
        same_as_last = (
            last_tool_call.get("tool") == tool_name
            and last_tool_call.get("args", {}) == tool_args
        )
        if same_as_last:
            repeats = last_tool_call.get("repeats", 1) + 1
            if repeats >= repeat_threshold:
                return (
                    "[SYSTEM WARNING] You have called '{tool}' with the same "
                    "arguments {n} times in a row. This looks like a loop. "
                    "Try different arguments, a different tool, or provide a "
                    "final_answer."
                ).format(tool=tool_name, n=repeats)

    result = registry.execute(tool_name, tool_args)

    output = result.get("stdout", "")
    err = result.get("stderr", "")
    err_dict = result.get("error", "")

    feedback = f"Tool '{tool_name}' executed.\n"
    if output:
        trimmed = output[:8000]
        feedback += f"Output:\n{trimmed}\n"
        if len(output) > 8000:
            feedback += f"[WARNING: Output truncated at 8000 chars. Total output was {len(output)} chars. If this is a symbol/string listing, call the tool again with a higher 'skip' or 'page' offset to see more results.]\n"
    if err:
        feedback += f"Stderr:\n{err[:2000]}\n"
    if err_dict:
        feedback += f"System Error:\n{err_dict}\n"

    return feedback


def build_file_tree(project_name):
    """Builds a nested file-tree dict of a project workspace (host side)."""
    root = os.path.join(WORKSPACE_DIR, project_name)

    def walk(path, rel, depth):
        name = os.path.basename(path) or project_name
        node = {"name": name, "path": rel, "type": "dir", "children": []}
        try:
            entries = os.listdir(path)
        except OSError:
            return node
        # Sort: directories first (alphabetical), then files (alphabetical).
        dirs = sorted(e for e in entries if os.path.isdir(os.path.join(path, e)))
        files = sorted(e for e in entries if not os.path.isdir(os.path.join(path, e)))
        for entry in dirs:
            full = os.path.join(path, entry)
            child_rel = f"{rel}/{entry}" if rel else entry
            if entry in _TREE_SKIP_DIRS:
                continue
            if depth >= _TREE_MAX_DEPTH:
                node["children"].append({"name": entry, "path": child_rel, "type": "dir", "children": []})
                continue
            node["children"].append(walk(full, child_rel, depth + 1))
        for entry in files:
            full = os.path.join(path, entry)
            child_rel = f"{rel}/{entry}" if rel else entry
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            node["children"].append({"name": entry, "path": child_rel, "type": "file", "size": size})
        return node

    if not os.path.isdir(root):
        return {"name": project_name, "path": "", "type": "dir", "children": []}
    return walk(root, "", 0)


def read_project_file(project_name, rel_path):
    """Reads a file from the project workspace (host side) for the frontend viewer."""
    if not rel_path:
        return {"ok": False, "error": "No path provided."}
    # Normalize and prevent escaping the project root.
    rel = rel_path.lstrip("/").lstrip("\\")
    root = os.path.abspath(os.path.join(WORKSPACE_DIR, project_name))
    full = os.path.abspath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) and full != root:
        return {"ok": False, "error": "Path outside workspace."}
    if not os.path.isfile(full):
        return {"ok": False, "error": "Not a file or does not exist."}
    try:
        size = os.path.getsize(full)
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(2_000_000)  # 2MB cap for the viewer
        return {"ok": True, "path": rel, "size": size, "content": content, "truncated": size > 2_000_000}
    except OSError as e:
        return {"ok": False, "error": str(e)}


def _fmt_elapsed(ms):
    if ms > 700:
        return f"{ms / 1000:.1f}s"
    return f"{ms}ms"


def _sha256_file(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _walk_project_files(root):
    """Yields every file's path relative to root, skipping the agent's own
    bookkeeping dirs/files (see _EXPORT_EXCLUDE_DIRS/_EXPORT_EXCLUDE_FILES)."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _EXPORT_EXCLUDE_DIRS]
        rel_dir = os.path.relpath(dirpath, root)
        for fname in filenames:
            if rel_dir == "." and fname in _EXPORT_EXCLUDE_FILES:
                continue
            rel_path = fname if rel_dir == "." else os.path.join(rel_dir, fname)
            yield rel_path.replace(os.sep, "/")


def _snapshot_baseline(root):
    """{relpath: sha256} for every project file currently under root."""
    baseline = {}
    for rel_path in _walk_project_files(root):
        full = os.path.join(root, *rel_path.split("/"))
        h = _sha256_file(full)
        if h is not None:
            baseline[rel_path] = h
    return baseline


def _compute_diff(root, baseline):
    """Compares the CURRENT files under root against a saved baseline
    {relpath: sha256}. Returns {"added": [...], "modified": [...], "deleted": [...]}."""
    current = _snapshot_baseline(root)
    added = sorted(p for p in current if p not in baseline)
    modified = sorted(p for p in current if p in baseline and current[p] != baseline[p])
    deleted = sorted(p for p in baseline if p not in current)
    return {"added": added, "modified": modified, "deleted": deleted}


def _read_import_meta(project_dir):
    """Returns {source_path, imported_at} for a project imported via
    AgentApi.import_workspace, or None if this project wasn't imported (a
    plain new/created project). Deliberately excludes the baseline hash map
    from what's returned here — that's an internal implementation detail,
    not something the frontend needs to display."""
    meta_path = os.path.join(project_dir, IMPORT_META_FILENAME)
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {"source_path": data.get("source_path"), "imported_at": data.get("imported_at")}
    except (OSError, json.JSONDecodeError):
        return None


class AgentApi:
    """Bridge exposed to the webview frontend as `pywebview.api.*`."""

    def __init__(self):
        self._window = None
        self._lock = threading.Lock()
        self._busy = False
        self._stop = False
        self._thread = None
        self.session = None  # dict with project, messages, memory_dir, ...

    def set_window(self, window):
        self._window = window

    # --- helpers -------------------------------------------------------------
    def _emit(self, event):
        if self._window is None:
            return
        try:
            js = "window.__agent.onEvent(" + json.dumps(event, ensure_ascii=False) + ")"
            self._window.evaluate_js(js)
        except Exception:
            pass

    def _refresh_tree(self):
        if not self.session:
            return
        self._emit({"type": "file_tree", "tree": build_file_tree(self.session["project"])})

    def _refresh_system_prompt(self):
        """Re-derives messages[0] (the system message) from the session's
        base prompt plus the CURRENT plan's rendered state. Called after
        every plan mutation so the model always sees live plan state without
        needing it duplicated into the conversation transcript on every
        change (which would grow context on every single status update)."""
        if not self.session:
            return
        plan = planning.get_active_plan()
        section = ""
        if plan is not None:
            section = (
                "\n\nCURRENT PLAN (auto-synchronized — this reflects your own plan_* tool calls in "
                "real time; keep it accurate as you work):\n" + plan.to_markdown()
            )
        self.session["messages"][0]["content"] = self.session["base_system_prompt"] + section

    def _on_plan_update(self, plan_dict):
        """Bridge from planning.py's generic notify callback to this app's
        webview event stream + live system prompt. planning.py itself has no
        knowledge of pywebview/agent.py session internals."""
        self._refresh_system_prompt()
        self._emit({"type": "plan_update", "plan": plan_dict})

    # --- public API (called from JS) ----------------------------------------
    def get_projects(self):
        os.makedirs(WORKSPACE_DIR, exist_ok=True)
        try:
            projects = [d for d in os.listdir(WORKSPACE_DIR) if os.path.isdir(os.path.join(WORKSPACE_DIR, d))]
        except OSError:
            projects = []
        projects.sort()
        return projects

    def create_project(self, name):
        name = (name or "").strip()
        if not name:
            return {"ok": False, "error": "Project name cannot be empty."}
        if any(c in name for c in ('/', '\\', ':', '*', '?', '"', '<', '>', '|')):
            return {"ok": False, "error": "Project name contains invalid characters."}
        project_dir = os.path.join(WORKSPACE_DIR, name)
        os.makedirs(project_dir, exist_ok=True)
        return {"ok": True, "project": name}

    # --- workspace import / export -------------------------------------------
    def pick_folder(self):
        """Opens a native OS folder picker (via pywebview) and returns the
        chosen absolute path, or path=None if the user cancelled. Reused for
        BOTH picking an import source and picking an export target."""
        if self._window is None:
            return {"ok": False, "error": "Window not ready."}
        try:
            result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not result:
            return {"ok": True, "path": None}
        path = result[0] if isinstance(result, (list, tuple)) else result
        return {"ok": True, "path": path}

    def import_workspace(self, project_name, source_path):
        """Creates a NEW project by copying an external folder's contents
        into it — the agent only ever edits this copy, inside the sandbox,
        never the original folder directly. Records a content-hash baseline
        at copy time so compute_export_diff/export_workspace can later apply
        an exact diff back out, rather than a blind overwrite."""
        project_name = (project_name or "").strip()
        if not project_name:
            return {"ok": False, "error": "Project name cannot be empty."}
        if any(c in project_name for c in ('/', '\\', ':', '*', '?', '"', '<', '>', '|')):
            return {"ok": False, "error": "Project name contains invalid characters."}
        if not source_path or not os.path.isdir(source_path):
            return {"ok": False, "error": f"Source folder not found: {source_path}"}

        project_dir = os.path.join(WORKSPACE_DIR, project_name)
        if os.path.exists(project_dir) and os.listdir(project_dir):
            return {"ok": False, "error": f"Project '{project_name}' already exists and isn't empty — choose a new project name for this import."}

        try:
            os.makedirs(project_dir, exist_ok=True)
            for entry in os.listdir(source_path):
                src = os.path.join(source_path, entry)
                dst = os.path.join(project_dir, entry)
                if os.path.isdir(src):
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)
        except OSError as e:
            return {"ok": False, "error": f"Copy failed: {e}"}

        baseline = _snapshot_baseline(project_dir)
        meta = {
            "source_path": os.path.abspath(source_path),
            "imported_at": datetime.datetime.now().isoformat(timespec="seconds"),
            "baseline": baseline,
        }
        try:
            with open(os.path.join(project_dir, IMPORT_META_FILENAME), "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)
        except OSError as e:
            return {"ok": False, "error": f"Copied {len(baseline)} file(s) but failed to save import metadata: {e}"}

        return {"ok": True, "project": project_name, "file_count": len(baseline)}

    def get_import_status(self, project_name=None):
        project_name = project_name or (self.session["project"] if self.session else None)
        if not project_name:
            return {"ok": False, "error": "No project specified and no active session."}
        meta = _read_import_meta(os.path.join(WORKSPACE_DIR, project_name))
        if meta is None:
            return {"ok": True, "imported": False}
        return {"ok": True, "imported": True, **meta}

    def compute_export_diff(self, project_name=None):
        """Computes what's changed in a project's workspace since it was
        imported (or, for a project with no import baseline, treats every
        current file as 'added' — a full export). Does NOT touch anything on
        disk; call export_workspace after the user approves this diff."""
        project_name = project_name or (self.session["project"] if self.session else None)
        if not project_name:
            return {"ok": False, "error": "No project specified and no active session."}
        project_dir = os.path.join(WORKSPACE_DIR, project_name)
        if not os.path.isdir(project_dir):
            return {"ok": False, "error": f"Project '{project_name}' not found."}

        meta_path = os.path.join(project_dir, IMPORT_META_FILENAME)
        baseline = {}
        source_path = None
        has_baseline = False
        if os.path.isfile(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                baseline = data.get("baseline", {})
                source_path = data.get("source_path")
                has_baseline = True
            except (OSError, json.JSONDecodeError):
                pass

        diff = _compute_diff(project_dir, baseline)
        return {"ok": True, "diff": diff, "source_path": source_path, "has_baseline": has_baseline}

    def export_workspace(self, project_name, target_path):
        """Applies the CURRENT diff (added/modified files copied out,
        deleted files removed if present) onto target_path. This is the
        'after I approve' step — call compute_export_diff first, show it to
        the user, and only call this once they've confirmed."""
        project_name = project_name or (self.session["project"] if self.session else None)
        if not project_name:
            return {"ok": False, "error": "No project specified and no active session."}
        project_dir = os.path.join(WORKSPACE_DIR, project_name)
        if not os.path.isdir(project_dir):
            return {"ok": False, "error": f"Project '{project_name}' not found."}
        if not target_path:
            return {"ok": False, "error": "No target folder given."}
        try:
            os.makedirs(target_path, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": f"Could not create/access target folder: {e}"}

        diff_res = self.compute_export_diff(project_name)
        if not diff_res.get("ok"):
            return diff_res
        diff = diff_res["diff"]

        applied = {"copied": [], "deleted": [], "errors": []}
        for rel_path in diff["added"] + diff["modified"]:
            src = os.path.join(project_dir, *rel_path.split("/"))
            dst = os.path.join(target_path, *rel_path.split("/"))
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                applied["copied"].append(rel_path)
            except OSError as e:
                applied["errors"].append(f"{rel_path}: {e}")
        for rel_path in diff["deleted"]:
            dst = os.path.join(target_path, *rel_path.split("/"))
            if os.path.isfile(dst):
                try:
                    os.remove(dst)
                    applied["deleted"].append(rel_path)
                except OSError as e:
                    applied["errors"].append(f"{rel_path}: {e}")

        return {"ok": True, "target": target_path, "applied": applied}

    def get_state(self):
        if not self.session:
            return {"active": False}
        return {
            "active": True,
            "project": self.session["project"],
            "memory_summary": self.session.get("last_summary", ""),
        }

    def start_session(self, project_name):
        project_dir = os.path.join(WORKSPACE_DIR, project_name)
        memory_dir = os.path.join(MEMORY_DIR, project_name)
        os.makedirs(project_dir, exist_ok=True)
        os.makedirs(memory_dir, exist_ok=True)

        self._emit({"type": "log", "content": f"[Sandbox] Preparing Docker environment for '{project_name}'..."})
        try:
            setup_sandbox(project_dir)
        except SystemExit as e:
            return {"ok": False, "error": f"Docker sandbox failed to start (exit {e}). Is Docker Desktop running?"}
        except Exception as e:
            return {"ok": False, "error": f"Docker sandbox failed to start: {e}"}
        self._emit({"type": "log", "content": "[Sandbox] Container is ready."})

        summaries = sorted(glob.glob(os.path.join(memory_dir, "summary_*.txt")))
        base_system_prompt = get_full_system_prompt()
        messages = [{"role": "system", "content": base_system_prompt}]

        last_summary_text = None
        if summaries:
            try:
                with open(summaries[-1], "r", encoding="utf-8") as f:
                    last_summary_text = f.read()
                messages.append({"role": "assistant", "content": f"[MEMORY SUMMARY]: {last_summary_text}"})
            except OSError:
                last_summary_text = None

        self.session = {
            "project": project_name,
            "messages": messages,
            "base_system_prompt": base_system_prompt,
            "memory_dir": memory_dir,
            "last_summary": last_summary_text or "",
            "original_task": None,
            "step_count": 0,
            "last_tool_call": None,
            "consecutive_tools": 0,
            "soft_tool_nudge": SOFT_TOOL_NUDGE,
            "max_consecutive_tools": MAX_CONSECUTIVE_TOOLS,
            "loop_repeat_threshold": LOOP_REPEAT_THRESHOLD,
            "summary_resets": 0,
            "needs_plan": True,
            "tools_since_plan_touch": 0,
            "_plan_touch_nudge_sent": False,
        }

        # Plan-and-execute: resume a previous in-progress plan for this
        # project (if any), otherwise start clean. notify=False here since
        # self.session isn't fully wired to _on_plan_update semantics
        # (base_system_prompt refresh) until after session_started fires.
        planning.set_context(memory_dir, notify_callback=self._on_plan_update)
        resumed_plan = planning.load_plan(memory_dir)
        if resumed_plan and not resumed_plan.is_complete():
            planning.set_active_plan(resumed_plan, notify=False)
            self.session["needs_plan"] = False
        else:
            planning.clear_active_plan(notify=False)

        tree = build_file_tree(project_name)
        self._emit({"type": "session_started",
                    "project": project_name,
                    "memory_summary": last_summary_text or "",
                    "file_tree": tree,
                    "import_source": _read_import_meta(project_dir)})
        # Now that self.session is fully built, push the (possibly resumed)
        # plan to the GUI and fold it into the live system prompt.
        active_plan = planning.get_active_plan()
        self._on_plan_update(active_plan.to_dict() if active_plan else None)
        return {"ok": True, "project": project_name}

    def send_message(self, text):
        if not self.session:
            return {"ok": False, "error": "No active session. Start a project first."}
        with self._lock:
            if self._busy:
                return {"ok": False, "error": "Agent is already working. Stop it first."}
            self._busy = True
            self._stop = False

        self.session["messages"].append({"role": "user", "content": text})
        if self.session["original_task"] is None:
            self.session["original_task"] = text
        # Fresh user turn -> reset per-task loop/budget state.
        self.session["last_tool_call"] = None
        self.session["consecutive_tools"] = 0
        self.session["summary_resets"] = 0

        # Plan-and-execute: a genuinely NEW task (no active plan, or the
        # previous one is fully done) must be planned before any tool runs.
        # A follow-up message that continues an in-progress plan does NOT
        # force a re-plan — the model can just keep working the existing one
        # (or call plan_add_task/plan_update_task itself if the follow-up
        # changes scope).
        active_plan = planning.get_active_plan()
        if active_plan is None or active_plan.is_complete():
            self.session["needs_plan"] = True
        self.session["tools_since_plan_touch"] = 0
        self.session["_plan_touch_nudge_sent"] = False

        self._emit({"type": "user_message", "content": text})
        self._thread = threading.Thread(target=self._run_agent_loop, daemon=True)
        self._thread.start()
        return {"ok": True}

    def stop(self):
        if not self._busy:
            return {"ok": False, "error": "Nothing to stop."}
        self._stop = True
        self._emit({"type": "system", "content": "Stop requested — will halt before the next LLM call."})
        return {"ok": True}

    def get_file_tree(self):
        if not self.session:
            return {"ok": False, "error": "No active session."}
        return {"ok": True, "tree": build_file_tree(self.session["project"])}

    def read_file(self, rel_path):
        if not self.session:
            return {"ok": False, "error": "No active session."}
        return read_project_file(self.session["project"], rel_path)

    def get_code_graph(self):
        """Reads the chunked code knowledge graph from the project workspace
        and returns vis-network-ready nodes/edges/legend for the frontend
        visualization. Returns an error if no graph has been built yet.
        """
        if not self.session:
            return {"ok": False, "error": "No active session."}
        project = self.session["project"]
        graph_dir = os.path.join(WORKSPACE_DIR, project, ".codegraph")
        manifest_path = os.path.join(graph_dir, "manifest.json")
        if not os.path.isfile(manifest_path):
            return {"ok": False, "error": "No knowledge graph found. Ask the agent to run build_code_graph on a decompiled directory first."}
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            meta_path = os.path.join(graph_dir, "meta.json")
            meta = {}
            if os.path.isfile(meta_path):
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)

            # Load class shards
            classes = {}
            for shard_name in manifest.get("class_shards", []):
                shard_path = os.path.join(graph_dir, shard_name)
                if os.path.isfile(shard_path):
                    with open(shard_path, "r", encoding="utf-8") as f:
                        classes.update(json.load(f))

            # Load callers
            callers = {}
            callers_path = os.path.join(graph_dir, manifest.get("files", {}).get("callers", "callers.json"))
            if os.path.isfile(callers_path):
                with open(callers_path, "r", encoding="utf-8") as f:
                    callers = json.load(f)

            # Build visualization data (same logic as _kg_query.py graph_data)
            data = self._build_viz_data(classes, callers, meta)
            return {"ok": True, "graph": data}
        except Exception as e:
            return {"ok": False, "error": f"Failed to read graph: {e}"}

    def _build_viz_data(self, classes, callers, meta, max_nodes=600):
        """Build vis-network nodes/edges/legend from class + caller data."""
        palette = [
            "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
            "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
            "#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD",
        ]
        # Community = top-level package
        pkg_groups = {}
        for cname in classes:
            d = cname.lstrip("L[").rstrip(";")
            top = d.split("/")[0] if "/" in d else "(default)"
            pkg_groups.setdefault(top, []).append(cname)
        comm_ids = {pkg: i % len(palette) for i, pkg in enumerate(sorted(pkg_groups.keys()))}
        legend = [{"cid": comm_ids[pkg], "color": palette[comm_ids[pkg]], "label": pkg, "count": len(pkg_groups[pkg])}
                  for pkg in sorted(pkg_groups.keys())]

        # Build call edges
        edges_set = {}
        for cname, cinfo in classes.items():
            for m, mi in cinfo.get("methods", {}).items():
                src = "%s->%s" % (cname, m)
                for cal in mi.get("calls", []):
                    key = (src, cal)
                    edges_set[key] = edges_set.get(key, 0) + 1

        degree = {}
        for (src, dst) in edges_set:
            degree[src] = degree.get(src, 0) + 1
            degree[dst] = degree.get(dst, 0) + 1

        class_deg = {}
        for cname in classes:
            d = 0
            for m in classes[cname].get("methods", {}):
                d += degree.get("%s->%s" % (cname, m), 0)
            class_deg[cname] = d

        top_classes = sorted(class_deg, key=lambda c: class_deg[c], reverse=True)[:max_nodes]
        top_set = set(top_classes)

        nodes = []
        for cname in top_classes:
            d = cname.lstrip("L[").rstrip(";")
            top = d.split("/")[0] if "/" in d else "(default)"
            cid = comm_ids.get(top, 0)
            color = palette[cid]
            deg = class_deg[cname]
            nodes.append({
                "id": cname, "label": d.split("/")[-1] if "/" in d else d,
                "color": {"background": color, "border": color, "highlight": {"background": "#ffffff", "border": color}},
                "size": 10 + min(deg * 0.5, 30), "community": cid, "community_name": top,
                "source_file": classes[cname].get("file", ""), "file_type": "smali", "degree": deg, "title": cname,
            })

        method_to_class = {}
        for cname in classes:
            for m in classes[cname].get("methods", {}):
                method_to_class["%s->%s" % (cname, m)] = cname

        class_edges = {}
        for (src, dst) in edges_set:
            src_cls = method_to_class.get(src, src.split("->")[0] if "->" in src else src)
            dst_cls = method_to_class.get(dst, dst.split("->")[0] if "->" in dst else dst)
            if src_cls in top_set and dst_cls in top_set and src_cls != dst_cls:
                key = (src_cls, dst_cls)
                class_edges[key] = class_edges.get(key, 0) + 1

        edges = [{"from": s, "to": d, "label": "", "title": "%d call(s)" % w,
                  "width": min(1 + w * 0.3, 6), "color": {"opacity": 0.5}, "dashes": False}
                 for (s, d), w in class_edges.items()]

        return {"nodes": nodes, "edges": edges, "legend": legend,
                "stats": {"total_nodes": len(nodes), "total_edges": len(edges),
                          "total_communities": len(legend), "classes": meta.get("classes", len(classes)),
                          "methods": meta.get("methods", 0), "call_edges": meta.get("edges", len(edges_set))}}

    def end_session(self):
        self.stop()
        planning.clear_active_plan(notify=False)
        planning.set_context(None, notify_callback=None)
        self.session = None
        self._emit({"type": "session_ended"})
        return {"ok": True}

    def exit_app(self):
        if self._window is not None:
            try:
                self._window.destroy()
            except Exception:
                pass
        return {"ok": True}

    # --- the agent loop (runs in a background thread, emits events) ----------
    def _run_agent_loop(self):
        s = self.session
        container_msg = None
        try:
            while True:
                if self._stop:
                    self._emit({"type": "system", "content": "Generation stopped by user."})
                    break

                # Soft nudge
                if s["consecutive_tools"] >= s["soft_tool_nudge"] and not getattr(s, "_nudge_sent", False):
                    s["_nudge_sent"] = True
                    self._emit({"type": "system",
                                "content": f"SYSTEM GUARD: {s['consecutive_tools']} consecutive tool calls. If the task is complete, give a final_answer; otherwise keep going."})
                    s["messages"].append({"role": "user",
                                          "content": f"SYSTEM GUARD: You have executed {s['consecutive_tools']} tools in a row. If the task is complete, provide a final_answer now. If the task still needs more work, continue with the next step."})

                # Thinking indicator
                self._emit({"type": "thinking_start"})
                start_time = time.time()
                raw_response = ask_llm(s["messages"])
                elapsed_ms = int((time.time() - start_time) * 1000)
                self._emit({"type": "thinking_end", "elapsed_ms": elapsed_ms})

                response_type, payload = parse_response(raw_response)

                if response_type == "error":
                    self._emit({"type": "system", "content": "Response was not valid JSON — retrying..."})
                    retry_messages = s["messages"] + [
                        {"role": "assistant", "content": raw_response},
                        {"role": "user",
                         "content": "Your last response was not valid JSON. You MUST respond with a raw JSON object only — no markdown, no prose. Use {\"type\": \"tool_call\", ...} or {\"type\": \"final_answer\", \"content\": \"...\"}."}
                    ]
                    self._emit({"type": "thinking_start"})
                    start_time = time.time()
                    raw_response = ask_llm(retry_messages)
                    elapsed_ms += int((time.time() - start_time) * 1000)
                    self._emit({"type": "thinking_end", "elapsed_ms": elapsed_ms})
                    response_type, payload = parse_response(raw_response)

                s["messages"].append({"role": "assistant", "content": raw_response})

                # Extract the pre-JSON "thought" text the model emits.
                start_idx = raw_response.find("{")
                thought_process = raw_response[:start_idx].strip() if start_idx != -1 else raw_response.strip()
                time_str = _fmt_elapsed(elapsed_ms)

                self._emit({"type": "thought", "time": time_str, "elapsed_ms": elapsed_ms,
                            "text": thought_process,
                            "thought_chars": len(thought_process)})

                if response_type == "tool_call":
                    tool_name = payload.get("tool")
                    tool_args = payload.get("args", {})

                    # Plan-and-execute gate: a new task must be planned before
                    # any non-plan tool runs (see PLAN-AND-EXECUTE WORKFLOW in
                    # llm.py's system prompt). Bounded retries so a model that
                    # never complies doesn't loop forever — it fails open
                    # after a few nudges rather than stalling the task.
                    if s.get("needs_plan") and tool_name not in PLAN_TOOL_NAMES:
                        s["plan_gate_retries"] = s.get("plan_gate_retries", 0) + 1
                        if s["plan_gate_retries"] <= 3:
                            self._emit({"type": "system", "content": "Waiting for the agent to create a plan before proceeding..."})
                            s["messages"].append({"role": "user", "content": (
                                "[SYSTEM] This is a new task and no plan exists yet. Before taking any "
                                "other action, call plan_create with a short task summary and an ordered "
                                "list of concrete steps."
                            )})
                            continue
                        else:
                            self._emit({"type": "system", "content": "Proceeding without an explicit plan after repeated attempts to prompt for one."})
                            s["needs_plan"] = False

                    tool_id = uuid.uuid4().hex[:12]
                    run_started = time.time()

                    # Emit "running" immediately so the UI can show what tool
                    # is executing BEFORE we wait for its output.
                    self._emit({"type": "tool_running",
                                "id": tool_id,
                                "tool": tool_name,
                                "args": tool_args,
                                "step": s["step_count"] + 1})

                    tool_feedback = execute_tool(payload, s["last_tool_call"], s["loop_repeat_threshold"])
                    run_ms = int((time.time() - run_started) * 1000)
                    is_loop_warning = tool_feedback.startswith("[SYSTEM WARNING]")
                    prev_call = s["last_tool_call"]
                    same_as_prev = (
                        isinstance(prev_call, dict)
                        and prev_call.get("tool") == tool_name
                        and prev_call.get("args", {}) == tool_args
                    )
                    if is_loop_warning:
                        if isinstance(prev_call, dict):
                            s["last_tool_call"] = dict(prev_call)
                            s["last_tool_call"]["repeats"] = prev_call.get("repeats", 1) + 1
                        else:
                            s["last_tool_call"] = {"tool": tool_name, "args": tool_args, "repeats": 2}
                    elif same_as_prev:
                        s["last_tool_call"] = {"tool": tool_name, "args": tool_args, "repeats": prev_call.get("repeats", 1) + 1}
                    else:
                        s["last_tool_call"] = {"tool": tool_name, "args": tool_args, "repeats": 1}

                    s["step_count"] += 1
                    s["consecutive_tools"] += 1

                    # Plan-and-execute bookkeeping: clear the gate once a plan
                    # actually exists, and gently nudge if many tool calls pass
                    # without the model touching the plan at all (it may be
                    # silently working ahead of it instead of keeping status
                    # updated as instructed in the system prompt).
                    if tool_name == "plan_create":
                        s["needs_plan"] = False
                        s["plan_gate_retries"] = 0
                    if tool_name in PLAN_TOOL_NAMES or (tool_name or "").startswith("plan_"):
                        s["tools_since_plan_touch"] = 0
                        s["_plan_touch_nudge_sent"] = False
                    else:
                        s["tools_since_plan_touch"] = s.get("tools_since_plan_touch", 0) + 1
                        if (planning.get_active_plan() is not None
                                and s["tools_since_plan_touch"] >= PLAN_TOUCH_NUDGE
                                and not s.get("_plan_touch_nudge_sent")):
                            s["_plan_touch_nudge_sent"] = True
                            s["messages"].append({"role": "user", "content": (
                                f"[SYSTEM] {s['tools_since_plan_touch']} tool calls have passed without "
                                "updating the plan. If you've made progress, call plan_update_task to "
                                "reflect it (or plan_add_task if you've discovered new work) before continuing."
                            )})

                    self._emit({"type": "tool_result",
                                "id": tool_id,
                                "tool": tool_name,
                                "args": tool_args,
                                "result": tool_feedback,
                                "step": s["step_count"],
                                "consecutive_tools": s["consecutive_tools"],
                                "is_loop_warning": is_loop_warning,
                                "run_ms": run_ms,
                                "time": time_str})
                    self._refresh_tree()

                    s["messages"].append({"role": "user", "content": f"TOOL RESULT:\n{tool_feedback}"})

                    if s["consecutive_tools"] >= s["max_consecutive_tools"]:
                        if s["summary_resets"] >= MAX_SUMMARY_RESETS:
                            self._emit({"type": "system", "content": "Agent appears stuck after multiple context resets. Aborting to prevent runaway."})
                            break
                        self._emit({"type": "system", "content": f"Long task in progress: compacting memory after {s['consecutive_tools']} tool steps (progress preserved)."})
                        s["messages"] = summarize_memory(s["messages"], s["memory_dir"], s["original_task"])
                        s["base_system_prompt"] = s["messages"][0]["content"]
                        self._refresh_system_prompt()
                        s["step_count"] = 0
                        s["consecutive_tools"] = 0
                        s["_nudge_sent"] = False
                        s["summary_resets"] += 1
                elif response_type == "final_answer":
                    s["step_count"] += 1
                    s["last_tool_call"] = None
                    self._emit({"type": "final_answer",
                                "content": payload,
                                "steps": s["step_count"],
                                "time": time_str})
                    break
                else:
                    self._emit({"type": "system", "content": f"Parse error: {payload}"})
                    s["step_count"] += 1
                    break

                if self._stop:
                    self._emit({"type": "system", "content": "Generation stopped by user."})
                    break

                if s["step_count"] >= MAX_STEPS_BEFORE_SUMMARY or estimate_context_chars(s["messages"]) > CONTEXT_CHAR_LIMIT:
                    self._emit({"type": "system", "content": "Memory summarized (context reset). Original task preserved."})
                    s["messages"] = summarize_memory(s["messages"], s["memory_dir"], s["original_task"])
                    s["base_system_prompt"] = s["messages"][0]["content"]
                    self._refresh_system_prompt()
                    s["step_count"] = 0
                    s["consecutive_tools"] = 0
                    s["_nudge_sent"] = False
                    s["summary_resets"] += 1

                self._emit({"type": "status",
                            "step_count": s["step_count"],
                            "consecutive_tools": s["consecutive_tools"],
                            "ctx_chars": estimate_context_chars(s["messages"]),
                            "summary_resets": s["summary_resets"]})
        except Exception as e:
            self._emit({"type": "error", "content": f"Agent loop crashed: {e}"})
        finally:
            with self._lock:
                self._busy = False
            self._refresh_tree()
            self._emit({"type": "done"})


def main():
    api = AgentApi()
    frontend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "frontend", "index.html"))
    if not os.path.isfile(frontend_path):
        print(f"[ERROR] Frontend not found at {frontend_path}")
        sys.exit(1)
    window = webview.create_window(
        "Omni Agent",
        url=frontend_path,
        js_api=api,
        width=1320,
        height=840,
        min_size=(980, 600),
    )
    api.set_window(window)
    webview.start(debug=True)


if __name__ == "__main__":
    main()
