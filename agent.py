import os
import sys
import base64
import datetime
import json
import glob
import time
import threading
import uuid
import shutil
import hashlib
import zipfile
import webview

# On Windows the default console/file encoding is cp1252, which can't handle
# Unicode characters the LLM emits (arrows, checkmarks, em-dashes, etc.).
# Force UTF-8 on stdout/stderr so print() and console output never crash.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")


from llm import (
    ask_llm,
    get_full_system_prompt,
    list_providers,
    get_effective_config,
    save_config,
    test_connection,
    extract_json_action,
    strip_reasoning,
)
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
# How many corrective re-asks a malformed (non-JSON) LLM reply gets before the
# loop salvages the reply as prose instead of aborting the whole run.
MAX_PARSE_RETRIES = 2

# --- Chat persistence + UI memory safety -------------------------------------
# The full conversation (LLM messages) and a replayable UI transcript are saved
# per project so the chat survives a webview refresh, a renderer crash, or a full
# app restart — and the agent can continue from where it left off.
CONVERSATION_FILENAME = "conversation.json"
TRANSCRIPT_FILENAME = "transcript.json"
# The workspace file tree is expensive to rebuild + re-render (a decompiled APK
# is thousands of files). Rebuilding it after every tool call is what overloads
# the webview. Refresh it at most this often during a run (a final forced
# refresh still fires when the run ends).
TREE_REFRESH_MIN_INTERVAL = 4.0  # seconds
# The webview renderer (WebView2/Chromium) OOMs if the chat DOM accumulates the
# raw text of every tool result over a long run. We only ever SHOW a bounded
# slice in the UI (the agent keeps the full text in its own context/messages).
UI_RESULT_CAP = 16000        # max chars of a single tool result shown in the UI
UI_THOUGHT_CAP = 16000       # max chars of a single "thought" block shown in the UI
UI_TEXT_CAP = 40000          # max chars of any other renderable field (answer, user msg)
# Keep only the most recent renderable events in the persisted/replayed transcript.
TRANSCRIPT_MAX_EVENTS = 500
# Event types that make up the visible chat and are persisted for replay.
RENDERABLE_EVENT_TYPES = {"user_message", "thought", "tool_result", "final_answer", "system", "error"}


def _ui_trunc(text, cap):
    """Cap text shown in the UI. The full text still lives in the agent's own
    message history — this only limits what crosses into the DOM, so a long run
    can't OOM the webview renderer."""
    if text is None:
        return text
    text = str(text)
    if len(text) <= cap:
        return text
    return text[:cap] + f"\n\n… [truncated {len(text) - cap:,} more chars — full output is retained in the agent's context]"


def _cap_transcript(transcript):
    """Return the last TRANSCRIPT_MAX_EVENTS events with their text fields capped,
    so the persisted/replayed transcript stays bounded no matter how it was built."""
    out = []
    for e in transcript[-TRANSCRIPT_MAX_EVENTS:]:
        e = dict(e)
        if "result" in e:
            e["result"] = _ui_trunc(e["result"], UI_RESULT_CAP)
        if e.get("type") == "thought" and "text" in e:
            e["text"] = _ui_trunc(e["text"], UI_THOUGHT_CAP)
        if "content" in e:
            e["content"] = _ui_trunc(e["content"], UI_TEXT_CAP)
        out.append(e)
    return out


def _write_json_atomic(path, data):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, path)
        return True
    except (OSError, TypeError, ValueError):
        return False


# --- Code-graph guard --------------------------------------------------------
# Reading this many files in a row with no code-graph/search call in between is
# the "sweeping thousands of scripts" anti-pattern on big decompiled apps. When
# it happens, nudge the model toward build_code_graph / query_code_graph /
# grep_directory instead. Bounded per task so it can't spam.
GRAPH_NUDGE_THRESHOLD = 12
MAX_GRAPH_NUDGES = 4
# Tools that count as actually NAVIGATING (graph queries or content search) —
# using any of these resets the file-sweep counter.
NAVIGATION_TOOLS = {"build_code_graph", "query_code_graph", "grep_directory",
                    "search_smali", "grep_file", "find_files"}

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
    data = extract_json_action(response_text or "")
    if data is None:
        return ("error", f"LLM returned non-JSON content: {(response_text or '')[:300]}")

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


