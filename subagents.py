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
    behind a single workspace lock so only one writer ever touches /workspace.

No new provider/key: every subagent reuses `llm.ask_llm`, exactly like the two
sub-agents this replaces. Never raises for orchestration reasons — a failed
subagent returns {ok: False, report: "<why>"} so the caller decides.
"""
import concurrent.futures
import json
import threading
import time

import llm
from llm import ask_llm, extract_json_action, strip_reasoning
from tool_registry import registry, CORE_GROUP
from tool_policy import is_readonly_tool, is_mutating_tool, READONLY_TOOLS, SUBAGENT_EXCLUDED

# --- Bounds (reuse the proven values from codebase_qa / reviewer) ------------
DEFAULT_MAX_STEPS = 12       # tool calls a subagent may make before it must answer
MAX_STEPS_CAP = 40           # hard ceiling regardless of the agent def / caller
SUBAGENT_TEMPERATURE = 0.3   # steady tool use, like the other isolated sub-agents
PER_RESULT_CHAR_CAP = 6000   # truncate each tool result fed back into the sub-session
CONTEXT_CHAR_LIMIT = 180_000 # force an answer if the sub-conversation grows past this
REPEAT_LIMIT = 3             # identical call this many times in a row -> steer


def _pool_size(n_specs):
    """Concurrency for a read wave: at most keys-1 (reserve headroom), never more
    than the number of specs, floored at 1. Derived live from the key pool — no
    hardcoded constant.
    Note: this reserves HEADROOM (bounds concurrent subagents to keys-1) — it does
    NOT pin a specific key away from the main thread."""
    n_keys = len(llm.active_key_pool())
    reserve = max(1, n_keys - 1)
    return max(1, min(reserve, n_specs))

# Only ONE write-capable subagent may touch the shared /workspace at a time. Read
# subagents never acquire it (they can't mutate), so parallel research is unaffected.
# Subagents are never nested (they get no delegation tools), so a plain Lock is safe.
_WORKSPACE_LOCK = threading.Lock()


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


# The distinct-key-per-concurrent-subagent guarantee assumes ONE wave holds keys at
# a time (true today: the read wave blocks on its queue drain; write path and
# dispatch_agents are serial).
_KEY_ALLOCATOR = KeyAllocator()


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
You MAY modify the workspace with your tools. After any change, VERIFY it with an objective check \
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
    tools to a read agent), include_contract (prepend the shared protocol contract)."""

    def __init__(self, name, system_prompt, mode="read", description="",
                 toolsets=None, allowed_tools=None, temperature=None,
                 max_steps=DEFAULT_MAX_STEPS, allow_optin_read=False,
                 include_contract=True):
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

    @property
    def is_write(self):
        return self.mode == "write"


def resolve_allowed_tools(agent_def):
    """The concrete set of registered tools a subagent may call.

    - explicit allowed_tools override wins (still safety-filtered for read agents);
    - else a READ agent gets the read-only slice of its declared toolsets plus a
      read-only core base (or the whole read-only universe if no toolsets);
    - a WRITE agent gets the full core working set plus the FULL surface of its
      declared toolsets (mutating tools included).
    A read agent can NEVER end up holding a mutating tool (final safety filter)."""
    optin = agent_def.allow_optin_read
    if agent_def.allowed_tools is not None:
        tools = set(agent_def.allowed_tools)
    elif agent_def.is_write:
        core_work = set(registry.tools_in_group(CORE_GROUP))
        domain = set()
        for ts in agent_def.toolsets:
            domain |= set(registry.tools_in_group(ts))
        tools = core_work | domain
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
    # Only real, registered tools survive (drops typos in an override / stale name).
    return {n for n in tools if registry.is_registered(n)}


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
            "tokens": 0}


def _build_messages(agent_def, allowed, task, context, run_dir):
    contract = ""
    if agent_def.include_contract:
        contract = _SUBAGENT_CONTRACT + (_WRITER_CONTRACT if agent_def.is_write else "")
    tool_prompt = registry.get_tool_prompt(allowed_tools=allowed)
    parts = [agent_def.system_prompt.strip()]
    if contract:
        parts.append(contract)
    parts.append(tool_prompt)
    system_prompt = "\n\n".join(p for p in parts if p)

    user = "TASK:\n" + task.strip() + "\n"
    if (context or "").strip():
        user += "\nCONTEXT FROM THE ORCHESTRATOR:\n" + context.strip() + "\n"
    if run_dir:
        user += (f"\nYou may write long/detailed output to files under {run_dir} and reference their paths "
                 "in your final answer, so the orchestrator can read them on demand instead of inline.\n")
    return [{"role": "system", "content": system_prompt},
            {"role": "user", "content": user}]


def _force_final(agent_def, messages, temperature, steps, tools_used, result, note, tokens=0):
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
    result.update(ok=True, report=_content_to_text(content), raw_report=content,
                  steps=steps, tools_used=tools_used, note=note, tokens=tokens)
    return result


