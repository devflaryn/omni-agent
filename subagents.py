"""Generalized isolated-context subagent engine.

This is the one primitive the whole orchestrator/plugin/delegation stack is built
on. It GENERALIZES the two isolated sub-agents that already exist in this project
— `tools/codebase_qa.ask_codebase` and `tools/reviewer.run_review` — into a single
runner that can drive ANY persona over ANY allowed tool surface, then hand back a
DISTILLED result while the sub-transcript is discarded.

Why it matters for a hours→days run on a fixed 1M context: a subagent gets its own
fresh conversation, does the heavy tool work there, and returns only a short report.
The orchestrator's main context never accumulates the dozens of reads/queries/edits
the task actually took — the GSD "fresh context per task, task 50 == task 1"
property.

Two capability modes (the user-chosen hybrid):
  * mode="read"  — tool surface is filtered to the read-only inspection allowlist
    (tool_policy.READONLY_TOOLS). Safe to run MANY in PARALLEL (run_subagents_parallel).
  * mode="write" — may use mutating/build/validate tools too, but runs SERIALIZED
    behind a single workspace lock so only one writer ever touches the project folder.

No new provider/key: every subagent reuses `llm.ask_llm`, exactly like the two
sub-agents this replaces. Never raises for orchestration reasons — a failed
subagent returns {ok: False, report: "<why>"} so the caller decides.
"""
import concurrent.futures
import json
import os
import threading
import time
import uuid

import llm
from llm import ask_llm, extract_json_action, strip_reasoning
from tool_registry import registry, CORE_GROUP
from tool_policy import is_readonly_tool, is_mutating_tool, READONLY_TOOLS, SUBAGENT_EXCLUDED
from workflows import schema as _wf_schema

# --- Bounds (reuse the proven values from codebase_qa / reviewer) ------------
DEFAULT_MAX_STEPS = 12       # tool calls a subagent may make before it must answer
SUBAGENT_TEMPERATURE = 0.3   # steady tool use, like the other isolated sub-agents
PER_RESULT_CHAR_CAP = 6000   # truncate each tool result fed back into the sub-session
SCHEMA_MAX_TRIES = 3         # initial answer + 2 repairs
CONTEXT_CHAR_LIMIT = 180_000 # compact (then, if still large, finalize) past this
REPEAT_LIMIT = 3             # identical call this many times in a row -> steer


def _env_int(name, default, minimum=1):
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return default


# Hard ceiling on a subagent's tool calls, regardless of the agent def / caller.
# Sized for BUILD work, not just lookups: authoring a large artifact incrementally
# (append_to_file) or porting a package of smali is dozens of calls on its own, and
# a subagent that gets cut off mid-build hands back a half-finished workspace, which
# is worse than one that costs more. Env-overridable for tuning.
MAX_STEPS_CAP = _env_int("OMNI_SUBAGENT_MAX_STEPS_CAP", 120)

# How many times a long-running subagent may COMPACT its own sub-conversation
# before it is forced to finalize. Compaction (rather than an immediate forced
# answer) is what lets a build agent keep working past the context limit: the
# middle of the transcript is elided, its durable output is on disk / in the
# ledger anyway, and it continues with its task and recent context intact.
CONTEXT_COMPACTIONS_MAX = _env_int("OMNI_SUBAGENT_COMPACTIONS", 4, minimum=0)
COMPACT_KEEP_TAIL = 8        # recent messages preserved verbatim on compaction

# Max subagents run at once in a single wave. Cost is not a constraint, so this is
# deliberately generous and DECOUPLED from the key count (keys are shared across
# concurrent subagents by KeyAllocator). Env-overridable for tuning against provider
# rate limits.
try:
    SUBAGENT_MAX_CONCURRENCY = max(1, int(os.environ.get("OMNI_SUBAGENT_MAX_CONCURRENCY", "16")))
except ValueError:
    SUBAGENT_MAX_CONCURRENCY = 16


def _pool_size(n_specs):
    """Concurrency for a read wave: up to SUBAGENT_MAX_CONCURRENCY, never more than
    the number of specs, floored at 1. Decoupled from the key count — keys are
    shared across concurrent subagents (cost is irrelevant), so parallelism is
    bounded by the work and the safety cap, not by how many keys exist."""
    return max(1, min(SUBAGENT_MAX_CONCURRENCY, n_specs))

# --- workspace write concurrency ---------------------------------------------
# Write subagents used to share ONE global lock, so every change in a run happened
# strictly one at a time. That is correct but needlessly total: two agents porting
# smali/com/a/** and smali/com/b/** cannot collide, and serializing them is what
# made a multi-megabyte, many-file modification take as long as it did.
#
# A write subagent now declares the paths it OWNS (from its plan step's `scope`).
# Non-overlapping owners run CONCURRENTLY; an agent that declares nothing keeps the
# old exclusive-whole-workspace behavior, so anything that doesn't opt in is exactly
# as safe as before. Read subagents never acquire anything.


