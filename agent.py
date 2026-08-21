import os
import re
import shlex
import sys
import base64
import binascii
import datetime
import json
import glob
import time
import threading
import uuid
import shutil
import hashlib
import zipfile
import subprocess
import webview

# On Windows the default console/file encoding is cp1252, which can't handle
# Unicode characters the LLM emits (arrows, checkmarks, em-dashes, etc.).
# Force UTF-8 on stdout/stderr so print() and console output never crash.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")


import llm
from llm import (
    ask_llm,
    get_full_system_prompt,
    get_static_system_prompt,
    render_tools_section,
    list_providers,
    get_effective_config,
    get_effective_configs,
    save_config,
    save_configs,
    set_fallback_notifier,
    set_active_provider_notifier,
    get_active_provider,
    active_supports_native_tools,
    native_tools_payload_chars,
    get_preferred_model,
    set_preferred_model,
    set_model_effort,
    list_model_options,
    set_stop_check,
    test_connection,
    extract_json_action,
    strip_reasoning,
    get_context_window,
    take_last_usage,
    reset_salvage_stats,
    SALVAGE_STATS,
)
from host_exec import (
    set_workspace,
    set_timeout_decider,
    set_stop_check as set_exec_stop_check,
    run_cmd,
)
import devices
from tool_registry import registry, CORE_GROUP
import planning
import investigation
import ledger
import strategy
import superpowers
import tools  # Triggers the __init__.py which loads all tool categories
from tools.reviewer import run_review, run_strategy_review
from tools import mission_constraints
from tools.output_distillers import NOISY_TOOLS, distill as distill_output
import subagents  # generalized isolated-context subagent engine
import plugins     # Claude-Code-style plugin system (agents/skills/commands/hooks)

MEMORY_DIR = "./memory"

# --- Workspace selection (Part 2 redesign) -----------------------------------
# There is NO fixed workspace folder any more. The user PICKS a host folder at
# runtime (native folder dialog); that folder IS the project root (no
# project-subfolder layer) and is the working directory every tool command runs in. The last-used pick is persisted so it's the default next launch, but
# the user can always re-pick. Conversation/memory is kept OUTSIDE the picked
# folder, under MEMORY_DIR keyed by the folder's absolute path.
_WS_SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "agent_workspaces.json")
_active_workspace = None  # abspath of the currently selected folder, or None