def _tree_signature(tree):
    """A cheap content signature of the file tree, used to skip re-emitting an
    unchanged tree to the UI. Structural (paths + sizes), so it changes iff a
    file is added/removed/resized."""
    try:
        return hashlib.md5(
            json.dumps(tree, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
    except (TypeError, ValueError):
        return None


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


# Viewer preview types. Images are shipped to the frontend as base64 data URIs
# (the webview can't fetch workspace files over HTTP); zip-based archives get a
# listing so the viewer can render a browsable explorer instead of mojibake.
_VIEWER_IMAGE_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".ico": "image/x-icon", ".svg": "image/svg+xml",
}
_VIEWER_ARCHIVE_EXTS = {".zip", ".apk", ".jar", ".aar", ".xapk", ".apks"}
_VIEWER_TEXT_CAP = 2_000_000       # 2MB text cap for the viewer
_VIEWER_IMAGE_CAP = 20_000_000     # refuse to inline images bigger than this
_VIEWER_MAX_ARCHIVE_ENTRIES = 20_000


def _resolve_project_file(project_name, rel_path):
    """Normalizes rel_path and sandboxes it inside the project root.
    Returns (full_path, rel, None) or (None, None, error)."""
    if not rel_path:
        return None, None, "No path provided."
    rel = rel_path.lstrip("/").lstrip("\\")
    root = os.path.abspath(os.path.join(WORKSPACE_DIR, project_name))
    full = os.path.abspath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) and full != root:
        return None, None, "Path outside workspace."
    if not os.path.isfile(full):
        return None, None, "Not a file or does not exist."
    return full, rel, None