def run_subagent(agent_def, task, context="", run_dir=None, on_event=None):
    """Run one subagent to completion and return a distilled result dict:
    {agent, ok, report, raw_report, artifacts, verified, steps, tools_used, note, tokens}.

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
        messages = _build_messages(agent_def, allowed, task, context, run_dir)
    except Exception as e:
        result["report"] = f"(subagent setup failed: {e})"
        return result

    key = None
    acquired_lock = None
    started = time.monotonic()
    try:
        key = _KEY_ALLOCATOR.acquire(llm.active_key_pool())
        llm.set_subagent_context(pinned_key=key)
        _emit_event(on_event, {"type": "subagent_started", "agent": agent_def.name,
                               "task": task[:160], "key_label": _mask(key), "mode": agent_def.mode})
        if agent_def.is_write:
            _WORKSPACE_LOCK.acquire()
            acquired_lock = _WORKSPACE_LOCK
        out = _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
                        on_event=on_event, agent_name=agent_def.name, max_steps_total=max_steps,
                        started=started, key_label=_mask(key))
    except Exception as e:
        result.update(ok=False, report=f"(subagent crashed: {e})")
        out = result
    finally:
        if acquired_lock is not None:
            acquired_lock.release()
        llm.clear_subagent_context()
        _KEY_ALLOCATOR.release(key)  # release(None) is already a safe no-op

    _emit_event(on_event, {"type": "subagent_done", "agent": agent_def.name,
                           "ok": bool(out.get("ok")), "tokens": out.get("tokens", 0),
                           "steps": out.get("steps", 0),
                           "elapsed_s": round(time.monotonic() - started, 1),
                           "key_label": _mask(key)})
    return out


def _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
              on_event=None, agent_name="", max_steps_total=None, started=None, key_label=""):
    steps = 0
    last_sig = None
    repeats = 0
    parse_errors = 0
    tools_used = []
    tokens = 0
    started = started if started is not None else time.monotonic()

    while steps < max_steps:
        raw = ask_llm(messages, temperature=temperature)
        u = llm.take_last_usage()
        tokens += (u["total"] if u else _estimate_tokens(messages, raw))
        result["tokens"] = tokens
        rtype, payload = _parse_response(raw)
        messages.append({"role": "assistant", "content": raw})

        if rtype == "final_answer":
            result.update(ok=True, report=_content_to_text(payload), raw_report=payload,
                          steps=steps, tools_used=tools_used, tokens=tokens)
            return result

        if rtype == "error":
            parse_errors += 1
            if parse_errors >= 3:
                salvage = strip_reasoning(raw)
                result.update(ok=True, report=salvage, raw_report=salvage, steps=steps,
                              tools_used=tools_used, note="salvaged from non-JSON output",
                              tokens=tokens)
                return result
            messages.append({"role": "user", "content": _JSON_NUDGE})
            continue
        parse_errors = 0

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
        feedback = _execute(agent_def, allowed, tool_name, tool_args)
        messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})

        _emit_event(on_event, {"type": "subagent_progress", "agent": agent_name,
                               "elapsed_s": round(time.monotonic() - started, 1),
                               "tokens": tokens, "step": steps,
                               "max_steps": max_steps_total or max_steps,
                               "last_tool": tool_name, "key_label": key_label})

        if _estimate_chars(messages) > CONTEXT_CHAR_LIMIT:
            return _force_final(agent_def, messages, temperature, steps, tools_used, result,
                                note="stopped early — sub-context grew large.", tokens=tokens)

    return _force_final(agent_def, messages, temperature, steps, tools_used, result,
                        note=f"reached the {max_steps}-step budget.", tokens=tokens)


# --- parallel waves ----------------------------------------------------------

def _normalize_spec(spec):
    """Accept (agent_def, task), (agent_def, task, context), or a dict."""
    if isinstance(spec, dict):
        return spec["agent_def"], spec.get("task", ""), spec.get("context", "")
    if len(spec) == 2:
        return spec[0], spec[1], ""
    return spec[0], spec[1], spec[2]


def run_subagents_parallel(specs, pool_size=None, run_dir=None, on_event=None):
    """Run a wave of subagents and return their result dicts IN INPUT ORDER.

    Read-only subagents fan out across a bounded thread pool; write-capable
    subagents always run sequentially (one writer on the shared workspace at a
    time) after the reads, so a mixed wave is safe. This is the GSD "waves of
    parallel researchers" pattern: each returns only its distilled report.

    `pool_size` overrides the derived concurrency (see `_pool_size`) when given;
    `on_event`, if given, is threaded down to every subagent for live telemetry."""
    norm = [_normalize_spec(s) for s in specs]
    results = [None] * len(norm)
    read_idx = [i for i, (a, _t, _c) in enumerate(norm) if not a.is_write]
    write_idx = [i for i, (a, _t, _c) in enumerate(norm) if a.is_write]

    if read_idx:
        workers = pool_size if pool_size is not None else _pool_size(len(read_idx))
        workers = max(1, min(workers, len(read_idx)))
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(run_subagent, norm[i][0], norm[i][1], norm[i][2], run_dir, on_event): i
                    for i in read_idx}
            for fut in concurrent.futures.as_completed(futs):
                i = futs[fut]
                try:
                    results[i] = fut.result()
                except Exception as e:
                    r = _new_result(norm[i][0])
                    r["report"] = f"(subagent crashed: {e})"
                    results[i] = r

    for i in write_idx:  # sequential; each write subagent takes the workspace lock
        results[i] = run_subagent(norm[i][0], norm[i][1], norm[i][2], run_dir, on_event)

    return results