def _scope_prefixes(scope):
    """Reduce path patterns to the literal prefixes used for overlap tests.

    Everything from the first wildcard on is dropped, because anything at or below
    that point may match: "smali/com/foo/**" -> "smali/com/foo". A prefix that ends
    mid-segment (from "smali*/x") is flagged so it is compared as a raw string
    prefix — "smali*" must be treated as overlapping "smali_classes2/...".

    Returns a list of (prefix, ends_mid_segment) pairs, or [] meaning EXCLUSIVE.
    Deliberately over-approximates: it may report an overlap that could not really
    happen, never the reverse."""
    out = []
    for pat in (scope or []):
        p = str(pat or "").strip().replace("\\", "/").lstrip("/")
        if not p:
            continue
        cut = len(p)
        for i, ch in enumerate(p):
            if ch in "*?[":
                cut = i
                break
        prefix = p[:cut]
        mid_segment = cut < len(p) and not prefix.endswith("/")
        prefix = prefix.rstrip("/")
        if not prefix:
            return []          # a pattern rooted at the workspace -> exclusive
        out.append((prefix, mid_segment))
    return out


def _prefix_covers(a, a_mid, b):
    """Whether prefix `a` covers path `b` (so the two owners could collide)."""
    if a_mid:
        return b.startswith(a)
    return b == a or b.startswith(a + "/")


def _scopes_conflict(a, b):
    """Whether two acquired scopes may touch the same file. An empty scope is
    EXCLUSIVE and conflicts with everything (including another exclusive)."""
    if not a or not b:
        return True
    for pa, pa_mid in a:
        for pb, pb_mid in b:
            if _prefix_covers(pa, pa_mid, pb) or _prefix_covers(pb, pb_mid, pa):
                return True
    return False


class ScopedWorkspaceLock:
    """Grants concurrent workspace access to write subagents whose declared scopes
    cannot overlap, and serializes the ones that can.

    Fair: a request is granted only when it conflicts with nothing currently held
    AND with nothing queued ahead of it, so an exclusive writer can't be starved by
    a stream of scoped ones. Deadlock-free by construction — a subagent holds at
    most one grant at a time and acquires all of its scope atomically."""

    def __init__(self):
        self._cv = threading.Condition()
        self._held = {}       # token -> scope
        self._waiting = []    # [(token, scope), ...] in arrival order
        self._next = 0

    def acquire(self, scope=None):
        """Block until this scope is exclusively ours; returns a release token."""
        prefixes = _scope_prefixes(scope)
        with self._cv:
            self._next += 1
            token = self._next
            self._waiting.append((token, prefixes))
            while not self._grantable(token, prefixes):
                self._cv.wait()
            self._waiting = [w for w in self._waiting if w[0] != token]
            self._held[token] = prefixes
            return token

    def release(self, token):
        if token is None:
            return
        with self._cv:
            self._held.pop(token, None)
            self._cv.notify_all()

    def _grantable(self, token, prefixes):
        if any(_scopes_conflict(prefixes, held) for held in self._held.values()):
            return False
        for wtoken, wscope in self._waiting:      # queued ahead of us => wait
            if wtoken == token:
                break
            if _scopes_conflict(prefixes, wscope):
                return False
        return True

    def held_count(self):
        with self._cv:
            return len(self._held)


_WORKSPACE_LOCK = ScopedWorkspaceLock()


class KeyAllocator:
    """Hands each subagent the LEAST-LOADED API key (fewest active subagents
    right now; ties broken round-robin) and tracks a per-key active count so the
    running set stays balanced across the pool at every instant — and, over a run,
    each key serves ~equal subagents. A subagent holds its key for its whole run
    (many ask_llm calls) so it keeps a warm prompt cache; per-request switching
    would forfeit that discount. Thread-safe.
    Note: the balancing guarantee assumes the SAME key pool is passed in on every
    acquire() call for this instance."""

    def __init__(self):
        self._lock = threading.Lock()
        self._counts = {}
        self._rr = 0

    def acquire(self, keys: list[str]) -> "str | None":
        with self._lock:
            if not keys:
                return None
            for k in keys:
                self._counts.setdefault(k, 0)
            n = len(keys)
            best, best_load = None, None
            for i in range(n):
                k = keys[(self._rr + i) % n]
                load = self._counts[k]
                if best_load is None or load < best_load:
                    best, best_load = k, load
            self._rr = (self._rr + 1) % n
            self._counts[best] += 1
            return best

    def release(self, key: "str | None") -> None:
        if key is None:
            return
        with self._lock:
            if self._counts.get(key, 0) > 0:
                self._counts[key] -= 1


# NOTE: concurrent subagents may now SHARE a key — _pool_size is deliberately
# decoupled from the key count, so a wide wave can outnumber the key pool and
# KeyAllocator hands the same least-loaded key to more than one subagent at once.
# The frontend dock does NOT rely on key_label to tell concurrent bars apart; each
# subagent invocation carries its own unique `sub_id` (see run_subagent) for that.
_KEY_ALLOCATOR = KeyAllocator()


# --- UI telemetry sink -------------------------------------------------------
# A process-global callback the desktop agent wires to its own `_emit` (which
# pushes an event to the browser). Tools that spawn subagents OUTSIDE the
# planner's read-wave — notably `dispatch_agents` — have no handle on the
# agent's `_emit`, so without this bridge their wave/subagent telemetry never
# reaches the frontend and the Subagents HUD stays empty. The agent sets it once
# via `set_ui_sink`; `ui_emit` is a no-op until then (e.g. under tests/headless).
# Single desktop agent instance, so a module global is sufficient.
_UI_SINK = None


def set_ui_sink(fn):
    """Register the callback used to forward subagent telemetry to the UI."""
    global _UI_SINK
    _UI_SINK = fn