def _load_ws_settings():
    try:
        with open(_WS_SETTINGS_PATH, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_ws_settings(d):
    try:
        with open(_WS_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
    except OSError as e:
        print(f"[WARNING] Could not persist workspace settings: {e}")


def _ws_label(path):
    return os.path.basename(os.path.normpath(path)) or path


def set_active_workspace(path):
    """Make `path` the active workspace root and persist it as last-used + in
    the recent list. Returns its abspath."""
    global _active_workspace
    ap = os.path.abspath(path)
    _active_workspace = ap
    s = _load_ws_settings()
    s["last"] = ap
    recent = [r for r in s.get("recent", [])
              if isinstance(r, dict) and r.get("path") != ap]
    # opened_at drives the "2 hours ago" column in the workspace picker. Entries
    # written before this field existed simply have no timestamp; the picker
    # renders those as "—" rather than pretending they were opened just now.
    recent.insert(0, {"label": _ws_label(ap), "path": ap, "opened_at": time.time()})
    s["recent"] = recent[:12]
    _save_ws_settings(s)
    return ap


def active_workspace():
    """The active workspace root (abspath). On a fresh process, falls back to
    the persisted last-used folder if it still exists. Raises RuntimeError if
    nothing has ever been picked (the caller surfaces 'pick a folder first')."""
    global _active_workspace
    if _active_workspace:
        return _active_workspace
    last = _load_ws_settings().get("last")
    if last and os.path.isdir(last):
        _active_workspace = os.path.abspath(last)
        return _active_workspace
    raise RuntimeError("No workspace selected yet — pick a folder first.")


def _project_root(project=None):
    """Absolute host root of the active project. The PICKED FOLDER IS THE ROOT
    (no project-subfolder layer). `project` is accepted for call-site
    compatibility but ignored — there is one active picked folder."""
    return active_workspace()


def _memory_dir_for(root):
    """Per-folder conversation/memory dir, kept OUTSIDE the picked folder and
    keyed by its absolute path so two same-named folders never collide."""
    ap = os.path.abspath(root)
    key = _ws_label(ap) + "-" + hashlib.md5(ap.encode("utf-8")).hexdigest()[:8]
    return os.path.join(MEMORY_DIR, key)
MAX_STEPS_BEFORE_SUMMARY = 500
# --- Context-window management -----------------------------------------------
# Token usage is monitored against the ACTIVE model's context window (from
# llm.get_context_window()). When estimated usage reaches CONTEXT_WINDOW_FRACTION
# of that window, the loop auto-summarizes the whole history into a compact
# bullet-point summary and continues — so an overnight run never overflows/crashes.
CHARS_PER_TOKEN = 4                 # rough heuristic (providers don't stream token counts here)
CONTEXT_WINDOW_FRACTION = 0.8       # summarize once we hit 80% of the window
# Legacy absolute-char fallback, still honored as an upper safety bound in case a
# model reports an absurdly large window. 3.2M chars ~= 800k tokens.
CONTEXT_CHAR_LIMIT = 3_200_000

# --- Long-run context editing (tool-result eviction) -------------------------
# A multi-day run accumulates hundreds of verbose "TOOL RESULT:" messages that
# stay in the history until the (rare) full compaction fires. Most of their value
# has already been distilled into the plan + investigation memory (which survive),
# so old raw results are pure dead weight. We keep the most-recent
# TOOL_RESULT_KEEP_RECENT results verbatim (the model's active working set) and
# collapse older, large ones to a short stub — Anthropic-style "context editing".
# This bounds tool-result context to ~KEEP_RECENT × 8000 chars instead of growing
# without limit, so overnight runs stay lean and cheap between summaries.
TOOL_RESULT_KEEP_RECENT = 14        # most-recent tool results kept in full
TOOL_RESULT_STUB_OVER = 1200        # only elide results longer than this
TOOL_RESULT_STUB_HEAD = 220         # chars of the original kept in the stub

# --- Workflow launch (UI-initiated) -------------------------------------------
# A user-launched workflow's result goes back into the conversation so the model
# can act on it. This follows the existing TOOL RESULT convention (user-role
# messages carrying tool output), rather than inventing a new channel.
WORKFLOW_RESULT_PREFIX = "WORKFLOW RESULT"
# An exhaustive-audit result can be enormous. Capping it protects exactly the
# context budget the workflow engine exists to protect; the run id is the
# pointer to the full record.
WORKFLOW_RESULT_CAP = 4000

# --- Tool budget / loop protection -------------------------------------------
# No soft "you've run too many tools" nudge: multi-day runs make hundreds of
# back-to-back tool calls normal. MAX_CONSECUTIVE_TOOLS only triggers silent
# memory compaction (it never asks the model to stop).
MAX_CONSECUTIVE_TOOLS = 400
MAX_SUMMARY_RESETS = 8
LOOP_REPEAT_THRESHOLD = 3
# How many corrective re-asks a malformed (non-JSON) LLM reply gets in one turn
# before the loop moves on WITHOUT terminating (it keeps re-prompting on the next
# turn — a parse failure never ends the session).
MAX_PARSE_RETRIES = 3
# Incremental conversation persistence: the agent loop saves the chat at most
# this often (seconds) DURING a run, not only when the loop ends. Without this a
# hard interrupt / crash / kill mid-run loses every assistant+tool turn since the
# last send_message (plan/investigation persist per-update and survive; the chat
# must too). Throttled so rapid tool calls don't rewrite the ~100KB+ file every turn.
PERSIST_MIN_INTERVAL_S = 15
# Watchdog: if the SAME tool fails this many times in a row, force the agent to
# switch strategy instead of blindly retrying the same failing command.
WATCHDOG_FAIL_THRESHOLD = 5
# --- Long-running command timeout decisions ----------------------------------
# When a tool command outruns its timeout we don't kill it outright — the LLM
# is asked whether it's stuck (kill) or a slow-but-progressing job (keep going).
# See AgentApi._decide_on_timeout.
TIMEOUT_EXTEND_CAP = 3600            # max seconds granted per "continue" decision
# If the model gives no clear kill/continue answer this many times in a row for
# the SAME command, stop waiting — prevents a hung/confused model from pinning a
# process open forever while still honoring "don't kill immediately".
AMBIGUOUS_TIMEOUT_KILL_STREAK = 3
TIMEOUT_DECIDER_SYSTEM = (
    "You supervise long-running commands for an autonomous reverse-engineering agent. "
    "Some commands (large builds, decompilation, static analysis, code-graph indexing) "
    "legitimately take many minutes and are NOT stuck. Given a command that is still "
    "running past its timeout, decide whether to keep waiting or stop it. Reply with a "
    "single raw JSON object only — no prose, no markdown."
)
# The exact corrective message appended to the history on a JSON parse failure.
# ONE consistent schema — do not introduce alias keys here (that confused models
# further). Also forbids the <tool_call> tag shape that GLM/harmony models emit.
JSON_CORRECTION_MSG = (
    "Your last message was not a valid action. Respond with EXACTLY ONE raw JSON "
    "object and nothing else — no markdown, no code fences, no prose, and do NOT "
    "use <tool_call> or <function> tags. "
    'For a tool call: {"type": "tool_call", "tool": "<name>", "args": { ... }}. '
    'For the final answer: {"type": "final_answer", "content": "<text>"}.'
)

# --- Chat persistence + UI memory safety -------------------------------------
# The full conversation (LLM messages) and a replayable UI transcript are saved
# per project so the chat survives a webview refresh, a renderer crash, or a full
# app restart — and the agent can continue from where it left off.
CONVERSATION_FILENAME = "conversation.json"
TRANSCRIPT_FILENAME = "transcript.json"
# A context reset writes a single HANDOFF.md to the WORKSPACE ROOT (a real,
# visible project file — the mounted folder) capturing everything needed to
# resume. Repeated resets UPDATE this one file rather than piling up summaries.
HANDOFF_FILENAME = "HANDOFF.md"
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

# Subagent-dock lifecycle events. These are NOT chat transcript events (they drive
# the Subagents sidebar, not the message list), so they're captured into a separate
# compact snapshot (session["dock"]) that is persisted and replayed on reopen — so
# the Subagents menu doesn't vanish on a refresh.
DOCK_EVENT_TYPES = {"wave_started", "subagent_started", "subagent_progress",
                    "subagent_done", "wave_done"}
DOCK_MAX_ROWS = 24           # cap restored rows so a long multi-wave run stays bounded


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

# --- Skill guard -------------------------------------------------------------
# Skills (apk-modding, ssl-pinning-bypass, signature-bypass, ...) are the
# battle-tested workflows under ./skills/ — they encode the exact tool order and
# the pitfalls to avoid. The model can otherwise plow through an entire APK / RE
# task improvising the workflow and never load the ONE skill that matches (the
# "hundreds of tool calls, no skill check" anti-pattern). This guard fires when
# enough hands-on domain work has happened with no skill consulted, steering the
# model to use_skill. Like every guard here it only NUDGES — work is never
# blocked — and it's bounded so it can't spam, and disarms once a skill is loaded.
SKILL_NUDGE_THRESHOLD = 8
# Bounded per task. Raised from 2 because the guard no longer latches OFF after the
# first skill load — it re-arms so a long run that drifts into a different sub-task
# (e.g. apk-modding -> anti-debug-bypass) gets steered to the SPECIFIC skill too,
# not just once at the very start. Still capped so it can never nag.
MAX_SKILL_NUDGES = 3
# Anti-rabbit-hole: how many times per task the assumption gate may nudge toward
# observing the current build before an expensive native patch. Kept tiny (the
# lesson only needs saying once) so it can never nag.
MAX_ASSUMPTION_NUDGES = 1
# Tools representing hands-on APK / reverse-engineering work a skill would guide.
# Calling these without having consulted a skill advances the skill-nudge counter.
SKILL_DOMAIN_TOOLS = {
    "decode_apk", "jadx_decompile", "unzip_apk", "recompile_apk",
    "search_smali", "search_java", "patch_smali_method", "insert_smali_code",
    "disassemble_dex", "assemble_dex", "replace_file_in_apk",
    "get_apk_signature_hash", "patch_bytes_at_offset", "patch_at_offset_with_bytes",
    "nop_function", "patch_function_return", "disassemble_range", "ghidra_decompile",
    # Emulator / on-device work — a run of these with no skill loaded should
    # steer to emulator-management (login/cookie/place-id/lifecycle) or
    # emulator-testing (observe/report), which encode the exact flows + gotchas.
    "ensure_emulator_running", "install_apk_on_emulator", "launch_app_on_emulator",
    "run_apk_test_session", "play_roblox",
}
# The skill-discovery/loading tools. Using any resets the counter and (for
# use_skill) disarms further nudges for the run.
SKILL_TOOLS = {"list_skills", "use_skill", "read_skill_resource"}

# --- Plan-and-execute workflow -----------------------------------------------
# Tools allowed to run BEFORE a plan exists for the current task (creating or
# just inspecting a plan doesn't need one to already exist).
PLAN_TOOL_NAMES = {"plan_create", "plan_view"}
# If this many tool calls happen in a row without touching the plan (add/update/
# reorder), nudge the model to keep it synchronized rather than silently
# working ahead of it.
PLAN_TOUCH_NUDGE = 8

# --- Adaptive planning loop policy -------------------------------------------
# Whether the adaptive-planning gate (orientation window, plan-outcome gate on
# final answers, replan-required after the watchdog trips) is on for new
# sessions. When off, the loop keeps its simpler "plan before any tool" behavior.
ADAPTIVE_PLANNING_DEFAULT = True
# INSPECT FREELY, PLAN WHEN READY (2026-07 planning-gate redesign).
# Before a plan exists the agent may run ANY non-mutating tool, with NO cap — it
# analyzes the workspace as much as it needs and only plans once it actually
# understands the task. The ONLY plan gate is a single soft nudge on the FIRST
# mutating action taken with no plan (see _run_agent_loop); the plan is never
# force-created and never silently disabled. This replaces the old bounded
# ORIENTATION_TOOLS whitelist + ORIENTATION_MAX_STEPS cap, which forced a plan
# after 6 reads and then abandoned planning entirely after a few nudges — exactly
# the "forces a plan / disables the plan" behavior we're removing.
#
# Bound on how many times a premature final answer (active plan not concluded) is
# nudged before it's accepted anyway, so the gate can never deadlock the run.
MAX_FINAL_PLAN_NUDGES = 3

# --- GSD context-hygiene: re-grounding against context rot -------------------
# On a run that spans thousands of steps and many summaries, the model's attention
# to the original goal degrades ("context rot") even below the token limit. Every
# REGROUND_EVERY tool calls (and on every phase advance) we inject a compact
# SITUATION block — goal + current phase + next action + recent findings + open
# questions, all pulled from the DURABLE plan/investigation state — so the early
# instructions are periodically re-anchored. This complements evict_old_tool_results
# (which trims stale bulk) and fresh-context delegation (which keeps sub-tasks off
# the main context). Gated by the session `context_hygiene` flag.
REGROUND_EVERY = 25

# A plugin on_final_answer hook may send the answer back for more work (e.g. a
# verification plugin that demands an objective check before "done"). Bounded so a
# stuck hook can never deadlock the finish — after this many plugin nudges the answer
# proceeds to the normal review gate regardless.
MAX_FINAL_HOOK_NUDGES = 2

# Explanation cadence: if this many tool calls run WITHOUT the model narrating a
# new sub-process (an "explanation"), inject a [SYSTEM] nudge so it introduces the
# work it's doing now. This is the middle-ground guardrail — it stops long silent
# stretches of 10-15 bare tool calls without forcing an explanation on every call
# (a sub-process is ~2-6 related calls, so a value in that range keeps roughly one
# explanation per sub-process). Unlike the graph nudge it re-fires every N silent
# calls for the whole run, since the goal is a steady cadence, not a one-off hint.
EXPLANATION_CADENCE_NUDGE = 6

# Read-only tool calls the ORCHESTRATOR may run inline before it's reminded that
# those are exactly what a parallel subagent wave does for ~0 context. Bounded and
# self-re-arming (see _maybe_nudge_delegation); 0 disables the nudge entirely.
# Default matches EXPLANATION_CADENCE_NUDGE (6) — a sub-process is ~2-6 calls, so a
# streak past that many pure look-ups is a fan-out the model has clearly not taken.
# Was 8; lowered to catch chronic solo-reading a step sooner.
try:
    SOLO_READ_NUDGE = max(0, int(os.environ.get("OMNI_SOLO_READ_NUDGE", "6")))
except ValueError:
    SOLO_READ_NUDGE = 6

# Soft per-session ceiling on PREMIUM subagent dispatches. Advisory: over-budget
# @premium requests degrade to standard rather than being blocked. 0 = unlimited.
try:
    PREMIUM_BUDGET = max(0, int(os.environ.get("OMNI_PREMIUM_BUDGET", "5")))
except ValueError:
    PREMIUM_BUDGET = 5

# Tools that MEAN the model delegated — they reset the solo-read streak.
DELEGATION_TOOLS = {"dispatch_agents", "ask_codebase"}

# --- Auto-delegation ---------------------------------------------------------
# Nudges alone measurably under-deliver: an observed 300-step run produced only
# TWO subagents, because an advisory line is easy to read past. So the harness
# also TAGS obviously-delegatable plan steps itself. It only ever touches steps
# that are pending, unblocked and carry no `delegate` of their own — the model
# can always retag or clear one, and every auto-tag is announced in the chat.
#   * a wave of independent RESEARCH steps -> researcher (cheap): they fan out.
#   * a self-contained CHANGE step         -> implementer (standard). Writes
#     still SERIALIZE on the workspace lock (two agents editing one decompiled
#     tree corrupts it) — the win there is isolated context + a cheaper model,
#     not speed.
# Set OMNI_AUTO_DELEGATE=0 to turn the whole behaviour off and go back to
# advisory-only nudges.
AUTO_DELEGATE = (os.environ.get("OMNI_AUTO_DELEGATE", "1").strip().lower()
                 not in ("0", "false", "no", "off"))
# Independent research steps needed before a wave is auto-tagged. One lone
# lookup is not a wave, and hijacking it would just annoy; two is a real fan-out.
AUTO_DELEGATE_READ_MIN = 2
AUTO_DELEGATE_READ_TAG = "researcher@cheap"
AUTO_DELEGATE_WRITE_TAG = "implementer@standard"

# Narration throttle (the OTHER side of the cadence): a narration line is only
# surfaced when SWITCHING to a new sub-process AND at least this many tool calls
# have run since the last line — so the chat shows one line per sub-process, not
# text on every step or call. The first narration of a task always shows. Together
# with EXPLANATION_CADENCE_NUDGE this pins narration to a comfortable middle: no
# more often than every NARRATION_MIN_GAP calls, no rarer than EXPLANATION_CADENCE_NUDGE.
NARRATION_MIN_GAP = 3

# --- Evidence-based / planner-worker-reviewer workflow -----------------------
# Lower sampling randomness for the main (technical) loop than ask_llm's 0.7
# default — steadier tool use and fewer malformed actions. A per-provider
# temperature set in llm_config.json still overrides this (see _openai_request);
# providers that ignore sampling (Anthropic, reasoning models) are unaffected.
MAIN_LOOP_TEMPERATURE = 0.15

# Review gate: when the worker emits a final_answer, an INDEPENDENT reviewer
# (tools/reviewer.run_review — separate isolated context, same model/key) checks
# it for unsupported claims, contradictions and incomplete work BEFORE it's
# accepted. On "revise" the loop injects the reviewer's feedback and continues
# instead of finishing. Bounded so it can never deadlock the run.
REVIEW_ENABLED_DEFAULT = True
MAX_REVIEW_ROUNDS = 2          # after this many revise rounds, accept and finish
REVIEW_MAX_STEPS = 8           # verification tool calls the reviewer may make

# Strategic Brief: a synthesized, pinned, adversarially-reviewed thesis that shapes
# decisions. Behind strategy_brief_enabled; OFF is byte-identical to today.
STRATEGY_BRIEF_DEFAULT = True
MAX_STRATEGY_REVIEW_ROUNDS = 2   # revise rounds before the gate forces a mutation through
STRATEGY_RESYNC_FINDINGS = 5     # new findings before nudging a brief reconcile

# Superpowers Mode: on a NON-TRIVIAL new task, auto-brainstorm the goal into a
# chosen approach (autonomously — never asks the user) BEFORE planning, then make
# subagent-driven execution the DEFAULT (unless the user clearly asked for inline).
# Behind superpowers_enabled; OFF (OMNI_SUPERPOWERS=0) is byte-identical to today.
SUPERPOWERS_DEFAULT = (os.environ.get("OMNI_SUPERPOWERS", "1").strip().lower()
                       not in ("0", "false", "no", "off"))
# The persona the auto-brainstorm dispatches (must exist on disk / in a plugin).
SUPERPOWERS_BRAINSTORMER = "brainstormer"
SUPERPOWERS_ARCHITECT = "architect"
SUPERPOWERS_BRAINSTORM_MAX_STEPS = 12

# The workspace-mutation classification (MUTATING_TOOLS / VALIDATION_TOOLS) now
# lives in tool_policy.py — the single source of truth shared with subagents.py
# and the planning gate. Re-exported here so every existing reference in this
# module (validation gate, planning gate) is unchanged.
from tool_policy import (
    MUTATING_TOOLS, VALIDATION_TOOLS,
    NATIVE_SPECULATION_TOOLS, OBSERVE_RUN_TOOLS,
    is_readonly_tool,
)
# Argument names, in priority order, that most likely name the file a mutating
# tool touched — used to auto-record a "modified file" into investigation memory.
_PATH_ARG_KEYS = ("path", "file_path", "so_path", "smali_path", "dex_path",
                  "apk_path", "file", "target", "output", "out_path", "dst",
                  "dest", "destination", "class_name")


def _split_delegate(raw):
    """Split a plan step's delegate tag into (agent_name, tier).

    'researcher@cheap' -> ('researcher', 'cheap'); a bare 'researcher' ->
    ('researcher', None), meaning the persona's own default tier applies. The
    tier rides inside the existing string field so no new plan-step column has
    to be threaded through planning.py and plan_tools.py."""
    name, _, tier = (raw or "").strip().partition("@")
    return name.strip(), (tier.strip().lower() or None)


# Wording that reads as INVESTIGATION (a read-only subagent could own it end to
# end) vs. wording that reads as a CHANGE (a write-capable subagent's job). These
# drive the delegation nudges AND auto-delegation, so a false positive costs a
# misrouted subagent — recoverable (the model retags), but not free. Both sides
# match on WORD BOUNDARIES; see _looks_like_research for why that matters.
_RESEARCH_HINTS = ("find", "locate", "identify", "investigate", "research", "map ",
                   "search", "inspect", "analyze", "analyse", "where", "which",
                   "how does", "determine", "audit", "survey", "trace", "enumerate")
_CHANGE_HINTS = ("patch", "edit", "rebuild", "build", "sign", "install", "write",
                 "modify", "implement", "fix ", "remove", "replace")
# Wording that reads as an ORCHESTRATOR JUDGMENT CALL — deciding between
# approaches, choosing a strategy, weighing trade-offs. These must never be
# auto-delegated: handing "decide which bypass to use" to a cheap researcher
# offloads exactly the reasoning the main agent is supposed to keep. A nudge is
# fine (the model can still choose to delegate), but the harness won't do it.
_JUDGMENT_HINTS = ("decide", "choose", "which approach", "strategy", "trade-off",
                   "tradeoff", "weigh", "evaluate whether", "assess whether",
                   "recommend", "prioritize", "prioritise")


def _ordinal_suffix(n):
    """'st'/'nd'/'rd'/'th' for a positive int, handling the 11-13 exception
    (11th/12th/13th, not 11st). Used in the escalating nudge wording, which
    reaches counts like 21 in a long run (21st, not 21th)."""
    if 10 <= (n % 100) <= 20:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def _step_text(item):
    """The wording of a plan step, for the research/change heuristics."""
    return " ".join(str(item.get(k) or "")
                    for k in ("content", "action", "purpose")).lower()


def _hits_hints(text, hints):
    """True if any hint appears in `text` as a WHOLE WORD. A plain `in` check
    would have "sign" (a change hint) false-hit inside "signature", misreading
    "locate the signature check" as a change."""
    return any(re.search(r"\b" + re.escape(h.strip()) + r"\b", text) for h in hints)


def _looks_like_research(item):
    """True when a plan step reads as an investigation rather than a change.
    CHANGE wording wins: a step that both investigates and edits is a change."""
    text = _step_text(item)
    if _hits_hints(text, _CHANGE_HINTS):
        return False
    return _hits_hints(text, _RESEARCH_HINTS)


def _looks_like_change(item):
    """True when a plan step reads as an edit/build/install rather than a lookup.
    The inverse gate to _looks_like_research — used to route a self-contained
    change step to a WRITE subagent instead of a read-only researcher."""
    return _hits_hints(_step_text(item), _CHANGE_HINTS)


def _is_clear_change(item):
    """A change step SAFE to auto-route to a write subagent: it uses change
    wording AND carries no investigation lead verb. Several change hints are
    ordinary words ("build", "sign", "fix") that also appear in research steps —
    "investigate how the release build signs the apk" is a lookup, not an edit.
    Requiring the absence of a research verb keeps those with the main agent
    (they end up in neither auto pool) rather than handing a read task to a
    workspace-lock-holding implementer at the standard tier."""
    text = _step_text(item)
    return _hits_hints(text, _CHANGE_HINTS) and not _hits_hints(text, _RESEARCH_HINTS)


def _is_self_contained(item):
    """True when a step carries enough spec for a subagent to own it end to end:
    an explicit action or a "done when" check. Auto-delegating a one-line stub
    with no success criterion just moves the ambiguity into an isolated context
    where the orchestrator can't see it, so those stay with the main loop."""
    return bool((item.get("action") or "").strip()
                or (item.get("verification") or "").strip()
                or (item.get("expected") or "").strip())


def _best_path_arg(args):
    """Best-effort: the most path-like value among a tool call's args, for
    recording which file a mutating tool changed. Empty string if none found."""
    if not isinstance(args, dict):
        return ""
    for k in _PATH_ARG_KEYS:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


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


def estimate_tokens(messages):
    """Rough token estimate for the whole message list (chars / CHARS_PER_TOKEN)."""
    return estimate_context_chars(messages) // CHARS_PER_TOKEN


def session_context_chars(session):
    """Total request size (chars) for THIS session: the message list PLUS the
    native function-calling `tools=` array, which ask_llm sends out of band and
    the message list never carries. Without this, the header and summarize-guard
    undercount native-mode context by the whole tool-schema payload (tens of
    thousands of tokens). Reduces to estimate_context_chars when not native."""
    chars = estimate_context_chars(session.get("messages", []))
    try:
        chars += native_tools_payload_chars(session.get("active_toolsets"))
    except Exception:
        pass
    return chars


def session_context_tokens(session):
    """Rough token estimate for the whole session request (chars / CHARS_PER_TOKEN)."""
    return session_context_chars(session) // CHARS_PER_TOKEN


def context_token_budget():
    """The token count at which the loop must summarize: CONTEXT_WINDOW_FRACTION of
    the ACTIVE model's context window (read live so a UI/model change takes effect)."""
    try:
        window = int(get_context_window())
    except Exception:
        window = 1_000_000
    return int(window * CONTEXT_WINDOW_FRACTION)


def context_pressure(messages, extra_chars=0):
    """True when estimated usage has reached the summarize threshold — either the
    80%-of-window token budget or the absolute char safety bound. `extra_chars`
    folds in out-of-band request bytes (the native `tools=` array) so the guard
    fires on the REAL request size, not just the message list."""
    total_chars = estimate_context_chars(messages) + extra_chars
    return (total_chars // CHARS_PER_TOKEN >= context_token_budget()
            or total_chars > CONTEXT_CHAR_LIMIT)


def _is_tool_result_msg(m):
    return (m.get("role") == "user"
            and isinstance(m.get("content"), str)
            and m["content"].startswith("TOOL RESULT"))


def evict_old_tool_results(messages, keep_recent=TOOL_RESULT_KEEP_RECENT,
                           stub_over=TOOL_RESULT_STUB_OVER, head=TOOL_RESULT_STUB_HEAD):
    """Context editing for long runs: collapse large, OLD tool-result messages to a
    short stub, keeping the most-recent `keep_recent` results verbatim.

    Safe because the durable state the agent is told to maintain — the plan and the
    evidence-first investigation memory — is folded into the system prompt and is
    NOT touched here; only stale raw tool output (already superseded by recorded
    findings) is trimmed. Idempotent: an already-stubbed message is skipped, and a
    result shorter than `stub_over` is left alone. Returns the number of messages
    newly elided (0 if nothing changed) and mutates `messages` in place."""
    idxs = [i for i, m in enumerate(messages) if _is_tool_result_msg(m)]
    if len(idxs) <= keep_recent:
        return 0
    elided = 0
    for i in idxs[:-keep_recent]:
        c = messages[i]["content"]
        if len(c) <= stub_over or c.startswith("TOOL RESULT [elided"):
            continue
        snippet = c[:head].replace("\n", " ").rstrip()
        messages[i]["content"] = (
            "TOOL RESULT [elided to save context — was %d chars; recorded findings, "
            "plan and investigation memory retain what mattered]: %s…" % (len(c), snippet))
        elided += 1
    return elided


def _tool_result_failed(result):
    """True when a tool result signals a real failure the agent should not just
    blindly retry — an explicit error dict, or a non-zero exit whose only output
    is on stderr. A non-matching search (grep exit 1 with a normal stdout body) is
    NOT treated as a failure."""
    if not isinstance(result, dict):
        return False
    if result.get("error"):
        return True
    rc = result.get("returncode")
    if isinstance(rc, int) and rc != 0:
        has_out = bool((result.get("stdout") or "").strip())
        has_err = bool((result.get("stderr") or "").strip())
        if has_err and not has_out:
            return True
    return False


# The exact section layout of HANDOFF.md — the model is asked to fill these and
# nothing else, so a resumed run always finds the same shape. "Files in flight"
# is deliberately a sub-section (###) under "Current state".
HANDOFF_TEMPLATE_SPEC = (
    "# Goal\n(what we're trying to build — the user's objective, quoted if possible)\n\n"
    "## Current state\n(where the work stands right now)\n\n"
    "### Files in flight\n(the active files being modified right now — exact paths)\n\n"
    "## Changed\n(what's been touched this session — files created/edited/patched, with exact paths)\n\n"
    "## Failed attempts\n(what didn't work and why — so we don't repeat it)\n\n"
    "## Next step\n(the SINGLE next thing to try)\n"
)


def _handoff_path(root, memory_dir):
    """Where HANDOFF.md lives: the workspace ROOT (a real, visible project file)
    when we have one, else the agent's memory dir as a fallback."""
    base = root if (root and os.path.isdir(root)) else memory_dir
    return os.path.join(base, HANDOFF_FILENAME)


def write_handoff(messages, root, memory_dir, original_task=None):
    """Ask the model to distill the whole conversation into a single HANDOFF.md
    (the sections in HANDOFF_TEMPLATE_SPEC) and write it to the workspace root,
    OVERWRITING any existing one — repeated resets update the same file, they
    never pile up. The live plan and investigation memory are handed in as source
    material (they survive the reset on their own, but the handoff should reflect
    them). Returns the handoff markdown text."""
    plan = planning.get_active_plan()
    inv = investigation.get_active()
    source = []
    if original_task:
        source.append(f"USER'S ORIGINAL TASK:\n{original_task}")
    if plan is not None:
        source.append("CURRENT PLAN:\n" + plan.to_markdown())
    if inv is not None and not inv.is_empty():
        source.append("INVESTIGATION MEMORY:\n" + inv.to_markdown())
    source_block = ("\n\n".join(source)) or "(no structured plan/investigation captured yet)"

    handoff_prompt = messages + [{
        "role": "user",
        "content": (
            "We are about to RESET the conversation context to free up room. Before we do, write a "
            "HANDOFF.md that a fresh session (with no memory of this chat) could pick up and continue "
            "from with zero loss of working state.\n\n"
            "Output MARKDOWN ONLY, using EXACTLY these headings in this order and nothing else "
            "(no preamble, no code fences):\n\n"
            + HANDOFF_TEMPLATE_SPEC +
            "\nRules:\n"
            "- Preserve ALL technical artifacts verbatim: exact file paths, class/method/symbol names, "
            "hex offsets/addresses, signature hashes, graph_ids, key command outputs, and error text.\n"
            "- 'Next step' must be ONE concrete, immediately-doable action.\n"
            "- Be truthful; do not invent progress. Keep it tight but complete.\n\n"
            "Use this structured state as your source of truth:\n\n" + source_block + "\n\n"
            'Respond with {"type": "final_answer", "content": "<the full HANDOFF.md markdown>"} only.'
        )
    }]

    raw = ask_llm(handoff_prompt)
    response_type, handoff_text = parse_response(raw)
    if response_type != "final_answer" or not str(handoff_text).strip():
        handoff_text = strip_reasoning(raw) or raw

    path = _handoff_path(root, memory_dir)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = f"<!-- Omni Agent handoff — updated {stamp} (overwritten on each context reset) -->\n\n{handoff_text.strip()}\n"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    except OSError as e:
        print(f"[WARNING] Could not write {path}: {e}")
    return handoff_text.strip()


def summarize_memory(messages, memory_dir, original_task=None, root=None):
    """Reset the conversation context by writing/refreshing HANDOFF.md and starting
    a fresh, compact message history that resumes from it.

    The active plan and the structured investigation memory are NOT rebuilt here —
    they live outside the message history (module-level singletons persisted to
    disk) and survive the reset untouched; the caller re-appends them to the fresh
    system prompt via AgentApi._refresh_system_prompt. HANDOFF.md is the
    human-readable, workspace-visible companion to that state.
    """
    if root is None:
        try:
            root = active_workspace()
        except RuntimeError:
            root = None

    handoff_text = write_handoff(messages, root, memory_dir, original_task)

    new_messages = [
        # STATIC prompt only — the caller's _refresh_system_prompt re-adds the
        # (progressive) tool section + live plan + investigation memory on top.
        {"role": "system", "content": get_static_system_prompt()},
        {"role": "assistant", "content": (
            "[CONTEXT RESET] The prior conversation was compacted into HANDOFF.md (also saved to the "
            "workspace). Resume from it:\n\n" + handoff_text)},
    ]
    if original_task:
        new_messages.append({"role": "user", "content": (
            "Continue the task from the HANDOFF above — do not restart from scratch. "
            "Original task: " + original_task)})
    return new_messages


def _default_opening_explanation(tool_name):
    """A friendly opener shown when the model gives the FIRST tool call of a task
    no "explanation" of its own, so every run visibly starts with a line to the
    user (per the EXPLAINING YOUR WORK contract) instead of a bare tool call.
    Later subtasks rely on the model's own explanations."""
    if tool_name == "plan_create":
        return "First, a quick plan to map this out."
    return "Okay, getting started."


def _subprocess_narration(payload):
    """The narration for a plan step being STARTED — the primary way the chat is
    split into subprocesses. When the model marks a step in_progress (via
    plan_update_task), that step's first-person 'explanation' (or, failing that,
    its description) becomes the chat line that opens a new action group. Returns
    "" when this tool_call isn't a step-start, so the loop falls back to the
    per-call explanation. An 'explanation' passed in the call args wins, so the
    model can set the narration in the very call that starts the step."""
    if not isinstance(payload, dict) or payload.get("tool") != "plan_update_task":
        return ""
    args = payload.get("args") or {}
    if str(args.get("status", "")).strip().lower() != "in_progress":
        return ""
    plan = planning.get_active_plan()
    if plan is None:
        return ""
    step = plan.find(args.get("task_id"))
    if not step:
        return str(args.get("explanation") or "").strip()
    return (str(args.get("explanation") or "").strip()
            or str(step.get("explanation") or "").strip()
            or str(step.get("content") or "").strip())


def parse_response(response_text):
    """Parses the LLM JSON response and returns a (type, payload) tuple."""
    data = extract_json_action(response_text or "")
    if data is None:
        return ("error", f"LLM returned non-JSON content: {(response_text or '')[:300]}")

    response_type = data.get("type")

    # The provider cut the response off at the output-token cap (llm marks it with
    # this sentinel). Non-terminal and recoverable — the loop re-prompts for a
    # smaller output instead of trying to parse a truncated fragment.
    if response_type == "truncated":
        return ("truncated", None)

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


def parse_timeout_decision(raw):
    """Parse the LLM's reply to a 'kill or keep waiting' timeout question.

    Returns ("kill", None), ("extend", seconds|None), or (None, None) when the
    reply is ambiguous. Tolerant of prose around the JSON and of a plain-English
    answer, since this is a side-channel question the model may not answer in
    strict protocol."""
    text = raw or ""
    obj = None
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(text[start:end + 1])
        except (ValueError, TypeError):
            obj = None

    if isinstance(obj, dict):
        decision = str(obj.get("decision", "")).lower()
        if "kill" in decision or "stop" in decision:
            return ("kill", None)
        if "cont" in decision or "wait" in decision or "extend" in decision or "keep" in decision:
            secs = obj.get("seconds", obj.get("s", obj.get("time")))
            try:
                secs = int(float(secs))
            except (TypeError, ValueError):
                secs = None
            return ("extend", secs)

    # Fallback: scan free text.
    low = text.lower()
    if "kill" in low or "stuck" in low or ("stop" in low and "continue" not in low):
        return ("kill", None)
    m = re.search(r"(?:continue|keep|wait|extend)[^0-9]{0,24}(\d+)", low)
    if m:
        return ("extend", int(m.group(1)))
    m = re.search(r"(\d+)\s*s(?:ec|econds)?\b", low)
    if m:
        return ("extend", int(m.group(1)))
    if "continue" in low or "keep going" in low or "not stuck" in low:
        return ("extend", None)
    return (None, None)


def execute_tool(tool_data, last_tool_call=None, repeat_threshold=LOOP_REPEAT_THRESHOLD,
                 return_result=False, run_dir=None, task_context=""):
    """Executes a tool from a parsed tool_call dict and returns a feedback string.

    When return_result=True, returns (feedback, result_dict) so the caller can
    inspect success/failure (result_dict is None for the loop-warning short-circuit,
    which didn't actually run the tool). Default single-string return is unchanged
    for existing callers/tests."""
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
                warn = (
                    "[SYSTEM WARNING] You have called '{tool}' with the same "
                    "arguments {n} times in a row. This looks like a loop. "
                    "Try different arguments, a different tool, or provide a "
                    "final_answer."
                ).format(tool=tool_name, n=repeats)
                return (warn, None) if return_result else warn

    result = registry.execute(tool_name, tool_args)

    output = result.get("stdout", "")
    err = result.get("stderr", "")
    err_dict = result.get("error", "")

    if not output and not err and not err_dict and isinstance(result, dict) and result:
        # Some tools (play_roblox, set_roblox_account, list_roblox_accounts, ...)
        # return their JSON result directly instead of wrapping it in
        # {"stdout": ...}. Without this, a successful call renders as a blank
        # "Tool executed." with nothing after it — indistinguishable from a
        # silent no-op — which has driven the agent to abandon a working call
        # and fall back to a legacy tool that happens to always populate stdout.
        output = json.dumps(result, indent=2, default=str)

    # --- Context hygiene -------------------------------------------------
    # A curated NOISY tool's output is distilled (summary in chat, full raw to a
    # file) instead of dumped. Any OTHER oversized output is saved to a file so
    # the tail is never silently lost to blind truncation.
    if tool_name in NOISY_TOOLS and (output or err_dict):
        try:
            distilled = distill_output(tool_name, result, run_dir, task_context)
            output = distilled.get("stdout", output)
            feedback = f"Tool '{tool_name}' executed.\n"
            if output:
                feedback += f"Output:\n{output}\n"
            if err:
                feedback += f"Stderr:\n{err[:2000]}\n"
            return (feedback, result) if return_result else feedback
        except Exception:
            pass  # fall through to the generic path — never break the call

    feedback = f"Tool '{tool_name}' executed.\n"
    if output:
        if len(output) > 8000:
            path = None
            if run_dir:
                try:
                    from tools.output_distillers import _save_raw
                    path = _save_raw(run_dir, tool_name, output)
                except Exception:
                    path = None
            feedback += f"Output:\n{output[:8000]}\n"
            if path:
                feedback += f"[Output truncated at 8000 of {len(output)} chars — full raw saved to {path}]\n"
            else:
                feedback += (f"[WARNING: Output truncated at 8000 chars. Total output was {len(output)} chars. "
                             "If this is a symbol/string listing, call the tool again with a higher 'skip' or "
                             "'page' offset to see more results.]\n")
        else:
            feedback += f"Output:\n{output}\n"
    if err:
        feedback += f"Stderr:\n{err[:2000]}\n"
    if err_dict:
        feedback += f"System Error:\n{err_dict}\n"

    return (feedback, result) if return_result else feedback


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


# Depth and ignore list mirror the local walker, so switching machines does not
# silently change what the tree shows.
_REMOTE_TREE_DEPTH = 6
_REMOTE_TREE_IGNORE = (".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build")


def _remote_find_command():
    """Two `find` passes, one per type, each tagged with a leading d/f. The file
    pass also carries a size, so remote file nodes get "size" the same as local
    ones (frontend's humanSize() otherwise silently shows nothing).

    Deliberately avoids `find -printf` and `stat -c`, which are GNU-only. The
    local box assumes a GNU userland, but a remote host may be macOS or BSD, and
    a tree that fails on half the machines you connect to is not a tree. `wc -c`
    is POSIX and prints "<size> <path>"; requiring the "./" prefix in the sed
    pattern drops wc's per-batch "total" line (it has no "./" prefix) for free."""
    prune = " -o ".join(f"-name {shlex.quote(n)}" for n in _REMOTE_TREE_IGNORE)
    base = f"find . -maxdepth {_REMOTE_TREE_DEPTH} \\( {prune} \\) -prune -o "
    d = base + r"-type d -print | sed 's|^|d\t|'"
    f = (base + r"-type f -exec wc -c {} + | "
                r"sed -n 's|^ *\([0-9][0-9]*\) \(\./.*\)$|f\t\1\t\2|p'")
    return d + "; " + f


def _parse_find_output(text, project_name):
    """Turn the tagged find output into the SAME nested dict the local walker
    produces, so the frontend needs no changes.

    Directory lines are 2-field ("d\\t<path>"); file lines are 3-field
    ("f\\t<size>\\t<path>") so file nodes carry "size", matching the local
    walker. A 2-field file line (no size available) still parses, with
    size falling back to 0, rather than being dropped."""
    root = {"name": project_name or "workspace", "path": "", "type": "dir", "children": []}
    dirs = {"": root}

    rows = []  # (kind, rel, size-or-None)
    for line in (text or "").splitlines():
        if "\t" not in line:
            continue
        parts = line.split("\t")
        kind = parts[0]
        if kind == "d":
            if len(parts) < 2:
                continue
            raw, size = parts[1], None
        elif kind == "f":
            if len(parts) >= 3:
                raw, size_str = parts[2], parts[1]
                try:
                    size = int(size_str)
                except ValueError:
                    size = None
            elif len(parts) == 2:
                raw, size = parts[1], None
            else:
                continue
        else:
            continue
        rel = raw[2:] if raw.startswith("./") else raw
        if rel in ("", "."):
            continue
        rows.append((kind, rel, size))

    # Directories first and shallowest-first, so a parent always exists before
    # its child is attached.
    rows.sort(key=lambda r: (0 if r[0] == "d" else 1, r[1].count("/"), r[1]))

    for kind, rel, size in rows:
        parent_rel, _, name = rel.rpartition("/")
        parent = dirs.get(parent_rel)
        if parent is None:
            continue          # its parent was pruned; skip rather than orphan it
        node = {"name": name, "path": rel, "type": "dir" if kind == "d" else "file"}
        if kind == "d":
            node["children"] = []
            dirs[rel] = node
        else:
            node["size"] = size if size is not None else 0
        parent["children"].append(node)

    def sort_tree(node):
        node["children"].sort(key=lambda c: (0 if c["type"] == "dir" else 1, c["name"].lower()))
        for c in node["children"]:
            if c["type"] == "dir":
                sort_tree(c)

    sort_tree(root)
    return root


# The tree node a failed remote listing puts in the sidebar. A path no real file
# can have, so a stray click/drag on it resolves to nothing.
REMOTE_TREE_ERROR_PATH = ".omni-device-unreachable"


def _remote_file_tree(project_name):
    res = run_cmd(_remote_find_command(), timeout=60)
    if res.get("error") or res.get("returncode"):
        # Returning a bare empty tree here made an unreachable host look exactly
        # like an empty project folder — the user sees nothing wrong and starts
        # working. Keep the payload shape (the UI walks .children and would break
        # on anything else) but say so, both in a machine-readable `error` key and
        # as a node the user actually SEES in the sidebar.
        d = devices.active()
        detail = (res.get("error") or res.get("stderr") or "").strip()             or f"the listing command exited {res.get('returncode')}"
        where = f"'{d.name}' ({d.target})" if d else "the active device"
        msg = f"Could not list the project folder on {where}: {detail}"
        return {"name": project_name or "workspace", "path": "", "type": "dir",
                "error": msg,
                "children": [{"name": f"⚠ {msg}", "path": REMOTE_TREE_ERROR_PATH,
                              "type": "dir", "children": []}]}
    return _parse_find_output(res.get("stdout") or "", project_name)


def build_file_tree(project_name):
    """Builds a nested file-tree dict of the active workspace (host side).
    The picked folder is the root (no project-subfolder layer)."""
    if devices.is_remote():
        return _remote_file_tree(project_name)
    try:
        root = _project_root(project_name)
    except RuntimeError:
        return {"name": project_name or "workspace", "path": "", "type": "dir", "children": []}

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
_VIEWER_SNIFF_BYTES = 8192         # how much of a file the binary sniff looks at

# Magic-number → human label, so "this isn't previewable" can say WHAT the file
# actually is instead of just "binary". Matching one of these is on its own proof
# the file is not text, so every entry must be a signature no plausible text file
# could open with — that rules out short/printable prefixes like "MZ" (a CSV
# could start "MZ,…") and "BZh". Those formats are still caught, just by the byte
# sniff below rather than by name. Longer prefixes come first where they overlap.
_VIEWER_MAGIC = (
    (b"%PDF-", "PDF document"),
    (b"\x7fELF", "ELF binary"),
    (b"\xca\xfe\xba\xbe", "Mach-O universal binary"),
    (b"\xcf\xfa\xed\xfe", "Mach-O binary"),
    (b"\xce\xfa\xed\xfe", "Mach-O binary (32-bit)"),
    (b"dex\n", "Android DEX bytecode"),
    (b"\x00\x61\x73\x6d", "WebAssembly module"),
    (b"\x1f\x8b", "gzip archive"),
    (b"7z\xbc\xaf\x27\x1c", "7-Zip archive"),
    (b"Rar!\x1a\x07", "RAR archive"),
    (b"\xfd7zXZ\x00", "XZ archive"),
    (b"SQLite format 3\x00", "SQLite database"),
    (b"OggS", "Ogg media"),
    (b"fLaC", "FLAC audio"),
    (b"\xff\xd8\xff", "JPEG image"),
    (b"wOFF", "WOFF font"),
    (b"wOF2", "WOFF2 font"),
    (b"\x00\x01\x00\x00\x00", "TrueType font"),
)
# Offset-4 magics (media containers put the brand after a size field).
_VIEWER_MAGIC_AT_4 = ((b"ftyp", "video/audio container"),)


def _viewer_known_binary(head):
    """The format's own signature, or None if we don't recognize it. A hit is
    conclusive — no byte sniffing needed, and no threshold to get wrong on a
    small file (a short PDF stub is mostly printable ASCII, but it is still a
    PDF and rendering it as text helps nobody)."""
    for magic, label in _VIEWER_MAGIC:
        if head.startswith(magic):
            return label
    for magic, label in _VIEWER_MAGIC_AT_4:
        if head[4:4 + len(magic)] == magic:
            return label
    return None


def _viewer_describe_binary(head, ext):
    """Best-effort human label for an unpreviewable file, from magic bytes and
    then the extension. Never raises — worst case it says 'binary file'."""
    known = _viewer_known_binary(head)
    if known:
        return known
    if ext:
        return f"{ext.lstrip('.').upper()} file"
    return "binary file"


def _viewer_looks_binary(head):
    """True when `head` (the first few KB of a file) is not plausibly text.

    Three signals, cheapest-first: a recognized binary signature, a NUL byte
    (which almost never appears in real text), and a low share of printable
    bytes. UTF-16 text trips the NUL check on purpose — the viewer decodes
    UTF-8, so showing it is exactly the mojibake this guard exists to prevent."""
    if not head:
        return False  # an empty file is a perfectly fine empty text file
    if _viewer_known_binary(head):
        return True
    if b"\x00" in head:
        return True
    try:
        head.decode("utf-8")
        return False
    except UnicodeDecodeError:
        pass
    # Not valid UTF-8: fall back to a printable-ratio test so latin-1/cp1252 text
    # still opens while real binaries don't. The two populations sit far apart —
    # accented characters are a few percent of Western European prose, whereas
    # NUL-free binary (compressed/encrypted payloads) is near-uniform random and
    # lands around 39% printable. 0.80 is the gap between them.
    printable = sum(1 for b in head if 32 <= b < 127 or b in (9, 10, 13, 12))
    return printable / len(head) < 0.80


def _viewer_unsupported(rel, size, label, *, detail=None):
    """The payload the frontend turns into the 'not supported / view as text
    anyway' panel. kind='unsupported' is always ok=True: nothing failed, we're
    just declining to guess at a rendering."""
    # Phrased around the label rather than pluralizing it: labels range from
    # "PDF document" to "ELF binary" to "XYZ file", and "ELF binarys" is not a
    # word.
    return {"ok": True, "kind": "unsupported", "path": rel, "size": size,
            "label": label,
            "reason": detail or f"This looks like a {label}, which the viewer can't render.",
            "can_force_text": True}


def _resolve_project_file(project_name, rel_path):
    """Normalizes rel_path and confines it to the project root.
    Returns (full_path, rel, None) or (None, None, error)."""
    if not rel_path:
        return None, None, "No path provided."
    rel = rel_path.lstrip("/").lstrip("\\")
    try:
        root = os.path.abspath(_project_root(project_name))
    except RuntimeError as e:
        return None, None, str(e)
    full = os.path.abspath(os.path.join(root, rel))
    # Traversal guard anchored to the PICKED root: never resolve outside it.
    if not full.startswith(root + os.sep) and full != root:
        return None, None, "Path outside workspace."
    if not os.path.isfile(full):
        return None, None, "Not a file or does not exist."
    return full, rel, None


# base64 over ssh is fine for a screenshot and absurd for an APK. Anything above
# this is refused rather than transferred for a preview nobody can use.
REMOTE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

_REMOTE_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                      ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}


def _remote_read_project_file(project_name, rel_path, force_text=False):
    from tools.common import normalize_path, wpath
    rel = normalize_path(rel_path)
    t = wpath(rel)

    # Same guard as the local viewer: resolve the path on the far side and
    # confirm the result is still inside the project root. Resolving only
    # dirname() (as an earlier version of this did) misses a LEAF symlink:
    # `ln -s /etc/passwd leak.txt` has dirname "." — which trivially passes the
    # root check — while the leaf itself points outside. So the leaf is
    # resolved too: realpath if present, else `readlink -f`, else (for hosts
    # with neither, e.g. some macOS/BSD) one manual level of `readlink` on the
    # leaf, re-anchored against its resolved directory if the target is
    # relative. Whichever path wins, the root comparison runs on it before any
    # -f/wc/cat/base64 touches the file.
    #
    # The manual fallback (tier 3) cannot fully canonicalize: a `..`-relative
    # symlink target (`ln -s ../../etc/passwd leak.txt`) or a 2+-level symlink
    # chain both evade a single `readlink` hop — the string-prefix root check
    # would then see a literal `..` segment it never collapsed and misjudge
    # it as inside. So the principle here is: refuse what you cannot
    # canonicalize, not "normalize it yourself" — hand-rolled `..` collapsing
    # in POSIX sh is exactly how this class of bug recurs. Concretely: (1) if
    # tier 3 finds the leaf IS a symlink, it refuses outright rather than
    # trusting one hop; (2) regardless of tier, a resolved path that still
    # contains a `..` segment is refused too, as a second, independent net —
    # a canonical path never has one, so its presence means resolution did
    # not complete.
    probe_script = (
        f'T={t}; R=$(pwd -P); '
        f'D=$(cd "$(dirname "$T")" 2>/dev/null && pwd -P); '
        f'B=$(basename "$T"); '
        f'if command -v realpath >/dev/null 2>&1; then F=$(realpath "$D/$B" 2>/dev/null); '
        f'elif L=$(readlink -f "$D/$B" 2>/dev/null) && [ -n "$L" ]; then F="$L"; '
        f'else '
        f'LK=$(readlink "$D/$B" 2>/dev/null); '
        f'if [ -n "$LK" ]; then echo OUTSIDE; exit 0; fi; '
        f'F="$D/$B"; '
        f'fi; '
        f'if [ -z "$F" ]; then echo OUTSIDE; exit 0; fi; '
        f'case "$F" in *"/../"*|*"/..") echo OUTSIDE; exit 0;; esac; '
        f'case "$F" in "$R"/*|"$R") ;; *) echo OUTSIDE; exit 0;; esac; '
        f'if [ ! -f {t} ]; then echo MISSING; exit 0; fi; '
        f'S=$(wc -c < {t} | tr -d " "); echo "SIZE=$S"; '
        # The binary sniff needs BYTES, and it rides along on this same probe
        # rather than costing a second round trip. base64 so the bytes survive
        # the pipe intact, one line so the parse below stays line-oriented, and
        # `dd` behind `head -c` for the rare host whose head lacks -c. If both
        # fail the line is empty and the sniff simply sees an empty head — the
        # pre-existing text path, not a crash. Skipped entirely above the preview
        # cap, where the answer is "too large" and no bytes should be read at all.
        f'if [ "$S" -le {REMOTE_PREVIEW_MAX_BYTES} ]; then '
        f'echo "HEAD=$( (head -c {_VIEWER_SNIFF_BYTES} {t} 2>/dev/null '
        f'|| dd if={t} bs=1 count={_VIEWER_SNIFF_BYTES} 2>/dev/null) '
        # tr -dc (keep only the base64 alphabet) rather than tr -d of a newline:
        # it strips the line wrapping without an escaped newline in the middle of
        # a shell string, and drops anything a chattier base64 might add.
        f"| base64 | tr -dc 'A-Za-z0-9+/=' )\"; fi"
    )
    probe = run_cmd(probe_script, timeout=30)
    out = (probe.get("stdout") or "").strip()
    if probe.get("error"):
        return {"ok": False, "error": probe["error"]}
    if out.startswith("OUTSIDE"):
        return {"ok": False, "error": f"{rel_path} resolves outside the project folder."}
    if out.startswith("MISSING"):
        return {"ok": False, "error": f"No such file on device: {rel_path}"}

    size, head = 0, b""
    for line in out.splitlines():
        if line.startswith("SIZE="):
            try:
                size = int(line[5:])
            except ValueError:
                size = 0
        elif line.startswith("HEAD="):
            try:
                head = base64.b64decode(line[5:] or "")
            except (binascii.Error, ValueError):
                head = b""
    if size > REMOTE_PREVIEW_MAX_BYTES:
        mb = REMOTE_PREVIEW_MAX_BYTES // (1024 * 1024)
        return {"ok": False,
                "error": f"{rel_path} is {size} bytes — too large to preview from a "
                         f"remote device (limit {mb} MB). Work with it through tools instead."}

    ext = os.path.splitext(rel)[1].lower()
    if ext in _REMOTE_IMAGE_MIME and not force_text:
        res = run_cmd(f"base64 {t} | tr -d '\\n'", timeout=120)
        if res.get("error") or res.get("returncode"):
            return {"ok": False, "error": res.get("error") or "could not read the image"}
        return {"ok": True, "kind": "image", "mime": _REMOTE_IMAGE_MIME[ext],
                "data": (res.get("stdout") or "").strip(), "path": rel, "size": size}

    # Everything the local viewer would render as an archive listing or decline as
    # binary must be declined here too. Without this an .apk or .so under the 8 MB
    # cap was `cat`'d straight into the viewer as mojibake — worse than the local
    # behaviour on the same file. The payload is _viewer_unsupported()'s exact
    # shape (kind/path/size/label/reason/can_force_text) because the frontend is
    # not being changed; only the wording says the limitation is the device.
    # Archive extensions are declined by NAME rather than sniffed, deliberately:
    # listing a remote zip's entries is a subsystem (every member read would be
    # its own ssh round trip), not a preview.
    if not force_text and (ext in _VIEWER_ARCHIVE_EXTS or _viewer_looks_binary(head)):
        label = _viewer_describe_binary(head, ext)
        d = devices.active()
        where = f"'{d.name}'" if d else "the active device"
        return _viewer_unsupported(
            rel, size, label,
            detail=(f"This looks like a {label}. Preview isn't available for this "
                    f"type on a remote device ({where}) — read it with tools that "
                    f"run there instead."))

    res = run_cmd(f"cat {t}", timeout=120)
    if res.get("error") or res.get("returncode"):
        return {"ok": False, "error": res.get("error") or "could not read the file"}
    return {"ok": True, "kind": "text", "content": res.get("stdout") or "", "path": rel,
            "size": size}


def read_project_file(project_name, rel_path, force_text=False):
    """Reads a file from the project workspace (host side) for the frontend
    viewer. Returns a typed payload: kind="image" (base64 + mime),
    kind="archive" (zip/apk entry listing), kind="unsupported" (binary we
    decline to render), or kind="text" (the default).

    force_text=True is the frontend's "view as text anyway" escape hatch: it
    skips the binary sniff and decodes with errors="replace"."""
    if devices.is_remote():
        return _remote_read_project_file(project_name, rel_path, force_text)
    full, rel, err = _resolve_project_file(project_name, rel_path)
    if err:
        return {"ok": False, "error": err}
    ext = os.path.splitext(full)[1].lower()
    try:
        size = os.path.getsize(full)
        if ext in _VIEWER_IMAGE_MIME and not force_text:
            if size > _VIEWER_IMAGE_CAP:
                return _viewer_unsupported(
                    rel, size, "Image", detail=f"Image too large to preview ({size:,} bytes).")
            with open(full, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            return {"ok": True, "kind": "image", "path": rel, "size": size,
                    "mime": _VIEWER_IMAGE_MIME[ext], "data": data}
        if ext in _VIEWER_ARCHIVE_EXTS and not force_text and zipfile.is_zipfile(full):
            with zipfile.ZipFile(full) as zf:
                infos = zf.infolist()
            entries = [{"name": i.filename, "size": i.file_size, "dir": i.is_dir()}
                       for i in infos[:_VIEWER_MAX_ARCHIVE_ENTRIES]]
            return {"ok": True, "kind": "archive", "path": rel, "size": size,
                    "entries": entries, "entry_count": len(infos),
                    "truncated": len(infos) > _VIEWER_MAX_ARCHIVE_ENTRIES}
        if not force_text:
            with open(full, "rb") as f:
                head = f.read(_VIEWER_SNIFF_BYTES)
            if _viewer_looks_binary(head):
                return _viewer_unsupported(rel, size, _viewer_describe_binary(head, ext))
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(_VIEWER_TEXT_CAP)
        return {"ok": True, "kind": "text", "path": rel, "size": size, "content": content,
                "truncated": size > _VIEWER_TEXT_CAP}
    except (OSError, zipfile.BadZipFile) as e:
        return {"ok": False, "error": str(e)}


def read_project_archive_member(project_name, rel_path, member, force_text=False):
    """Reads a single entry out of a zip-based archive (zip/apk/jar/…) in the
    workspace, for previewing inside the frontend's archive explorer. Entries
    get the same typed treatment as read_project_file (image, text, or the
    'unsupported' decline), including the force_text escape hatch."""
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
            entry_path = f"{rel} › {member}"
            ext = os.path.splitext(member)[1].lower()
            if ext in _VIEWER_IMAGE_MIME and not force_text:
                if info.file_size > _VIEWER_IMAGE_CAP:
                    return _viewer_unsupported(
                        entry_path, info.file_size, "Image",
                        detail=f"Image too large to preview ({info.file_size:,} bytes).")
                with zf.open(info) as f:
                    data = base64.b64encode(f.read()).decode("ascii")
                return {"ok": True, "kind": "image", "path": entry_path,
                        "size": info.file_size, "mime": _VIEWER_IMAGE_MIME[ext], "data": data}
            with zf.open(info) as f:
                raw = f.read(_VIEWER_TEXT_CAP)
            if not force_text and _viewer_looks_binary(raw[:_VIEWER_SNIFF_BYTES]):
                return _viewer_unsupported(
                    entry_path, info.file_size,
                    _viewer_describe_binary(raw[:_VIEWER_SNIFF_BYTES], ext))
            return {"ok": True, "kind": "text", "path": entry_path,
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


_ULTRA_ON = (
    "ULTRA MODE: ON. For any substantive task — a review, an audit, a migration, "
    "a research question, a design decision — reach for `run_workflow` BEFORE "
    "working through it turn by turn. Prefer a library workflow by name. Trivial "
    "or conversational turns still get a direct answer."
)
_ULTRA_OFF = (
    "ULTRA MODE: OFF. Do not start a workflow on your own judgement — a fan-out "
    "spends real money. Answer directly, or use dispatch_agents for a single "
    "parallel wave. If a task genuinely warrants multi-stage orchestration, say so "
    "and let the user turn ultra mode on. `run_workflow` still runs if they name one."
)

# Word-boundary match so 'ultrasound' / 'ultrasonic' do not trip it.
_ULTRA_RE = re.compile(r"\bultra\b", re.IGNORECASE)


def _ultra_prompt_segment(session):
    return _ULTRA_ON if (session or {}).get("ultra") else _ULTRA_OFF


def _device_prompt_segment(session):
    """Tell the model which machine its commands land on. It has no tool to
    change this — the user selects the device — so the line is informational and
    must say so, or the model will hunt for a switch that does not exist.

    `session` is accepted (symmetric with _ultra_prompt_segment) but not read:
    this reads devices.active() directly, exactly like the execution-routing
    call sites (host_exec.py, tools/web_tools.py) do. That means a bug that
    lets session["active_device"] drift from devices.active() would be
    invisible here — prompt, UI and routing all mirror the same module-level
    global, so they'd look internally consistent while commands ran on the
    wrong machine. _load_persisted is what has to keep them in sync."""
    d = devices.active()
    if d is None:
        return ("EXECUTION TARGET: this computer. Commands, file edits and builds "
                "all run locally.")
    return (
        f"EXECUTION TARGET: the remote device '{d.name}' ({d.target}). Every "
        f"command, file edit and build runs THERE, in {d.remote_root} — not on "
        f"this computer. You cannot change the target; the user selects it. "
        f"Emulator, screen-capture, Frida and code-graph tools are local-only and "
        f"will refuse while a device is active."
    )


def _ultra_keyword_requested(text):
    return bool(_ULTRA_RE.search(text or ""))


class AgentApi:
    """Bridge exposed to the webview frontend as `pywebview.api.*`."""

    def __init__(self):
        self._window = None
        self._lock = threading.Lock()
        self._busy = False
        self._stop = False
        self._thread = None
        self.session = None  # dict with project, messages, memory_dir, ...
        # Counts consecutive ambiguous timeout-decision replies for the command
        # currently running, so a confused model can't pin a process open forever.
        self._timeout_ambiguous_streak = 0
        # Route command timeouts through the LLM instead of a hard kill.
        set_timeout_decider(self._decide_on_timeout)
        # Surface LLM fallbacks (primary provider failed -> using the next one) as
        # system lines in the chat so the user can see which provider is in play.
        set_fallback_notifier(self._on_llm_fallback)
        # Keep the persistent "active LLM" badge in sync with whichever provider
        # is actually serving requests (updates when the sticky fallback moves).
        set_active_provider_notifier(self._on_active_llm)
        # Let ask_llm's never-give-up retry/backoff loop see the Stop button, so a
        # long backoff wait (up to 10 min) can still be interrupted by the user.
        set_stop_check(lambda: self._stop)
        # Same predicate for the executor, so a running tool subprocess is killed the
        # instant Stop is pressed instead of blocking for its whole timeout window.
        set_exec_stop_check(lambda: self._stop)
        # Bridge subagent telemetry emitted OUTSIDE the planner's read-wave (e.g.
        # the dispatch_agents tool) to the browser, so the Subagents HUD lights up
        # for deliberate delegation too, not only auto read-waves.
        subagents.set_ui_sink(self._emit)

    def set_window(self, window):
        self._window = window

    def _on_llm_fallback(self, message):
        """Called by llm.ask_llm when it fails over between configured providers."""
        self._emit({"type": "system", "content": message})

    def _on_active_llm(self, info):
        """Called by llm.ask_llm when the active provider changes. Drives the
        persistent active-LLM badge in the UI header."""
        self._emit({
            "type": "active_llm",
            "name": info.get("name", ""),
            "label": info.get("label", ""),
            "model": info.get("model", ""),
        })

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
            # Wall-clock stamp so a REPLAYED transcript can show the real elapsed
            # per action group instead of ~0s (the frontend has no live clock on
            # reopen — it derives group durations from these stamps).
            stored.setdefault("ts", int(time.time() * 1000))
            tr = self.session.setdefault("transcript", [])
            tr.append(stored)
            if len(tr) > TRANSCRIPT_MAX_EVENTS:
                del tr[:len(tr) - TRANSCRIPT_MAX_EVENTS]
        # Keep a compact snapshot of the subagent dock so the Subagents menu
        # survives a refresh / reopen (the wave/subagent events are NOT part of
        # the chat transcript).
        self._track_dock(event)
        if self._window is None:
            return
        try:
            js = "window.__agent.onEvent(" + json.dumps(event, ensure_ascii=False) + ")"
            self._window.evaluate_js(js)
        except Exception:
            pass

    def _track_dock(self, event):
        """Fold a subagent/wave event into session['dock'] — a compact, JSON-safe
        snapshot of the Subagents dock (one row per subagent, plus a wave-done
        flag) so the menu can be rebuilt after a refresh / reopen. Best-effort:
        never raises into the emit path."""
        s = self.session
        if s is None:
            return
        et = event.get("type")
        if et not in DOCK_EVENT_TYPES:
            return
        try:
            dock = s.setdefault("dock", {"rows": [], "index": {}, "done": False, "wave_id": None})

            def _key(ev):
                return ev.get("sub_id") or f"{ev.get('agent') or ''}::{ev.get('key_label') or ''}"

            if et == "wave_started":
                # A fresh parallel wave replaces the previous snapshot.
                dock["rows"] = []
                dock["index"] = {}
                dock["done"] = False
                dock["wave_id"] = event.get("wave_id")
            elif et == "subagent_started":
                k = _key(event)
                row = {"sub_id": event.get("sub_id"), "agent": event.get("agent"),
                       "task": event.get("task"), "tier": event.get("tier"),
                       "model": event.get("model"), "key_label": event.get("key_label"),
                       "running": True, "ok": None, "steps": 0, "tokens": 0,
                       "elapsed_s": 0, "escalated": False}
                if k in dock["index"]:
                    dock["rows"][dock["index"][k]].update(row)
                else:
                    # Bound the snapshot: drop the oldest rows and reindex.
                    dock["rows"].append(row)
                    if len(dock["rows"]) > DOCK_MAX_ROWS:
                        dock["rows"] = dock["rows"][-DOCK_MAX_ROWS:]
                    dock["index"] = {(_key(r)): i for i, r in enumerate(dock["rows"])}
            elif et in ("subagent_progress", "subagent_done"):
                idx = dock["index"].get(_key(event))
                if idx is not None:
                    row = dock["rows"][idx]
                    for f in ("tokens", "elapsed_s", "model", "escalated"):
                        if event.get(f) is not None:
                            row[f] = event.get(f)
                    # progress emits `step` (singular); done emits `steps` (plural).
                    step = event.get("steps", event.get("step"))
                    if step is not None:
                        row["steps"] = step
                    if et == "subagent_done":
                        row["running"] = False
                        row["ok"] = bool(event.get("ok"))
            elif et == "wave_done":
                dock["done"] = True
                for row in dock["rows"]:
                    row["running"] = False
        except Exception:
            pass  # a dock-snapshot hiccup must never break the emit path

    # --- long-running command supervision ------------------------------------
    def _decide_on_timeout(self, display, elapsed_s, base_timeout, rounds):
        """Called by the executor when a command outruns its timeout instead of
        killing it. Asks the LLM whether the process looks stuck (kill it) or is
        a slow-but-progressing job (keep waiting). Returns ("kill", None) or
        ("extend", seconds). Never raises — any failure falls back to extending
        by the base timeout so we don't kill on a transient error, except after a
        run of ambiguous replies (or an explicit user stop), which do kill."""
        # A user stop means: don't keep waiting on anything.
        if self._stop:
            return ("kill", None)

        # New command's first decision round resets the ambiguity streak.
        if rounds <= 1:
            self._timeout_ambiguous_streak = 0

        elapsed_i = int(elapsed_s)
        self._emit({"type": "system", "content": (
            f"A command has been running for {elapsed_i}s without finishing — "
            "asking the agent whether it's stuck or just slow...")})

        messages = [
            {"role": "system", "content": TIMEOUT_DECIDER_SYSTEM},
            {"role": "user", "content": (
                "A command the agent started is still running:\n\n"
                f"  {display[:500]}\n\n"
                f"It has been running for {elapsed_i} seconds and has not returned yet. "
                "This might be a long process that's NOT stuck but still trying to be "
                "completed (for example a large build, decompilation, or static analysis). "
                "Decide what to do and reply with ONE JSON object only:\n"
                '  {"decision":"continue","seconds":N}  -> keep it running for N more seconds (do NOT kill it)\n'
                '  {"decision":"kill"}                   -> stop it now because it looks genuinely stuck\n'
                f"N must be a positive integer up to {TIMEOUT_EXTEND_CAP}. Prefer continuing when the "
                "command is the kind of job that legitimately takes a long time.")},
        ]

        try:
            raw = ask_llm(messages)
        except Exception:
            raw = ""
        action, seconds = parse_timeout_decision(raw)

        if action == "kill":
            self._timeout_ambiguous_streak = 0
            self._emit({"type": "system", "content": (
                f"Agent judged the command stuck after {elapsed_i}s — stopping it.")})
            return ("kill", None)

        if action == "extend":
            self._timeout_ambiguous_streak = 0
            secs = seconds if isinstance(seconds, int) and seconds > 0 else base_timeout
            secs = min(secs, TIMEOUT_EXTEND_CAP)
            self._emit({"type": "system", "content": (
                f"Agent judged the command still working, not stuck — giving it {secs}s more "
                f"(running {elapsed_i}s so far).")})
            return ("extend", secs)

        # Ambiguous / no usable answer: honor "don't kill immediately" by
        # extending once, but give up after a few ambiguous rounds in a row.
        self._timeout_ambiguous_streak += 1
        if self._timeout_ambiguous_streak >= AMBIGUOUS_TIMEOUT_KILL_STREAK:
            self._timeout_ambiguous_streak = 0
            self._emit({"type": "system", "content": (
                "No clear decision after several checks — stopping the command.")})
            return ("kill", None)
        self._emit({"type": "system", "content": (
            f"No clear decision — giving the command {base_timeout}s more and re-checking.")})
        return ("extend", base_timeout)

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
            # Header stats (steps / tools used / context / resets) so the counts
            # survive a reopen instead of zeroing out. The snapshot already carries
            # tools_used, so it doubles as the cumulative-count store.
            "stats": s.get("last_status"),
            # Progressive-disclosure: which on-demand toolsets were expanded, so a
            # reopened long run keeps their full schemas instead of dropping back
            # to catalog-only until the next domain call re-arms them.
            "active_toolsets": sorted(s.get("active_toolsets") or []),
            # Subagents-dock snapshot so the menu survives a reopen (see _track_dock).
            "dock": s.get("dock"),
            # Ultra mode, so a project the user switched ON stays on across
            # restarts. A keyword-armed turn is deliberately NOT persisted — it
            # is scoped to that one turn (see send_message / _run_agent_loop).
            "ultra": bool(s.get("ultra")) and not s.get("ultra_turn_only"),
            # Which machine work happens on, so reopening a project doesn't
            # silently drop back to the local computer while the user believes
            # they're still on a remote device (see _load_persisted).
            "active_device": s.get("active_device"),
            "saved_at": datetime.datetime.now().isoformat(timespec="seconds"),
        })
        _write_json_atomic(os.path.join(mem, TRANSCRIPT_FILENAME), _cap_transcript(s.get("transcript", [])))
        s["_last_persist_ts"] = time.monotonic()

    def _persist_session_throttled(self):
        """Persist the session at most once per PERSIST_MIN_INTERVAL_S — called on
        every agent-loop iteration so an interrupted long run keeps its history
        without rewriting the (growing) conversation file on every single turn.
        The loop's end-of-run `finally` still does an unconditional final save."""
        s = self.session
        if not s:
            return
        last = s.get("_last_persist_ts", 0.0)
        if time.monotonic() - last >= PERSIST_MIN_INTERVAL_S:
            self._persist_session()

    def _load_persisted(self, memory_dir):
        """Returns (messages_or_None, transcript_list, original_task, stats) saved
        for this project, or (None, [], None, None) if there's nothing usable.
        `stats` is the last header-stats snapshot (or None) so the counts can be
        restored on reopen."""
        conv_path = os.path.join(memory_dir, CONVERSATION_FILENAME)
        tr_path = os.path.join(memory_dir, TRANSCRIPT_FILENAME)
        messages, transcript, original_task, stats = None, [], None, None
        # Restored progressive-disclosure toolsets + dock snapshot are stashed on
        # self (rather than widening this method's return tuple) and read back in
        # start_session.
        self._restored_active_toolsets = set()
        self._restored_dock = None
        self._restored_ultra = False
        self._restored_active_device = None
        saved_device = None
        try:
            if os.path.isfile(conv_path):
                with open(conv_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                msgs = data.get("messages")
                if isinstance(msgs, list) and any(m.get("role") != "system" for m in msgs):
                    messages = msgs
                    original_task = data.get("original_task")
                st = data.get("stats")
                if isinstance(st, dict):
                    stats = st
                ts = data.get("active_toolsets")
                if isinstance(ts, list):
                    self._restored_active_toolsets = set(ts)
                dk = data.get("dock")
                if isinstance(dk, dict) and isinstance(dk.get("rows"), list) and dk["rows"]:
                    self._restored_dock = dk
                self._restored_ultra = bool(data.get("ultra"))
                saved_device = data.get("active_device")
        except (OSError, json.JSONDecodeError, AttributeError):
            messages, original_task, stats = None, None, None
        # Unconditionally assert the device state for THIS project — including
        # when it has no saved device (key absent, corrupt file, or brand new
        # project) — so opening a project never inherits whatever the PREVIOUS
        # project left active in devices._active (module-level, process-wide
        # state). set_active(None) correctly means local; do not gate this call
        # on saved_device being truthy, or a project switch can silently leave
        # commands routed at the last project's remote host.
        try:
            devices.set_active(saved_device)
            self._restored_active_device = saved_device
        except KeyError:
            # Device deleted since last session — degrade to local rather than
            # crash the session, and don't leave the previous project's device
            # active in its place.
            devices.set_active(None)
            self._restored_active_device = None
        try:
            if os.path.isfile(tr_path):
                with open(tr_path, "r", encoding="utf-8") as f:
                    tr = json.load(f)
                if isinstance(tr, list):
                    transcript = tr[-TRANSCRIPT_MAX_EVENTS:]
        except (OSError, json.JSONDecodeError):
            transcript = []
        return messages, transcript, original_task, stats

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
        STATIC base prompt + the progressive tool section (core tools in full
        plus a catalog for inactive domain toolsets, and full schemas for any
        toolset activated this session) + the CURRENT plan + investigation
        memory. Called after every plan/investigation mutation and after any
        toolset activation, so the model always sees live state without it being
        duplicated into the transcript on every change (which would grow context
        on every single status update)."""
        if not self.session:
            return
        # Native-aware: when the active model is driven via the function-calling
        # interface, the prompt must NOT command the JSON-envelope protocol or
        # embed full text schemas (they ride in the request's tools= array) — that
        # contradicts tool_choice=required and wastes context. The decision is made
        # ONCE per session (start_session, stored as session["native_tools"]) and
        # the matching base_system_prompt is built there; here we just read it, so
        # composition doesn't depend on live global config mid-run.
        native = bool(self.session.get("native_tools"))
        strat_on = bool(self.session.get("strategy_brief_enabled"))
        # When the Strategic Brief is OFF, suppress its toolset entirely so the
        # prompt is byte-identical to a pre-feature build; when ON, render it in full.
        hidden = None if strat_on else {"strategy"}
        active = set(self.session.get("active_toolsets") or set())
        if strat_on:
            active = active | {"strategy"}
        # Progressive tool disclosure: render only core + activated toolsets in
        # full; everything else stays a one-line catalog until used/expanded.
        tools_section = render_tools_section(active, native=native, hidden_groups=hidden)
        plan = planning.get_active_plan()
        section = ""
        # Strategic Brief pins FIRST (above plan + investigation) so it's the stable
        # north-star the model reasons against every turn.
        if strat_on:
            brief = strategy.get_active()
            if brief is not None and not brief.is_empty():
                section += (
                    "\n\nSTRATEGIC BRIEF (your synthesized thesis — keep it current with strategy_set / "
                    "strategy_update; a complete brief must pass an independent strategy review before you "
                    "may change the workspace):\n" + brief.to_markdown()
                )
        # Design Brief pins just below the Strategic Brief: the autonomously-chosen
        # approach from the auto-brainstorm, so the plan is built against it. Only
        # rendered when Superpowers is on AND a brief exists — otherwise byte-identical.
        if self.session.get("superpowers_enabled"):
            design = superpowers.get_active()
            if design is not None and not design.is_empty():
                section += (
                    "\n\nDESIGN BRIEF (auto-brainstormed approach chosen for this task — plan and execute "
                    "against it; the assumptions were resolved without asking, so proceed on them unless "
                    "the user corrects one):\n" + design.to_markdown()
                )
        if plan is not None:
            section += (
                "\n\nCURRENT PLAN (auto-synchronized — this reflects your own plan_* tool calls in "
                "real time; keep it accurate as you work):\n" + plan.to_markdown()
            )
        # Fold the structured investigation memory in too, so its evidence-first
        # state (findings/hypotheses/failed attempts/…) rides in the system prompt
        # and SURVIVES a context-window summarization/reset intact — the raw
        # messages get discarded, this does not.
        inv = investigation.get_active()
        if inv is not None and not inv.is_empty():
            section += (
                "\n\nINVESTIGATION MEMORY (structured & evidence-first; survives context resets — keep it "
                "current with record_finding / record_hypothesis / update_hypothesis / record_failed_attempt "
                "/ record_decision / record_test_result / set_next_steps):\n" + inv.to_markdown()
            )
        # Fold the BUILD LEDGER in too — the physical manifest of a large,
        # multi-artifact modification (components done vs planned, files produced,
        # offsets patched, verifications). Aggregate-first and bounded, it rides in
        # the prompt and SURVIVES a summarization/reset just like investigation
        # memory, so a many-hour / many-subagent build never loses track of how
        # much is done or what's left.
        lg = ledger.get_active()
        if lg is not None and not lg.is_empty():
            section += (
                "\n\nBUILD LEDGER (physical build accounting; survives context resets — keep it current with "
                "ledger_add_component / ledger_set_component_status / ledger_record_artifact / "
                "ledger_record_patch / ledger_record_verification; treat THIS, not the transcript, as the "
                "source of truth for what's built and what remains):\n" + lg.to_markdown()
            )
        if PREMIUM_BUDGET:
            used = self.session.get("premium_dispatches", 0)
            section += (f"\n\n[premium budget: {used}/{PREMIUM_BUDGET} premium "
                         "subagent dispatches used this session]")
        section += "\n\n" + _ultra_prompt_segment(self.session)
        section += "\n\n" + _device_prompt_segment(self.session)
        self.session["messages"][0]["content"] = (
            self.session["base_system_prompt"] + "\n" + tools_section + section
        )

    def _on_plan_update(self, plan_dict):
        """Bridge from planning.py's generic notify callback to this app's
        webview event stream + live system prompt. planning.py itself has no
        knowledge of pywebview/agent.py session internals."""
        self._refresh_system_prompt()
        self._emit({"type": "plan_update", "plan": plan_dict})

    def _on_investigation_update(self, inv_dict):
        """Bridge from investigation.py's notify callback to the webview event
        stream + live system prompt (mirrors _on_plan_update). Keeps the
        structured investigation memory visible in the prompt in real time."""
        self._refresh_system_prompt()
        self._emit({"type": "investigation_update", "investigation": inv_dict})

    def _on_ledger_update(self, ledger_dict):
        """Bridge from ledger.py's notify callback to the live prompt + event
        stream (mirrors _on_investigation_update). Keeps the physical build
        manifest visible in the prompt in real time."""
        self._refresh_system_prompt()
        self._emit({"type": "ledger_update", "ledger": ledger_dict})

    def _on_strategy_update(self, brief_dict):
        """Bridge from strategy.py's notify callback to the live prompt + event
        stream (mirrors _on_plan_update / _on_investigation_update)."""
        self._refresh_system_prompt()
        self._emit({"type": "strategy_update", "strategy": brief_dict})

    def _on_design_brief_update(self, brief_dict):
        """Bridge from superpowers.py's notify callback to the live prompt + event
        stream (mirrors _on_strategy_update). Keeps the auto-brainstorm's Design
        Brief pinned in the prompt in real time."""
        self._refresh_system_prompt()
        self._emit({"type": "design_brief_update", "design_brief": brief_dict})

    # --- plan-driven delegation ------------------------------------------------
    def _auto_delegate_untagged_steps(self, plan):
        """Tag obviously-delegatable steps of the ACTIVE phase, so fan-out does
        not depend on the model remembering to ask for it.

        Advisory nudges alone were not enough — an observed 300-step run produced
        two subagents. This closes the gap for the cases where delegation is
        unambiguous, and deliberately leaves everything else alone:

          * A WAVE of >=2 independent research steps -> researcher (cheap). They
            run concurrently, so this is the real speed win.
          * A self-contained CHANGE step -> implementer (standard). Write
            subagents still SERIALIZE behind the workspace lock (two agents
            editing one decompiled tree corrupts it), so the win here is the
            isolated context and the cheaper model, not parallelism.

        Only PENDING, unblocked, untagged steps are eligible — an in_progress
        step may be one the model is actively doing itself, and a step with
        unmet dependencies is not ready for anyone. Every tag is announced in
        the chat and to the model, which stays free to retag or clear it.
        OMNI_AUTO_DELEGATE=0 disables this entirely."""
        s = self.session
        if not AUTO_DELEGATE or not s.get("delegation_enabled", True):
            return
        # Superpowers inline-only: the user asked to keep execution in this context,
        # so the harness never auto-tags steps for subagents (explicit delegate= tags
        # the model sets itself are still honored downstream).
        if s.get("superpowers_enabled") and s.get("inline_only"):
            return
        if not getattr(plan, "current_phase_id", None):
            return
        reg = plugins.get_registry()

        def _live(tag):
            """The tag, if its agent actually exists — else None, so a missing
            persona degrades to no auto-delegation instead of manufacturing the
            'Unknown delegate agent' error path."""
            return tag if reg.get_agent(_split_delegate(tag)[0]) is not None else None

        pool = [it for it in plan.items
                if it.get("phase_id") == plan.current_phase_id
                and it.get("status") == "pending"
                and not (it.get("delegate") or "").strip()
                and not [d for d in (it.get("depends_on") or []) if d]]
        if not pool:
            return

        # A judgment call (deciding between approaches, choosing a strategy) may
        # read as "research" by keyword, but auto-delegating it offloads the
        # orchestrator's own reasoning to a cheap agent — never do that. The
        # nudge still mentions these; the harness just won't tag them itself.
        pool = [it for it in pool
                if not _hits_hints(_step_text(it), _JUDGMENT_HINTS)]
        if not pool:
            return

        picks = []
        read_tag = _live(AUTO_DELEGATE_READ_TAG)
        reads = [it for it in pool if _looks_like_research(it)]
        # Superpowers makes subagent-driven execution the DEFAULT: a single independent
        # research step is enough to fan out (floor 1), vs the conservative 2+ otherwise.
        read_min = (1 if (s.get("superpowers_enabled") and not s.get("inline_only"))
                    else AUTO_DELEGATE_READ_MIN)
        if read_tag and len(reads) >= read_min:
            picks += [(it, read_tag) for it in reads]
        write_tag = _live(AUTO_DELEGATE_WRITE_TAG)
        if write_tag:
            picks += [(it, write_tag) for it in pool
                      if _is_clear_change(it) and _is_self_contained(it)]
        if not picks:
            return

        done = []
        for step, tag in picks:
            try:
                plan.update_item(step["id"], delegate=tag)
            except Exception:
                continue          # a plan mutation must never break the loop
            done.append((step["id"], tag))
        if not done:
            return
        planning.notify_updated()

        n_read = sum(1 for _i, t in done if t == read_tag)
        n_write = len(done) - n_read
        bits = []
        if n_read:
            bits.append(f"{n_read} research step{'s' if n_read != 1 else ''} → "
                        f"{_split_delegate(read_tag)[0]} (parallel)")
        if n_write:
            bits.append(f"{n_write} change step{'s' if n_write != 1 else ''} → "
                        f"{_split_delegate(write_tag)[0]} (serialized)")
        self._emit({"type": "system",
                    "content": "Auto-delegated " + ", ".join(bits) + "."})
        listing = "; ".join(f"({i}) → {t}" for i, t in done)
        s["messages"].append({"role": "user", "content": (
            f"[SYSTEM] Auto-delegated these unblocked, untagged steps: {listing}. Read agents "
            "run as ONE parallel wave; write agents run one at a time on the shared workspace. "
            "Their distilled reports fold back here — you do NOT need to redo their work. If one "
            "was a bad fit, retag it (plan_update_task delegate=\"<agent>@<tier>\") or clear the "
            "delegate to take it back."
        )})

    def _premium_budget_gate(self, tier):
        """Ration premium. Returns (effective_tier, note). A premium request over
        the soft cap degrades to 'standard' (never blocked); an allowed premium
        request increments the session counter. Non-premium tiers pass untouched.
        PREMIUM_BUDGET == 0 disables the cap entirely. (Rate-limit degradation is
        already handled by models_for_tier's failover body — this only rations.)"""
        if llm._norm_tier(tier) != "premium":
            return tier, ""
        if not PREMIUM_BUDGET:
            return "premium", ""
        used = self.session.get("premium_dispatches", 0)
        if used >= PREMIUM_BUDGET:
            return "standard", (f"premium budget exhausted ({used}/{PREMIUM_BUDGET}) "
                                "— ran standard")
        self.session["premium_dispatches"] = used + 1
        return "premium", ""

    def _maybe_dispatch_delegated_steps(self):
        """Dispatch delegated plan steps of the ACTIVE phase. Parallel-by-default:
        every ready independent READ step (deps satisfied) fans out in ONE wide wave
        via run_subagents_parallel; WRITE steps run serially behind the workspace
        lock. Loops until no step is ready (a completed dependency can unblock more).
        With session['parallel_execution_enabled'] False, falls back to dispatching
        only steps already marked in_progress, one at a time (legacy behavior).
        Only distilled reports fold back into the main context, never transcripts."""
        s = self.session
        if not s.get("delegation_enabled", True):
            return
        plan = s.get("plan") or planning.get_active_plan()
        if plan is None:
            return
        # Tag obviously-delegatable steps BEFORE candidates are computed, so a
        # freshly auto-tagged step joins THIS dispatch pass instead of waiting
        # for the next plan tool call.
        self._auto_delegate_untagged_steps(plan)
        dispatched = s.setdefault("dispatched_steps", set())
        reg = plugins.get_registry()
        parallel = s.get("parallel_execution_enabled", True)

        def _resolve(step):
            """Return (AgentDef, tier) for a step's delegate, or (None, None) — and
            surface the unknown-agent nudge, marking it dispatched so we don't retry."""
            name, tier = _split_delegate(step.get("delegate"))
            ad = reg.get_agent(name)
            if ad is None:
                dispatched.add(step["id"])
                names = ", ".join(a.name for a in plugins.list_agents()) or "(none configured)"
                self._emit({"type": "system",
                            "content": f"Unknown delegate agent '{name}' — the agent will handle the step itself."})
                s["messages"].append({"role": "user", "content": (
                    f"[SYSTEM] Plan step ({step['id']}) is tagged delegate='{name}', but no such subagent "
                    f"exists (available: {names}). Do this step yourself, or fix/clear the delegate name.")})
                return None, None
            return ad, tier

        # Bounded loop: each pass dispatches the currently-ready batch; a completed
        # dependency can make more steps ready on the next pass. Capped so a
        # pathological dependency cycle degrades to "nothing ready" instead of hanging.
        for _ in range(len(plan.items) + 1):
            if parallel:
                candidates = plan.ready_delegatable_steps(dispatched)
            else:
                # Legacy: only steps the model has explicitly started, untouched.
                candidates = [it for it in plan.items
                              if it.get("status") == "in_progress" and (it.get("delegate") or "").strip()
                              and it["id"] not in dispatched]
            if not candidates:
                return

            wave, writes = [], []
            for step in candidates:
                ad, tier = _resolve(step)
                if ad is None:
                    continue
                tier, budget_note = self._premium_budget_gate(tier)
                if budget_note:
                    self._emit({"type": "delegate_note", "agent": ad.name,
                                "content": budget_note})
                dispatched.add(step["id"])
                if parallel and step.get("status") != "in_progress":
                    # Harness-initiated start of a pulled-forward step: mark it live so
                    # the plan/UI reflect it, exactly like a model-started step.
                    plan.update_item(step["id"], status="in_progress")
                # Reads always fan out. A WRITE step joins the same wave as soon as it
                # declares the paths it owns (`scope`): subagents.ScopedWorkspaceLock
                # lets disjoint owners run at once and makes overlapping ones queue, so
                # a many-package change progresses in parallel while staying safe. A
                # write step with no scope claims the whole workspace, so it stays on
                # the serial path below.
                if not ad.is_write or step.get("scope"):
                    wave.append((step, ad.name, ad, tier))
                else:
                    writes.append((step, ad.name, ad, tier))
            planning.notify_updated()

            if wave:
                try:
                    self._run_delegated_wave(plan, wave)
                except Exception as e:
                    for step, _name, _ad, _tier in wave:
                        s["messages"].append({"role": "user", "content": (
                            f"[SYSTEM] Delegation of step ({step['id']}) failed to start ({e}). "
                            "Handle this step yourself.")})

            for step, name, ad, tier in writes:
                try:
                    task = self._compose_delegate_task(step)
                    context = self._compose_delegate_context(plan)
                    self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                                "content": f"Delegating step ({step['id']}) to subagent '{name}' ({ad.mode})…"})
                    # Only pass `scope` when the step actually declares one, keeping
                    # the historical call shape for unscoped writes (which is all
                    # that reaches this serial path) intact.
                    _extra = {"scope": step["scope"]} if step.get("scope") else {}
                    result = subagents.run_subagent(ad, task, context=context,
                                                    run_dir=getattr(self, "_delegate_run_dir", None),
                                                    tier=tier, **_extra)
                    self._fold_delegate_result(plan, step, name, ad, result)
                except Exception as e:
                    s["messages"].append({"role": "user", "content": (
                        f"[SYSTEM] Delegation of step ({step['id']}) failed to start ({e}). "
                        "Handle this step yourself.")})

            if not parallel:
                # Legacy path handled the started step(s) once; don't loop-pull more.
                return

    def _run_delegated_wave(self, plan, reads):
        """Run a batch of independent delegated steps as ONE parallel wave
        (subagents.run_subagents_parallel), streaming each worker's live telemetry
        to self._emit as it arrives instead of buffering it until the whole wave
        finishes. Runs the wave in a background thread and drains a thread-safe
        queue on the calling (main) thread — self._emit is only ever called from
        the main thread this way, same as the rest of the event stream.

        The wave carries every READ step plus every SCOPED write step; each spec
        passes its step's `scope` down so writers that own disjoint paths execute
        concurrently and overlapping ones serialize inside the subagent layer.

        NOTE: run_dir is intentionally NOT threaded into run_subagents_parallel
        here (unlike the serial write path below) — _delegate_run_dir is not
        currently set anywhere, so this is a no-op today either way."""
        import queue as _queue
        evq = _queue.Queue()
        specs = [{"agent_def": ad, "task": self._compose_delegate_task(step),
                  "context": self._compose_delegate_context(plan), "tier": tier,
                  "scope": step.get("scope")}
                 for (step, _name, ad, tier) in reads]
        for step, name, ad, _tier in reads:
            _how = ("read" if not ad.is_write
                    else "write, owns " + ", ".join(step.get("scope") or []))
            self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                        "content": f"Delegating step ({step['id']}) to subagent '{name}' ({_how}) in a parallel wave…"})
        holder = {}
        _SENTINEL = {"type": "__wave_done__"}

        def work():
            try:
                holder["results"] = subagents.run_subagents_parallel(specs, on_event=evq.put)
            except Exception as e:
                holder["error"] = e
            finally:
                evq.put(_SENTINEL)

        t = threading.Thread(target=work, daemon=True)
        t.start()
        while True:
            ev = evq.get()
            if ev is _SENTINEL:
                break
            self._emit(ev)
        t.join()

        results = holder.get("results") or []
        if holder.get("error") is not None or len(results) != len(reads):
            # Wave-level (infrastructure) failure, or a partial/empty result list —
            # either way every dispatched read step already has its id in
            # dispatched_steps, so it must be folded here or it stalls in_progress
            # forever with no failure ever surfaced.
            err = holder.get("error")
            for step, name, ad, _tier in reads:
                result = {"agent": name, "ok": False,
                          "report": f"(delegation wave failed to start: {err})" if err is not None
                                    else "(delegation wave returned no result for this step)",
                          "steps": 0, "tokens": 0}
                self._fold_delegate_result(plan, step, name, ad, result)
            return

        for (step, name, ad, _tier), result in zip(reads, results):
            self._fold_delegate_result(plan, step, name, ad, result)

    def _compose_delegate_task(self, step):
        parts = [(step.get("content") or "").strip()]
        for label, key in (("Action", "action"), ("Goal", "purpose"),
                           ("Expected result", "expected"), ("Done when", "verification"),
                           ("Fallback if it fails", "fallback")):
            if step.get(key):
                parts.append(f"{label}: {step[key]}")
        return "\n".join(p for p in parts if p)

    def _compose_delegate_context(self, plan):
        bits = [f"Overall mission: {plan.task}"]
        if plan.success_criteria:
            bits.append("Success criteria: " + "; ".join(plan.success_criteria))
        if plan.constraints:
            bits.append("Constraints: " + "; ".join(plan.constraints))
        cur = plan.current_phase()
        if cur:
            bits.append(f"Current phase: {cur['title']}")
        # A minimal read-only slice of the Strategic Brief so a delegated subagent
        # pulls in the orchestrator's direction — NEVER the full brief (no diagnosis
        # internals, rejected alternatives, or kill-criteria) and never any strategy_*
        # tool. Subagents execute a scoped task; they do not re-strategize.
        if self.session and self.session.get("strategy_brief_enabled"):
            brief = strategy.get_active()
            if brief is not None and not brief.is_empty():
                if brief.strategy:
                    bits.append("Chosen strategy: " + brief.strategy)
                if brief.hypothesis:
                    bits.append("Current top hypothesis: " + brief.hypothesis)
        return "\n".join(bits)

    def _fold_delegate_result(self, plan, step, agent_name, agent_def, result):
        """Post-`run_subagent` fold-back: distill the subagent's report into the
        MAIN context, persist it into durable investigation memory, and update the
        plan step's status — shared by both the serial dispatch path above and the
        parallel wave path (_run_delegated_wave)."""
        self.session["solo_read_streak"] = 0
        s = self.session
        report = (result.get("report") or "").strip()
        ok = bool(result.get("ok"))
        artifacts = result.get("artifacts") or []
        self._emit({"type": "delegate_done", "agent": agent_name, "step_id": step["id"],
                    "ok": ok, "steps": result.get("steps", 0),
                    "report": _ui_trunc(report, UI_THOUGHT_CAP)})

        # Fold the distilled report into the MAIN context — never the transcript.
        folded = (f"[DELEGATE RESULT — subagent '{agent_name}' handled plan step ({step['id']}): "
                  f"{step.get('content', '')}]\n{report or '(no report returned)'}")
        if artifacts:
            folded += "\n\nArtifacts written: " + ", ".join(str(a) for a in artifacts)
        folded += ("\n\nThis is the subagent's DISTILLED report — its intermediate tool calls stayed in its own "
                   "context. Verify anything you build on, then continue the plan from here.")
        s["messages"].append({"role": "user", "content": folded})

        # Persist into durable investigation memory so it survives a context reset.
        try:
            inv = investigation.get_active()
            if inv is not None and report:
                inv.add_finding(f"[delegate:{agent_name}] {report[:600]}",
                                evidence=f"subagent '{agent_name}' on plan step {step['id']}")
                investigation.notify_updated()
        except Exception:
            pass

        # Update the step; keep the verification discipline for a delegated WRITE.
        note = f"delegated to {agent_name} — {'completed' if ok else 'returned without success'}"
        plan.update_item(step["id"], status="completed" if ok else "in_progress", notes=note)
        if ok and agent_def.is_write:
            # A delegated write changed the SHARED workspace, so make the main loop's
            # validation gate insist on an objective check, exactly as for a local edit.
            s["unverified_change"] = f"delegated change by subagent '{agent_name}' (step {step['id']})"
        planning.notify_updated()

    # --- GSD context-hygiene: re-grounding -------------------------------------
    def _situation_block(self):
        """A compact SITUATION snapshot built from DURABLE state (plan +
        investigation), used to re-anchor the model on a long run. Deliberately
        bounded so it never itself bloats the context it's protecting."""
        s = self.session
        lines = ["[SITUATION CHECK — periodic re-grounding so the original goal and current focus don't get "
                 "diluted over a long run. Nothing new here; re-anchor and continue.]"]
        plan = planning.get_active_plan()
        goal = s.get("original_task") or (plan.task if plan else "")
        if goal:
            lines.append(f"Goal: {goal[:400]}")
        if plan is not None:
            cur = plan.current_phase()
            if cur:
                done, total = plan.progress()
                lines.append(f"Current phase: {cur['title']}  (steps {done}/{total} done)")
            if plan.success_criteria:
                lines.append("Success criteria: " + "; ".join(plan.success_criteria[:4]))
            if plan.next_action:
                lines.append(f"Next action: {plan.next_action[:300]}")
        inv = investigation.get_active()
        if inv is not None and not inv.is_empty():
            finds = (inv.data.get("findings") or [])[-3:]
            if finds:
                lines.append("Recent confirmed findings: "
                             + " | ".join((f.get("text", "") or "")[:120] for f in finds))
            oqs = (inv.data.get("open_questions") or [])[-3:]
            if oqs:
                lines.append("Open questions: "
                             + " | ".join((o.get("text", "") or "")[:120] for o in oqs))
        lines.append("Re-anchor on the current phase's steps. If the plan or investigation memory is stale, "
                     "update it before continuing rather than working from memory of this chat.")
        return "\n".join(lines)

    def _maybe_reground(self, force=False):
        """Inject a SITUATION block every REGROUND_EVERY tool calls (or when forced,
        e.g. right after a phase advance). No-op unless context-hygiene is on and
        there's durable state worth re-anchoring to."""
        s = self.session
        if not s.get("context_hygiene"):
            return
        s["steps_since_reground"] = s.get("steps_since_reground", 0) + (0 if force else 1)
        if not force and s["steps_since_reground"] < REGROUND_EVERY:
            return
        if planning.get_active_plan() is None and s.get("original_task") is None:
            return  # nothing durable to re-ground against yet
        s["steps_since_reground"] = 0
        s["messages"].append({"role": "user", "content": self._situation_block()})
        self._emit({"type": "system", "content": "Re-grounding on the goal and current plan (context hygiene)."})

    def _plugin_hook_context(self, event, **extra):
        """The durable-signal context dict passed to plugin lifecycle hooks. Hooks
        get read-only runtime signals (never the raw transcript) plus any per-event
        extras (e.g. the tool name, or the final answer text)."""
        s = self.session
        plan = planning.get_active_plan()
        ctx = {
            "event": event,
            "step": s.get("step_count", 0),
            "tools_used": s.get("tools_used", 0),
            "active_toolsets": sorted(s.get("active_toolsets", set()) or set()),
            "goal": s.get("original_task") or (plan.task if plan else ""),
            "phase": (plan.current_phase() or {}).get("title", "") if plan else "",
            "context_hygiene": bool(s.get("context_hygiene")),
        }
        ctx.update(extra)
        return ctx

    def _fire_plugin_hooks(self, event, **extra):
        """Fire every enabled plugin's hooks for `event` and surface their advice.

        This is the LIVE side of the plugin hook system (plugins.py loads hooks; this
        runs them). Hooks are ADVISORY — a hook may return a dict carrying:
          - "inject": <text> -> appended as a [PLUGIN] steering message the model sees
                                 next turn (same mechanism as native re-grounding nudges)
          - "note":   <text> -> shown to the user as a system line, not fed to the model
        Anything else is ignored. Never raises (a bad hook can't break the loop) and is
        a zero-cost no-op when no plugin registered a hook for this event — so existing
        setups with no hook-bearing plugins are completely unaffected.

        Returns the number of `inject` advisories surfaced this call. Advisory events
        (pre_tool/post_tool/on_phase_change) ignore the return; the on_final_answer gate
        uses it to decide whether to send the answer back for more work (bounded)."""
        injected = 0
        try:
            if not plugins.has_hooks(event):
                return 0
            ctx = self._plugin_hook_context(event, **extra)
            for res in plugins.run_hook(event, ctx):
                if not isinstance(res, dict):
                    continue
                who = res.get("plugin") or "plugin"
                inject = res.get("inject")
                if inject:
                    self.session["messages"].append(
                        {"role": "user", "content": f"[PLUGIN:{who}] {str(inject).strip()}"})
                    self._emit({"type": "system",
                                "content": f"Plugin advisory ({who}) added to the run."})
                    injected += 1
                note = res.get("note")
                if note:
                    self._emit({"type": "system", "content": str(note).strip()})
                err = res.get("hook_error")
                if err:
                    self._emit({"type": "system", "content": f"(plugin hook error: {err})"})
        except Exception:
            pass  # a hook problem must never break the agent loop
        return injected

    # --- public API (called from JS) ----------------------------------------
    def get_projects(self):
        """Recently-used workspace folders, most-recent first, plus the persisted
        last-used default. A 'project' is just a host folder you picked.

        Each entry carries what the picker shows in its list: label, absolute
        path, when it was last opened, and how many messages its saved chat holds
        (0 when there is no saved chat). Folders that no longer exist are dropped.
        """
        s = _load_ws_settings()
        recent = []
        for r in s.get("recent", []):
            if not isinstance(r, dict):
                continue
            path = r.get("path")
            if not path or not os.path.isdir(path):
                continue
            recent.append({
                "label": r.get("label") or _ws_label(path),
                "path": path,
                "opened_at": r.get("opened_at"),
                "message_count": self._saved_message_count(path),
            })
        return {"ok": True, "recent": recent, "last": s.get("last")}

    @staticmethod
    def _saved_message_count(root):
        """How many turns the saved chat for this folder holds, for the picker's
        list. Counts the UI transcript rather than the LLM message list, since
        that is what the user would actually see on reopening. Best-effort: any
        unreadable or absent file simply reports 0."""
        try:
            path = os.path.join(_memory_dir_for(root), TRANSCRIPT_FILENAME)
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            return len(data) if isinstance(data, list) else 0
        except (OSError, ValueError):
            return 0

    def reveal_in_finder(self, path):
        """Open a path in the host file manager.

        Accepts either an absolute host path (the workspace picker passes one,
        and has no session yet) or a workspace-relative path (the file tree's
        context menu). Relative paths go through _safe_abs, so the tree can never
        use this to reveal something outside the workspace.
        """
        raw = (path or "").strip()
        if os.path.isabs(raw):
            target = os.path.abspath(raw)
        else:
            try:
                target = self._safe_abs(raw, must_exist=True)
            except ValueError as e:
                return {"ok": False, "error": str(e)}
        if not os.path.exists(target):
            return {"ok": False, "error": f"Not found: {target}"}
        try:
            if sys.platform == "darwin":
                subprocess.run(["open", "-R", target], check=False)
            elif sys.platform.startswith("win"):
                os.startfile(os.path.dirname(target) if os.path.isfile(target) else target)  # noqa: S606
            else:
                subprocess.run(["xdg-open", target if os.path.isdir(target)
                                else os.path.dirname(target)], check=False)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}

    def select_workspace(self, path=None):
        """Pick (or accept) a host folder to use as the workspace ROOT: validate
        it, persist it as last-used, and make it the folder every tool command
        runs in (set_workspace also reports any missing tools). Selecting a new
        folder just re-points it. Pass an explicit `path` to skip the dialog
        (recent list / automation)."""
        if not path:
            picked = self.pick_folder()
            if not picked.get("ok"):
                return picked
            path = picked.get("path")
            if not path:
                return {"ok": True, "cancelled": True}
        if not os.path.isdir(path):
            return {"ok": False, "error": f"Not a folder: {path}"}
        root = set_active_workspace(path)
        self._emit({"type": "log", "content": f"[Workspace] Activating {root}..."})
        try:
            set_workspace(root)   # make it the command cwd + tool preflight
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "path": root, "label": _ws_label(root)}

    def create_project(self, name):
        """Deprecated in the picked-folder model — kept so old UI calls fail
        cleanly instead of tracebacking."""
        return {"ok": False,
                "error": "Projects are folders now — use 'Select workspace folder' to pick one."}

    def delete_workspace(self, path=None):
        """Forget a workspace: drop it from the recent list and delete its
        agent-side conversation/memory. Does NOT touch the user's picked folder
        on disk — that is their real project."""
        path = (path or "").strip()
        if not path:
            return {"ok": False, "error": "No workspace path given."}
        ap = os.path.abspath(path)
        if self.session and self.session.get("root") == ap:
            return {"ok": False, "error": "That workspace has an active session — end it first."}
        s = _load_ws_settings()
        s["recent"] = [r for r in s.get("recent", []) if r.get("path") != ap]
        if s.get("last") == ap:
            s["last"] = s["recent"][0]["path"] if s["recent"] else None
        _save_ws_settings(s)
        mem = _memory_dir_for(ap)
        if os.path.isdir(mem):
            try:
                shutil.rmtree(mem)
            except OSError as e:
                return {"ok": False, "error": f"Removed from list but memory cleanup failed: {e}"}
        return {"ok": True, "path": ap}

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

    def import_workspace(self, project_name=None, source_path=None):
        """Deprecated: the agent no longer copies an external folder into a fixed
        workspace. Pick the folder directly with select_workspace — it is used
        and edited in place on this machine, so there is nothing to copy in or
        export back out."""
        return {"ok": False,
                "error": "Import/copy is gone — pick the folder itself with "
                         "'Select workspace folder'; it is edited in place."}

    def get_import_status(self, project_name=None):
        try:
            meta = _read_import_meta(_project_root(project_name))
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}
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
        try:
            project_dir = _project_root(project_name)
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}
        if not os.path.isdir(project_dir):
            return {"ok": False, "error": "Workspace folder no longer exists."}

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
        try:
            project_dir = _project_root(project_name)
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}
        if not os.path.isdir(project_dir):
            return {"ok": False, "error": "Workspace folder no longer exists."}
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
                    "reasoning_effort": eff.get("reasoning_effort", ""),
                    "reasoning_style": eff.get("reasoning_style", ""),
                    "temperature": eff.get("temperature"),
                    "context_window": eff.get("context_window"),
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
            "reasoning_effort": cfg.get("reasoning_effort"),
            "reasoning_style": cfg.get("reasoning_style"),
            "temperature": cfg.get("temperature"),
            "context_window": cfg.get("context_window"),
        })
        if not ok:
            return {"ok": False, "error": "Failed to write llm_config.json (check file permissions)."}
        eff = get_effective_config()
        return {"ok": True, "provider": eff["provider"], "model": eff["model"], "label": eff["label"]}

    def get_llm_configs(self):
        """Return the ordered list of configured providers (fallback priority) plus
        the preset metadata the settings UI needs. API keys are included so the edit
        form can prefill; this is a local single-user webview and they never leave
        the machine."""
        try:
            configs = [{
                "id": e["id"],
                "name": e["name"],
                "provider": e["provider"],
                "label": e["label"],
                "protocol": e["protocol"],
                # DECOUPLED: a shared key pool + separate text/vision model ladders.
                # Singular api_key/model are the first of each, for older UI paths.
                "api_keys": e.get("api_keys", []),
                "models": e.get("models", []),
                "vision_models": e.get("vision_models", []),
                "model": e["model"],
                "base_url": e["base_url"],
                "api_key": e["api_key"],
                "max_tokens": e["max_tokens"],
                "reasoning_effort": e.get("reasoning_effort", ""),
                "reasoning_style": e.get("reasoning_style", ""),
                # Per-model reasoning overrides {model_id: {reasoning_effort, reasoning_style}}.
                "model_settings": e.get("model_settings", {}),
                "temperature": e.get("temperature"),
                "context_window": e.get("context_window"),
            } for e in get_effective_configs()]
            return {"ok": True, "configs": configs, "providers": list_providers()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_llm_configs(self, configs):
        """Persist the whole ordered provider list (the order IS the fallback
        chain). Called by the settings UI on add/edit/delete/reorder."""
        if not isinstance(configs, list):
            return {"ok": False, "error": "Expected a list of LLM configs."}
        valid = {p["id"] for p in list_providers()}
        clean = []
        for c in configs:
            if not isinstance(c, dict):
                continue
            provider = (c.get("provider") or "").strip()
            if provider not in valid:
                return {"ok": False, "error": f"Unknown provider '{provider}'."}
            entry = {
                "id": (c.get("id") or "").strip() or None,
                "name": (c.get("name") or "").strip(),
                "provider": provider,
                "api_key": (c.get("api_key") or "").strip(),
                "model": (c.get("model") or "").strip(),
                "base_url": (c.get("base_url") or "").strip(),
                "max_tokens": c.get("max_tokens"),
                "reasoning_effort": c.get("reasoning_effort"),
                "reasoning_style": c.get("reasoning_style"),
                "temperature": c.get("temperature"),
                "context_window": c.get("context_window"),
            }
            # Decoupled pool/ladders when the UI sends them (lists win over singular).
            if isinstance(c.get("api_keys"), list):
                entry["api_keys"] = [str(k).strip() for k in c["api_keys"] if str(k).strip()]
            if isinstance(c.get("models"), list):
                entry["models"] = [str(m).strip() for m in c["models"] if str(m).strip()]
            if isinstance(c.get("vision_models"), list):
                entry["vision_models"] = [str(m).strip() for m in c["vision_models"] if str(m).strip()]
            # Per-model reasoning overrides; llm.save_configs normalizes/prunes them.
            if isinstance(c.get("model_settings"), dict):
                entry["model_settings"] = c["model_settings"]
            clean.append(entry)
        if not save_configs(clean):
            return {"ok": False, "error": "Failed to write llm_config.json (check file permissions)."}
        effs = get_effective_configs()
        primary = effs[0] if effs else None
        return {
            "ok": True,
            "count": len(effs),
            "primary": ({"name": primary["name"], "label": primary["label"], "model": primary["model"]}
                        if primary else None),
        }

    def test_llm_config(self, cfg):
        try:
            overrides = None
            if isinstance(cfg, dict):
                # Probe the FIRST key of the pool against the FIRST (primary) model
                # of the ladder — that's what a decoupled entry leads with.
                api_key = cfg.get("api_key")
                if isinstance(cfg.get("api_keys"), list) and cfg["api_keys"]:
                    api_key = cfg["api_keys"][0]
                model = cfg.get("model")
                if isinstance(cfg.get("models"), list) and cfg["models"]:
                    model = cfg["models"][0]
                overrides = {
                    "provider": ((cfg.get("provider") or "").strip() or None),
                    "api_key": api_key,
                    "model": model,
                    "base_url": cfg.get("base_url"),
                    "max_tokens": cfg.get("max_tokens"),
                    "reasoning_effort": cfg.get("reasoning_effort"),
                    "reasoning_style": cfg.get("reasoning_style"),
                    "temperature": cfg.get("temperature"),
                }
            return test_connection(overrides)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_active_llm(self):
        """The provider currently serving requests (sticky active, or the primary
        if no call has landed yet). Used by the UI to populate its active-LLM badge
        on load/refresh; live changes arrive via 'active_llm' events."""
        try:
            info = get_active_provider()
            return {"ok": True, "active": info}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_model_options(self):
        """Every text-model rung in fallback order for the composer's model
        selector, plus which one is pinned and which is actively serving."""
        try:
            return {
                "ok": True,
                "options": list_model_options(),
                "preferred": get_preferred_model(),
                "active": get_active_provider(),
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_preferred_model(self, config_id, model):
        """Pin the model requests start at (fallback then goes downward only).
        A falsy model clears the pin (start from the primary again)."""
        try:
            if not set_preferred_model(config_id, model):
                return {"ok": False, "error": "Failed to write llm_config.json."}
            return {"ok": True, "preferred": get_preferred_model()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_model_effort(self, config_id, model, effort):
        """Set one model's reasoning effort from the composer's inline menu.
        Writes the same model_settings field the LLM settings panel edits, and
        returns the refreshed option list so the composer re-renders from truth
        rather than assuming the write landed."""
        try:
            if not set_model_effort(config_id, model, effort):
                return {"ok": False, "error": "Could not save the effort setting."}
            return {"ok": True, "options": list_model_options()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def start_session(self, project=None):
        # `project` may be an absolute folder path (recent list / just-picked
        # folder) or None (use the active/last-used workspace).
        if project and os.path.isdir(project):
            set_active_workspace(project)
        try:
            root = active_workspace()
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}
        project_name = _ws_label(root)
        memory_dir = _memory_dir_for(root)
        os.makedirs(memory_dir, exist_ok=True)

        # Ensure the picked folder is the active workspace. Skip if
        # select_workspace already activated this exact root.
        try:
            from host_exec import workspace_root
            already_active = (workspace_root() == root)
        except Exception:
            already_active = False
        if not already_active:
            self._emit({"type": "log", "content": f"[Workspace] Activating {root}..."})
            try:
                set_workspace(root)
            except Exception as e:
                return {"ok": False, "error": f"Workspace could not be activated: {e}"}
        self._emit({"type": "log", "content": "[Workspace] Ready."})

        # Build the static base to MATCH how requests are sent: native-aware when
        # the active model uses the function-calling interface. _refresh_system_prompt
        # recomputes this if the model changes mid-session.
        session_native = active_supports_native_tools()
        base_system_prompt = get_static_system_prompt(native_tools=session_native)

        # Prefer restoring the full prior conversation (so the agent can CONTINUE
        # from the old chat). Fall back to the latest memory summary only if there
        # is no saved conversation for this project.
        saved_messages, saved_transcript, saved_task, saved_stats = self._load_persisted(memory_dir)
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
            # No saved conversation — resume from HANDOFF.md if a prior run left one
            # (workspace root first, then the legacy per-project summary files).
            handoff_path = _handoff_path(root, memory_dir)
            if os.path.isfile(handoff_path):
                try:
                    with open(handoff_path, "r", encoding="utf-8") as f:
                        last_summary_text = f.read().strip()
                    messages.append({"role": "assistant", "content": (
                        "[HANDOFF] Resuming from HANDOFF.md left by a prior session:\n\n" + last_summary_text)})
                except OSError:
                    last_summary_text = None
            if last_summary_text is None:
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
            "root": root,
            "messages": messages,
            "base_system_prompt": base_system_prompt,
            "native_tools": session_native,
            "memory_dir": memory_dir,
            "last_summary": last_summary_text or "",
            "transcript": saved_transcript,
            "original_task": saved_task,
            "step_count": 0,
            "last_tool_call": None,
            "consecutive_tools": 0,
            # Progressive tool disclosure: which on-demand toolsets are expanded
            # to full schemas. Starts from whatever a reopened run had active;
            # grows as the model uses/expands domain tools (see the loop).
            "active_toolsets": set(getattr(self, "_restored_active_toolsets", set()) or set()),
            # Subagents-dock snapshot restored from disk, so the menu reappears on
            # reopen (see _track_dock / _emit_session_started).
            "dock": getattr(self, "_restored_dock", None),
            # Long-run context editing: stub out stale tool results (keep recent).
            "context_editing": True,
            # Which machine work happens on: None means this computer. Restored
            # from disk (see _load_persisted) so reopening a project doesn't
            # silently drop back to local while the user thinks they're remote.
            "active_device": getattr(self, "_restored_active_device", None),
            # Ultra mode: whether the model may start workflows on its own
            # judgement (see _ultra_prompt_segment / set_ultra / get_ultra).
            # Restored from disk so the header toggle survives a restart.
            "ultra": bool(getattr(self, "_restored_ultra", False)),
            # True only while the `ultra` KEYWORD armed this turn; cleared when
            # the turn ends, and never persisted.
            "ultra_turn_only": False,
            "max_consecutive_tools": MAX_CONSECUTIVE_TOOLS,
            "loop_repeat_threshold": LOOP_REPEAT_THRESHOLD,
            "summary_resets": 0,
            # Size of the main conversation in real provider-reported tokens, and
            # the previous call's usage the per-turn delta is measured against.
            # All three are restored together: the first call after a reopen
            # re-sends the whole restored history, so without its matching prompt
            # baseline the delta would count that entire history a second time.
            # See _count_conversation_usage.
            "convo_tokens": (saved_stats or {}).get("convo_tokens", 0),
            "usage_prev_prompt": (saved_stats or {}).get("usage_prev_prompt", 0),
            "usage_prev_completion": (saved_stats or {}).get("usage_prev_completion", 0),
            "needs_plan": saved_task is None,
            "tools_since_plan_touch": 0,
            "_plan_touch_nudge_sent": False,
            "reads_since_nav": 0,
            "graph_nudges_sent": 0,
            # Skill guard: domain-work calls since a skill was consulted, nudges
            # sent, and whether a skill has been loaded this run (latches the guard off).
            "domain_tools_since_skill": 0,
            "skill_nudges_sent": 0,
            "skill_loaded": False,
            # Bare tool calls since the last explanation (drives the cadence nudge).
            "tools_since_explanation": 0,
            # Tool calls since the last narration LINE (drives the min-gap throttle).
            "tools_since_narration": 0,
            "narrated_this_task": saved_task is not None,
            # Restore the persisted header stats so the counts survive a reopen.
            "last_status": saved_stats,
            "tools_used": (saved_stats or {}).get("tools_used", 0),
            # --- evidence-based / review workflow state ---
            "review_enabled": REVIEW_ENABLED_DEFAULT,   # gate final answers on an independent review
            "review_rounds": 0,                         # revise rounds used this task
            # --- Strategic Brief workflow state ---
            "strategy_brief_enabled": STRATEGY_BRIEF_DEFAULT,
            "strategy_review_rounds": 0,        # strategy-review revise rounds this task
            # --- Superpowers Mode state ---
            "superpowers_enabled": SUPERPOWERS_DEFAULT,
            "needs_brainstorm": False,          # set per-task in send_message for non-trivial new tasks
            "needs_architect": False,           # ditto — the architect designs the plan after the brainstorm
            "inline_only": False,               # user clearly asked for inline (no subagent) execution
            "findings_since_brief_sync": 0,     # new findings since the last brief reconcile
            "evidence_guards": True,                    # repeat-failure guard + validation nudge + file tracking
            "unverified_change": None,                  # a mutating tool ran but wasn't validated yet
            "failed_sigs": {},                          # (tool,args) signatures that failed this run
            "failed_sig_warned": set(),                 # signatures we've already nudged about
            "_validation_nudged_for": None,             # last mutating tool we nudged validation for
            # --- anti-rabbit-hole assumption gate ---
            # build_observed: has the CURRENT build been installed/launched/tested on
            # the emulator (its behaviour observed) since the last recompile/sign?
            # Native anti-tamper patching before that is the classic wasted rabbit hole.
            "build_observed": False,
            "assumption_nudges_sent": 0,                # bounded native-speculation nudges this task
            # --- delegation nudges (bounded; see _maybe_nudge_delegation) ---
            "solo_read_streak": 0,              # consecutive inline read-only calls
            "solo_read_nudges_sent": 0,         # streak nudges fired this task (escalates wording)
            "premium_dispatches": 0,            # premium subagent dispatches this session
            "premium_budget_nudged": 0,         # escalating near-cap nudges sent (Task 6)
            "_delegation_phase_nudged": set(),  # (phase_id, candidate-set) sigs already nudged
            # --- adaptive planning loop policy ---
            "adaptive_planning": ADAPTIVE_PLANNING_DEFAULT,
            "mutating_gate_nudged": False,              # one-time soft nudge fired on the first unplanned mutation
            # Plan-driven delegation: a plan step tagged with `delegate` auto-runs in
            # an isolated subagent when marked in_progress; only its distilled report
            # returns to this conversation. dispatched_steps tracks ids already handed off.
            "delegation_enabled": ADAPTIVE_PLANNING_DEFAULT,
            "dispatched_steps": set(),
            # Parallel-by-default execution: dispatch ALL ready independent delegated
            # steps of the active phase as one wide wave (vs one at a time). Kill
            # switch — False restores strict one-step dispatch.
            "parallel_execution_enabled": ADAPTIVE_PLANNING_DEFAULT,
            # GSD context-hygiene: periodic re-grounding against context rot.
            "context_hygiene": ADAPTIVE_PLANNING_DEFAULT,
            "steps_since_reground": 0,
            "final_plan_nudges": 0,                     # premature final answers deflected
            "replan_required": False,                   # watchdog demands a plan_replan before more work
            "watchdog_tool": None,                      # tool currently failing repeatedly
            "tool_fail_streak": 0,                      # consecutive failures of watchdog_tool
        }

        # Strategic Brief tools live in the non-core "strategy" group; when the
        # feature is on they must be ACTIVE so the native function-calling tools=
        # payload (openai_tools_for(active_toolsets)) offers strategy_set/update —
        # otherwise a native-tools model can't call them. Off: never seeded, so the
        # active set (and the OFF prompt) is unchanged.
        if self.session.get("strategy_brief_enabled"):
            self.session["active_toolsets"].add("strategy")

        # Plan-and-execute: resume a previous in-progress plan for this
        # project (if any), otherwise start clean. notify=False here since
        # self.session isn't fully wired to _on_plan_update semantics
        # (base_system_prompt refresh) until after session_started fires.
        # Workflow run directories live under <memory_dir>/workflows/<run_id>/.
        # Set here because this is the only place memory_dir is known — the same
        # module-level-setter pattern as subagents.set_ui_sink and
        # host_exec.set_stop_check. Without it every run wrote into the process
        # CWD and a resume_from run_id was unfindable after a relaunch.
        try:
            import workflows as _workflows
            _workflows.set_run_root(memory_dir)
        except Exception:
            pass    # a missing engine must not break session start

        planning.set_context(memory_dir, notify_callback=self._on_plan_update)
        resumed_plan = planning.load_plan(memory_dir)
        if resumed_plan and not resumed_plan.is_complete():
            planning.set_active_plan(resumed_plan, notify=False)
            self.session["needs_plan"] = False
        else:
            planning.clear_active_plan(notify=False)

        # Structured investigation memory (evidence-first): wire up autosave/notify
        # and resume any prior investigation for this project, mirroring the plan.
        investigation.set_context(memory_dir, notify_callback=self._on_investigation_update)
        resumed_inv = investigation.load(memory_dir)
        if resumed_inv is not None:
            investigation.set_active(resumed_inv, notify=False)
        else:
            investigation.clear_active(notify=False)

        # Build ledger (physical manifest of a large modification): wire autosave/
        # notify and resume any prior ledger for this project, mirroring the plan
        # and investigation memory so a big build survives reopen + summarization.
        ledger.set_context(memory_dir, notify_callback=self._on_ledger_update)
        resumed_ledger = ledger.load(memory_dir)
        if resumed_ledger is not None:
            ledger.set_active(resumed_ledger, notify=False)
        else:
            ledger.clear_active(notify=False)

        strategy.set_context(memory_dir, notify_callback=self._on_strategy_update)
        _restored_brief = strategy.load_brief(memory_dir)
        if _restored_brief is not None:
            strategy.set_active_brief(_restored_brief, notify=False)

        superpowers.set_context(memory_dir, notify_callback=self._on_design_brief_update)
        _restored_design = superpowers.load_brief(memory_dir)
        if _restored_design is not None:
            superpowers.set_active_brief(_restored_design, notify=False)
        else:
            superpowers.clear_active_brief(notify=False)

        # Per-session ephemeral state (no resume, unlike plan/investigation):
        # mission build-constraints + retry budget, and the tool-call salvage
        # counters. These live in process-wide module globals, so switching
        # projects in the same running process (omni-executor drives many) MUST
        # clear them, or project A's declared constraints (and spent retry
        # budget) leak into project B's builds.
        mission_constraints.reset_mission_constraints()
        reset_salvage_stats()

        # Compose messages[0] = static prompt + progressive tool section + live
        # plan + investigation. The plan/investigation were wired with
        # notify=False above, so nothing has refreshed messages[0] yet — do it now
        # so the very first LLM call sees the tools and any resumed state.
        self._refresh_system_prompt()

        self._emit_session_started()
        return {"ok": True, "project": project_name, "root": root}

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
            "import_source": _read_import_meta(s.get("root", "")),
            "transcript": s.get("transcript", []),
            "busy": self._busy,
        })
        # The chip is painted once at init() and then only by `device_changed`.
        # _load_persisted() reinstates (or clears) devices._active for the project
        # being opened, so WITHOUT this emit a change-session into a project with a
        # different saved device leaves the chip reading the PREVIOUS project's
        # machine — routing remote while the chip says "this computer", or the
        # reverse. Emitted unconditionally, local included: the chip has to be
        # repainted to "this computer" just as urgently as to a device name.
        _dev = devices.active()
        self._emit({"type": "device_changed",
                    "device": (_dev.to_dict() if _dev else None)})
        # Restore the header stats (steps / tools used / context / resets) after the
        # chat is rebuilt, so a reopened project shows its last counts instead of 0.
        last_status = s.get("last_status")
        if isinstance(last_status, dict):
            self._emit(last_status)
        # Rebuild the Subagents dock from its snapshot so the menu doesn't vanish on
        # a refresh / reopen. Purely a UI restore — emitted after the chat is built.
        dock = s.get("dock")
        if isinstance(dock, dict) and dock.get("rows"):
            self._emit({"type": "wave_restore", "dock": dock})
        active_plan = planning.get_active_plan()
        self._on_plan_update(active_plan.to_dict() if active_plan else None)
        active_inv = investigation.get_active()
        self._on_investigation_update(active_inv.to_dict() if active_inv else None)
        active_ledger = ledger.get_active()
        self._on_ledger_update(active_ledger.to_dict() if active_ledger else None)

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
        # A cleared chat IS a new conversation, so its token size starts over.
        s["convo_tokens"] = 0
        s["usage_prev_prompt"] = 0
        s["usage_prev_completion"] = 0
        s["tools_since_plan_touch"] = 0
        s["_plan_touch_nudge_sent"] = False
        s["reads_since_nav"] = 0
        s["graph_nudges_sent"] = 0
        s["domain_tools_since_skill"] = 0
        s["skill_nudges_sent"] = 0
        s["skill_loaded"] = False
        s["plan_gate_retries"] = 0
        s["narrated_this_task"] = False
        s["tools_since_explanation"] = 0
        s["tools_since_narration"] = 0
        s["tools_used"] = 0
        s["last_status"] = None
        s["review_rounds"] = 0
        s["strategy_review_rounds"] = 0
        s["findings_since_brief_sync"] = 0
        s["unverified_change"] = None
        s["failed_sigs"] = {}
        s["failed_sig_warned"] = set()
        s["_validation_nudged_for"] = None
        s["build_observed"] = False
        s["assumption_nudges_sent"] = 0
        s["solo_read_streak"] = 0
        s["solo_read_nudges_sent"] = 0
        s["_delegation_phase_nudged"] = set()
        # Fresh chat -> drop expanded toolsets back to catalog-only (they re-arm
        # as the new task uses domain tools).
        s["active_toolsets"] = set()
        self._emit({"type": "status", "step_count": 0, "consecutive_tools": 0,
                    "tools_used": 0, "ctx_chars": 0, "ctx_tokens": 0,
                    "convo_tokens": 0,
                    "ctx_budget": context_token_budget(), "summary_resets": 0})
        # A fresh chat only needs a new plan if there isn't an in-progress one.
        active_plan = planning.get_active_plan()
        s["needs_plan"] = active_plan is None or active_plan.is_complete()
        s["mutating_gate_nudged"] = False  # re-arm the one-time unplanned-mutation nudge
        s["dispatched_steps"] = set()      # fresh chat -> nothing delegated yet
        s["dock"] = None                   # fresh chat -> drop the subagents snapshot
        s["steps_since_reground"] = 0
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

        if _ultra_keyword_requested(text) and not self.session.get("ultra"):
            # The spec: the keyword arms ultra mode for THAT TURN. It used to
            # latch on forever, so one message mentioning "ultra" left every
            # later turn free to fan out. _run_agent_loop's finally clears it.
            self.session["ultra"] = True
            self.session["ultra_turn_only"] = True
            # Without this the very turn that asked for ultra still runs against
            # the OFF prompt — the flag is only read when the prompt is rebuilt.
            self._refresh_system_prompt()
            self._emit({"type": "ultra_mode", "ultra": True})

        self.session["messages"].append({"role": "user", "content": text})
        if self.session["original_task"] is None:
            self.session["original_task"] = text
        # Superpowers: read this turn's execution-mode intent. Inline-only is honored
        # only on a CLEAR request; it disables subagent-driven execution for the task
        # (the auto-brainstorm then runs inline instead of dispatching a subagent).
        self.session["inline_only"] = (
            bool(self.session.get("superpowers_enabled"))
            and superpowers.detect_inline_only(text))
        # Fresh user turn -> reset per-task loop/budget state. Shared with the
        # workflow-launch path (see _reset_per_task_state) so a counter added
        # here can never drift out of the other one.
        self._reset_per_task_state(text)

        self._emit({"type": "user_message", "content": text})
        # Persist immediately so the user's message survives even if the app is
        # closed / crashes mid-generation.
        self._persist_session()
        self._thread = threading.Thread(target=self._run_agent_loop, daemon=True)
        self._thread.start()
        return {"ok": True}

    def set_ultra(self, on):
        """Toggle ultra mode. Exposed to the webview as pywebview.api.set_ultra.

        An explicit toggle is STICKY: it clears the keyword's turn scoping, so
        the state the user picked survives the end of the turn and is persisted."""
        if not self.session:
            return {"ok": False, "error": "No active session.", "ultra": False}
        self.session["ultra"] = bool(on)
        self.session["ultra_turn_only"] = False
        self._refresh_system_prompt()
        self._emit({"type": "ultra_mode", "ultra": self.session["ultra"]})
        return {"ultra": self.session["ultra"]}

    def get_ultra(self):
        return {"ultra": bool((self.session or {}).get("ultra"))}

    def list_devices(self):
        # Reads devices.active() rather than self.session["active_device"] —
        # same reasoning as _device_prompt_segment: it's the module-level
        # global that execution routing actually uses, so this must mirror
        # THAT, not the session's copy of it.
        d = devices.active()
        return {"ok": True, "active": (d.id if d else None),
                "devices": [x.to_dict() for x in devices.load_devices()]}

    def add_device(self, name, target, remote_root, env_prelude="", notes=""):
        try:
            d = devices.add_device(name, target, remote_root, env_prelude, notes)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "device": d.to_dict()}

    def remove_device(self, device_id):
        return {"ok": devices.remove_device(device_id)}

    def test_device(self, device_id):
        d = devices.get_device(device_id)
        if d is None:
            return {"ok": False, "error": "no such device"}
        return devices.probe(d)

    def select_device(self, device_id):
        """Switch the machine work happens on. Recorded in the transcript so a
        later reader is never left guessing which computer a command ran on."""
        # Routing is read per tool call from a process-wide global, so switching
        # mid-turn would split ONE task across TWO machines: the build lands on
        # the device, the install on this computer. Refuse instead.
        if getattr(self, "_busy", False):
            return {"ok": False, "error": (
                "The agent is working right now — switching machines mid-task "
                "would run part of it here and part of it there. Let the current "
                "task finish, or press Stop, then switch.")}
        try:
            d = devices.set_active(device_id)
        except KeyError:
            return {"ok": False, "error": "no such device"}
        self.session["active_device"] = (d.id if d else None)
        where = f"the device '{d.name}' ({d.target}), folder {d.remote_root}" if d \
            else "this computer"
        self._emit({"type": "system", "content": f"Execution target is now {where}."})
        self._emit({"type": "device_changed",
                    "device": (d.to_dict() if d else None)})
        self._refresh_system_prompt()
        return {"ok": True, "device": (d.to_dict() if d else None)}

    def list_workflows(self):
        import workflows
        return {"ok": True, "workflows": workflows.list_library()}

    def list_runs(self, limit=50):
        import workflows
        return {"ok": True, "runs": workflows.list_runs(limit=limit)}

    def load_run(self, run_id):
        import workflows
        return workflows.load_run(run_id)

    def _workflow_result_into_conversation(self, res):
        """Append a finished run's result as a user-role message.

        User-role because this codebase already feeds tool output back that way
        ('TOOL RESULT:'), so the model reads it with machinery it already has."""
        import json as _json
        name = res.get("name") or "workflow"
        run_id = res.get("run_id") or "(no run id)"
        head = f"{WORKFLOW_RESULT_PREFIX} ({name}, run {run_id}):\n"
        if not res.get("ok"):
            body = f"The run FAILED: {res.get('error') or 'unknown error'}"
        else:
            try:
                body = _json.dumps(res.get("result"), indent=2, default=str)
            except (TypeError, ValueError):
                body = str(res.get("result"))
            if len(body) > WORKFLOW_RESULT_CAP:
                body = (body[:WORKFLOW_RESULT_CAP]
                        + f"\n… truncated. Open run {run_id} in the Workflow tab "
                          f"for the full result.")
        stats = (f"\n({res.get('agent_count', 0)} agents, "
                 f"{res.get('elapsed_s', 0)}s)")
        warn = ""
        for w in (res.get("warnings") or []):
            warn += f"\nWARNING: {w}"
        self.session["messages"].append(
            {"role": "user", "content": head + body + stats + warn})

    def _run_workflow_with_ui_drain(self, name, args, dry_run):
        """Run workflows.run() on a background thread and drain its events HERE,
        on the calling thread, one at a time.

        parallel()/pipeline() spawn one thread PER BRANCH (WorkflowRuntime._spawn
        in workflows/runtime.py), and each branch fires wf_agent_started /
        wf_agent_done through on_event from that branch's own thread. self._emit
        appends to and trims session["transcript"], mutates session["dock"]
        across several statements, and calls self._window.evaluate_js — none of
        it synchronized, and _emit swallows exceptions so a race there would be
        silent. Funneling every event through one queue and draining it from a
        single thread is the same pattern as _run_delegated_wave (agent.py) and
        tools/workflow_tools.py's _drain_to_ui — never pass self._emit as
        on_event to something that can fan out across threads."""
        import queue as _queue
        import workflows
        q = _queue.Queue()
        _SENTINEL = object()
        holder = {}

        def runner():
            try:
                holder["result"] = workflows.run(name=name, args=args, on_event=q.put,
                                                  dry_run=bool(dry_run))
            except Exception as e:  # noqa: BLE001
                holder["error"] = e
            finally:
                q.put(_SENTINEL)

        t = threading.Thread(target=runner, daemon=True)
        t.start()
        while True:
            ev = q.get()
            if ev is _SENTINEL:
                break
            self._emit(ev)
        t.join()
        if holder.get("error") is not None:
            raise holder["error"]
        return holder.get("result")

    def _reset_per_task_state(self, text=None):
        """Reset the per-task loop/budget/guard counters before a fresh turn.

        ONE definition, called by both paths that start a turn: send_message
        (with the text the user typed) and launch_workflow's follow-up turn
        (with None). It used to be copy-pasted between the two, field for
        field — faithful on the day it was written and one new counter away
        from silently drifting.

        `text` is the only difference between the two callers. There is no
        typed text on the launch path, so there is nothing to run the
        triviality check against, and a workflow result is a finding to act on
        rather than a fresh task to brainstorm — so that path never arms the
        auto-brainstorm/architect."""
        s = self.session
        s["last_tool_call"] = None
        s["consecutive_tools"] = 0
        s["summary_resets"] = 0
        s["reads_since_nav"] = 0
        s["graph_nudges_sent"] = 0
        # Fresh task -> re-arm the skill guard so this task gets its own skill check.
        s["domain_tools_since_skill"] = 0
        s["skill_nudges_sent"] = 0
        s["skill_loaded"] = False
        # Fresh task -> reset the review/evidence guards for this task.
        s["review_rounds"] = 0
        s["strategy_review_rounds"] = 0
        s["findings_since_brief_sync"] = 0
        s["unverified_change"] = None
        s["failed_sigs"] = {}
        s["failed_sig_warned"] = set()
        s["_validation_nudged_for"] = None
        s["build_observed"] = False
        s["assumption_nudges_sent"] = 0
        s["solo_read_streak"] = 0
        s["solo_read_nudges_sent"] = 0
        s["_delegation_phase_nudged"] = set()
        # New task -> the next tool call is the "first", so guarantee it opens with
        # an explanation (see the emit block in _run_agent_loop).
        s["narrated_this_task"] = False
        s["tools_since_explanation"] = 0
        s["tools_since_narration"] = 0

        # Plan-and-execute: a genuinely NEW task (no active plan, or the
        # previous one is fully done) must be planned before any tool runs.
        # A follow-up message that continues an in-progress plan does NOT
        # force a re-plan — the model can just keep working the existing one
        # (or call plan_add_task/plan_update_task itself if the follow-up
        # changes scope).
        active_plan = planning.get_active_plan()
        if active_plan is None or active_plan.is_complete():
            s["needs_plan"] = True
            s["mutating_gate_nudged"] = False  # re-arm the one-time unplanned-mutation nudge
            s["dispatched_steps"] = set()      # new plan -> fresh delegation tracking
            s["steps_since_reground"] = 0
            # Superpowers: a genuinely NEW, non-trivial task earns an autonomous
            # brainstorm before planning. Trivial one-liners skip straight to work.
            s["needs_brainstorm"] = (
                text is not None
                and bool(s.get("superpowers_enabled"))
                and not superpowers.is_trivial_task(text))
            # …and the architect designs the plan itself, right after the brainstorm.
            s["needs_architect"] = s["needs_brainstorm"]
        else:
            # A follow-up continuing an in-progress plan does not re-brainstorm.
            s["needs_brainstorm"] = False
            s["needs_architect"] = False
        s["tools_since_plan_touch"] = 0
        s["_plan_touch_nudge_sent"] = False

    def launch_workflow(self, name, args=None, dry_run=False):
        """Run a workflow from the UI, then hand its result to the model."""
        import threading
        import workflows
        if not self.session:
            return {"ok": False, "error": "No active session. Start a project first."}
        known = [w["name"] for w in workflows.list_library()]
        if name not in known:
            return {"ok": False,
                    "error": f"no workflow named '{name}'. Available: {', '.join(known)}"}
        with self._lock:
            if self._busy:
                # Two things driving the conversation at once is incoherent.
                return {"ok": False,
                        "error": "The agent is busy. Finish or stop the current task first."}
            self._busy = True
            self._stop = False

        def work():
            # _busy has exactly ONE owner at a time. This thread takes it from
            # launch_workflow above and holds it until either it clears the flag
            # itself or it hands ownership to _run_agent_loop, whose own finally
            # clears the flag AND emits `done`.
            #
            # The handoff has to happen BEFORE the call: _run_agent_loop's
            # `done` re-enables the UI input, so a send_message can legitimately
            # set _busy = True and start a second loop the instant that event
            # lands — while this frame is still sitting in _run_agent_loop's
            # return path. A finally here that cleared _busy unconditionally
            # would un-flag THAT loop, letting a third send_message start a
            # third one, with two agent loops interleaving on
            # session["messages"] and session["transcript"].
            owns_busy = True
            try:
                res = self._run_workflow_with_ui_drain(name, args, dry_run)
                if not dry_run:
                    self._workflow_result_into_conversation(res)
                    self._reset_per_task_state()
                    self._persist_session()
                    owns_busy = False       # handed to _run_agent_loop
                    self._run_agent_loop()
                    return
                self._emit({"type": "system",
                            "content": f"Dry run of '{name}': "
                                       + ("passed" if res.get("ok")
                                          else res.get("error", "failed"))})
            except Exception as e:  # noqa: BLE001
                self._emit({"type": "error", "content": f"workflow launch failed: {e}"})
            finally:
                if owns_busy:
                    with self._lock:
                        self._busy = False
                    # The frontend sets busy on an ok launch response and clears
                    # it on `done`. Every exit from this thread that does NOT go
                    # through _run_agent_loop (a dry run, a launch that threw)
                    # must emit it too, or Stop stays on screen forever and the
                    # input stays disabled.
                    self._emit({"type": "done"})

        # Named so a test — and a thread dump — can tell this thread apart.
        threading.Thread(target=work, name="workflow-launch", daemon=True).start()
        return {"ok": True, "started": True}

    def _abort_active_workflows(self):
        """Cancel every running workflow. Called from the same place that sets
        self._stop, so Stop remains the single cancellation path rather than the
        engine growing a second one."""
        try:
            import workflows
            n = workflows.abort()
            if n:
                self._emit({"type": "log",
                            "content": f"stopping {n} running workflow(s)…"})
        except Exception:
            pass    # stopping must never itself fail

    def stop(self):
        if not self._busy:
            return {"ok": False, "error": "Nothing to stop."}
        self._stop = True
        self._abort_active_workflows()
        self._emit({"type": "system", "content": "Stopping now — aborting the current step (in-flight LLM call / running tool)."})
        return {"ok": True}

    def get_file_tree(self):
        if not self.session:
            return {"ok": False, "error": "No active session."}
        return {"ok": True, "tree": build_file_tree(self.session["project"])}

    def read_file(self, rel_path, force_text=False):
        if not self.session:
            return {"ok": False, "error": "No active session."}
        return read_project_file(self.session["project"], rel_path, force_text=bool(force_text))

    def read_archive_member(self, rel_path, member, force_text=False):
        # Reading an archive member unzips a LOCAL file. With a device active the
        # tree shows the REMOTE box, so the path in hand names a remote file and
        # the same path here would open an unrelated local one.
        _err = devices.require_local("Browsing inside an archive")
        if _err:
            return {"ok": False, **_err}
        if not self.session:
            return {"ok": False, "error": "No active session."}
        return read_project_archive_member(
            self.session["project"], rel_path, member, force_text=bool(force_text))

    # --- workspace file operations (file-tree drag/drop + context menu) -------
    # Everything here funnels through _safe_abs, which is the ONLY thing standing
    # between a frontend-supplied relative path and arbitrary host filesystem
    # access. It resolves symlinks before comparing, so a symlink inside the
    # workspace cannot be used to escape it.
    #
    # ALL OF IT IS LOCAL-ONLY. _safe_abs resolves against session["root"] — the
    # LOCAL picked folder — while build_file_tree() shows the REMOTE folder when a
    # device is active. Without a guard, deleting `config.json` from the (remote)
    # tree trashes the LOCAL project's file and then repaints the remote tree, so
    # the destruction is invisible. Every entry point below therefore refuses out
    # loud when a device is active; _safe_abs itself refuses too, so a future
    # caller inherits the guard instead of having to remember it. There is no
    # remote implementation on purpose — refusing is v1, exactly like the other
    # local-only tools.

    TRASH_DIRNAME = ".omni-trash"

    def _safe_abs(self, rel, *, must_exist=False):
        """Resolve a workspace-relative path to an absolute one, or raise
        ValueError if it would land outside the workspace root."""
        _err = devices.require_local("Editing files from the file tree")
        if _err:
            raise ValueError(_err["error"])
        if not self.session:
            raise ValueError("No active session.")
        root = os.path.realpath(self.session.get("root") or _project_root())
        cleaned = (rel or "").strip().replace("\\", "/").strip("/")
        target = os.path.realpath(os.path.join(root, *[p for p in cleaned.split("/") if p]))
        if target != root and not target.startswith(root + os.sep):
            raise ValueError("Path is outside the workspace.")
        if must_exist and not os.path.exists(target):
            raise ValueError(f"Not found: {cleaned or '/'}")
        return target

    def _tree_result(self, **extra):
        """Standard success shape: every mutation returns the refreshed tree so
        the frontend re-renders from truth instead of patching its own state."""
        self._refresh_tree(force=True)
        out = {"ok": True, "tree": build_file_tree(self.session["project"])}
        out.update(extra)
        return out

    @staticmethod
    def _unique_path(path):
        """A non-colliding variant of `path` ('a.txt' -> 'a (2).txt'). Used so a
        move or restore never silently overwrites an existing file."""
        if not os.path.exists(path):
            return path
        base, ext = os.path.splitext(path)
        for n in range(2, 1000):
            candidate = f"{base} ({n}){ext}"
            if not os.path.exists(candidate):
                return candidate
        raise ValueError("Could not find a free filename.")

    def fs_move(self, rel_paths, dest_dir_rel):
        """Move files/folders into dest_dir_rel (drag and drop in the tree)."""
        _err = devices.require_local("Moving files in the file tree")
        if _err:
            return {"ok": False, **_err}
        try:
            dest = self._safe_abs(dest_dir_rel, must_exist=True)
            if not os.path.isdir(dest):
                return {"ok": False, "error": "Destination is not a folder."}
            moved, skipped = [], []
            for rel in (rel_paths or []):
                try:
                    src = self._safe_abs(rel, must_exist=True)
                except ValueError as e:
                    skipped.append({"path": rel, "reason": str(e)})
                    continue
                # Moving a folder into itself or its own descendant would destroy
                # it; the frontend guards this too, but never trust the caller.
                if os.path.isdir(src) and (dest == src or dest.startswith(src + os.sep)):
                    skipped.append({"path": rel, "reason": "cannot move a folder into itself"})
                    continue
                if os.path.dirname(src) == dest:
                    continue  # already there — a no-op drop, not an error
                try:
                    shutil.move(src, self._unique_path(os.path.join(dest, os.path.basename(src))))
                    moved.append(rel)
                except (OSError, ValueError) as e:
                    skipped.append({"path": rel, "reason": str(e)})
            return self._tree_result(moved=moved, skipped=skipped)
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    def fs_delete(self, rel_paths):
        """Move files/folders to the workspace's .omni-trash (recoverable).

        Deliberately not an unlink: a mis-drop on the trash node has to be
        undoable, and the agent's own tools already treat the workspace as the
        unit of state.
        """
        _err = devices.require_local("Deleting files from the file tree")
        if _err:
            return {"ok": False, **_err}
        try:
            root = self._safe_abs("")
            trash = os.path.join(root, self.TRASH_DIRNAME)
            os.makedirs(trash, exist_ok=True)
            trashed, skipped = [], []
            for rel in (rel_paths or []):
                try:
                    src = self._safe_abs(rel, must_exist=True)
                except ValueError as e:
                    skipped.append({"path": rel, "reason": str(e)})
                    continue
                if src == root:
                    skipped.append({"path": rel, "reason": "cannot delete the workspace root"})
                    continue
                if src == trash or src.startswith(trash + os.sep):
                    skipped.append({"path": rel, "reason": "already in the trash"})
                    continue
                try:
                    shutil.move(src, self._unique_path(os.path.join(trash, os.path.basename(src))))
                    trashed.append(rel)
                except (OSError, ValueError) as e:
                    skipped.append({"path": rel, "reason": str(e)})
            return self._tree_result(trashed=trashed, skipped=skipped)
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    def fs_trash_empty(self):
        """Permanently delete everything in the workspace trash."""
        _err = devices.require_local("Emptying the trash")
        if _err:
            return {"ok": False, **_err}
        try:
            trash = self._safe_abs(self.TRASH_DIRNAME)
            if not os.path.isdir(trash):
                return self._tree_result(removed=0)
            removed = 0
            for name in os.listdir(trash):
                path = os.path.join(trash, name)
                try:
                    shutil.rmtree(path) if os.path.isdir(path) else os.remove(path)
                    removed += 1
                except OSError:
                    pass
            return self._tree_result(removed=removed)
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    def fs_mkdir(self, rel):
        """Create a new folder."""
        _err = devices.require_local("Creating a folder")
        if _err:
            return {"ok": False, **_err}
        try:
            target = self._safe_abs(rel)
            if os.path.exists(target):
                return {"ok": False, "error": "That name is already taken."}
            os.makedirs(target)
            return self._tree_result(path=rel)
        except (ValueError, OSError) as e:
            return {"ok": False, "error": str(e)}

    def fs_new_file(self, rel):
        """Create an empty file."""
        _err = devices.require_local("Creating a file")
        if _err:
            return {"ok": False, **_err}
        try:
            target = self._safe_abs(rel)
            if os.path.exists(target):
                return {"ok": False, "error": "That name is already taken."}
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "x", encoding="utf-8"):
                pass
            return self._tree_result(path=rel)
        except (ValueError, OSError) as e:
            return {"ok": False, "error": str(e)}

    def fs_rename(self, rel, new_name):
        """Rename in place. new_name is a bare name, never a path — accepting a
        path here would let a rename act as a move outside the workspace."""
        _err = devices.require_local("Renaming a file")
        if _err:
            return {"ok": False, **_err}
        try:
            src = self._safe_abs(rel, must_exist=True)
            name = (new_name or "").strip()
            if not name or "/" in name or "\\" in name or name in (".", ".."):
                return {"ok": False, "error": "Enter a valid file name."}
            dest = os.path.join(os.path.dirname(src), name)
            if os.path.exists(dest):
                return {"ok": False, "error": "That name is already taken."}
            os.rename(src, dest)
            return self._tree_result()
        except (ValueError, OSError) as e:
            return {"ok": False, "error": str(e)}

    def fs_duplicate(self, rel):
        """Copy a file or folder beside itself."""
        _err = devices.require_local("Duplicating a file")
        if _err:
            return {"ok": False, **_err}
        try:
            src = self._safe_abs(rel, must_exist=True)
            dest = self._unique_path(src)
            if os.path.isdir(src):
                shutil.copytree(src, dest)
            else:
                shutil.copy2(src, dest)
            return self._tree_result()
        except (ValueError, OSError) as e:
            return {"ok": False, "error": str(e)}

    def fs_write_upload(self, dest_dir_rel, name, b64_chunk, first=True, last=True):
        """Append one base64 chunk of a dropped file.

        Chunked because the pywebview JS bridge serializes arguments as JSON —
        handing it a whole large file in one call is a memory spike on both
        sides. `first` truncates (starting a new file), `last` finalizes.
        `name` may contain forward slashes so a dropped FOLDER can recreate its
        structure; each segment is still resolved through _safe_abs.
        """
        _err = devices.require_local("Uploading into the file tree")
        if _err:
            return {"ok": False, **_err}
        try:
            rel_name = (name or "").strip().replace("\\", "/").strip("/")
            if not rel_name or ".." in rel_name.split("/"):
                return {"ok": False, "error": "Invalid file name."}
            base = (dest_dir_rel or "").strip().strip("/")
            target = self._safe_abs(f"{base}/{rel_name}" if base else rel_name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb" if first else "ab") as f:
                f.write(base64.b64decode(b64_chunk or ""))
            # Only refresh the tree when the file is complete; doing it per chunk
            # would rebuild the whole tree hundreds of times for one large file.
            if last:
                return self._tree_result(path=rel_name)
            return {"ok": True}
        except (ValueError, OSError, binascii.Error) as e:
            return {"ok": False, "error": str(e)}

    def upload_files(self, dest_dir=""):
        """Opens a native multi-select file picker and copies the chosen host
        files into the current project's workspace (optionally into a subfolder
        dest_dir, relative to the project root). Returns the refreshed file tree
        so the frontend updates immediately. Existing files of the same name are
        overwritten (an upload of a newer copy)."""
        _err = devices.require_local("Uploading files")
        if _err:
            return {"ok": False, **_err}
        if not self.session:
            return {"ok": False, "error": "No active session."}
        if self._window is None:
            return {"ok": False, "error": "Window not ready."}

        # Resolve + confine the destination to inside the PICKED project root.
        root = os.path.abspath(self.session.get("root") or _project_root())
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
        # `project` was undefined here — every successful upload raised NameError
        # on its way out, so the caller saw a failure after the copy had already
        # happened. The session's project name is what build_file_tree wants.
        return {"ok": True, "cancelled": False, "copied": copied, "skipped": skipped,
                "dest": rel or "(workspace root)",
                "tree": build_file_tree(self.session["project"])}

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
        cg_root = os.path.join(self.session.get("root") or _project_root(), ".codegraph")

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
            return {"ok": False, "error": "No knowledge graph yet. Click “Build graph” above to index the workspace (or a project folder), or ask the agent to run build_code_graph."}

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

    # --- knowledge-graph build (manual, from the Graph tab) ------------------
    def _codegraph_root(self):
        """Absolute host path of the active workspace's .codegraph namespace dir
        (where every built graph is stored and where get_code_graph reads)."""
        return os.path.join(self.session.get("root") or _project_root(), ".codegraph")

    def list_graph_build_targets(self):
        """List the workspace's top-level subdirectories as candidate build
        targets for the Graph tab's manual Build control. Each becomes its OWN
        graph instance, so a user comparing two projects can build each folder
        separately. Caches / VCS / build-output dirs are skipped. The whole
        workspace is always offered by the caller as the default."""
        if not self.session:
            return {"ok": False, "error": "No active session."}
        root = os.path.abspath(self.session.get("root") or _project_root())
        skip = {".codegraph", ".git", ".hg", ".svn", "__pycache__", ".idea",
                ".vscode", "node_modules", ".emulator", "screenshots",
                "test_reports", ".gradle", "venv", ".venv", "dist", "build",
                "out", ".next", ".pytest_cache", ".mypy_cache"}
        dirs = []
        try:
            for name in sorted(os.listdir(root)):
                if name in skip or name.startswith("."):
                    continue
                if os.path.isdir(os.path.join(root, name)):
                    dirs.append(name)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "root_label": _ws_label(root), "dirs": dirs}

    def build_code_graph_ui(self, root_dir="", graph_id="", include_so=False, force=True):
        """Manual 'Build graph' action from the Graph tab.

        Runs the code-graph indexer in-process against the picked workspace, so
        the .codegraph/<id>/ folder is created exactly where the Graph tab reads
        it. Indexing a specific subdirectory gives it its
        OWN graph instance (multi-project): comparing two directories builds two
        separate graphs that stay independent and can be rendered side by side.
        Returns a short summary plus the refreshed graph list for the selector."""
        if not self.session:
            return {"ok": False, "error": "No active session."}
        from tools.common import normalize_path
        from tools.code_graph import _slug

        root = os.path.abspath(self.session.get("root") or _project_root())

        # Confine the target INSIDE the picked project folder.
        rel = normalize_path(root_dir)  # '', '.', legacy '/workspace' -> '.'
        if rel in ("", "."):
            target_abs = root
            rel_disp = "."
        else:
            target_abs = os.path.abspath(os.path.join(root, *rel.split("/")))
            if target_abs != root and not target_abs.startswith(root + os.sep):
                return {"ok": False, "error": "Target is outside the workspace."}
            rel_disp = os.path.relpath(target_abs, root).replace("\\", "/")
        if not os.path.isdir(target_abs):
            return {"ok": False, "error": f"Directory not found: {rel_disp}"}

        # graph_id: explicit if given, else a slug of the target — whole-workspace
        # uses the workspace folder name so it reads nicely in the selector.
        gid = (graph_id or "").strip()
        gid = _slug(gid) if gid else (_slug(_ws_label(root)) if rel_disp == "." else _slug(rel_disp))

        inc = "1" if include_so in (True, "true", "True", 1, "1") else "0"
        frc = "1" if force in (True, "true", "True", 1, "1") else "0"

        indexer = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "tools", "_kg_indexer.py")
        env = dict(os.environ)
        env["CODEGRAPH_WORKSPACE"] = root  # graphs land under <root>/.codegraph/
        try:
            proc = subprocess.run(
                [sys.executable, indexer, target_abs, inc, frc, gid],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", env=env, timeout=1800)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Build timed out after 1800s. Try a specific subdirectory instead of the whole workspace."}
        except Exception as e:
            return {"ok": False, "error": f"Build failed to start: {e}"}

        out = (proc.stdout or "").strip()
        if proc.returncode != 0:
            return {"ok": False,
                    "error": (proc.stderr or out or "indexer failed").strip()[:600]}

        # Pull the headline counts out of the indexer summary so the UI can show
        # HOW MUCH was indexed (confirming a whole-workspace build really covered
        # the whole workspace) and WHERE the cache landed.
        def _count(pat):
            m = re.search(pat, out)
            return int(m.group(1)) if m else 0
        counts = {"files": _count(r"files=(\d+)"), "classes": _count(r"classes=(\d+)"),
                  "methods": _count(r"methods=(\d+)")}

        # Refresh the graph list (and detect an empty build) so the UI updates
        # its selector and can warn if the chosen folder had no indexable code.
        listing = self.get_code_graph(gid)
        graphs = listing.get("graphs", []) if isinstance(listing, dict) else []
        has_nodes = bool(isinstance(listing, dict) and listing.get("ok")
                         and (listing.get("graph") or {}).get("nodes"))
        # Refresh the file tree too, so the newly written .codegraph/<gid>/ cache
        # folder shows up instead of the user wondering whether anything was made.
        try:
            self._emit({"type": "file_tree", "tree": build_file_tree(self.session["project"])})
        except Exception:
            pass
        return {"ok": True, "graph_id": gid, "target": rel_disp,
                "summary": out[-1200:], "counts": counts,
                "cache_dir": ".codegraph/%s" % gid,
                "graphs": graphs, "empty": not has_nodes}

    def delete_code_graph(self, graph_id):
        """Delete one built graph instance (its .codegraph/<id>/ folder + its
        entry in the shared index), leaving the others untouched. Lets the user
        clear a stray/empty or outdated graph from the Graph tab while juggling
        several projects. Returns the refreshed graph list."""
        if not self.session:
            return {"ok": False, "error": "No active session."}
        gid = (graph_id or "").strip()
        if not gid or gid == "(default)":
            return {"ok": False, "error": "Pick a specific graph to delete."}
        cg_root = self._codegraph_root()
        gdir = os.path.join(cg_root, gid)
        # Never let a crafted id escape the .codegraph directory.
        if os.path.dirname(os.path.abspath(gdir)) != os.path.abspath(cg_root):
            return {"ok": False, "error": "Invalid graph id."}
        try:
            if os.path.isdir(gdir):
                shutil.rmtree(gdir, ignore_errors=True)
            idx_path = os.path.join(cg_root, "graphs.json")
            if os.path.isfile(idx_path):
                with open(idx_path, "r", encoding="utf-8") as f:
                    idx = json.load(f)
                if isinstance(idx, dict) and gid in idx:
                    del idx[gid]
                    with open(idx_path, "w", encoding="utf-8") as f:
                        json.dump(idx, f)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        listing = self.get_code_graph()
        return {"ok": True,
                "graphs": listing.get("graphs", []) if isinstance(listing, dict) else []}

    def end_session(self):
        self.stop()
        self._persist_session()
        planning.clear_active_plan(notify=False)
        planning.set_context(None, notify_callback=None)
        strategy.set_context(None, notify_callback=None)
        superpowers.set_context(None, notify_callback=None)
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
    def _maybe_summarize_context(self, s):
        """Context-window guard: summarize BEFORE we overflow. Fires at 80% of the
        active model's context window (token estimate) or after a large number of
        steps, then returns — the run never crashes on overflow and never terminates
        here. Out-of-band request bytes (native `tools=` schema array) are counted
        alongside the messages so the guard reflects the true request size (the tool
        schemas never appear in s["messages"])."""
        ctx_overhead = native_tools_payload_chars(s.get("active_toolsets"))
        # A large build can carry its durable state in the plan + investigation +
        # BUILD LEDGER (all folded into the prompt and surviving a reset), so it may
        # opt to run more steps between summaries via a per-session override. The
        # token/char pressure guard below is unchanged and still the hard ceiling.
        step_ceiling = s.get("max_steps_before_summary") or MAX_STEPS_BEFORE_SUMMARY
        if s["step_count"] >= step_ceiling or context_pressure(s["messages"], ctx_overhead):
            used = estimate_tokens(s["messages"]) + ctx_overhead // CHARS_PER_TOKEN
            self._emit({"type": "system", "content": (
                f"Context at ~{used} tokens (>= {int(CONTEXT_WINDOW_FRACTION*100)}% of the "
                f"{get_context_window()}-token window) — summarizing and continuing. "
                "Task and progress preserved.")})
            s["messages"] = summarize_memory(s["messages"], s["memory_dir"], s["original_task"], s.get("root"))
            s["base_system_prompt"] = s["messages"][0]["content"]
            self._refresh_system_prompt()
            s["step_count"] = 0
            s["consecutive_tools"] = 0
            s["summary_resets"] += 1

    def _count_conversation_usage(self, s):
        """Fold the just-completed main-loop call into the running size of the
        MAIN conversation, in real provider-reported tokens.

        Must be called IMMEDIATELY after the conversation's own ask_llm. The
        review gate, strategy review and summarizer also call ask_llm on this
        thread, and their spend is not part of the conversation — reading the
        usage right here means theirs is never attributed to the counter.
        Subagents are excluded for free: take_last_usage is thread-local.

        Each turn contributes only what is genuinely NEW — the growth in the
        prompt since the last call (i.e. the tool results that were appended)
        plus the reply itself. Without the delta, re-sending the whole history
        every turn would count the same messages over and over.

        The max(0, ...) clamp is what makes the number monotonic. It also means
        that on the turn where _maybe_summarize_context fires, the prompt
        collapses, the delta floors at zero, and that one turn's tool-result
        tokens go uncounted. That undercounts by a few thousand tokens once per
        summarization, which is preferred over filling the gap with a chars/4
        estimate — the fake number this counter exists to replace.
        """
        usage = take_last_usage() or {}
        prompt = int(usage.get("prompt") or 0)
        completion = int(usage.get("completion") or 0)
        if not prompt and not completion:
            return  # provider reported no usage — leave the counter untouched
        prev = s.get("usage_prev_prompt", 0) + s.get("usage_prev_completion", 0)
        s["convo_tokens"] = s.get("convo_tokens", 0) + max(0, prompt - prev) + completion
        s["usage_prev_prompt"] = prompt
        s["usage_prev_completion"] = completion

    def _emit_status(self, s):
        """Emit the per-iteration telemetry status event and remember it so the
        stats can be persisted and restored into the header when the project is
        reopened."""
        status_ev = {"type": "status",
                     "step_count": s["step_count"],
                     "consecutive_tools": s["consecutive_tools"],
                     "tools_used": s.get("tools_used", 0),
                     "ctx_chars": session_context_chars(s),
                     "ctx_tokens": session_context_tokens(s),
                     "convo_tokens": s.get("convo_tokens", 0),
                     # Carried so the delta baseline survives a reopen — this event
                     # doubles as the persisted stats snapshot (see _persist_session).
                     # The frontend ignores both.
                     "usage_prev_prompt": s.get("usage_prev_prompt", 0),
                     "usage_prev_completion": s.get("usage_prev_completion", 0),
                     "ctx_budget": context_token_budget(),
                     "summary_resets": s["summary_resets"]}
        s["last_status"] = status_ev
        self._emit(status_ev)

    def _skill_guard(self, s, tool_name, tool_args=None):
        """Consult a matching skill instead of improvising a whole APK/RE workflow.

        A run of hands-on domain work with no skill consulted triggers a bounded
        nudge toward use_skill. Loading a skill resets the counter (so following a
        skill correctly never nags) but — unlike before — does NOT permanently
        disarm the guard: sub-tasks shift mid-run (the general modding flow drifts
        into a signature check, SSL pinning, or an anti-tamper rabbit hole), and a
        long improvisation streak AFTER a skill was loaded should still steer to the
        SPECIFIC skill for the new problem. Only ever nudges — work is never blocked."""
        if tool_name in SKILL_TOOLS:
            s["skill_loaded"] = True
            s["domain_tools_since_skill"] = 0
            if tool_name == "use_skill" and isinstance(tool_args, dict):
                name = (tool_args.get("skill_name") or "").strip()
                if name:
                    s["last_skill_loaded"] = name
        elif tool_name in SKILL_DOMAIN_TOOLS:
            s["domain_tools_since_skill"] = s.get("domain_tools_since_skill", 0) + 1
            if (s["domain_tools_since_skill"] >= SKILL_NUDGE_THRESHOLD
                    and s.get("skill_nudges_sent", 0) < MAX_SKILL_NUDGES):
                s["domain_tools_since_skill"] = 0
                s["skill_nudges_sent"] = s.get("skill_nudges_sent", 0) + 1
                if s.get("skill_loaded"):
                    # Re-arm case: a skill was consulted earlier, but a lot of work has
                    # happened since with no skill check — likely a shifted sub-task.
                    last = s.get("last_skill_loaded") or "a"
                    self._emit({"type": "system", "content": (
                        "SYSTEM GUARD: lots of hands-on work since the last skill was "
                        "consulted — checking you're on the right skill for this sub-task.")})
                    s["messages"].append({"role": "user", "content": (
                        f"[SYSTEM] You loaded the '{last}' skill earlier, but have since done a "
                        "lot of hands-on APK / emulator work without consulting a skill again. "
                        "Sub-tasks shift mid-run — if you've moved from the general modding flow "
                        "to a SPECIFIC problem, load the skill for THAT problem now: "
                        "signature-bypass, ssl-pinning-bypass, anti-debug-bypass, "
                        "string-deobfuscation, manifest-resource-editing, dex-multidex-handling, "
                        "native-patching, smali-code-injection, or code-graph-analysis for a huge "
                        "decompiled tree. Each encodes the exact tool order and the pitfalls — "
                        "e.g. do NOT chase a native anti-tamper patch before you've confirmed the "
                        "plain re-signed APK actually crashes (re-signing alone often works). If "
                        "the skill you already have still fits this work, just continue."
                    )})
                else:
                    # First-time case: substantial domain work, no skill ever consulted.
                    self._emit({"type": "system", "content": (
                        "SYSTEM GUARD: substantial APK/RE work without consulting a "
                        "skill — steering to use_skill.")})
                    s["messages"].append({"role": "user", "content": (
                        "[SYSTEM] You've done a lot of hands-on APK / emulator work "
                        "without loading a skill. Skills are battle-tested workflows with "
                        "the exact tool order and pitfalls to avoid — for APK/RE: "
                        "apk-modding, ssl-pinning-bypass, signature-bypass, "
                        "anti-debug-bypass, string-deobfuscation, manifest-resource-editing, "
                        "dex-multidex-handling, smali-code-injection, code-graph-analysis; "
                        "for on-device work: emulator-management (cookie login / saved "
                        "account / enter a place id / dev instance / lifecycle) and "
                        "emulator-testing (run + observe + report). Loading a skill also "
                        "brings its tools online in full. Call list_skills, then use_skill "
                        "for the ONE that matches this task and follow it. If you've already "
                        "checked and none apply, just continue."
                    )})

    def _watchdog_after_tool(self, s, tool_name, tool_failed):
        """The SAME tool failing WATCHDOG_FAIL_THRESHOLD times in a row means retrying
        it as-is isn't working — force a strategy switch instead of letting the model
        grind the same failing path all night. A success (or a different tool) clears
        the streak. Repeated failure of a core approach is a REPLAN trigger: in
        adaptive mode, pause work until plan_replan deliberately revises the plan."""
        if tool_failed:
            if s.get("watchdog_tool") == tool_name:
                s["tool_fail_streak"] = s.get("tool_fail_streak", 0) + 1
            else:
                s["watchdog_tool"] = tool_name
                s["tool_fail_streak"] = 1
            if s["tool_fail_streak"] >= WATCHDOG_FAIL_THRESHOLD:
                s["tool_fail_streak"] = 0  # re-arm so it can fire again later
                if s.get("adaptive_planning"):
                    s["replan_required"] = True
                self._emit({"type": "system", "content": (
                    f"WATCHDOG: '{tool_name}' failed {WATCHDOG_FAIL_THRESHOLD} times in a "
                    "row — forcing a replan / strategy switch.")})
                s["messages"].append({"role": "user", "content": (
                    f"[SYSTEM — STRATEGY SWITCH] The tool '{tool_name}' has failed "
                    f"{WATCHDOG_FAIL_THRESHOLD} times in a row. STOP retrying it the same way — "
                    "that approach is not working. This is a repeated failure, so REPLAN before "
                    "doing more work: call plan_replan with the reason (these recorded failures) "
                    "and new steps for a DIFFERENT approach — it preserves completed work. Ideas: "
                    "search for a different class/method/symbol; target a different .so or "
                    "architecture; use a fallback injection point; or switch tools (e.g. "
                    "patch_function_return -> nop_function or binary_patch, smali edits -> a native "
                    "patch). If it's a genuine dead end, call plan_set_outcome "
                    "'blocked'/'needs_different_approach' with the evidence."
                )})
        else:
            s["watchdog_tool"] = None
            s["tool_fail_streak"] = 0

    def _evidence_bookkeeping(self, s, tool_name, tool_args, tool_failed):
        """Evidence-based bookkeeping (opt-in per session via evidence_guards):
        remember failed (tool,args) signatures for the repeat-failure guard; treat a
        workspace mutation as UNVERIFIED until an objective check confirms it, nudging
        once toward validation + record_test_result; and auto-record modified files
        into the durable investigation memory."""
        if s.get("evidence_guards"):
            sig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
            if tool_failed:
                s.setdefault("failed_sigs", {})[sig] = True
            elif tool_name in MUTATING_TOOLS:
                s["unverified_change"] = tool_name
                inv = investigation.ensure_active(s.get("original_task") or "")
                inv.add_modified_file(_best_path_arg(tool_args) or f"(via {tool_name})", tool_name)
                investigation.notify_updated()
                if s.get("_validation_nudged_for") != tool_name:
                    s["_validation_nudged_for"] = tool_name
                    s["messages"].append({"role": "user", "content": (
                        f"[SYSTEM] You just modified the workspace with '{tool_name}'. Treat this "
                        "change as UNVERIFIED until an objective check passes: run the appropriate "
                        "validation (rebuild/repack, sign, install, launch, run a test, or inspect "
                        "logs) and record the outcome with record_test_result. Do not claim success "
                        "until a check confirms it.")})
            if tool_name in VALIDATION_TOOLS and not tool_failed:
                s["unverified_change"] = None
                s["_validation_nudged_for"] = None
            # Anti-rabbit-hole tracking: observing the current build running satisfies
            # the "confirm the crash before native patching" precondition; a fresh
            # recompile/sign invalidates it (the new build hasn't been observed yet).
            if tool_name in OBSERVE_RUN_TOOLS and not tool_failed:
                s["build_observed"] = True
            elif tool_name in ("recompile_apk", "sign_apk") and not tool_failed:
                s["build_observed"] = False

    def _maybe_compact_long_run(self, s):
        """Long-run compaction: once we've done a lot of tool steps, fold the history
        into a summary and continue (never abort — an overnight run must keep going;
        only a final_answer or an explicit user stop ends the loop)."""
        if s["consecutive_tools"] >= s["max_consecutive_tools"]:
            self._emit({"type": "system", "content": f"Long task in progress: compacting memory after {s['consecutive_tools']} tool steps (progress preserved)."})
            s["messages"] = summarize_memory(s["messages"], s["memory_dir"], s["original_task"], s.get("root"))
            s["base_system_prompt"] = s["messages"][0]["content"]
            self._refresh_system_prompt()
            s["step_count"] = 0
            s["consecutive_tools"] = 0
            s["summary_resets"] += 1

    def _plan_bookkeeping_after_tool(self, s, tool_name, tool_failed):
        """Post-execution plan bookkeeping. Only a SUCCESSFUL plan_create that produced
        a real plan opens the plan gate; a successful plan_replan lifts the
        replan-required pause and re-arms the watchdog. Any plan tool resets the
        plan-touch counter (and auto-dispatches a newly in_progress delegated step /
        re-grounds + fires on_phase_change on a phase advance); otherwise a long run
        with no plan touch gets a bounded nudge."""
        if (tool_name == "plan_create" and not tool_failed
                and planning.get_active_plan() is not None):
            s["needs_plan"] = False
            s["plan_gate_retries"] = 0
        if tool_name == "plan_replan" and not tool_failed:
            s["replan_required"] = False
            s["watchdog_tool"] = None
            s["tool_fail_streak"] = 0
        if tool_name in PLAN_TOOL_NAMES or (tool_name or "").startswith("plan_"):
            s["tools_since_plan_touch"] = 0
            s["_plan_touch_nudge_sent"] = False
            # If this plan tool just marked a delegated step in_progress, auto-run it
            # in an isolated subagent and fold back its report.
            if not tool_failed:
                self._maybe_dispatch_delegated_steps()
                # Suppress nudge #2 if nudge #1 (the solo-read-streak nudge) already
                # fired earlier THIS turn. Only plan_view can reach both nudges in
                # one turn — it's the one plan tool that's also read-only.
                if not s.get("_delegation_nudge_fired_this_turn"):
                    self._maybe_nudge_plan_delegation(s)
            # A phase advance is a natural re-grounding point (GSD phases).
            if tool_name == "plan_advance_phase" and not tool_failed:
                self._maybe_reground(force=True)
                # Let plugins react to the milestone (e.g. a checkpoint/verify hook).
                _plan = planning.get_active_plan()
                _phase = (_plan.current_phase() or {}).get("title", "") if _plan else ""
                self._fire_plugin_hooks("on_phase_change", phase=_phase)
                self._reconcile_brief_on_phase_change()
        else:
            if tool_name == "record_finding" and not tool_failed:
                self._note_finding_for_brief()
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

    def _maybe_nudge_delegation(self, s, tool_name):
        """Delegation nudge #1 — the SOLO-READ STREAK.

        Read-only calls the orchestrator runs inline are precisely the work a
        parallel subagent wave does for ~0 main context, so a long streak of them
        is the delegation opportunity the model is most likely to miss.

        RE-ARMS every SOLO_READ_NUDGE read-only calls, exactly like the
        explanation-cadence guardrail above — it does NOT fire once and go quiet.
        The one-shot version of this shipped first and was effectively silent: in
        a 300-step autonomous run inside a single user turn it fired once, and
        only a real delegation could re-arm it, so the observed result was two
        subagents in three hundred steps. A steady cadence is the whole point.
        Each repeat states how many chances have now passed, so ignoring it reads
        as a growing cost rather than the same line again. SOLO_READ_NUDGE=0
        disables it."""
        if not SOLO_READ_NUDGE:
            return
        if tool_name in DELEGATION_TOOLS:
            s["solo_read_streak"] = 0
            return
        if not is_readonly_tool(tool_name):
            return
        s["solo_read_streak"] = s.get("solo_read_streak", 0) + 1
        if s["solo_read_streak"] < SOLO_READ_NUDGE:
            return
        run = s["solo_read_streak"]
        s["solo_read_streak"] = 0                       # re-arm: steady cadence
        sent = s["solo_read_nudges_sent"] = s.get("solo_read_nudges_sent", 0) + 1
        s["_delegation_nudge_fired_this_turn"] = True
        again = ("" if sent == 1 else
                 f" This is the {sent}{_ordinal_suffix(sent)} time "
                 "this task — every one of those batches could have been running in parallel "
                 "while you did something else.")
        s["messages"].append({"role": "user", "content": (
            f"[SYSTEM] That's {run} read-only tool calls in a row in your OWN context.{again} "
            "Independent look-ups like these are exactly what a parallel subagent wave does for "
            "almost no context cost to you — and they run concurrently, so a batch of them takes "
            "about as long as one. Group the next batch into ONE dispatch_agents call "
            "(tier=\"cheap\" for symbol/where-is lookups, \"standard\" for real analysis), or tag "
            "the corresponding plan steps delegate=\"researcher@cheap\". Keep only the work that "
            "genuinely needs your own judgment inline."
        )})
        # TEETH: an advisory line alone is easy to read past — that was the ORIGINAL
        # failure (two subagents in a 300-step run). Dispatch is otherwise only
        # triggered by a plan_* tool call (_plan_bookkeeping_after_tool), so a long
        # inline-read streak that never touches the plan leaves any already-delegatable
        # steps sitting undispatched while the model reads on. When the streak trips,
        # proactively run the auto-tag + fan-out pass: if a plan with ready research/
        # change steps exists, they go out as a real wave NOW instead of only being
        # talked about. Idempotent (dispatched steps are tracked) and a no-op when no
        # plan/step qualifies — so pure free-exploration (no plan yet) still degrades
        # to advisory-only, where the harness genuinely can't author the sub-tasks.
        disp = getattr(self, "_maybe_dispatch_delegated_steps", None)
        if callable(disp):
            try:
                disp()
            except Exception:
                pass  # a dispatch hiccup must never break the main tool loop

    def _maybe_nudge_plan_delegation(self, s):
        """Delegation nudge #2 — PLAN SHAPE.

        A phase holding 2+ independent, still-pending, research-flavored steps
        with no `delegate` is a parallel wave the model left on the table. Names
        the exact step ids and the exact tag to add; never delegates by itself
        (that is _auto_delegate_untagged_steps' job, and it runs first).

        Keyed on the CANDIDATE SET, not just the phase id: once-per-phase meant a
        phase that later grew three new untagged research steps stayed silent
        forever. Re-fires whenever the set of untagged candidates actually
        changes, and stays quiet while it doesn't."""
        plan = planning.get_active_plan()
        if plan is None or not getattr(plan, "current_phase_id", None):
            return
        cands = [it for it in plan.items
                 if it.get("phase_id") == plan.current_phase_id
                 and it.get("status") not in planning.DONE_STATUSES
                 and not (it.get("delegate") or "").strip()
                 and not [d for d in (it.get("depends_on") or []) if d]
                 and _looks_like_research(it)
                 and not _hits_hints(_step_text(it), _JUDGMENT_HINTS)]
        if len(cands) < 2:
            return
        sig = (plan.current_phase_id, frozenset(str(it["id"]) for it in cands))
        nudged = s.setdefault("_delegation_phase_nudged", set())
        if sig in nudged:
            return
        nudged.add(sig)
        ids = ", ".join(str(it["id"]) for it in cands)
        s["messages"].append({"role": "user", "content": (
            f"[SYSTEM] Steps {ids} in this phase are independent research with no delegate. "
            "Tag each one delegate=\"researcher@cheap\" (plan_update_task) — they'll fan out as "
            "ONE parallel wave, run on a cheap model, and cost you almost no context. A "
            "self-contained CHANGE step can be delegated too — tag it "
            "delegate=\"implementer@standard\" (write subagents run one at a time on the shared "
            "workspace, so you get the isolated context and the cheaper model, not extra speed). "
            "Leave untagged only the steps that genuinely need your own judgment."
        )})

    def _maybe_nudge_premium_budget(self, s):
        """Advisory, escalating, fire-once-per-threshold: warn when premium is
        nearly (1 left) then fully spent, so the orchestrator reserves it for the
        highest-value remaining step. `premium_budget_nudged` is the level already
        announced (0 none / 1 nearly / 2 spent) so neither message repeats every
        turn. Silent when PREMIUM_BUDGET is disabled or there is >1 headroom."""
        if not PREMIUM_BUDGET:
            return None
        used = s.get("premium_dispatches", 0)
        remaining = PREMIUM_BUDGET - used
        sent = s.get("premium_budget_nudged", 0)
        if remaining <= 0:
            if sent >= 2:
                return None
            s["premium_budget_nudged"] = 2
            return ("[SYSTEM] Premium budget is spent for this session — further "
                    "@premium delegations will run on the standard model. Reserve any "
                    "remaining hard problem for where standard is genuinely insufficient.")
        if remaining == 1:
            if sent >= 1:
                return None
            s["premium_budget_nudged"] = 1
            return ("[SYSTEM] Premium budget nearly spent (1 premium dispatch left). "
                    "Reserve it for the single highest-value remaining step.")
        return None

    def _code_graph_guard(self, s, tool_name):
        """Catch the "sweeping files one by one" anti-pattern. Any navigation tool
        (graph query or content search) resets the counter; a long run of pure
        read_file_chunk with no navigation triggers a bounded nudge toward
        build_code_graph / query_code_graph / grep_directory."""
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
                    "[SYSTEM] You've read many files individually without querying the code "
                    "graph or running a search. On a decompiled app this exhausts context fast "
                    "and is the wrong approach. STOP reading files one by one and NAVIGATE "
                    "instead: call query_code_graph with just a name — no query_type needed — "
                    "e.g. query_code_graph(name=\"isRooted\") or query_code_graph(name=\"/system/"
                    "xbin/su\"); it AUTO-BUILDS the graph and searches strings+methods+classes+"
                    "native symbols at once, landing you on the exact file:line. To search any "
                    "tree (smali, Java, XML, assets) use grep_directory / search_smali / "
                    "find_files. Then read_file_chunk ONLY the specific slice those point you to. "
                    "If you genuinely have a reason to keep reading these files, continue."
                )})

    def _activate_used_toolsets(self, s, tool_name, tool_result, tool_failed, tool_feedback, is_loop_warning):
        """Progressive tool disclosure: usage-driven expansion. Calling any on-demand
        domain tool activates its whole toolset so its full schemas ride along on
        subsequent turns; an explicit expand_tools activates the group it names, and
        use_skill brings its toolsets online via _activate_groups. On a FAILED first
        call into a catalog-only group, the tool's full schema is appended inline so
        the model self-corrects in one shot. Loop-warning short-circuits (tool_result
        is None) don't count as a real call. Returns the (possibly appended)
        tool_feedback."""
        if not is_loop_warning:
            grp = registry.group_of(tool_name)
            was_catalog_only = (grp != CORE_GROUP
                                and grp not in s["active_toolsets"])
            newly_active = False
            if was_catalog_only:
                s["active_toolsets"].add(grp)
                newly_active = True
            if tool_name == "expand_tools" and isinstance(tool_result, dict):
                eg = tool_result.get("_expanded_group")
                if eg and eg not in s["active_toolsets"]:
                    s["active_toolsets"].add(eg)
                    newly_active = True
            # Loading a skill (use_skill) brings its toolsets online, so every tool the
            # skill instructs you to call arrives with full schemas next turn instead of
            # a one-line catalog entry. Same activation path as expand_tools.
            if isinstance(tool_result, dict):
                for ag in (tool_result.get("_activate_groups") or []):
                    if ag and ag not in s["active_toolsets"]:
                        s["active_toolsets"].add(ag)
                        newly_active = True
            # First call into a domain toolset that FAILED (usually a malformed/guessed
            # arg) — hand back that tool's full schema inline so the model self-corrects
            # in one shot instead of guessing again from the one-line catalog.
            if tool_failed and was_catalog_only:
                block = registry.full_tool_block(tool_name)
                if block:
                    tool_feedback += (
                        "\n\n[TOOLSET EXPANDED] Full schema for '%s' (its '%s' toolset is now "
                        "loaded for the rest of this session):\n%s" % (tool_name, grp, block))
            if newly_active:
                # Re-render messages[0] so the newly-active toolset's full schemas are
                # present on the next LLM call.
                self._refresh_system_prompt()
        return tool_feedback

    def _pre_tool_gates(self, s, tool_name, tool_args, adaptive, is_plan_tool):
        """Gates that run BEFORE a tool executes and may skip execution this turn by
        nudging the model (returning "continue"); otherwise returns None and the call
        proceeds. Covers: the replan gate (mutations paused after a watchdog trip until
        a deliberate plan_replan), the plan-and-execute gate (inspect freely, single
        soft nudge on the first un-planned mutation; legacy non-adaptive keeps the old
        "plan before any tool" behavior), and the repeat-failure guard (an EXACT call
        that already failed earlier is nudged once before it's allowed through)."""
        # Superpowers auto-brainstorm gate: FIRST thing on a new non-trivial task —
        # turn the goal into a chosen approach (autonomously) before anything else,
        # so the plan is built against it. Fires at most once per task (clears its own
        # flag), never blocks reads afterward, and never raises.
        if self._maybe_run_brainstorm_gate(s, tool_name) == "continue":
            return "continue"

        # Superpowers architect gate: with the approach chosen, have the architect
        # design the actual plan (in its own context, on a stronger model) and install
        # it — so execution starts from a wide, delegated, dependency-shaped plan
        # instead of whatever serial list the orchestrator would have typed. Fires at
        # most once per task and degrades to self-planning on any shortfall.
        if self._maybe_run_architect_gate(s, tool_name) == "continue":
            return "continue"

        # Replan gate: once the watchdog trips (a core approach failed repeatedly),
        # MUTATIONS stay paused until a DELIBERATE plan_replan, so the agent revises
        # the plan instead of grinding a dead end. Read-only inspection stays FREE
        # (inspect-freely policy). Plan tools are non-mutating so they pass; only
        # plan_replan actually clears the gate (in the post-tool bookkeeping).
        if adaptive and s.get("replan_required") and tool_name in MUTATING_TOOLS:
            self._emit({"type": "system", "content": "Waiting for a deliberate replan before changing anything more…"})
            s["messages"].append({"role": "user", "content": (
                "[SYSTEM] A core approach failed repeatedly, so further CHANGES are paused until you "
                "replan (you can still inspect freely). Call plan_replan with the reason (the recorded "
                "failures) and new steps for a different approach — it preserves completed work — or, if "
                "this is a genuine dead end, call plan_set_outcome 'blocked'/'needs_different_approach' "
                "with the evidence. Do not retry the failed path as-is."
            )})
            return "continue"

        # Diagnosis-phase gate: before CHANGING the workspace, require a complete
        # Strategic Brief that has passed one independent strategy review. Reads are
        # never gated (recon stays free), so a read-only run can never deadlock here.
        if s.get("strategy_brief_enabled") and tool_name in MUTATING_TOOLS:
            brief = strategy.get_active()
            if brief is None or not brief.required_present():
                self._emit({"type": "system", "content": (
                    "About to change the workspace with no diagnosed strategy yet — asking for a "
                    "Strategic Brief first.")})
                s["messages"].append({"role": "user", "content": (
                    "[SYSTEM] STRATEGIC BRIEF REQUIRED before changing the workspace. You've done recon; "
                    "now synthesize it: call strategy_set with the goal, the diagnosis (each protection "
                    "with a file:line/symbol evidence pointer), and the chosen strategy (plus rationale, "
                    "rejected alternatives, and kill-criteria if you can). It will be independently reviewed "
                    "before your first change. Read/inspection tools remain free.")})
                return "continue"
            if not brief.reviewed:
                return self._run_strategy_review_gate(s, brief)

        # Plan-and-execute gate — INSPECT FREELY, PLAN WHEN READY. A new task does NOT
        # have to be planned before inspecting: in adaptive mode every non-mutating
        # tool runs with no plan and no cap. The ONLY plan gate is a SINGLE soft nudge
        # the first time it goes to MUTATE the workspace with no plan; after that one
        # nudge the mutation is allowed. The plan is never force-created and never
        # silently disabled. (Legacy non-adaptive sessions keep the old simple "plan
        # before any tool" behavior.)
        if s.get("needs_plan") and not is_plan_tool:
            if adaptive:
                if tool_name not in MUTATING_TOOLS:
                    pass  # inspect freely — fall through and run it
                elif not s.get("mutating_gate_nudged"):
                    s["mutating_gate_nudged"] = True
                    self._emit({"type": "system", "content": "About to change the workspace with no plan yet — suggesting a plan first."})
                    s["messages"].append({"role": "user", "content": (
                        "[SYSTEM] You're about to MODIFY the workspace but haven't made a plan yet. "
                        "You were free to inspect; now that you're about to CHANGE something, prefer "
                        "plan_create first (task summary, success_criteria, constraints, phases, and the "
                        "first phase's concrete steps) so the work stays tracked and verifiable. If this "
                        "genuinely is a trivial one-off change, go ahead and repeat the call."
                    )})
                    return "continue"
                # else: already nudged once — allow the mutation through
                # (never deadlock, never disable the plan).
            else:
                s["plan_gate_retries"] = s.get("plan_gate_retries", 0) + 1
                if s["plan_gate_retries"] <= 3:
                    self._emit({"type": "system", "content": "Waiting for the agent to create a plan before proceeding..."})
                    s["messages"].append({"role": "user", "content": (
                        "[SYSTEM] This is a new task and no plan exists yet. Call plan_create with the "
                        "task summary, success_criteria, constraints, the high-level phases, and the "
                        "first phase's concrete steps before proceeding."
                    )})
                    return "continue"
                else:
                    self._emit({"type": "system", "content": "Proceeding without an explicit plan after repeated attempts to prompt for one."})
                    s["needs_plan"] = False

        # Anti-rabbit-hole assumption gate: before an EXPENSIVE native .so patch,
        # confirm the cheap check was done first — that the current (plain re-signed)
        # build was actually installed and observed. The overnight failure was burning
        # effort on a native anti-tamper patch that was never the cause; the re-signed
        # APK would have launched fine. Fires at most MAX_ASSUMPTION_NUDGES times per
        # task and only while no run of the current build has been observed, so it can
        # never nag and never blocks once the agent has looked.
        if (s.get("evidence_guards")
                and tool_name in NATIVE_SPECULATION_TOOLS
                and not s.get("build_observed")
                and s.get("assumption_nudges_sent", 0) < MAX_ASSUMPTION_NUDGES):
            s["assumption_nudges_sent"] = s.get("assumption_nudges_sent", 0) + 1
            self._emit({"type": "system", "content": (
                "About to patch native code without having run the current build — "
                "asking to confirm the crash first.")})
            s["messages"].append({"role": "user", "content": (
                f"[SYSTEM] Before patching native code with '{tool_name}', CONFIRM THE ASSUMPTION "
                "that a native check is actually the problem: build → sign → install → launch the "
                "current (plain re-signed) APK and OBSERVE whether it really crashes. On native game "
                "APKs a plain re-signed APK often launches fine, and a native bl→RET/NOP that yields "
                "UnsatisfiedLinkError breaks JNI RegisterNatives rather than defeating an anti-tamper "
                "check — a wasted rabbit hole. If you have already observed a crash and identified the "
                "specific check, repeat the call to proceed.")})
            return "continue"

        # Repeat-failure guard: this EXACT call already failed earlier in the run (not
        # just the immediately-previous call, which the loop-repeat guard covers).
        # Nudge once — skipping execution this turn — so the worker reconsiders instead
        # of blindly re-running a known-bad call. Bounded: after one nudge, the same
        # call is allowed through.
        if s.get("evidence_guards"):
            fsig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
            if (fsig in s.get("failed_sigs", {})
                    and fsig not in s.get("failed_sig_warned", set())):
                s.setdefault("failed_sig_warned", set()).add(fsig)
                self._emit({"type": "system", "content": (
                    f"'{tool_name}' with these exact args already failed earlier — "
                    "asking the agent to reconsider before retrying.")})
                _kc_line = ""
                if s.get("strategy_brief_enabled"):
                    _b = strategy.get_active()
                    if _b is not None and _b.kill_criteria:
                        _kc_line = ("\nCheck your brief's kill-criteria — if one is now met, abandon this "
                                    "strategy (strategy_update) instead of retrying: "
                                    + "; ".join(_b.kill_criteria))
                s["messages"].append({"role": "user", "content": (
                    f"[SYSTEM] You already ran '{tool_name}' with these EXACT arguments earlier "
                    "in this run and it FAILED. Don't blindly repeat it. Either change the "
                    "approach, or — if you now have NEW evidence it should work — record that "
                    "evidence (record_finding) and note why this attempt differs, then proceed. "
                    "If it's a genuine dead end, log it with record_failed_attempt and switch "
                    "strategy." + _kc_line)})
                return "continue"
        return None

    def _handle_tool_call(self, s, payload, explanation_text, time_str):
        """Execute one tool call end to end: pre-execution gates (may return
        "continue" to skip this turn), plugin pre/post hooks, the execution itself,
        progressive tool disclosure, per-call counters + narration cadence, plan
        bookkeeping/delegation, the code-graph and skill guards, the tool_result
        emit + TOOL RESULT message, context editing, the watchdog, evidence
        bookkeeping, and long-run compaction. Returns "continue" or None."""
        tool_name = payload.get("tool")
        tool_args = payload.get("args", {})

        adaptive = s.get("adaptive_planning")
        is_plan_tool = tool_name in PLAN_TOOL_NAMES or (tool_name or "").startswith("plan_")

        # Pre-execution gates (replan / plan / repeat-failure) may skip this
        # turn by nudging the model instead of running the call.
        if self._pre_tool_gates(s, tool_name, tool_args, adaptive, is_plan_tool) == "continue":
            return "continue"

        # Plugin pre_tool hook (advisory): a policy/verification plugin can
        # inspect the intended call and steer via an [PLUGIN] message. No-op
        # unless a plugin registered a pre_tool hook; never blocks execution.
        self._fire_plugin_hooks("pre_tool", tool=tool_name, args=tool_args)

        tool_id = uuid.uuid4().hex[:12]
        run_started = time.time()

        # Emit "running" immediately so the UI can show what tool
        # is executing BEFORE we wait for its output.
        self._emit({"type": "tool_running",
                    "id": tool_id,
                    "tool": tool_name,
                    "args": tool_args,
                    "step": s["step_count"] + 1})

        tool_feedback, tool_result = execute_tool(
            payload, s["last_tool_call"], s["loop_repeat_threshold"], return_result=True,
            run_dir=s.get("memory_dir"), task_context=(s.get("original_task") or ""))
        run_ms = int((time.time() - run_started) * 1000)
        is_loop_warning = tool_feedback.startswith("[SYSTEM WARNING]")
        tool_failed = _tool_result_failed(tool_result)

        # Progressive tool disclosure: a used tool's whole toolset comes
        # online (may append an inline schema to tool_feedback on a failed
        # first call into a catalog-only group).
        tool_feedback = self._activate_used_toolsets(
            s, tool_name, tool_result, tool_failed, tool_feedback, is_loop_warning)
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
        # Tool calls since the last narration line — drives the min-gap
        # throttle so narration can't fire again until several calls pass.
        s["tools_since_narration"] = s.get("tools_since_narration", 0) + 1
        # Cumulative tools-used count for this project's chat (persisted
        # and restored across reopen; reset only when the chat is cleared).
        s["tools_used"] = s.get("tools_used", 0) + 1

        # Explanation-cadence guardrail: enforce a MIDDLE ground so the
        # model neither narrates every single call nor runs a long silent
        # stretch. If this call carried an explanation, the counter was
        # reset above; otherwise count it, and once too many bare calls
        # pass, nudge the model to introduce its current sub-process on
        # the next call. Re-arms every N silent calls (steady cadence).
        if explanation_text:
            s["tools_since_explanation"] = 0
        else:
            s["tools_since_explanation"] = s.get("tools_since_explanation", 0) + 1
            if s["tools_since_explanation"] >= EXPLANATION_CADENCE_NUDGE:
                s["tools_since_explanation"] = 0
                s["messages"].append({"role": "user", "content": (
                    "[SYSTEM] You've run several tool calls without explaining what you're "
                    "doing. On your NEXT tool call, add a short, friendly \"explanation\" "
                    "introducing the sub-process you're working on now, so the user can follow "
                    "along. Keep narrating each new sub-process this way (about one explanation "
                    "per few related calls) — but don't explain every single call."
                )})

        # Delegation nudges: a long inline read streak is a subagent wave not taken.
        # The two nudges are mutually exclusive for every tool except plan_view (the
        # one plan tool that's also READONLY, so it can trip nudge #1 here AND fall
        # into _plan_bookkeeping_after_tool's plan-tool branch below for nudge #2) —
        # reset the per-turn flag first so a stale True from a PRIOR turn can't
        # suppress a nudge that should fire now.
        s["_delegation_nudge_fired_this_turn"] = False
        self._maybe_nudge_delegation(s, tool_name)

        # Premium budget nudge: re-arming advisory when the premium dispatch cap
        # is within 1 (or already spent), so the orchestrator reserves whatever's
        # left for the highest-value remaining step (see _maybe_nudge_premium_budget).
        pn = self._maybe_nudge_premium_budget(s)
        if pn:
            s["messages"].append({"role": "user", "content": pn})

        # Plan bookkeeping: gate-clear on a real plan, delegation dispatch,
        # phase-change re-grounding, and the plan-touch nudge. Nudge #2 inside it
        # is suppressed below when nudge #1 already fired this turn, so the model
        # never gets two "[SYSTEM]" delegation lectures back to back.
        self._plan_bookkeeping_after_tool(s, tool_name, tool_failed)

        # GSD context-hygiene: periodic re-grounding tick (once per tool
        # call). Injects a compact SITUATION block every REGROUND_EVERY
        # calls so the goal/plan stay anchored across a very long run.
        self._maybe_reground()

        # Plugin post_tool hook (advisory): fires after a REAL execution
        # (loop-warning short-circuits carry no result, so skip those). A
        # plugin can watch outcomes and steer via an [PLUGIN] message.
        if not is_loop_warning:
            self._fire_plugin_hooks("post_tool", tool=tool_name, args=tool_args,
                                    failed=bool(tool_failed), ok=not tool_failed)

        # Code-graph guard: catch the "sweeping files one by one" anti-pattern.
        self._code_graph_guard(s, tool_name)

        # Skill guard: consult a matching skill instead of improvising a
        # whole APK/RE workflow.
        self._skill_guard(s, tool_name, tool_args)

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

        # The model stacked several tool calls into one message (a
        # common GLM off-protocol shape). The parser executed the
        # first and named the rest in _dropped_calls; tell the model
        # so it resends them one per turn instead of assuming they ran.
        dropped = payload.get("_dropped_calls") if isinstance(payload, dict) else None
        if dropped:
            tool_feedback += (
                f"\n\n[SYSTEM] You emitted {len(dropped) + 1} tool calls in "
                f"one message; only the first ran. This loop takes ONE tool "
                f"call per turn. Resend these individually if still needed: "
                f"{', '.join(dropped)}.")

        s["messages"].append({"role": "user", "content": f"TOOL RESULT:\n{tool_feedback}"})

        # Context editing: collapse OLD, large tool results to stubs so a
        # long run's history stays lean (the plan + investigation memory
        # keep what mattered). Keeps the most-recent results verbatim.
        if s.get("context_editing", True):
            evict_old_tool_results(s["messages"])

        # Watchdog: the SAME tool failing repeatedly forces a strategy
        # switch (in adaptive mode, a replan pause).
        self._watchdog_after_tool(s, tool_name, tool_failed)

        # Evidence-based bookkeeping (opt-in per session via evidence_guards):
        # failed-signature memory, unverified-change tracking + validation
        # nudge, and auto-recording modified files into investigation memory.
        self._evidence_bookkeeping(s, tool_name, tool_args, tool_failed)

        # Long-run compaction: fold history into a summary after a lot of
        # tool steps and CONTINUE (never abort — an overnight run keeps going).
        self._maybe_compact_long_run(s)
        return None

    def _handle_truncated(self, s):
        """The provider cut the reply off at the output-token cap — the tool call
        never completed. Do NOT dump the raw partial (that was the "huge text chunk"
        bug); tell the model WHY it failed and how to recover (smaller outputs /
        chunked writes) so it retries a bounded call instead of the same one."""
        s["step_count"] += 1
        s["last_tool_call"] = None
        self._emit({"type": "system", "content": (
            "The model's last response hit the output-token limit and was cut off before "
            "the tool call finished — re-prompting for a smaller output (large files must be "
            "written in parts). Raw partial output suppressed.")})
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] Your previous response was TRUNCATED at the output-token limit "
            "(max_tokens) — the JSON was cut off mid-way, so the tool call did not run. Do "
            "NOT repeat the same oversized call. Produce a SMALLER output this turn: for a "
            "large file, write_file the first portion, then append the remaining lines with "
            "further calls (e.g. run_cmd appending via base64/tee, or replace_in_file to add "
            "sections). Keep every response well under the limit."
        )})

    def _handle_malformed(self, s, raw_response, time_str):
        """Still malformed after the in-turn retries. Do NOT terminate the session — a
        parse failure is recoverable. Surface the model's prose to the UI so the
        operator can see it, append a firm correction, and let the loop re-prompt next
        turn. Only a real final_answer (or a user stop) ends the run."""
        s["step_count"] += 1
        s["last_tool_call"] = None
        salvage = strip_reasoning(raw_response)
        self._emit({"type": "system", "content": (
            "Model replied outside the JSON protocol again — re-prompting for valid JSON "
            "(the session keeps running)." )})
        if salvage:
            self._emit({"type": "thought",
                        "text": _ui_trunc(salvage, UI_THOUGHT_CAP),
                        "thought_chars": len(salvage),
                        "time": time_str})
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] " + JSON_CORRECTION_MSG + " If you are finished, send a final_answer; "
            "otherwise issue the next tool_call. Do not reply with prose again."
        )})

    def _get_model_response(self, s):
        """Emit the thinking indicator, call the model, and parse its reply. A
        malformed reply gets bounded correction retries — the failed attempt stays
        in the message history so the model can see what it did wrong (the old
        copy-list approach threw that away, so every retry started from the same
        state that just failed). Appends the accepted assistant message and returns
        (response_type, payload, raw_response, elapsed_ms)."""
        self._emit({"type": "thinking_start"})
        start_time = time.time()
        raw_response = ask_llm(s["messages"], temperature=MAIN_LOOP_TEMPERATURE,
                               active_groups=s.get("active_toolsets"))
        self._count_conversation_usage(s)
        elapsed_ms = int((time.time() - start_time) * 1000)
        self._emit({"type": "thinking_end", "elapsed_ms": elapsed_ms})

        response_type, payload = parse_response(raw_response)

        parse_retries = 0
        while response_type == "error" and parse_retries < MAX_PARSE_RETRIES and not self._stop:
            parse_retries += 1
            self._emit({"type": "system",
                        "content": f"Response was not valid JSON — retrying ({parse_retries}/{MAX_PARSE_RETRIES})..."})
            s["messages"].append({"role": "assistant", "content": raw_response})
            s["messages"].append({"role": "user", "content": JSON_CORRECTION_MSG})
            self._emit({"type": "thinking_start"})
            start_time = time.time()
            raw_response = ask_llm(s["messages"], temperature=MAIN_LOOP_TEMPERATURE,
                               active_groups=s.get("active_toolsets"))
            self._count_conversation_usage(s)
            elapsed_ms += int((time.time() - start_time) * 1000)
            self._emit({"type": "thinking_end", "elapsed_ms": elapsed_ms})
            response_type, payload = parse_response(raw_response)

        s["messages"].append({"role": "assistant", "content": raw_response})
        return response_type, payload, raw_response, elapsed_ms

    def _emit_narration(self, s, response_type, payload, elapsed_ms, time_str):
        """Narration is opt-in per tool call: the model puts a short "explanation"
        INSIDE the tool_call JSON when it starts a new subtask. We emit a 'thought'
        event only when it's present, and the frontend uses it to open a new action
        group — subsequent explanation-less calls fold into that group. ("thought" is
        still accepted as a legacy alias.) Returns the (possibly throttled) explanation
        text so the tool-call phase can drive its explanation-cadence guardrail."""
        explanation_text = ""
        if response_type == "tool_call" and isinstance(payload, dict):
            # PLAN-DRIVEN NARRATION (primary): starting a plan step narrates the
            # subprocess — the step's explanation/description becomes the chat line and
            # opens a new action group for the calls that follow. Falls back to a
            # per-call "explanation" (secondary) and the first-call opener.
            explanation_text = _subprocess_narration(payload)
            if not explanation_text:
                explanation_text = str(
                    payload.get("explanation") or payload.get("thought") or ""
                ).strip()
            # Guarantee the FIRST action of a task opens with an explanation even if
            # the model omitted one, so a run never starts with a bare tool call.
            if not explanation_text and not s.get("narrated_this_task"):
                explanation_text = _default_opening_explanation(payload.get("tool"))
        # THROTTLE: after the first narration of the task, a new line is only surfaced
        # once several tool calls have run since the last one — so rapid, fine-grained
        # step transitions coalesce into the current group instead of spamming the
        # chat. The suppressed step still runs; only its chat line is dropped.
        if (explanation_text and s.get("narrated_this_task")
                and s.get("tools_since_narration", NARRATION_MIN_GAP) < NARRATION_MIN_GAP):
            explanation_text = ""
        if explanation_text:
            self._emit({"type": "thought", "time": time_str, "elapsed_ms": elapsed_ms,
                        "text": _ui_trunc(explanation_text, UI_THOUGHT_CAP),
                        "thought_chars": len(explanation_text)})
            s["narrated_this_task"] = True
            # A narration line was just shown — reset both cadence counters (the
            # too-silent nudge and the too-chatty min-gap throttle).
            s["tools_since_explanation"] = 0
            s["tools_since_narration"] = 0
        return explanation_text

    def _run_review_gate(self, s, payload):
        """Independent-reviewer gate on a final answer. A separate isolated context
        (same model/key) checks the conclusion for unsupported claims, contradictions,
        and incomplete/unverified work. On "revise" it injects the reviewer's feedback
        and returns "continue" so the worker fixes the gaps and answers again; otherwise
        returns None (accept). Bounded by MAX_REVIEW_ROUNDS so it can never deadlock. A
        bare conversational reply (no tools, no plan, no investigation) has nothing to
        independently verify, so the review call is skipped entirely."""
        answer_text = (payload or "").strip() if isinstance(payload, str) else str(payload or "").strip()
        _inv = investigation.get_active()
        did_work = (s.get("consecutive_tools", 0) > 0
                    or planning.get_active_plan() is not None
                    or (_inv is not None and not _inv.is_empty()))
        if (s.get("review_enabled") and answer_text and did_work
                and s.get("review_rounds", 0) < MAX_REVIEW_ROUNDS and not self._stop):
            self._emit({"type": "system", "content": (
                "Independent reviewer verifying the conclusion (evidence, contradictions, "
                "completeness)…")})
            inv = investigation.get_active()
            # Give the reviewer the LIVE plan (mission, success criteria, phases,
            # outcome) alongside the investigation evidence, so it judges the
            # conclusion against what the task set out to do and the state it
            # actually reached — not just the notes.
            ctx_parts = []
            _rev_plan = planning.get_active_plan()
            if _rev_plan is not None:
                ctx_parts.append("CURRENT PLAN:\n" + _rev_plan.to_markdown())
            if inv is not None and not inv.is_empty():
                ctx_parts.append("INVESTIGATION MEMORY:\n" + inv.to_markdown())
            ctx = "\n\n".join(ctx_parts)
            if s.get("unverified_change"):
                ctx += (f"\n\nNOTE: a change made by '{s['unverified_change']}' has not yet been "
                        "validated by an objective check (build/install/launch/test/log).")
            try:
                verdict = run_review(answer_text, task=s.get("original_task") or "",
                                     extra_context=ctx, max_steps=REVIEW_MAX_STEPS)
            except Exception as e:
                verdict = {"approved": True, "summary": f"review skipped ({e})", "feedback": ""}
            self._emit({"type": "review",
                        "verdict": "approve" if verdict.get("approved") else "revise",
                        "summary": verdict.get("summary", ""),
                        "unsupported_claims": verdict.get("unsupported_claims", []),
                        "contradictions": verdict.get("contradictions", []),
                        "incomplete_work": verdict.get("incomplete_work", []),
                        "required_actions": verdict.get("required_actions", [])})
            if not verdict.get("approved"):
                s["review_rounds"] = s.get("review_rounds", 0) + 1
                self._emit({"type": "system", "content": (
                    f"Reviewer requested changes (round {s['review_rounds']}/{MAX_REVIEW_ROUNDS}): "
                    f"{verdict.get('summary', '')}")})
                s["messages"].append({"role": "user", "content": (
                    verdict.get("feedback")
                    or "[REVIEWER] Revise and re-verify the conclusion before finalizing.")})
                return "continue"  # worker addresses the feedback, then answers again
            self._emit({"type": "system", "content": (
                f"Reviewer approved the conclusion: {verdict.get('summary', '')}")})
        return None

    def _reconcile_brief_on_phase_change(self):
        """A phase advance is a natural re-synthesis point: re-open the Strategic
        Brief for an independent review (it will re-fire before the next mutation)
        and nudge the worker to reconcile it against the new evidence."""
        s = self.session
        if not s.get("strategy_brief_enabled"):
            return
        brief = strategy.get_active()
        if brief is None or brief.is_empty():
            return
        brief.reviewed = False
        strategy.notify_updated()
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] Phase advanced — reconcile your STRATEGIC BRIEF with what you've now established "
            "(strategy_update): is the diagnosis still right, and is this still the best strategy? It will "
            "be independently re-reviewed before your next change.")})

    def _note_finding_for_brief(self):
        """Count a new confirmed finding; every STRATEGY_RESYNC_FINDINGS, nudge a
        brief reconcile so the thesis keeps up with accumulating evidence."""
        s = self.session
        if not s.get("strategy_brief_enabled"):
            return
        brief = strategy.get_active()
        if brief is None or brief.is_empty():
            return
        s["findings_since_brief_sync"] = s.get("findings_since_brief_sync", 0) + 1
        if s["findings_since_brief_sync"] >= STRATEGY_RESYNC_FINDINGS:
            s["findings_since_brief_sync"] = 0
            s["messages"].append({"role": "user", "content": (
                "[SYSTEM] Several new findings since your last strategy sync — reconcile the STRATEGIC "
                "BRIEF (strategy_update): confirm the diagnosis and top hypothesis still hold, and adjust "
                "the strategy if the evidence has moved.")})

    # --- Superpowers auto-brainstorm gate --------------------------------------
    _BRAINSTORM_AUTONOMY = (
        "AUTONOMOUS MODE: do NOT defer to the user and do NOT return OPEN QUESTIONS. "
        "This runs unattended — no one will answer questions. Resolve every open "
        "question yourself with your best-judgment ASSUMPTION and label it. Return "
        "the brief with an ASSUMPTIONS section (each a decision you made) instead of "
        "a QUESTIONS section. Be decisive: pick ONE recommended approach."
    )

    def _brainstorm_context(self):
        """Light grounding for the brainstormer: workspace root + any existing plan /
        investigation memory. Kept short — the subagent inspects the workspace itself."""
        s = self.session
        bits = []
        root = s.get("root") or s.get("project")
        if root:
            bits.append(f"Workspace root: {root}")
        _plan = planning.get_active_plan()
        if _plan is not None and not _plan.is_complete():
            bits.append("An in-progress plan already exists:\n" + _plan.to_markdown())
        _inv = investigation.get_active()
        if _inv is not None and not _inv.is_empty():
            bits.append("Investigation memory so far:\n" + _inv.to_markdown())
        return "\n\n".join(bits)

    def _brainstorm_inline_fallback(self, s, note=None):
        """Inline self-brainstorm: no subagent is dispatched (used for inline-only
        mode and whenever the brainstormer persona is unavailable or fails). The
        model does the design thinking itself, in-context, before planning."""
        if note:
            self._emit({"type": "system", "content": note})
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] Before planning, BRAINSTORM this task inline and DECIDE — do not ask the user "
            "anything. In a few tight lines: (1) restate the goal crisply; (2) give 2–3 candidate "
            "approaches with honest trade-offs; (3) pick ONE and say why; (4) list the assumptions "
            "you're resolving on your own (label them ASSUMPTION); (5) note the key risks. Then plan "
            "against your chosen approach."
        )})

    _ARCHITECT_CONTRACT = (
        "Return your PLAN PROPOSAL as a single JSON object in a ```json fenced block, shaped "
        "EXACTLY like this (no other text is needed):\n"
        '{"task": "<one sentence>", "success_criteria": ["<objective, checkable>"], '
        '"constraints": ["<hard boundary>"], "phases": ["<milestone 1>", "<milestone 2>"], '
        '"components": ["<named build unit, for a large multi-artifact change>"], '
        '"risks": ["<risk/unknown>"], "next_action": "<the single next move>", '
        '"steps": [{"content": "<small verifiable step>", "key": "<short local name>", '
        '"delegate": "<subagent, optionally agent@tier>", "depends_on": ["<key of a step this '
        'one truly needs>"], "scope": ["<workspace paths this step owns, e.g. smali/com/x/**>"], '
        '"purpose": "...", "expected": "...", "verification": "<how it is objectively checked>", '
        '"fallback": "..."}]}\n'
        "PLAN FOR PARALLEL EXECUTION — this is the point of the proposal:\n"
        "- Steps with NO depends_on are dispatched CONCURRENTLY, so put every genuinely "
        "independent piece of the FIRST phase in `steps` and give depends_on ONLY where one "
        "step truly consumes another's result. A chain of steps that could have been a wave is "
        "the single most costly mistake you can make here.\n"
        "- Decompose by OWNERSHIP for a large change: one step per package / library / module, "
        "each with a `scope` naming the paths it owns. Disjoint scopes run at the same time; an "
        "unscoped change step takes the whole workspace and blocks everything else.\n"
        "- Tag every self-contained step with a `delegate` and match the tier to the job "
        "(a lookup is cheap, a design decision is not).\n"
        "- List each build unit of a large modification in `components` so progress is counted "
        "in artifacts, not in prose."
    )

    def _maybe_run_architect_gate(self, s, tool_name):
        """After the brainstorm and BEFORE any planning, have the `architect` persona
        inspect the workspace and hand back a structured, parallel-shaped plan, which
        is installed as the active plan directly.

        Why a subagent writes the plan: the orchestrator plans from whatever it has
        already read, under its own context pressure, and reliably produces a SERIAL
        list — which then executes serially no matter how much parallel machinery
        sits underneath. The architect inspects freely in its own context, on a
        stronger model, and answers in the plan's own vocabulary (delegate /
        depends_on / scope), so the parallel shape survives into execution instead of
        being flattened by re-transcription.

        Fires ONCE per new non-trivial task, never in inline-only mode, and degrades
        safely at every step: no persona, a failed run, or an unparseable answer all
        fall back to the orchestrator planning for itself (its proposal, if any, is
        still handed over as text). Never raises."""
        if not (s.get("superpowers_enabled") and s.get("needs_architect")):
            return None
        s["needs_architect"] = False        # spent, whatever happens below
        if s.get("inline_only") or not s.get("needs_plan"):
            return None
        task = (s.get("original_task") or "").strip()
        if not task:
            return None
        agent_def = plugins.get_agent(SUPERPOWERS_ARCHITECT)
        if agent_def is None:
            return None

        tier, budget_note = self._premium_budget_gate(getattr(agent_def, "tier", None) or "premium")
        if budget_note:
            self._emit({"type": "delegate_note", "agent": agent_def.name, "content": budget_note})
        self._emit({"type": "system", "content": (
            "Superpowers: the architect is inspecting the workspace and designing a "
            "parallel-shaped plan…")})

        context = self._brainstorm_context()
        brief = superpowers.get_active()
        if brief is not None and not brief.is_empty():
            context = ("DESIGN BRIEF (the approach already chosen — plan against it):\n"
                       + brief.to_markdown() + ("\n\n" + context if context else ""))
        try:
            result = subagents.run_subagent(agent_def, task + "\n\n" + self._ARCHITECT_CONTRACT,
                                            context=context, on_event=self._emit, tier=tier)
        except Exception as e:
            self._emit({"type": "system", "content": (
                f"Superpowers: architect run failed ({e}) — planning inline instead.")})
            return None

        report = (result or {}).get("report") or ""
        proposal = superpowers.parse_plan_proposal(report) if report.strip() else None
        if proposal is None:
            if report.strip():
                # Not machine-readable, but the thinking is still worth having.
                s["messages"].append({"role": "user", "content": (
                    "[SYSTEM] The architect subagent inspected the workspace and proposed this "
                    "plan. Turn it into plan_create yourself — and keep its parallel shape: "
                    "independent steps in the same phase with delegate + scope set, depends_on "
                    "only where a step truly needs another's result.\n\n" + report)})
                self._emit({"type": "system", "content": (
                    "Superpowers: architect returned a prose plan — handing it to the planner.")})
                return "continue"
            return None

        try:
            plan = self._install_proposed_plan(proposal, task, brief)
        except Exception as e:
            self._emit({"type": "system", "content": (
                f"Superpowers: could not install the architect's plan ({e}) — planning inline.")})
            return None

        s["needs_plan"] = False
        s["mutating_gate_nudged"] = True     # the plan exists; no un-planned-mutation nudge
        ready = [it for it in plan.ready_steps() if it["status"] == "pending"]
        self._emit({"type": "system", "content": (
            f"Plan installed from the architect: {len(plan.phases)} phase(s), "
            f"{len(plan.items)} step(s) in the current phase, {len(ready)} runnable right now.")})
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] The architect inspected the workspace and its PLAN IS NOW ACTIVE — you did "
            "not have to write it and you should NOT call plan_create. Read it (it is pinned in "
            f"your context), then EXECUTE it: {len(ready)} step(s) are independent and ready right "
            "now, and delegated ones dispatch as a concurrent wave the moment you start them. "
            "Adjust it as evidence arrives (plan_add_tasks / plan_update_task / plan_replan) — "
            "but do not quietly re-do the design work, and do not turn its parallel steps into a "
            "serial march."
        )})
        return "continue"

    def _install_proposed_plan(self, proposal, task, brief=None):
        """Build and activate a Plan from parsed architect proposal args. Also seeds
        the build ledger with the proposal's components, so a large multi-artifact
        change starts with a countable worklist instead of prose."""
        plan = planning.Plan(proposal.get("task") or task)
        plan.set_mission(success_criteria=proposal.get("success_criteria"),
                         constraints=proposal.get("constraints"))
        plan.set_orientation(
            unknowns=proposal.get("risks"),
            assumptions=(brief.assumptions if brief is not None else None))
        if proposal.get("phases"):
            plan.set_phases(proposal["phases"])
        plan.add_items(proposal.get("steps") or [])
        if proposal.get("next_action"):
            plan.set_next_action(proposal["next_action"])
        planning.set_active_plan(plan)

        components = proposal.get("components") or []
        if components:
            try:
                lg = ledger.ensure_active(plan.task)
                for name in components:
                    lg.add_component(name)
                ledger.notify_updated()
            except Exception:
                pass      # the ledger is an accelerator, never a hard dependency
        return plan

    def _maybe_run_brainstorm_gate(self, s, tool_name):
        """On the first tool call of a NEW non-trivial task, brainstorm the goal into
        a chosen approach BEFORE anything else — autonomously, never asking the user.
        Default path dispatches the `brainstormer` persona (isolated context, distilled
        report) and pins the result as a Design Brief; inline-only mode brainstorms
        in-context instead. Fires ONCE (clears needs_brainstorm up front, so it can
        never loop), never blocks reads afterward, and never raises."""
        if not (s.get("superpowers_enabled") and s.get("needs_brainstorm")):
            return None
        # Clear immediately: whatever happens below, this task's brainstorm is spent.
        s["needs_brainstorm"] = False

        task = (s.get("original_task") or "").strip()
        if not task:
            return None

        # Inline-only: honor "no subagents" — brainstorm in-context, don't dispatch.
        if s.get("inline_only"):
            self._brainstorm_inline_fallback(
                s, note="Superpowers: brainstorming inline (you asked for inline execution)…")
            return "continue"

        agent_def = plugins.get_agent(SUPERPOWERS_BRAINSTORMER)
        if agent_def is None:
            self._brainstorm_inline_fallback(
                s, note=("Superpowers: brainstormer persona unavailable — brainstorming inline instead."))
            return "continue"

        tier, budget_note = self._premium_budget_gate(getattr(agent_def, "tier", None) or "premium")
        if budget_note:
            self._emit({"type": "delegate_note", "agent": agent_def.name, "content": budget_note})
        self._emit({"type": "system", "content": (
            "Superpowers: auto-brainstorming the goal into a chosen approach before planning "
            "(autonomous — deciding, not asking)…")})

        sub_task = task + "\n\n" + self._BRAINSTORM_AUTONOMY
        try:
            result = subagents.run_subagent(agent_def, sub_task,
                                            context=self._brainstorm_context(),
                                            on_event=self._emit, tier=tier)
        except Exception as e:
            self._brainstorm_inline_fallback(
                s, note=f"Superpowers: brainstorm subagent errored ({e}) — brainstorming inline instead.")
            return "continue"

        report = (result or {}).get("report") or ""
        if not (result or {}).get("ok") or not report.strip():
            self._brainstorm_inline_fallback(
                s, note="Superpowers: brainstorm subagent returned nothing usable — brainstorming inline.")
            return "continue"

        brief = superpowers.parse_brief_report(report, source="subagent")
        if brief is None or brief.is_empty():
            self._brainstorm_inline_fallback(
                s, note="Superpowers: could not parse a design brief — brainstorming inline.")
            return "continue"

        superpowers.set_active_brief(brief)  # notifies -> pins into the prompt
        self._emit({"type": "system", "content": (
            f"Design brief ready — approach: {brief.one_line()[:160]}")})
        s["messages"].append({"role": "user", "content": (
            "[SYSTEM] A DESIGN BRIEF for this task has been prepared by the brainstormer and pinned "
            "in your context (see 'DESIGN BRIEF'). It chose an approach and resolved the open "
            "questions as ASSUMPTIONS — do NOT ask the user about them. Now create the plan against "
            "that chosen approach (plan_create), then execute. If you genuinely disagree with the "
            "brief, say why and adjust — but do not re-brainstorm from scratch."
        )})
        return "continue"

    def _run_strategy_review_gate(self, s, brief):
        """Independently review the Strategic Brief before the first mutation. On
        approve, mark it reviewed and return None (let the mutation proceed). On
        revise, inject the reviewer's feedback and return "continue" so the worker
        fixes the brief. Bounded by MAX_STRATEGY_REVIEW_ROUNDS — after the cap it
        forces the brief through (reviewed=True) so the gate can never deadlock."""
        if s.get("strategy_review_rounds", 0) >= MAX_STRATEGY_REVIEW_ROUNDS:
            brief.reviewed = True
            strategy.notify_updated()
            s["strategy_review_rounds"] = 0
            self._emit({"type": "system", "content": (
                "Strategy review round cap reached — proceeding with the current brief (still contested).")})
            return None
        self._emit({"type": "system", "content": (
            "Independent strategy reviewer pressure-testing the brief (diagnosis, better-strategy, order)…")})
        ctx_parts = []
        _plan = planning.get_active_plan()
        if _plan is not None:
            ctx_parts.append("CURRENT PLAN:\n" + _plan.to_markdown())
        _inv = investigation.get_active()
        if _inv is not None and not _inv.is_empty():
            ctx_parts.append("INVESTIGATION MEMORY:\n" + _inv.to_markdown())
        ctx = "\n\n".join(ctx_parts)
        try:
            verdict = run_strategy_review(brief.to_markdown(), task=s.get("original_task") or "",
                                          extra_context=ctx, max_steps=REVIEW_MAX_STEPS)
        except Exception as e:
            verdict = {"approved": True, "summary": f"strategy review skipped ({e})", "feedback": ""}
        self._emit({"type": "strategy_review",
                    "verdict": "approve" if verdict.get("approved") else "revise",
                    "summary": verdict.get("summary", ""),
                    "unsupported_claims": verdict.get("unsupported_claims", []),
                    "contradictions": verdict.get("contradictions", []),
                    "incomplete_work": verdict.get("incomplete_work", []),
                    "required_actions": verdict.get("required_actions", [])})
        if verdict.get("approved"):
            brief.reviewed = True
            strategy.notify_updated()
            s["strategy_review_rounds"] = 0
            self._emit({"type": "system", "content": (
                f"Strategy approved: {verdict.get('summary', '')}")})
            return None
        s["strategy_review_rounds"] = s.get("strategy_review_rounds", 0) + 1
        s["messages"].append({"role": "user", "content": (
            verdict.get("feedback") or "[STRATEGY REVIEWER] Revise the brief before changing anything.")})
        return "continue"

    def _handle_final_answer(self, s, payload, time_str):
        """Accept-or-send-back gate for a final answer. The plugin on_final_answer
        hook, the plan-outcome gate, and the independent review gate each get a chance
        to send the answer back for more work (returning "continue"). If all pass, the
        salvage stats + final_answer event are emitted and the run ends (returns
        "break")."""
        s["step_count"] += 1
        s["last_tool_call"] = None

        # --- Plugin on_final_answer gate ---
        # Give hook-bearing plugins (e.g. a verification plugin) the last word before
        # the answer is accepted. If any injects an advisory, the answer is sent back
        # for more work. Bounded by MAX_FINAL_HOOK_NUDGES so it can never deadlock; a
        # zero-cost no-op when no plugin hooks on_final_answer.
        if (s.get("final_hook_nudges", 0) < MAX_FINAL_HOOK_NUDGES
                and not self._stop):
            _ans = payload if isinstance(payload, str) else str(payload or "")
            if self._fire_plugin_hooks("on_final_answer", answer=_ans,
                                       unverified_change=s.get("unverified_change")):
                s["final_hook_nudges"] = s.get("final_hook_nudges", 0) + 1
                self._emit({"type": "system", "content": (
                    "A plugin asked for more before finishing (verification/policy).")})
                return "continue"

        # --- Plan-outcome gate ---
        # Don't let an in-progress plan be silently abandoned by a final answer. If a
        # plan is active with no terminal outcome yet, ask for an explicit
        # plan_set_outcome first — so the task's end state is deliberate. Bounded by
        # MAX_FINAL_PLAN_NUDGES so it can't deadlock.
        _active_plan = planning.get_active_plan()
        if (s.get("adaptive_planning") and _active_plan is not None
                and _active_plan.outcome == "active"
                and s.get("final_plan_nudges", 0) < MAX_FINAL_PLAN_NUDGES
                and not self._stop):
            s["final_plan_nudges"] = s.get("final_plan_nudges", 0) + 1
            self._emit({"type": "system", "content": (
                "An active plan hasn't been concluded — asking for an explicit outcome "
                "before finishing.")})
            s["messages"].append({"role": "user", "content": (
                "[SYSTEM] You're about to give a final answer, but the active plan has no "
                "terminal outcome yet. First call plan_set_outcome to declare where the task "
                "landed: 'completed' (success criteria met AND verified), 'partial' (say what's "
                "left), 'blocked' (say what's blocking), or 'needs_different_approach' (say why). "
                "Then send your final answer."
            )})
            return "continue"

        # --- Review gate ---
        if self._run_review_gate(s, payload) == "continue":
            return "continue"

        s["review_rounds"] = 0
        # Surface the tool-call salvage rate for the run. If the model went
        # off-protocol a lot, the operator sees it here instead of only when a run
        # dies. Silent when nothing was salvaged.
        _salvaged = SALVAGE_STATS.get("salvaged", 0)
        if _salvaged:
            self._emit({"type": "system", "content": (
                f"Tool-call salvage this run: {_salvaged} off-protocol "
                f"message(s) recovered by the parser"
                + (f", {SALVAGE_STATS['dropped_calls']} stacked extra call(s) "
                   f"fed back" if SALVAGE_STATS.get("dropped_calls") else "")
                + ".")})
        self._emit({"type": "final_answer",
                    "content": payload,
                    "steps": s["step_count"],
                    "time": time_str})
        return "break"

    def _run_agent_loop(self):
        s = self.session
        try:
            while True:
                if self._stop:
                    self._emit({"type": "system", "content": "Generation stopped by user."})
                    break

                # Durably save the conversation as it grows (throttled), so a hard
                # interrupt / crash mid-run keeps the history instead of losing every
                # turn since the last send_message. Runs at the loop top so it fires
                # on every iteration regardless of which `continue` a turn takes.
                self._persist_session_throttled()

                # No consecutive-tool nudge: this agent is built for multi-day runs
                # where hundreds of tool calls in a row are normal. Injecting a
                # "you've run N tools, give a final answer or continue" message only
                # pollutes context and pressures the model into ending early. The
                # loop ends only on a real final_answer or an explicit user stop;
                # long-run context is kept in check by the compaction at
                # MAX_CONSECUTIVE_TOOLS and the context-window guard below.

                # Thinking indicator, LLM call, and bounded JSON-correction retries.
                response_type, payload, raw_response, elapsed_ms = self._get_model_response(s)

                # Narration: surface the model's per-subtask "explanation" as a
                # throttled 'thought' so the UI opens a new action group on a shift.
                time_str = _fmt_elapsed(elapsed_ms)
                explanation_text = self._emit_narration(s, response_type, payload, elapsed_ms, time_str)

                if response_type == "tool_call":
                    if self._handle_tool_call(s, payload, explanation_text, time_str) == "continue":
                        continue
                elif response_type == "final_answer":
                    sig = self._handle_final_answer(s, payload, time_str)
                    if sig == "break":
                        break
                    if sig == "continue":
                        continue
                elif response_type == "truncated":
                    self._handle_truncated(s)
                    # fall through to the context/status housekeeping and loop again
                else:
                    self._handle_malformed(s, raw_response, time_str)
                    # fall through to the context/status housekeeping and loop again

                if self._stop:
                    self._emit({"type": "system", "content": "Generation stopped by user."})
                    break

                self._maybe_summarize_context(s)
                self._emit_status(s)
        except Exception as e:
            self._emit({"type": "error", "content": f"Agent loop crashed: {e}"})
        finally:
            with self._lock:
                self._busy = False
            # A keyword-armed ultra mode covers exactly the turn that asked for
            # it. The header toggle is unaffected (it never sets ultra_turn_only).
            if s.get("ultra_turn_only"):
                s["ultra_turn_only"] = False
                s["ultra"] = False
                self._refresh_system_prompt()
                self._emit({"type": "ultra_mode", "ultra": False})
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
        # pywebview defaults this to False, which injects
        # `body { -webkit-user-select: none }` into the whole webview — that is
        # what made chat messages impossible to drag-select or copy. Selection
        # policy now lives in frontend/index.html instead (chrome stays
        # unselectable, transcript/output/file text is selectable).
        text_select=True,
    )
    api.set_window(window)

    # OpenAI-compatible passthrough proxy: a single keyless endpoint on the LAN
    # that fronts the whole LLM fallback stack, so BYOK tools (opencode, Cursor,
    # curl) can reuse this machine's providers. Opt out with OMNI_API_SERVER=0;
    # override bind with OMNI_API_HOST / OMNI_API_PORT. Never fatal to the app.
    if os.environ.get("OMNI_API_SERVER", "1") != "0":
        try:
            import api_server
            api_server.start_in_background(
                host=os.environ.get("OMNI_API_HOST", api_server.DEFAULT_HOST),
                port=int(os.environ.get("OMNI_API_PORT", api_server.DEFAULT_PORT)),
            )
        except OSError as e:
            print(f"[api-server] not started ({e}) — is the port already in use?")
        except Exception as e:
            print(f"[api-server] failed to start: {e}")

    # DevTools (Web Inspector) no longer auto-opens on launch. Opt back in with
    # OMNI_DEVTOOLS=1 when you actually need to debug the renderer.
    _devtools = os.environ.get("OMNI_DEVTOOLS", "0").strip().lower() in ("1", "true", "yes", "on")
    webview.start(debug=_devtools)


if __name__ == "__main__":
    main()