def read_project_file(project_name, rel_path):
    """Reads a file from the project workspace (host side) for the frontend
    viewer. Returns a typed payload: kind="image" (base64 + mime),
    kind="archive" (zip/apk entry listing), or kind="text" (the default)."""
    full, rel, err = _resolve_project_file(project_name, rel_path)
    if err:
        return {"ok": False, "error": err}
    ext = os.path.splitext(full)[1].lower()
    try:
        size = os.path.getsize(full)
        if ext in _VIEWER_IMAGE_MIME:
            if size > _VIEWER_IMAGE_CAP:
                return {"ok": False, "error": f"Image too large to preview ({size:,} bytes)."}
            with open(full, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            return {"ok": True, "kind": "image", "path": rel, "size": size,
                    "mime": _VIEWER_IMAGE_MIME[ext], "data": data}
        if ext in _VIEWER_ARCHIVE_EXTS and zipfile.is_zipfile(full):
            with zipfile.ZipFile(full) as zf:
                infos = zf.infolist()
            entries = [{"name": i.filename, "size": i.file_size, "dir": i.is_dir()}
                       for i in infos[:_VIEWER_MAX_ARCHIVE_ENTRIES]]
            return {"ok": True, "kind": "archive", "path": rel, "size": size,
                    "entries": entries, "entry_count": len(infos),
                    "truncated": len(infos) > _VIEWER_MAX_ARCHIVE_ENTRIES}
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(_VIEWER_TEXT_CAP)
        return {"ok": True, "kind": "text", "path": rel, "size": size, "content": content,
                "truncated": size > _VIEWER_TEXT_CAP}
    except (OSError, zipfile.BadZipFile) as e:
        return {"ok": False, "error": str(e)}


def read_project_archive_member(project_name, rel_path, member):
    """Reads a single entry out of a zip-based archive (zip/apk/jar/…) in the
    workspace, for previewing inside the frontend's archive explorer. Entries
    get the same typed treatment as read_project_file (image or text)."""
    full, rel, err = _resolve_project_file(project_name, rel_path)
    if err:
        return {"ok": False, "error": err}
    if not member:
        return {"ok": False, "error": "No archive entry provided."}
    try:
        with zipfile.ZipFile(full) as zf:
            try:
                info = zf.getinfo(member)
            except KeyError:
                return {"ok": False, "error": "Entry not found in archive."}
            if info.is_dir():
                return {"ok": False, "error": "Entry is a directory."}
            ext = os.path.splitext(member)[1].lower()
            if ext in _VIEWER_IMAGE_MIME:
                if info.file_size > _VIEWER_IMAGE_CAP:
                    return {"ok": False, "error": f"Image too large to preview ({info.file_size:,} bytes)."}
                with zf.open(info) as f:
                    data = base64.b64encode(f.read()).decode("ascii")
                return {"ok": True, "kind": "image", "path": f"{rel} › {member}",
                        "size": info.file_size, "mime": _VIEWER_IMAGE_MIME[ext], "data": data}
            with zf.open(info) as f:
                raw = f.read(_VIEWER_TEXT_CAP)
            return {"ok": True, "kind": "text", "path": f"{rel} › {member}",
                    "size": info.file_size, "content": raw.decode("utf-8", errors="replace"),
                    "truncated": info.file_size > _VIEWER_TEXT_CAP}
    except (OSError, zipfile.BadZipFile) as e:
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
        # Record renderable events into the session transcript so the chat can be
        # replayed after a webview refresh / renderer crash / app restart. Cap the
        # stored text fields and the list length so the transcript can't grow
        # without bound (the full text always stays in the LLM messages).
        if self.session is not None and event.get("type") in RENDERABLE_EVENT_TYPES:
            stored = dict(event)
            if "result" in stored:
                stored["result"] = _ui_trunc(stored["result"], UI_RESULT_CAP)
            if stored.get("type") == "thought" and "text" in stored:
                stored["text"] = _ui_trunc(stored["text"], UI_THOUGHT_CAP)
            if "content" in stored:
                stored["content"] = _ui_trunc(stored["content"], UI_TEXT_CAP)
            tr = self.session.setdefault("transcript", [])
            tr.append(stored)
            if len(tr) > TRANSCRIPT_MAX_EVENTS:
                del tr[:len(tr) - TRANSCRIPT_MAX_EVENTS]
        if self._window is None:
            return
        try:
            js = "window.__agent.onEvent(" + json.dumps(event, ensure_ascii=False) + ")"
            self._window.evaluate_js(js)
        except Exception:
            pass

    # --- chat persistence ----------------------------------------------------
    def _persist_session(self):
        """Save the current conversation (LLM messages) + UI transcript to the
        project's memory dir so it survives a refresh / crash / app restart.
        Best-effort — never raises into the agent loop."""
        s = self.session
        if not s:
            return
        mem = s.get("memory_dir")
        if not mem:
            return
        try:
            os.makedirs(mem, exist_ok=True)
        except OSError:
            return
        _write_json_atomic(os.path.join(mem, CONVERSATION_FILENAME), {
            "project": s.get("project"),
            "original_task": s.get("original_task"),
            "messages": s.get("messages", []),
            "saved_at": datetime.datetime.now().isoformat(timespec="seconds"),
        })
        _write_json_atomic(os.path.join(mem, TRANSCRIPT_FILENAME), _cap_transcript(s.get("transcript", [])))

    def _load_persisted(self, memory_dir):
        """Returns (messages_or_None, transcript_list, original_task) previously
        saved for this project, or (None, [], None) if there's nothing usable."""
        conv_path = os.path.join(memory_dir, CONVERSATION_FILENAME)
        tr_path = os.path.join(memory_dir, TRANSCRIPT_FILENAME)
        messages, transcript, original_task = None, [], None
        try:
            if os.path.isfile(conv_path):
                with open(conv_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                msgs = data.get("messages")
                if isinstance(msgs, list) and any(m.get("role") != "system" for m in msgs):
                    messages = msgs
                    original_task = data.get("original_task")
        except (OSError, json.JSONDecodeError, AttributeError):
            messages, original_task = None, None
        try:
            if os.path.isfile(tr_path):
                with open(tr_path, "r", encoding="utf-8") as f:
                    tr = json.load(f)
                if isinstance(tr, list):
                    transcript = tr[-TRANSCRIPT_MAX_EVENTS:]
        except (OSError, json.JSONDecodeError):
            transcript = []
        return messages, transcript, original_task

    def _refresh_tree(self, force=False):
        """Rebuild + push the workspace file tree to the UI. Throttled: during a
        run (many tool calls) this is skipped unless TREE_REFRESH_MIN_INTERVAL has
        passed, and the emit is skipped entirely when the tree is unchanged (the
        common case — reads/queries don't alter files). Pass force=True at
        genuine end-of-run points (done, upload) to always push the latest tree."""
        if not self.session:
            return
        now = time.time()
        if not force and (now - self.session.get("_last_tree_emit", 0)) < TREE_REFRESH_MIN_INTERVAL:
            return
        self.session["_last_tree_emit"] = now
        tree = build_file_tree(self.session["project"])
        sig = _tree_signature(tree)
        if not force and sig is not None and sig == self.session.get("_last_tree_sig"):
            return  # nothing changed — don't re-serialize + re-render the tree
        self.session["_last_tree_sig"] = sig
        self._emit({"type": "file_tree", "tree": tree})

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

    def delete_workspace(self, name):
        """Permanently removes a project's workspace files AND its saved
        conversation/transcript memory. Refuses if that project has a live
        session — end it first. This is irreversible; the frontend confirms
        with the user before calling."""
        name = (name or "").strip()
        if not name:
            return {"ok": False, "error": "Project name cannot be empty."}
        if any(c in name for c in ('/', '\\', ':', '*', '?', '"', '<', '>', '|')):
            return {"ok": False, "error": "Project name contains invalid characters."}
        if self.session and self.session.get("project") == name:
            return {"ok": False, "error": f"'{name}' has an active session — end it before deleting."}

        project_dir = os.path.join(WORKSPACE_DIR, name)
        memory_dir = os.path.join(MEMORY_DIR, name)
        if not os.path.isdir(project_dir) and not os.path.isdir(memory_dir):
            return {"ok": False, "error": f"Project '{name}' not found."}

        for target in (project_dir, memory_dir):
            if os.path.isdir(target):
                try:
                    shutil.rmtree(target)
                except OSError as e:
                    return {"ok": False, "error": f"Failed to delete '{name}': {e}"}
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

    # --- LLM provider settings (exposed to the settings UI) ------------------
    # These read/write llm_config.json via the llm module and don't need an
    # active session, so the provider can be configured from the start screen
    # too. The API key is returned to the (local, single-user) webview so the
    # field can prefill; it never leaves this machine.
    def get_llm_config(self):
        try:
            eff = get_effective_config()
            return {
                "ok": True,
                "config": {
                    "provider": eff["provider"],
                    "model": eff["model"],
                    "base_url": eff["base_url"],
                    "api_key": eff["api_key"],
                    "max_tokens": eff["max_tokens"],
                },
                "providers": list_providers(),
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_llm_config(self, cfg):
        if not isinstance(cfg, dict):
            return {"ok": False, "error": "Invalid config."}
        provider = (cfg.get("provider") or "").strip()
        valid = {p["id"] for p in list_providers()}
        if provider not in valid:
            return {"ok": False, "error": f"Unknown provider '{provider}'."}
        ok = save_config({
            "provider": provider,
            "api_key": (cfg.get("api_key") or "").strip(),
            "model": (cfg.get("model") or "").strip(),
            "base_url": (cfg.get("base_url") or "").strip(),
            "max_tokens": cfg.get("max_tokens"),
        })
        if not ok:
            return {"ok": False, "error": "Failed to write llm_config.json (check file permissions)."}
        eff = get_effective_config()
        return {"ok": True, "provider": eff["provider"], "model": eff["model"], "label": eff["label"]}

    def test_llm_config(self, cfg):
        try:
            overrides = None
            if isinstance(cfg, dict):
                overrides = {
                    "provider": ((cfg.get("provider") or "").strip() or None),
                    "api_key": cfg.get("api_key"),
                    "model": cfg.get("model"),
                    "base_url": cfg.get("base_url"),
                    "max_tokens": cfg.get("max_tokens"),
                }
            return test_connection(overrides)
        except Exception as e:
            return {"ok": False, "error": str(e)}

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

        base_system_prompt = get_full_system_prompt()

        # Prefer restoring the full prior conversation (so the agent can CONTINUE
        # from the old chat). Fall back to the latest memory summary only if there
        # is no saved conversation for this project.
        saved_messages, saved_transcript, saved_task = self._load_persisted(memory_dir)
        last_summary_text = None
        if saved_messages is not None:
            messages = saved_messages
            # Always refresh the system prompt to the current one (tools/skills may
            # have changed since it was saved); keep the rest of the history.
            if messages and messages[0].get("role") == "system":
                messages[0] = {"role": "system", "content": base_system_prompt}
            else:
                messages.insert(0, {"role": "system", "content": base_system_prompt})
        else:
            messages = [{"role": "system", "content": base_system_prompt}]
            summaries = sorted(glob.glob(os.path.join(memory_dir, "summary_*.txt")))
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
            "transcript": saved_transcript,
            "original_task": saved_task,
            "step_count": 0,
            "last_tool_call": None,
            "consecutive_tools": 0,
            "soft_tool_nudge": SOFT_TOOL_NUDGE,
            "max_consecutive_tools": MAX_CONSECUTIVE_TOOLS,
            "loop_repeat_threshold": LOOP_REPEAT_THRESHOLD,
            "summary_resets": 0,
            "needs_plan": saved_task is None,
            "tools_since_plan_touch": 0,
            "_plan_touch_nudge_sent": False,
            "reads_since_nav": 0,
            "graph_nudges_sent": 0,
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

        self._emit_session_started()
        return {"ok": True, "project": project_name}

    def _emit_session_started(self):
        """Push the current session to the GUI (used on a fresh start AND when
        reconnecting after a webview refresh). Includes the replayable transcript
        so the chat is rebuilt exactly, then folds the live plan into the prompt."""
        s = self.session
        if not s:
            return
        project = s["project"]
        self._emit({
            "type": "session_started",
            "project": project,
            "memory_summary": s.get("last_summary", ""),
            "file_tree": build_file_tree(project),
            "import_source": _read_import_meta(os.path.join(WORKSPACE_DIR, project)),
            "transcript": s.get("transcript", []),
            "busy": self._busy,
        })
        active_plan = planning.get_active_plan()
        self._on_plan_update(active_plan.to_dict() if active_plan else None)

    def restore_session(self):
        """Re-attach the frontend to a still-live backend session after a webview
        refresh or renderer crash — replays the transcript instead of dropping to
        the start screen. Returns {active:false} if there's no live session."""
        if not self.session:
            return {"ok": True, "active": False}
        self._emit_session_started()
        return {"ok": True, "active": True, "project": self.session["project"]}

    def clear_chat(self):
        """Start a FRESH conversation for the same workspace: reset the message
        history, transcript and per-task counters, and wipe the saved conversation
        — but DO NOT touch memory summaries, the plan, or any files on disk."""
        if not self.session:
            return {"ok": False, "error": "No active session."}
        with self._lock:
            if self._busy:
                return {"ok": False, "error": "Agent is working. Stop it before clearing the chat."}
        s = self.session
        s["messages"] = [{"role": "system", "content": s["base_system_prompt"]}]
        s["transcript"] = []
        s["original_task"] = None
        s["last_tool_call"] = None
        s["step_count"] = 0
        s["consecutive_tools"] = 0
        s["summary_resets"] = 0
        s["tools_since_plan_touch"] = 0
        s["_plan_touch_nudge_sent"] = False
        s["reads_since_nav"] = 0
        s["graph_nudges_sent"] = 0
        s["_nudge_sent"] = False
        s["plan_gate_retries"] = 0
        # A fresh chat only needs a new plan if there isn't an in-progress one.
        active_plan = planning.get_active_plan()
        s["needs_plan"] = active_plan is None or active_plan.is_complete()
        # Fold the (unchanged) live plan back into the fresh system prompt.
        self._refresh_system_prompt()
        self._persist_session()
        return {"ok": True}

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
        self.session["reads_since_nav"] = 0
        self.session["graph_nudges_sent"] = 0

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
        # Persist immediately so the user's message survives even if the app is
        # closed / crashes mid-generation.
        self._persist_session()
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

    def read_archive_member(self, rel_path, member):
        if not self.session:
            return {"ok": False, "error": "No active session."}
        return read_project_archive_member(self.session["project"], rel_path, member)

    def upload_files(self, dest_dir=""):
        """Opens a native multi-select file picker and copies the chosen host
        files into the current project's workspace (optionally into a subfolder
        dest_dir, relative to the project root). Returns the refreshed file tree
        so the frontend updates immediately. Existing files of the same name are
        overwritten (an upload of a newer copy)."""
        if not self.session:
            return {"ok": False, "error": "No active session."}
        if self._window is None:
            return {"ok": False, "error": "Window not ready."}

        # Resolve + sandbox the destination to inside the project root.
        project = self.session["project"]
        root = os.path.abspath(os.path.join(WORKSPACE_DIR, project))
        rel = (dest_dir or "").strip().lstrip("/").lstrip("\\").replace("\\", "/")
        dest_abs = os.path.abspath(os.path.join(root, *rel.split("/"))) if rel else root
        if dest_abs != root and not dest_abs.startswith(root + os.sep):
            return {"ok": False, "error": "Destination is outside the workspace."}

        try:
            result = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not result:
            return {"ok": True, "cancelled": True, "copied": [], "skipped": []}

        paths = list(result) if isinstance(result, (list, tuple)) else [result]
        try:
            os.makedirs(dest_abs, exist_ok=True)
        except OSError as e:
            return {"ok": False, "error": f"Could not create destination folder: {e}"}

        copied, skipped = [], []
        for src in paths:
            name = os.path.basename(src)
            try:
                if not os.path.isfile(src):
                    skipped.append({"name": name, "reason": "not a file"})
                    continue
                shutil.copy2(src, os.path.join(dest_abs, name))
                copied.append(f"{rel + '/' if rel else ''}{name}")
            except OSError as e:
                skipped.append({"name": name, "reason": str(e)})

        self._refresh_tree(force=True)
        return {"ok": True, "cancelled": False, "copied": copied, "skipped": skipped,
                "dest": rel or "(workspace root)", "tree": build_file_tree(project)}

    def get_code_graph(self, graph_id=None):
        """Reads a chunked code knowledge graph from the project workspace and
        returns vis-network-ready nodes/edges/legend for the frontend, plus the
        list of ALL built graphs so the UI can offer a per-version selector.

        Graphs are namespaced under .codegraph/<graph_id>/ (see _kg_indexer.py),
        so one workspace can hold several — e.g. two app versions built
        separately for a diff. `graph_id` picks which to render; without it the
        most recently built graph is shown. A legacy flat graph (built before
        namespacing) is still read, listed as '(default)'.
        """
        if not self.session:
            return {"ok": False, "error": "No active session."}
        project = self.session["project"]
        cg_root = os.path.join(WORKSPACE_DIR, project, ".codegraph")

        # Enumerate the available graphs (id -> directory + summary for the UI).
        dirs = {}
        graphs = []
        index = {}
        index_path = os.path.join(cg_root, "graphs.json")
        if os.path.isfile(index_path):
            try:
                with open(index_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    index = loaded
            except Exception:
                index = {}
        for gid, info in index.items():
            gdir = os.path.join(cg_root, gid)
            if os.path.isfile(os.path.join(gdir, "manifest.json")):
                info = info or {}
                dirs[gid] = gdir
                graphs.append({
                    "id": gid, "root": info.get("root", ""),
                    "classes": info.get("classes", 0), "methods": info.get("methods", 0),
                    "built_at": info.get("built_at", ""), "built_at_ts": info.get("built_at_ts", 0),
                })
        # Legacy flat graph (pre-namespacing): read in place, listed as "(default)".
        # Pull its real counts from meta.json so the selector/auto-pick can tell
        # whether it actually has nodes (a graphs.json index predates it).
        if not dirs and os.path.isfile(os.path.join(cg_root, "manifest.json")):
            dirs["(default)"] = cg_root
            legacy_meta = {}
            legacy_meta_path = os.path.join(cg_root, "meta.json")
            if os.path.isfile(legacy_meta_path):
                try:
                    with open(legacy_meta_path, "r", encoding="utf-8") as f:
                        legacy_meta = json.load(f)
                except Exception:
                    legacy_meta = {}
            graphs.append({
                "id": "(default)", "root": legacy_meta.get("root", ""),
                "classes": legacy_meta.get("classes", 0), "methods": legacy_meta.get("methods", 0),
                "built_at": legacy_meta.get("built_at", ""), "built_at_ts": legacy_meta.get("built_at_ts", 0),
            })

        if not dirs:
            return {"ok": False, "error": "No knowledge graph found. Ask the agent to run build_code_graph on a decompiled directory first."}

        graphs.sort(key=lambda g: g.get("built_at_ts", 0), reverse=True)
        # Honor an explicit pick; otherwise auto-select the most-recently-built graph
        # that actually HAS classes. Without this, an empty build (wrong dir, a
        # not-yet-decompiled folder, or a native-only .so index) — which still gets
        # registered in graphs.json — would shadow a good graph purely because it's
        # newer, leaving the Graph tab stuck on "no nodes". Fall back to the newest
        # graph only when every graph is empty.
        if graph_id and graph_id in dirs:
            chosen = graph_id
        else:
            non_empty = [g for g in graphs if g.get("classes", 0) > 0]
            chosen = (non_empty[0]["id"] if non_empty else graphs[0]["id"])
        graph_dir = dirs[chosen]

        try:
            manifest_path = os.path.join(graph_dir, "manifest.json")
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
            return {"ok": True, "graph": data, "graphs": graphs, "graph_id": chosen}
        except Exception as e:
            return {"ok": False, "error": f"Failed to read graph: {e}", "graphs": graphs, "graph_id": chosen}

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
        self._persist_session()
        planning.clear_active_plan(notify=False)
        planning.set_context(None, notify_callback=None)
        self.session = None
        self._emit({"type": "session_ended"})
        return {"ok": True}

    def exit_app(self):
        self._persist_session()
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

                # A malformed reply gets bounded correction retries. The failed
                # attempt stays in the message history so the model can see what
                # it did wrong (the old copy-list approach threw that away, so
                # every retry started from the same state that just failed).
                parse_retries = 0
                while response_type == "error" and parse_retries < MAX_PARSE_RETRIES and not self._stop:
                    parse_retries += 1
                    self._emit({"type": "system",
                                "content": f"Response was not valid JSON — retrying ({parse_retries}/{MAX_PARSE_RETRIES})..."})
                    s["messages"].append({"role": "assistant", "content": raw_response})
                    s["messages"].append({"role": "user",
                                          "content": "Your last response was not valid JSON. You MUST respond with a raw JSON object only — no markdown, no prose. Use {\"type\": \"tool_call\", \"tool\": \"<name>\", \"args\": { ... }} or {\"type\": \"final_answer\", \"content\": \"...\"}."})
                    self._emit({"type": "thinking_start"})
                    start_time = time.time()
                    raw_response = ask_llm(s["messages"])
                    elapsed_ms += int((time.time() - start_time) * 1000)
                    self._emit({"type": "thinking_end", "elapsed_ms": elapsed_ms})
                    response_type, payload = parse_response(raw_response)

                s["messages"].append({"role": "assistant", "content": raw_response})

                # Extract the pre-JSON "thought" text the model emits.
                start_idx = raw_response.find("{")
                thought_process = raw_response[:start_idx].strip() if start_idx != -1 else raw_response.strip()
                time_str = _fmt_elapsed(elapsed_ms)

                self._emit({"type": "thought", "time": time_str, "elapsed_ms": elapsed_ms,
                            "text": _ui_trunc(thought_process, UI_THOUGHT_CAP),
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

                    # Code-graph guard: catch the "sweeping files one by one"
                    # anti-pattern. Any navigation tool (graph query or content
                    # search) resets the counter; a long run of pure
                    # read_file_chunk with no navigation triggers a bounded nudge
                    # toward build_code_graph / query_code_graph / grep_directory.
                    if tool_name in NAVIGATION_TOOLS:
                        s["reads_since_nav"] = 0
                    elif tool_name == "read_file_chunk":
                        s["reads_since_nav"] = s.get("reads_since_nav", 0) + 1
                        if (s["reads_since_nav"] >= GRAPH_NUDGE_THRESHOLD
                                and s.get("graph_nudges_sent", 0) < MAX_GRAPH_NUDGES):
                            s["reads_since_nav"] = 0
                            s["graph_nudges_sent"] = s.get("graph_nudges_sent", 0) + 1
                            self._emit({"type": "system", "content": (
                                "SYSTEM GUARD: many files read one-by-one without using the code "
                                "graph — steering to build_code_graph / query_code_graph.")})
                            s["messages"].append({"role": "user", "content": (
                                "[SYSTEM] You've read many files individually without building or "
                                "querying the code graph or running a search. On a decompiled app this "
                                "exhausts context fast and is the wrong approach. STOP reading files one "
                                "by one and NAVIGATE instead: for smali, call build_code_graph once, then "
                                "query_code_graph (string_refs / callers / callees / class / hierarchy) "
                                "to jump straight to the exact file:line you need; to search any tree "
                                "(smali, Java, XML, assets) use grep_directory / search_smali / find_files. "
                                "Then read_file_chunk ONLY the specific slice those point you to. If you "
                                "genuinely have a reason to keep reading these particular files, continue."
                            )})

                    # NOTE: the raw tool output is deliberately NOT sent to the UI
                    # — the chat shows only the action, never its output (the full
                    # output stays in the agent's own message context below). This
                    # is also what keeps the webview from OOMing on long runs.
                    self._emit({"type": "tool_result",
                                "id": tool_id,
                                "tool": tool_name,
                                "args": tool_args,
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
                    # Still malformed after the retries. The reply usually
                    # contains a usable prose answer — surface it instead of
                    # silently killing the run.
                    s["step_count"] += 1
                    s["last_tool_call"] = None
                    salvage = strip_reasoning(raw_response)
                    if salvage:
                        self._emit({"type": "system",
                                    "content": "Model kept replying outside the JSON protocol — showing its reply as-is. You can tell it to continue."})
                        self._emit({"type": "final_answer",
                                    "content": salvage,
                                    "steps": s["step_count"],
                                    "time": time_str})
                    else:
                        self._emit({"type": "system", "content": f"Parse error: {payload}"})
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
            self._refresh_tree(force=True)  # push the final tree state once, at the end
            # Save the conversation + transcript so a refresh / restart can
            # restore this chat and continue from here.
            self._persist_session()
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