def ui_emit(ev):
    """Forward one telemetry event to the UI sink, if one is registered.

    MUST be called from the agent-loop thread (the same thread that owns the
    other `_emit` calls) — callers that receive events on subagent worker
    threads should funnel them through a queue and drain it here, mirroring
    agent.py's `_run_delegated_wave`."""
    if _UI_SINK is None:
        return
    try:
        _UI_SINK(ev)
    except Exception:
        pass  # telemetry must never break a run


def _emit_event(on_event, ev):
    if on_event is None:
        return
    try:
        on_event(ev)
    except Exception:
        pass  # telemetry must never break a run

def _mask(key):
    if not key:
        return "—"
    return (key[:4] + "…" + key[-2:]) if len(key) > 8 else "key"

def _estimate_tokens(messages, raw):
    chars = sum(len(m.get("content", "")) for m in messages) + len(raw or "")
    return chars // 4


_SUBAGENT_CONTRACT = """You are an isolated SUBAGENT. You handle ONE delegated task in your own private \
context and return a SINGLE distilled result to the orchestrator. Your intermediate tool output stays in \
this session and is discarded — so put everything the orchestrator needs (findings, file:line evidence, \
what you changed, what's still open) into your final answer.

PROTOCOL — every turn is exactly ONE raw JSON object, nothing else (no markdown, no prose outside it):
  tool call:    {"type":"tool_call","tool":"<name>","args":{...}}
  final answer: {"type":"final_answer","content":"<your distilled result>"}
Call ONE tool at a time. Investigate before you conclude; back every important claim with concrete evidence \
(file:line, class/method, symbol/string, or command/test output). The moment you can actually answer, do — \
don't burn extra calls padding it."""

_WRITER_CONTRACT = """
Use the tools needed for your assigned task. Modify files when the task calls for changes; an investigation \
still ends with findings. After any change, VERIFY it with an objective check \
(build / disassemble / test / inspect) and state in your final answer whether the change is VERIFIED and how."""

_JSON_NUDGE = ('Your last reply was not valid JSON. Reply with a single raw JSON object only — either '
               '{"type":"tool_call","tool":"...","args":{...}} or {"type":"final_answer","content":"..."}.')


class AgentDef:
    """A subagent persona. Either supply `allowed_tools` explicitly (the two legacy
    sub-agents do this to keep their exact surface), or let it resolve from `mode` +
    `toolsets` against the live registry.

    Fields: name, system_prompt (persona body), mode ("read"|"write"), description,
    toolsets (domain groups the agent works in), allowed_tools (explicit override),
    temperature, max_steps, allow_optin_read (grant web/emulator/frida *observation*
    tools to a read agent), include_contract (prepend the shared protocol contract),
    tier (default cost-spine tier), models (default explicit model ladder)."""

    def __init__(self, name, system_prompt, mode="read", description="",
                 toolsets=None, allowed_tools=None, temperature=None,
                 max_steps=DEFAULT_MAX_STEPS, allow_optin_read=False,
                 include_contract=True, tier=None, models=None, skills=None):
        self.name = name
        self.system_prompt = system_prompt or ""
        self.mode = "write" if str(mode).lower().startswith("w") else "read"
        self.description = description
        self.toolsets = set(toolsets or ())
        self.allowed_tools = set(allowed_tools) if allowed_tools is not None else None
        self.temperature = temperature
        self.max_steps = max_steps
        self.allow_optin_read = allow_optin_read
        self.include_contract = include_contract
        # Cost routing defaults for THIS persona. `tier` names a rung band on the
        # global cost spine (llm.model_ladder); `models` pins an explicit ladder.
        # Both are overridable per dispatch — see resolve_model_ladder.
        self.tier = (tier or "").strip().lower() or None
        self.models = list(models) if models else None
        # Skills this persona wants PRELOADED (bodies injected up front); every
        # other skill stays reachable on demand via the skills index (see
        # _build_messages). Empty list, never None, so callers can iterate freely.
        self.skills = [str(s).strip() for s in (skills or []) if str(s).strip()]

    @property
    def is_write(self):
        return self.mode == "write"


def resolve_allowed_tools(agent_def):
    """The concrete set of registered tools a subagent may call.

    - explicit allowed_tools override wins (still safety-filtered for read agents);
    - else a READ agent gets the read-only slice of its declared toolsets plus a
      read-only core base (or the whole read-only universe if no toolsets);
    - a WRITE agent gets every registered tool (mutating tools included),
      except orchestrator-owned state and recursive delegation.
    A read agent can NEVER end up holding a mutating tool (final safety filter)."""
    optin = agent_def.allow_optin_read
    if agent_def.allowed_tools is not None:
        tools = set(agent_def.allowed_tools)
    elif agent_def.is_write:
        # Worker persona toolsets aid discovery, not limit capability.
        tools = set(registry._tools)
    else:
        core_read = {n for n in registry.tools_in_group(CORE_GROUP)
                     if is_readonly_tool(n, optin)}
        if agent_def.toolsets:
            domain = set()
            for ts in agent_def.toolsets:
                domain |= {n for n in registry.tools_in_group(ts) if is_readonly_tool(n, optin)}
            tools = core_read | domain
        else:
            tools = {n for n in registry._tools if is_readonly_tool(n, optin)}
    # A read agent must never hold a mutating tool, whatever the override said.
    if not agent_def.is_write:
        tools = {n for n in tools if not is_mutating_tool(n)}
    # No subagent may spawn nested subagents (bounds delegation depth + cost).
    tools -= SUBAGENT_EXCLUDED
    if _wants_skill_index(agent_def):
        tools |= {t for t in _SKILL_TOOLS if registry.is_registered(t)}
    # Only real, registered tools survive (drops typos in an override / stale name).
    return {n for n in tools if registry.is_registered(n)}


_SKILL_TOOLS = ("use_skill", "read_skill_resource", "list_skills")


def _wants_skill_index(agent_def):
    """True for personas that can ACT on domain knowledge — write agents, or read
    agents scoped to a toolset (native-analyst), or any persona that pins skills.
    A bare read researcher stays lean (no index tokens, no skill tools)."""
    return bool(agent_def.is_write or agent_def.toolsets or agent_def.skills)


# --- cost routing ------------------------------------------------------------

def resolve_model_ladder(agent_def, tier=None, models=None):
    """The concrete, ordered model ids ONE subagent run should try.

    Precedence, highest first:
      1. `models`            explicit ladder from the dispatch call
      2. `tier`              explicit tier from the dispatch call
      3. agent_def.models    persona default ladder (.md frontmatter)
      4. agent_def.tier      persona default tier (.md frontmatter)
      5. llm.DEFAULT_SUBAGENT_TIER

    An explicit list keeps the rest of the spine appended behind it, so a short
    list still has somewhere to fail over. Unknown ids are DROPPED (never fatal —
    a typo must not kill a wave) and named in the returned note.

    Returns (ladder, note). `ladder` is None when nothing is configured at all,
    which reproduces today's behavior (the global ladder, unchanged)."""
    spine = llm.model_ladder()
    if not spine:
        return None, ""
    known = {e["model"] for e in spine}
    known_tiers = {e["tier"] for e in spine}
    notes = []

    def _from_list(candidate):
        """(ladder, True) for an explicit list that matched at least one known
        model, else (None, False). Records any dropped ids in `notes`."""
        picked = [m for m in candidate if m in known]
        dropped = [m for m in candidate if m not in known]
        if dropped:
            notes.append("unknown model(s) ignored: " + ", ".join(dropped))
        if not picked:
            return None, False
        rest = [e["model"] for e in spine if e["model"] not in picked]
        return picked + rest, True

    def _check_tier(t):
        """Tier names are deliberately OPEN strings (see llm._norm_tier), so an
        unrecognized tier is never rejected — but silently falling back to
        DEFAULT_SUBAGENT_TIER on a typo (e.g. 'cheep') would quietly cost
        standard-rung tokens forever with no diagnostic. Note it, same as an
        unknown model id is noted above."""
        norm = llm._norm_tier(t)
        if norm and norm not in known_tiers:
            notes.append(f"unknown tier '{t}' — falling back to '{llm.DEFAULT_SUBAGENT_TIER}'")

    if models:
        ladder, ok = _from_list(models)
        if ok:
            return ladder, "; ".join(notes)
    if tier:
        _check_tier(tier)
        return llm.models_for_tier(tier, spine), "; ".join(notes)
    if agent_def.models:
        ladder, ok = _from_list(agent_def.models)
        if ok:
            return ladder, "; ".join(notes)
    for t in (agent_def.tier, llm.DEFAULT_SUBAGENT_TIER):
        if t:
            if t != llm.DEFAULT_SUBAGENT_TIER:
                _check_tier(t)
            return llm.models_for_tier(t, spine), "; ".join(notes)
    return None, "; ".join(notes)


def effective_tier(agent_def, tier, models):
    """The tier that ACTUALLY drove routing, mirroring resolve_model_ladder's own
    precedence order exactly (explicit models > explicit tier > persona models >
    persona tier > default) — for telemetry, not routing.

    Two bugs this fixes vs. a naive `tier or agent_def.tier or DEFAULT`:
      * a spec passing only 'models' routes on that explicit ladder but would
        still report DEFAULT_SUBAGENT_TIER ('standard') as if a tier had chosen
        it. Returns None in that case (no single tier describes an explicit
        list) — callers may render that as "explicit".
      * a malformed, non-string tier (e.g. 'tier': 5 from hand-edited JSON) is
        truthy and would silently override a persona's own tier default.
        Ignored here, same as llm._norm_tier ignores it for real routing."""
    def _valid(t):
        return t if isinstance(t, str) and t.strip() else None

    spine = llm.model_ladder()
    known = {e["model"] for e in spine}
    if models and any(m in known for m in models):
        return None
    tier = _valid(tier)
    if tier:
        return tier
    if agent_def.models and any(m in known for m in agent_def.models):
        return None
    return _valid(agent_def.tier) or llm.DEFAULT_SUBAGENT_TIER


def escalate_ladder(ladder):
    """One rung UP from `ladder`'s head — that model prepended, everything else
    kept behind it. Returns None when the head is already the top rung (or is
    unknown / the ladder is empty). Used by the parse-error safety valve so a
    cheap default degrades into a retry on a stronger model, not into garbage."""
    spine = llm.model_ladder()
    if not ladder or not spine:
        return None
    rung = next((e["rung"] for e in spine if e["model"] == ladder[0]), None)
    if not rung:            # None (unknown) or 0 (already the top)
        return None
    up = spine[rung - 1]["model"]
    return [up] + [m for m in ladder if m != up]


# --- response parsing / formatting (shared with the two legacy sub-agents) ----

def _parse_response(raw):
    data = extract_json_action(raw or "")
    if data is None:
        return ("error", None)
    rtype = data.get("type")
    if rtype not in ("tool_call", "final_answer") and ("args" in data or "tool" in data):
        data["tool"] = data.get("tool", rtype)
        rtype = "tool_call"
    if rtype == "tool_call":
        return ("tool_call", data)
    if rtype == "final_answer":
        return ("final_answer", data.get("content", ""))
    return ("error", None)


def _content_to_text(content):
    if isinstance(content, str):
        return content.strip()
    try:
        return json.dumps(content, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(content)


def _estimate_chars(messages):
    return sum(len(m.get("content", "")) for m in messages)


def _format_tool_result(tool_name, result):
    if not isinstance(result, dict):
        return f"Tool '{tool_name}' executed.\n(no structured output)\n"
    output = result.get("stdout", "")
    err = result.get("stderr", "")
    err_dict = result.get("error", "")
    feedback = f"Tool '{tool_name}' executed.\n"
    if output:
        feedback += f"Output:\n{output[:PER_RESULT_CHAR_CAP]}\n"
        if len(output) > PER_RESULT_CHAR_CAP:
            feedback += f"[truncated at {PER_RESULT_CHAR_CAP} of {len(output)} chars]\n"
    if err:
        feedback += f"Stderr:\n{err[:1500]}\n"
    if err_dict:
        feedback += f"System Error:\n{err_dict}\n"
    if not output and not err and not err_dict:
        feedback += "(no output)\n"
    return feedback


def _execute(agent_def, allowed, tool_name, tool_args):
    if tool_name not in allowed:
        return (f"Tool '{tool_name}' is not available to the '{agent_def.name}' subagent. "
                "Use one of the tools listed in your system prompt, or give your final answer.")
    if not agent_def.is_write and is_mutating_tool(tool_name):
        return (f"Tool '{tool_name}' would modify the workspace, but you are a READ-ONLY subagent. "
                "Report what you found and what needs changing instead.")
    if not isinstance(tool_args, dict):
        tool_args = {}
    try:
        result = registry.execute(tool_name, tool_args)
    except Exception as e:  # registry.execute already guards, but never let one bubble
        return f"Tool '{tool_name}' raised: {e}"
    return _format_tool_result(tool_name, result)


def _new_result(agent_def):
    return {"agent": agent_def.name, "ok": False, "report": "", "raw_report": None,
            "artifacts": [], "verified": None, "steps": 0, "tools_used": [], "note": "",
            "tokens": 0, "model": None, "escalated": False, "schema_ok": None}


def _build_messages(agent_def, allowed, task, context, run_dir, schema=None):
    contract = ""
    if agent_def.include_contract:
        contract = _SUBAGENT_CONTRACT + (_WRITER_CONTRACT if agent_def.is_write else "")
    tool_prompt = registry.get_tool_prompt(allowed_tools=allowed)
    parts = [agent_def.system_prompt.strip()]
    # Give every dispatch path the actual tool cwd, including temporary copies.
    # This does not depend on the orchestrator remembering to pass a root hint.
    try:
        import devices
        from host_exec import workspace_root
        remote = devices.active()
        root = remote.remote_root if remote else workspace_root()
        if root:
            parts.append(f"WORKING DIRECTORY: {root}. Use this real directory for file operations. "
                         "Keep outputs here; the user controls any promotion to another workspace.")
    except RuntimeError:
        pass  # Standalone tests and pure analysis agents need no workspace.
    if contract:
        parts.append(contract)
    if _wants_skill_index(agent_def):
        import skills_loader
        # Preload the bodies this persona pinned, so its core domain knowledge is
        # present up front; everything else stays reachable on demand via the index.
        if agent_def.skills:
            catalog = skills_loader.load_skills()
            for sk in agent_def.skills:
                entry = catalog.get(sk)
                if entry and entry.get("body"):
                    parts.append(f"PRELOADED SKILL — {sk}\n{entry['body'].strip()}")
        idx = skills_loader.get_skills_prompt()
        if idx:
            parts.append(idx)
    parts.append(tool_prompt)
    if schema:
        parts.append(_wf_schema.render_contract(schema))
    system_prompt = "\n\n".join(p for p in parts if p)

    user = "TASK:\n" + task.strip() + "\n"
    if (context or "").strip():
        user += "\nCONTEXT FROM THE ORCHESTRATOR:\n" + context.strip() + "\n"
    if run_dir:
        user += (f"\nYou may write long/detailed output to files under {run_dir} and reference their paths "
                 "in your final answer, so the orchestrator can read them on demand instead of inline.\n")
    return [{"role": "system", "content": system_prompt},
            {"role": "user", "content": user}]


def _compact_messages(messages, keep_tail=COMPACT_KEEP_TAIL):
    """Elide the MIDDLE of a long sub-conversation in place, keeping the system
    prompt, the original task, and the most recent exchanges.

    A build subagent that hits the context limit used to be forced to answer on the
    spot, which meant a large job could not be finished inside one subagent no
    matter how many steps it was given. Its real output is on disk (and in the
    ledger) rather than in its transcript, so the middle is the cheapest thing to
    drop. Returns the number of messages elided (0 if it was already short enough)."""
    if len(messages) <= keep_tail + 3:
        return 0
    head, tail = messages[:2], messages[-keep_tail:]
    elided = len(messages) - len(head) - len(tail)
    marker = {"role": "user", "content": (
        f"[SYSTEM] {elided} earlier messages from this sub-run were elided to make room — "
        "their tool calls already happened and their durable results are on disk (and in the "
        "build ledger / your notes), not in this transcript. Do NOT redo that work: if you "
        "are unsure whether something is already done, check the workspace or the ledger, then "
        "carry on with the task from where you are.")}
    messages[:] = head + [marker] + tail
    return elided


def _force_final(agent_def, messages, temperature, steps, tools_used, result, note, tokens=0,
                 schema=None):
    messages.append({"role": "user", "content": (
        "[SYSTEM] Investigation budget reached. Do NOT call more tools. Return your best "
        '{"type":"final_answer","content":"..."} now, based on what you have — say what you found and what '
        "remained unresolved.")})
    try:
        raw = ask_llm(messages, temperature=temperature)
    except Exception as e:
        result.update(ok=False, report=f"(subagent could not finalize: {e})", steps=steps,
                      tools_used=tools_used, note=note, tokens=tokens)
        return result
    tokens_here = (llm.take_last_usage() or {}).get("total") or _estimate_tokens(messages, raw)
    tokens += tokens_here
    rtype, payload = _parse_response(raw)
    content = payload if rtype == "final_answer" else strip_reasoning(raw)
    if schema:
        # A forced-final answer under budget/context pressure never went through the
        # repair loop's validation, so it can never be trusted to satisfy the schema.
        note = "; ".join(p for p in (note,
                         "forced final answer could not satisfy the schema") if p)
        result.update(ok=False, schema_ok=False, report=_content_to_text(content),
                      raw_report=content, steps=steps, tools_used=tools_used,
                      note=note, tokens=tokens)
        return result
    result.update(ok=True, report=_content_to_text(content), raw_report=content,
                  steps=steps, tools_used=tools_used, note=note, tokens=tokens)
    return result


def run_subagent(agent_def, task, context="", run_dir=None, on_event=None,
                 tier=None, models=None, scope=None, schema=None):
    """Run one subagent to completion and return a distilled result dict:
    {agent, ok, report, raw_report, artifacts, verified, steps, tools_used, note, tokens,
    model, escalated}.

    `report` is the final answer as text; `raw_report` preserves its original
    structure (a dict, for personas like the reviewer that answer with JSON).
    Never raises — any internal failure yields ok=False with the reason in report.

    Acquires a least-loaded API key for the run's whole duration (warm prompt
    cache), pins the subagent's llm thread-local context so usage accounting and
    key selection are isolated from the main thread, and — if `on_event` is
    given — emits subagent_started/subagent_progress/subagent_done telemetry."""
    result = _new_result(agent_def)
    task = (task or "").strip()
    if not task:
        result["report"] = "(no task provided to subagent)"
        return result

    try:
        allowed = resolve_allowed_tools(agent_def)
        temperature = agent_def.temperature if agent_def.temperature is not None else SUBAGENT_TEMPERATURE
        try:
            max_steps = max(1, min(int(agent_def.max_steps or DEFAULT_MAX_STEPS), MAX_STEPS_CAP))
        except (TypeError, ValueError):
            max_steps = DEFAULT_MAX_STEPS
        messages = _build_messages(agent_def, allowed, task, context, run_dir, schema=schema)
        if scope:
            messages[0]["content"] += ("\n\nOWNED PATHS: " + ", ".join(scope) +
                                        ". Coordinate changes outside these paths with the orchestrator.")
        ladder, ladder_note = resolve_model_ladder(agent_def, tier, models)
        if ladder_note:
            result["note"] = ladder_note
        eff_tier = effective_tier(agent_def, tier, models)
    except Exception as e:
        result["report"] = f"(subagent setup failed: {e})"
        return result

    key = None
    lock_token = None
    started = time.monotonic()
    sub_id = uuid.uuid4().hex[:8]
    try:
        key = _KEY_ALLOCATOR.acquire(llm.active_key_pool())
        llm.set_subagent_context(pinned_key=key, models=ladder)
        _emit_event(on_event, {"type": "subagent_started", "agent": agent_def.name,
                               "task": task, "key_label": _mask(key), "mode": agent_def.mode,
                               "sub_id": sub_id, "tier": eff_tier,
                               "model": (ladder[0] if ladder else None),
                               "scope": list(scope or [])})
        if agent_def.is_write:
            # Own only the declared paths (concurrent with disjoint owners), or the
            # whole workspace when nothing was declared.
            lock_token = _WORKSPACE_LOCK.acquire(scope)
        out = _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
                        on_event=on_event, agent_name=agent_def.name, max_steps_total=max_steps,
                        started=started, key_label=_mask(key), sub_id=sub_id,
                        ladder=ladder, key=key, schema=schema)
    except Exception as e:
        result.update(ok=False, report=f"(subagent crashed: {e})")
        out = result
    finally:
        if lock_token is not None:
            _WORKSPACE_LOCK.release(lock_token)
        llm.clear_subagent_context()
        _KEY_ALLOCATOR.release(key)  # release(None) is already a safe no-op

    _emit_event(on_event, {"type": "subagent_done", "agent": agent_def.name,
                           "ok": bool(out.get("ok")), "tokens": out.get("tokens", 0),
                           "steps": out.get("steps", 0),
                           "elapsed_s": round(time.monotonic() - started, 1),
                           "key_label": _mask(key), "sub_id": sub_id,
                           "model": out.get("model"), "escalated": out.get("escalated", False)})
    return out


def _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
              on_event=None, agent_name="", max_steps_total=None, started=None, key_label="",
              sub_id="", ladder=None, key=None, schema=None):
    steps = 0
    last_sig = None
    repeats = 0
    parse_errors = 0
    schema_tries = 0
    tools_used = []
    tokens = 0
    escalated = False
    compactions = 0
    started = started if started is not None else time.monotonic()

    def chat(role, content, **extra):
        _emit_event(on_event, {"type": "subagent_chat", "agent": agent_name,
                              "sub_id": sub_id, "role": role, "content": content, **extra})

    def stream(event):
        if event.get("type") == "reasoning_stream":
            return  # Main Thinking telemetry must not overwrite a worker's answer draft.
        _emit_event(on_event, {**event, "type": "subagent_stream", "agent": agent_name,
                              "sub_id": sub_id})

    def forced_final(note):
        with llm.stream_events(stream if on_event else None):
            final = _force_final(agent_def, messages, temperature, steps, tools_used,
                                 result, note=note, tokens=tokens, schema=schema)
        chat("assistant", final.get("report", ""))
        return final

    while steps < max_steps:
        with llm.stream_events(stream if on_event else None):
            raw = ask_llm(messages, temperature=temperature)
        u = llm.take_last_usage()
        tokens += (u["total"] if u else _estimate_tokens(messages, raw))
        result["tokens"] = tokens
        served = llm.take_last_model()
        if served:
            result["model"] = served
        rtype, payload = _parse_response(raw)
        messages.append({"role": "assistant", "content": raw})

        if rtype == "final_answer":
            chat("assistant", _content_to_text(payload))
            if schema:
                candidate = payload
                # Models routinely hand back the JSON as a STRING. Parse before
                # validating, or every structured call fails on shape.
                if isinstance(candidate, str):
                    try:
                        candidate = json.loads(strip_reasoning(candidate).strip())
                    except ValueError:
                        candidate = payload
                errors = _wf_schema.validate(candidate, schema)
                if errors:
                    schema_tries += 1
                    if schema_tries >= SCHEMA_MAX_TRIES:
                        note = "; ".join(p for p in (
                            result.get("note"),
                            "schema validation failed after "
                            f"{SCHEMA_MAX_TRIES} attempts: " + "; ".join(errors[:3])
                        ) if p)
                        result.update(ok=False, schema_ok=False, steps=steps,
                                      tools_used=tools_used, note=note, tokens=tokens)
                        return result
                    messages.append({"role": "user", "content": (
                        "[SYSTEM] Your final_answer did not match the required "
                        "schema. Fix these and answer again:\n- "
                        + "\n- ".join(errors[:8])
                    )})
                    continue
                result.update(ok=True, schema_ok=True,
                              report=_content_to_text(candidate),
                              raw_report=candidate, steps=steps,
                              tools_used=tools_used, tokens=tokens)
                return result
            result.update(ok=True, report=_content_to_text(payload), raw_report=payload,
                          steps=steps, tools_used=tools_used, tokens=tokens)
            return result

        if rtype == "error":
            parse_errors += 1
            # SAFETY VALVE for a cheap default: a weak model failing the strict JSON
            # protocol twice in a row is a routing problem, not a prompting one. Step
            # ONE rung up the cost spine (keeping the rest of the ladder behind it)
            # and keep going. Fires at most once per run; the 3-error salvage below
            # is still the final backstop.
            if parse_errors == 2 and not escalated and ladder:
                up = escalate_ladder(ladder)
                if up:
                    escalated = True
                    ladder = up
                    llm.set_subagent_context(pinned_key=key, models=ladder)
                    result["escalated"] = True
                    msg = f"escalated to {ladder[0]} after repeated protocol errors"
                    result["note"] = "; ".join(p for p in (result.get("note"), msg) if p)
                    messages.append({"role": "user", "content": _JSON_NUDGE})
                    continue
            if parse_errors >= 3:
                if schema:
                    result.update(ok=False, schema_ok=False, steps=steps,
                                  tools_used=tools_used, tokens=tokens,
                                  note="; ".join(p for p in (result.get("note"),
                                       "non-JSON output could not satisfy the schema") if p))
                    return result
                salvage = strip_reasoning(raw)
                chat("assistant", salvage)
                note = "; ".join(p for p in (result.get("note"),
                                             "salvaged from non-JSON output") if p)
                result.update(ok=True, report=salvage, raw_report=salvage, steps=steps,
                              tools_used=tools_used, note=note, tokens=tokens)
                return result
            messages.append({"role": "user", "content": _JSON_NUDGE})
            continue
        parse_errors = 0

        if payload.get("explanation"):
            chat("assistant", payload["explanation"])
        tool_name = payload.get("tool")
        tool_args = payload.get("args", {}) or {}
        sig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
        if sig == last_sig:
            repeats += 1
        else:
            repeats, last_sig = 1, sig
        if repeats >= REPEAT_LIMIT:
            messages.append({"role": "user", "content": (
                f"[SYSTEM] You've called '{tool_name}' identically {repeats} times — that's a loop. "
                "Try different args or a different tool, or give your final_answer.")})
            repeats = 0
            continue

        steps += 1
        tools_used.append(tool_name)
        chat("tool_call", json.dumps(tool_args, ensure_ascii=False, default=str), tool=tool_name)
        feedback = _execute(agent_def, allowed, tool_name, tool_args)
        chat("tool_result", str(feedback), tool=tool_name)
        messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})

        _emit_event(on_event, {"type": "subagent_progress", "agent": agent_name,
                               "elapsed_s": round(time.monotonic() - started, 1),
                               "tokens": tokens, "step": steps,
                               "max_steps": max_steps_total or max_steps,
                               "last_tool": tool_name, "key_label": key_label,
                               "sub_id": sub_id})

        if _estimate_chars(messages) > CONTEXT_CHAR_LIMIT:
            # Compact and keep going while the budget allows — only a subagent that
            # has already been compacted its full allowance is forced to finalize.
            if compactions < CONTEXT_COMPACTIONS_MAX and _compact_messages(messages):
                compactions += 1
                result["compactions"] = compactions
                _emit_event(on_event, {"type": "subagent_progress", "agent": agent_name,
                                       "elapsed_s": round(time.monotonic() - started, 1),
                                       "tokens": tokens, "step": steps,
                                       "max_steps": max_steps_total or max_steps,
                                       "last_tool": f"(compacted context x{compactions})",
                                       "key_label": key_label, "sub_id": sub_id})
                continue
            return forced_final("stopped early — sub-context grew large.")

    return forced_final(f"reached the {max_steps}-step budget.")


# --- parallel waves ----------------------------------------------------------

def _normalize_spec(spec):
    """Accept (agent_def, task), (agent_def, task, context), or a dict with
    {agent_def, task, context?, tier?, models?, scope?}. Returns a 6-tuple
    (agent_def, task, context, tier, models, scope)."""
    if isinstance(spec, dict):
        return (spec["agent_def"], spec.get("task", ""), spec.get("context", ""),
                spec.get("tier"), spec.get("models"), spec.get("scope"))
    if len(spec) == 2:
        return spec[0], spec[1], "", None, None, None
    return spec[0], spec[1], spec[2], None, None, None


def _route_kwargs(tier, models, scope=None):
    """Only forward tier/models/scope as kwargs when actually set. Keeps the
    zero-routing call shape IDENTICAL to before this feature existed — a bare
    (agent_def, task, context, run_dir, on_event) call — so a caller/test double
    still holding the old run_subagent signature keeps working when no per-spec
    routing was requested."""
    kw = {}
    if tier is not None:
        kw["tier"] = tier
    if models is not None:
        kw["models"] = models
    if scope:
        kw["scope"] = scope
    return kw


def run_subagents_parallel(specs, pool_size=None, run_dir=None, on_event=None):
    """Run a wave of subagents and return their result dicts IN INPUT ORDER.

    Read-only subagents fan out freely. SCOPED write subagents now fan out too:
    each one blocks on ScopedWorkspaceLock for the paths it owns, so writers with
    disjoint scopes genuinely run at the same time while overlapping (or unscoped,
    i.e. whole-workspace) writers still take their turn one at a time. That is what
    lets a large multi-package change progress in parallel instead of strictly
    single-file. Unscoped writers are queued after the rest so they don't hold the
    exclusive lock while scoped work is still waiting to start.

    `pool_size` overrides the derived concurrency (see `_pool_size`) when given;
    `on_event`, if given, is threaded down to every subagent for live telemetry."""
    norm = [_normalize_spec(s) for s in specs]
    results = [None] * len(norm)
    # Anything that can run concurrently: every read, plus writes that declared the
    # paths they own. An unscoped write takes the whole workspace, so it stays serial.
    pooled_idx = [i for i, n in enumerate(norm)
                  if not n[0].is_write or _scope_prefixes(n[5])]
    serial_idx = [i for i in range(len(norm)) if i not in set(pooled_idx)]

    wave_id = uuid.uuid4().hex[:8]
    workers = pool_size if pool_size is not None else _pool_size(max(1, len(pooled_idx)))
    _emit_event(on_event, {"type": "wave_started", "wave_id": wave_id,
                           "size": len(norm), "workers": max(1, min(workers, len(pooled_idx) or 1))})

    def _run_one(i):
        n = norm[i]
        return run_subagent(n[0], n[1], n[2], run_dir, on_event,
                            **_route_kwargs(n[3], n[4], n[5]))

    try:
        if pooled_idx:
            workers = pool_size if pool_size is not None else _pool_size(len(pooled_idx))
            workers = max(1, min(workers, len(pooled_idx)))
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                futs = {ex.submit(_run_one, i): i for i in pooled_idx}
                for fut in concurrent.futures.as_completed(futs):
                    i = futs[fut]
                    try:
                        results[i] = fut.result()
                    except Exception as e:
                        r = _new_result(norm[i][0])
                        r["report"] = f"(subagent crashed: {e})"
                        results[i] = r

        for i in serial_idx:  # each takes the workspace exclusively, in turn
            try:
                results[i] = _run_one(i)
            except Exception as e:
                r = _new_result(norm[i][0])
                r["report"] = f"(subagent crashed: {e})"
                results[i] = r
    finally:
        _emit_event(on_event, {"type": "wave_done", "wave_id": wave_id})
    return results
