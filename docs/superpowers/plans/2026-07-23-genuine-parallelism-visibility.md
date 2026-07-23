# Genuine Parallelism + Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagent delegation genuinely parallel (balanced across the API-key pool, thread-safe) and observable (live per-subagent telemetry rendered in the UI).

**Architecture:** One wave engine (`subagents.run_subagents_parallel`) is the single concurrency point. A thread-safe `KeyAllocator` hands each subagent the least-loaded API key for its whole run; subagent threads pin that key and never clobber the main thread's LLM state. The plan-step harness batches independent read-delegated steps into one wave and streams each agent's start/progress/done events to the frontend.

**Tech Stack:** Python 3, `threading` / `concurrent.futures` / `queue`, pytest; vanilla-JS frontend (`frontend/app.js`).

## Global Constraints

- Single provider today: **NVIDIA NIM**, OpenAI protocol, **pool of 5 API keys** (`llm_config.json`). NIM queues under load, so parallel requests must spread across distinct keys.
- **`ask_llm`'s string return signature MUST NOT change** — no compatibility break. Usage is captured out-of-band via a thread-local.
- **Pool size is never hardcoded**: `max(1, num_keys - 1)`, reserving headroom for the main orchestrator.
- **Real token usage is optional**: prefer the provider `usage` field; fall back to a char-based estimate (~len/4) per call. If usage proves flaky/inconsistent on NIM during implementation, use char-estimate uniformly.
- **Read subagents never mutate the workspace**; write subagents serialize behind the existing `_WORKSPACE_LOCK`.
- Follow existing patterns: tools/tests live under `tools/` and `tests/`; the LLM engine is `llm.py`; the subagent engine is `subagents.py`; the harness is `agent.py`.

---

## File Structure

- **Create** `tests/test_key_allocator.py` — unit tests for the allocator.
- **Modify** `subagents.py` — add `KeyAllocator`, dynamic pool size, key acquire/release, usage accumulation, `on_event` telemetry.
- **Modify** `llm.py` — thread-local subagent context (`_PINNED_KEY`, `_IS_SUBAGENT`, `_LAST_USAGE`); `_live_keys` honors the pinned key; `_run_group` guards global writes; `_openai_request`/`_anthropic_request` capture usage; add `active_key_pool()`.
- **Modify** `agent.py` — `_maybe_dispatch_delegated_steps` batches read steps into a streamed wave; factor out `_fold_delegate_result`.
- **Modify** `tests/test_subagents.py` — allocator wiring, telemetry, batching, thread-safety.
- **Modify** `frontend/app.js` — render `subagent_started/progress/done`.

---

## Task 1: `KeyAllocator` — balanced, thread-safe key distribution

**Files:**
- Modify: `subagents.py` (add class + module singleton near the top, after imports)
- Test: `tests/test_key_allocator.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `class KeyAllocator` with `acquire(keys: list[str]) -> str | None` and `release(key: str | None) -> None`; module singleton `_KEY_ALLOCATOR = KeyAllocator()`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_key_allocator.py`:

```python
import threading
from subagents import KeyAllocator


def test_balances_evenly_when_more_subagents_than_keys():
    alloc = KeyAllocator()
    keys = ["k0", "k1", "k2", "k3", "k4"]
    got = [alloc.acquire(keys) for _ in range(15)]
    counts = {k: got.count(k) for k in keys}
    assert counts == {k: 3 for k in keys}, counts


def test_release_frees_a_key_for_next_acquire():
    alloc = KeyAllocator()
    keys = ["k0", "k1"]
    a = alloc.acquire(keys)   # k0 -> load {k0:1, k1:0}
    b = alloc.acquire(keys)   # k1 -> load {k0:1, k1:1}
    alloc.release(a)          # free k0 -> {k0:0, k1:1}
    c = alloc.acquire(keys)   # least-loaded is k0 again
    assert c == a


def test_empty_pool_returns_none():
    alloc = KeyAllocator()
    assert alloc.acquire([]) is None
    alloc.release(None)  # must not raise


def test_concurrent_acquire_stays_balanced():
    alloc = KeyAllocator()
    keys = ["k0", "k1", "k2", "k3", "k4"]
    got = []
    lock = threading.Lock()

    def worker():
        k = alloc.acquire(keys)
        with lock:
            got.append(k)

    threads = [threading.Thread(target=worker) for _ in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    counts = {k: got.count(k) for k in keys}
    assert all(c == 10 for c in counts.values()), counts
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_key_allocator.py -v`
Expected: FAIL with `ImportError: cannot import name 'KeyAllocator' from 'subagents'`.

- [ ] **Step 3: Write minimal implementation**

In `subagents.py`, after the existing `_WORKSPACE_LOCK = threading.Lock()` block (around line 45), add:

```python
class KeyAllocator:
    """Hands each subagent the LEAST-LOADED API key (fewest active subagents
    right now; ties broken round-robin) and tracks a per-key active count so the
    running set stays balanced across the pool at every instant — and, over a run,
    each key serves ~equal subagents. A subagent holds its key for its whole run
    (many ask_llm calls) so it keeps a warm prompt cache; per-request switching
    would forfeit that discount. Thread-safe."""

    def __init__(self):
        self._lock = threading.Lock()
        self._counts = {}
        self._rr = 0

    def acquire(self, keys):
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

    def release(self, key):
        if key is None:
            return
        with self._lock:
            if self._counts.get(key, 0) > 0:
                self._counts[key] -= 1


_KEY_ALLOCATOR = KeyAllocator()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_key_allocator.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add subagents.py tests/test_key_allocator.py
git commit -m "feat(subagents): balanced thread-safe KeyAllocator"
```

---

## Task 2: Thread-local subagent LLM context in `llm.py`

Adds the thread-local state that lets subagent threads pin a key, suppress the main-thread badge, and expose per-call usage — without changing `ask_llm`'s signature.

**Files:**
- Modify: `llm.py` (new thread-local block; `_live_keys` at ~1686; `_run_group` success block at ~2008-2014; `_openai_request` at ~1288; `_anthropic_request` at ~1505; new `active_key_pool()`)
- Test: `tests/test_llm_subagent_context.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces (all in `llm`):
  - `set_subagent_context(pinned_key: str | None) -> None`
  - `clear_subagent_context() -> None`
  - `take_last_usage() -> dict | None` — returns `{"prompt": int, "completion": int, "total": int}` or `None`, and clears it.
  - `active_key_pool() -> list[str]`

- [ ] **Step 1: Write the failing test**

Create `tests/test_llm_subagent_context.py`:

```python
import llm


def teardown_function():
    llm.clear_subagent_context()


def test_live_keys_starts_at_pinned_key():
    llm.set_subagent_context(pinned_key="k3")
    ordered = llm._live_keys(["k0", "k1", "k2", "k3", "k4"], dead=set())
    assert ordered[0] == "k3"


def test_live_keys_falls_back_when_no_pin():
    llm.clear_subagent_context()
    ordered = llm._live_keys(["k0", "k1"], dead=set())
    assert ordered  # non-empty, no crash


def test_take_last_usage_roundtrip_and_clear():
    llm._record_usage({"prompt": 10, "completion": 5, "total": 15})
    assert llm.take_last_usage() == {"prompt": 10, "completion": 5, "total": 15}
    assert llm.take_last_usage() is None


def test_active_key_pool_returns_list():
    pool = llm.active_key_pool()
    assert isinstance(pool, list)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_llm_subagent_context.py -v`
Expected: FAIL with `AttributeError: module 'llm' has no attribute 'set_subagent_context'`.

- [ ] **Step 3: Write minimal implementation**

**3a.** Near the top of `llm.py` (after imports, before the active-state globals at ~1538, or immediately after them) add the thread-local block:

```python
_TL = threading.local()

def set_subagent_context(pinned_key=None):
    """Mark THIS thread as a subagent: pin its API key, suppress the main-thread
    provider badge, and start fresh usage accounting."""
    _TL.pinned_key = pinned_key
    _TL.is_subagent = True
    _TL.last_usage = None

def clear_subagent_context():
    _TL.pinned_key = None
    _TL.is_subagent = False
    _TL.last_usage = None

def _pinned_key():
    return getattr(_TL, "pinned_key", None)

def _is_subagent_thread():
    return getattr(_TL, "is_subagent", False)

def _record_usage(usage):
    _TL.last_usage = usage

def take_last_usage():
    """Return and clear the usage dict captured for the last ask_llm on this
    thread: {"prompt","completion","total"} or None if the provider omitted it."""
    u = getattr(_TL, "last_usage", None)
    _TL.last_usage = None
    return u
```

Ensure `import threading` exists at the top of `llm.py` (add it if missing).

**3b.** In `_live_keys` (~1686), replace the sticky-key rotation so a pinned key wins:

```python
    ordered = fresh + cooled
    pin = _pinned_key()
    anchor = pin if (pin in ordered) else _ACTIVE_KEY
    if anchor in ordered:
        i = ordered.index(anchor)
        ordered = ordered[i:] + ordered[:i]
    return ordered
```

**3c.** In `_run_group`'s success block (~2008-2014), do not let subagent threads clobber global badge state:

```python
            if res.get("ok"):
                _MODEL_COOLDOWN.pop(m["model"], None)   # it works again
                if not _is_subagent_thread():
                    _ACTIVE_KEY = key                   # shared key pool (text + vision)
                    if track_active:
                        _ACTIVE_CONFIG_ID = m.get("id") or None
                        _ACTIVE_MODEL = m["model"]
                        _notify_active(dict(cfg))
                return {"ok": True, "content": res["content"], "model": m, "key": key, "cfg": cfg}
```

(Note: `_ACTIVE_KEY` is only assigned on the non-subagent branch now; the `global` declaration at the top of `_run_group` stays.)

**3d.** In `_openai_request` (~1288, right after `content` is resolved and before the `return {"ok": True, ...}` for the normal text path), capture usage:

```python
            usage = data.get("usage") or {}
            if usage:
                _record_usage({
                    "prompt": int(usage.get("prompt_tokens") or 0),
                    "completion": int(usage.get("completion_tokens") or 0),
                    "total": int(usage.get("total_tokens")
                                 or (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0)),
                })
```

**3e.** In `_anthropic_request` (~1505, just before `return {"ok": True, "content": text}`):

```python
            usage = data.get("usage") or {}
            if usage:
                pt = int(usage.get("input_tokens") or 0)
                ct = int(usage.get("output_tokens") or 0)
                _record_usage({"prompt": pt, "completion": ct, "total": pt + ct})
```

**3f.** Add `active_key_pool()` near `get_effective_configs`/`get_preferred_model` (search those names to place it logically):

```python
def active_key_pool():
    """Flat list of API keys for the currently preferred (else primary) provider
    group, in config order. Sizes subagent waves and feeds the KeyAllocator."""
    configs = get_effective_configs()
    if not configs:
        return []
    pref = get_preferred_model() or {}
    cid = pref.get("config_id")
    chosen = next((c for c in configs if c.get("id") == cid), None) or configs[0]
    keys = chosen.get("api_keys")
    if isinstance(keys, list):
        return [k for k in keys if k]
    if isinstance(keys, str):
        import re
        return [p for p in re.split(r"[,\s]+", keys) if p]
    k = chosen.get("api_key")
    return [k] if k else []
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_llm_subagent_context.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full existing LLM/agent suite to confirm no regression**

Run: `python -m pytest tests/ -k "llm or subagent or agent" -q`
Expected: PASS (no failures introduced). If `_ACTIVE_KEY` global-assignment raises `UnboundLocalError`, confirm the `global _ACTIVE_CONFIG_ID, _ACTIVE_MODEL, _ACTIVE_KEY` line at the top of `_run_group` (~1986) is intact.

- [ ] **Step 6: Commit**

```bash
git add llm.py tests/test_llm_subagent_context.py
git commit -m "feat(llm): thread-local subagent context (pinned key, badge guard, usage capture)"
```

---

## Task 3: Dynamic pool size in `subagents.py`

**Files:**
- Modify: `subagents.py` (replace the `POOL_SIZE = 4` constant at line 40 with a function; use it in `run_subagents_parallel`)
- Test: `tests/test_subagents.py` (add)

**Interfaces:**
- Consumes: `llm.active_key_pool()`.
- Produces: `def _pool_size(n_specs: int) -> int`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_subagents.py`:

```python
import subagents


def test_pool_size_reserves_one_key(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: ["a", "b", "c", "d", "e"])
    assert subagents._pool_size(10) == 4      # keys-1
    assert subagents._pool_size(2) == 2       # never more than specs


def test_pool_size_single_key_is_serial(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: ["only"])
    assert subagents._pool_size(5) == 1


def test_pool_size_no_keys_defaults_to_one(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: [])
    assert subagents._pool_size(5) == 1
```

Ensure `subagents.py` imports the module as `llm` (it currently does `from llm import ...`); add `import llm` at the top so `subagents.llm` resolves and monkeypatch works.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagents.py -k pool_size -v`
Expected: FAIL with `AttributeError: module 'subagents' has no attribute '_pool_size'`.

- [ ] **Step 3: Write minimal implementation**

In `subagents.py`: add `import llm` at the top (alongside the existing `from llm import ...`). Replace `POOL_SIZE = 4` (line 40) with:

```python
def _pool_size(n_specs):
    """Concurrency for a read wave: at most keys-1 (reserve headroom for the main
    orchestrator), never more than the number of specs, floored at 1. Derived live
    from the key pool — no hardcoded constant."""
    n_keys = len(llm.active_key_pool())
    reserve = max(1, n_keys - 1)
    return max(1, min(reserve, n_specs))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_subagents.py -k pool_size -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add subagents.py tests/test_subagents.py
git commit -m "feat(subagents): derive wave pool size from key pool (keys-1)"
```

---

## Task 4: Wire key allocation, usage accumulation, and `on_event` telemetry into the subagent loop

**Files:**
- Modify: `subagents.py` (`run_subagent` at 244, `_run_loop` at 282, `_force_final` at 226, `run_subagents_parallel` at 348)
- Test: `tests/test_subagents.py` (add)

**Interfaces:**
- Consumes: `KeyAllocator` (Task 1), `llm.set_subagent_context/clear_subagent_context/take_last_usage/active_key_pool` (Task 2), `_pool_size` (Task 3).
- Produces:
  - `run_subagent(agent_def, task, context="", run_dir=None, on_event=None)`
  - `run_subagents_parallel(specs, pool_size=None, run_dir=None, on_event=None)`
  - Events (dicts) passed to `on_event`: `{"type":"subagent_started","agent","task","key_label","mode"}`, `{"type":"subagent_progress","agent","elapsed_s","tokens","step","max_steps","last_tool"}`, `{"type":"subagent_done","agent","ok","tokens","steps","elapsed_s"}`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_subagents.py`:

```python
from subagents import AgentDef, run_subagent


def _fake_reader():
    return AgentDef(name="probe", system_prompt="you probe", mode="read",
                    allowed_tools=set(), max_steps=1)


def test_run_subagent_emits_started_and_done(monkeypatch):
    # Force the sub-loop to answer immediately.
    monkeypatch.setattr(subagents, "ask_llm",
                        lambda messages, temperature=0.3: '{"type":"final_answer","content":"done"}')
    events = []
    res = run_subagent(_fake_reader(), task="do it", on_event=events.append)
    assert res["ok"] is True
    types = [e["type"] for e in events]
    assert types[0] == "subagent_started"
    assert types[-1] == "subagent_done"
    assert events[-1]["agent"] == "probe"


def test_run_subagent_releases_key_and_clears_context(monkeypatch):
    monkeypatch.setattr(subagents.llm, "active_key_pool", lambda: ["k0", "k1"])
    monkeypatch.setattr(subagents, "ask_llm",
                        lambda messages, temperature=0.3: '{"type":"final_answer","content":"ok"}')
    run_subagent(_fake_reader(), task="t")
    # after the run, no key should be checked out and no thread context should leak
    assert all(v == 0 for v in subagents._KEY_ALLOCATOR._counts.values())
    assert subagents.llm._is_subagent_thread() is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagents.py -k "emits_started or releases_key" -v`
Expected: FAIL — `run_subagent()` has no `on_event` parameter (`TypeError: unexpected keyword argument 'on_event'`).

- [ ] **Step 3: Write minimal implementation**

**3a.** `run_subagent` — acquire/pin key, set context, emit start/done, pass `on_event` down. Replace the signature and wrap the loop:

```python
def run_subagent(agent_def, task, context="", run_dir=None, on_event=None):
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

    key = _KEY_ALLOCATOR.acquire(llm.active_key_pool())
    llm.set_subagent_context(pinned_key=key)
    started = time.monotonic()
    _emit_event(on_event, {"type": "subagent_started", "agent": agent_def.name,
                           "task": task[:160], "key_label": _mask(key), "mode": agent_def.mode})

    write_lock = _WORKSPACE_LOCK if agent_def.is_write else None
    if write_lock:
        write_lock.acquire()
    try:
        out = _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
                        on_event=on_event, agent_name=agent_def.name, max_steps_total=max_steps,
                        started=started)
    except Exception as e:
        result.update(ok=False, report=f"(subagent crashed: {e})")
        out = result
    finally:
        if write_lock:
            write_lock.release()
        llm.clear_subagent_context()
        _KEY_ALLOCATOR.release(key)

    _emit_event(on_event, {"type": "subagent_done", "agent": agent_def.name,
                           "ok": bool(out.get("ok")), "tokens": out.get("tokens", 0),
                           "steps": out.get("steps", 0),
                           "elapsed_s": round(time.monotonic() - started, 1)})
    return out
```

Add these helpers near the top of `subagents.py` (after imports; also add `import time`):

```python
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
```

**3b.** `_run_loop` — accept telemetry params, accumulate tokens, emit progress. Update its signature and the per-step tail:

```python
def _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
              on_event=None, agent_name="", max_steps_total=None, started=None):
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
        # ... (error / repeat handling unchanged) ...
```

After the existing tool execution appends the tool result (right after `messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})`), add the progress emit:

```python
        _emit_event(on_event, {"type": "subagent_progress", "agent": agent_name,
                               "elapsed_s": round(time.monotonic() - started, 1),
                               "tokens": tokens, "step": steps,
                               "max_steps": max_steps_total or max_steps,
                               "last_tool": tool_name})
```

Also add `"tokens": 0` to the dict returned by `_new_result` (line ~200) so `result["tokens"]` always exists, and include `tokens=tokens` in the `result.update(...)` calls inside `_force_final` and the salvage/parse-error return paths.

**3c.** `run_subagents_parallel` — thread `on_event` through and derive the pool size. Replace its signature/body head:

```python
def run_subagents_parallel(specs, pool_size=None, run_dir=None, on_event=None):
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

    for i in write_idx:
        results[i] = run_subagent(norm[i][0], norm[i][1], norm[i][2], run_dir, on_event)

    return results
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_subagents.py -v`
Expected: PASS (all, including the earlier legacy subagent tests — confirm none regressed).

- [ ] **Step 5: Commit**

```bash
git add subagents.py tests/test_subagents.py
git commit -m "feat(subagents): key allocation, token accounting, and live on_event telemetry"
```

---

## Task 5: Path A — batch read-delegated plan steps into a streamed wave (`agent.py`)

**Files:**
- Modify: `agent.py` (`_maybe_dispatch_delegated_steps` at ~1322; `_dispatch_delegated_step` at ~1367 — factor fold-back into `_fold_delegate_result`)
- Test: `tests/test_agent_delegation_wave.py` (create)

**Interfaces:**
- Consumes: `subagents.run_subagents_parallel(specs, on_event=...)` (Task 4), `subagents.run_subagent` (existing).
- Produces: `Agent._fold_delegate_result(plan, step, agent_name, agent_def, result)`; reworked `Agent._maybe_dispatch_delegated_steps`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_agent_delegation_wave.py`. This verifies that multiple independent read-delegated in_progress steps are dispatched as ONE wave (one `run_subagents_parallel` call), not N serial `run_subagent` calls:

```python
import types
import agent as agent_mod


def _make_agent_with_plan(steps):
    a = agent_mod.Agent.__new__(agent_mod.Agent)   # bypass heavy __init__
    plan = types.SimpleNamespace(items=steps)
    a.session = {"plan": plan, "dispatched_steps": set()}
    a._delegate_run_dir = None
    a._emitted = []
    a._emit = lambda ev: a._emitted.append(ev)
    a._compose_delegate_task = lambda step: step.get("desc", "task")
    a._compose_delegate_context = lambda plan: "ctx"
    a._fold_delegate_result = lambda plan, step, name, ad, res: a._emitted.append(
        {"type": "folded", "step": step["id"], "ok": res.get("ok")})
    return a, plan


def test_two_read_steps_run_as_one_wave(monkeypatch):
    calls = {"parallel": 0, "single": 0}

    def fake_parallel(specs, on_event=None):
        calls["parallel"] += 1
        return [{"ok": True, "agent": s[0].name, "report": "r", "steps": 1, "tokens": 5}
                for s in specs]

    def fake_single(ad, task, context="", run_dir=None, on_event=None):
        calls["single"] += 1
        return {"ok": True, "agent": ad.name, "report": "r", "steps": 1, "tokens": 5}

    monkeypatch.setattr(agent_mod.subagents, "run_subagents_parallel", fake_parallel)
    monkeypatch.setattr(agent_mod.subagents, "run_subagent", fake_single)

    read_ad = agent_mod.subagents.AgentDef(name="reader", system_prompt="x", mode="read", allowed_tools=set())
    monkeypatch.setattr(agent_mod.plugins, "get_registry",
                        lambda: types.SimpleNamespace(get_agent=lambda n: read_ad))

    steps = [
        {"id": "s1", "status": "in_progress", "delegate": "reader"},
        {"id": "s2", "status": "in_progress", "delegate": "reader"},
    ]
    a, plan = _make_agent_with_plan(steps)
    a._maybe_dispatch_delegated_steps()

    assert calls["parallel"] == 1
    assert calls["single"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_agent_delegation_wave.py -v`
Expected: FAIL — current `_maybe_dispatch_delegated_steps` calls `run_subagent` once per step (`calls["single"] == 2`, `calls["parallel"] == 0`).

- [ ] **Step 3: Write minimal implementation**

**3a.** Factor the fold-back tail of `_dispatch_delegated_step` (the part after `run_subagent` returns — the `[DELEGATE RESULT ...]` context injection, `inv.add_finding`, step-status update, and `unverified_change` for writes, ~lines 1395-1424) into a new method `_fold_delegate_result(self, plan, step, agent_name, agent_def, result)`. Have the existing `_dispatch_delegated_step` call it, so the serial path is unchanged.

**3b.** Rewrite `_maybe_dispatch_delegated_steps` to batch reads:

```python
    def _maybe_dispatch_delegated_steps(self):
        s = self.session
        plan = s.get("plan")
        if not plan:
            return
        dispatched = s.setdefault("dispatched_steps", set())
        reg = plugins.get_registry()

        reads, writes = [], []
        for step in list(plan.items):
            if not (step.get("status") == "in_progress" and step.get("delegate")
                    and step["id"] not in dispatched):
                continue
            name = (step.get("delegate") or "").strip()
            ad = reg.get_agent(name)
            if ad is None:
                dispatched.add(step["id"])
                self._emit({"type": "system",
                            "content": f"Unknown delegate agent '{name}' — the agent will handle the step itself."})
                continue
            dispatched.add(step["id"])
            (writes if ad.is_write else reads).append((step, name, ad))

        if reads:
            self._run_delegated_read_wave(plan, reads)
        for step, name, ad in writes:
            task = self._compose_delegate_task(step)
            context = self._compose_delegate_context(plan)
            self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                        "content": f"Delegating step ({step['id']}) to subagent '{name}' ({ad.mode})…"})
            result = subagents.run_subagent(ad, task, context=context,
                                            run_dir=getattr(self, "_delegate_run_dir", None))
            self._fold_delegate_result(plan, step, name, ad, result)
```

**3c.** Add `_run_delegated_read_wave` — runs the wave in a background thread and drains telemetry to `_emit` live:

```python
    def _run_delegated_read_wave(self, plan, reads):
        import queue as _queue
        import threading as _threading
        evq = _queue.Queue()
        specs = [(ad, self._compose_delegate_task(step), self._compose_delegate_context(plan))
                 for (step, _name, ad) in reads]
        for step, name, ad in reads:
            self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                        "content": f"Delegating step ({step['id']}) to subagent '{name}' (read) in a parallel wave…"})
        holder = {}
        _SENTINEL = {"type": "__wave_done__"}

        def work():
            try:
                holder["results"] = subagents.run_subagents_parallel(
                    specs, run_dir=getattr(self, "_delegate_run_dir", None), on_event=evq.put)
            finally:
                evq.put(_SENTINEL)

        t = _threading.Thread(target=work, daemon=True)
        t.start()
        while True:
            ev = evq.get()
            if ev is _SENTINEL:
                break
            self._emit(ev)
        t.join()

        results = holder.get("results") or []
        for (step, name, ad), result in zip(reads, results):
            self._fold_delegate_result(plan, step, name, ad, result)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_agent_delegation_wave.py -v`
Expected: PASS.

- [ ] **Step 5: Run the delegation-related suite for regressions**

Run: `python -m pytest tests/ -k "deleg or subagent or agent" -q`
Expected: PASS.

- [ ] **Step 6: Add planning guidance note**

In the planning guidance string (search `llm.py` for the plan-narration guidance around line 205, "EXPLAINING YOUR WORK"), add one line so the model knows batching is possible:

```
Independent RESEARCH steps tagged delegate=<read-agent> may be marked in_progress TOGETHER — they run as one parallel wave. Dependent steps and delegate=<write-agent> steps must be started one at a time.
```

- [ ] **Step 7: Commit**

```bash
git add agent.py tests/test_agent_delegation_wave.py llm.py
git commit -m "feat(agent): batch independent read-delegated steps into a streamed parallel wave"
```

---

## Task 6: Frontend live subagent panel (`frontend/app.js`)

No JS unit-test harness exists in this repo, so this task ends with a **manual smoke check** rather than an automated test.

**Files:**
- Modify: `frontend/app.js` (`onEvent` switch at ~1055; add three cases + render helpers)

**Interfaces:**
- Consumes: events emitted by Task 5 — `subagent_started`, `subagent_progress`, `subagent_done`.
- Produces: DOM rendering; no exported API.

- [ ] **Step 1: Add the event cases**

In `onEvent` (`app.js:1055`), add inside the `switch (ev.type)`:

```javascript
      case 'subagent_started': subagentStarted(ev); break;
      case 'subagent_progress': subagentProgress(ev); break;
      case 'subagent_done': subagentDone(ev); break;
```

- [ ] **Step 2: Add the render helpers**

Add near the other renderers (follow the style of `startTool`/`finishTool`). This keeps a small live panel keyed by agent name:

```javascript
const _subagentRows = {};

function _subagentPanel() {
  let el = document.getElementById('subagent-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'subagent-panel';
    el.className = 'subagent-panel';
    (document.getElementById('chat') || document.body).appendChild(el);
  }
  return el;
}

function subagentStarted(ev) {
  const row = document.createElement('div');
  row.className = 'subagent-row running';
  row.innerHTML =
    `<span class="sa-name">${ev.agent}</span>` +
    `<span class="sa-task">${(ev.task || '').replace(/</g, '&lt;')}</span>` +
    `<span class="sa-key">${ev.key_label || ''}</span>` +
    `<span class="sa-stats">0s · 0 tok</span>`;
  _subagentPanel().appendChild(row);
  _subagentRows[ev.agent] = row;
}

function subagentProgress(ev) {
  const row = _subagentRows[ev.agent];
  if (!row) return;
  const stats = row.querySelector('.sa-stats');
  if (stats) stats.textContent =
    `${ev.elapsed_s}s · ${ev.tokens} tok · step ${ev.step}/${ev.max_steps}`;
}

function subagentDone(ev) {
  const row = _subagentRows[ev.agent];
  if (!row) return;
  row.classList.remove('running');
  row.classList.add(ev.ok ? 'ok' : 'failed');
  const stats = row.querySelector('.sa-stats');
  if (stats) stats.textContent =
    `${ev.ok ? '✓' : '✗'} ${ev.elapsed_s}s · ${ev.tokens} tok · ${ev.steps} steps`;
}
```

- [ ] **Step 3: Add minimal styles**

In `frontend/tailwind.input.css` (or the app's stylesheet), add:

```css
.subagent-panel { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.subagent-row { display: flex; gap: 8px; font-size: 12px; padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,0.04); }
.subagent-row.running { border-left: 3px solid #3b82f6; }
.subagent-row.ok { border-left: 3px solid #22c55e; }
.subagent-row.failed { border-left: 3px solid #ef4444; }
.subagent-row .sa-name { font-weight: 600; }
.subagent-row .sa-stats { margin-left: auto; opacity: 0.8; }
```

- [ ] **Step 4: Manual smoke check**

Start the app (`python api_server.py` or the project's run entry) and trigger a plan with two independent `delegate=<read-agent>` research steps marked in_progress together. Confirm the panel shows two rows advancing their `Ns · tokens · step` counters concurrently, then each resolves to ✓/✗. Confirm the numbers on the two rows move independently (proving concurrency, not sequential updates).

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/tailwind.input.css
git commit -m "feat(frontend): live subagent telemetry panel"
```

---

## Self-Review

**Spec coverage:**
- Component 1a KeyAllocator → Task 1. ✓
- Component 1b pinned-key ordering → Task 2 (3b). ✓
- Component 1c subagent-scoped state → Task 2 (3c). ✓
- Component 1d usage capture + fallback → Task 2 (3d/3e) + Task 4 (`_estimate_tokens`). ✓
- Component 1e derived pool size → Task 3. ✓
- Component 2 Path A batched wave → Task 5. ✓
- Component 3 telemetry events → Task 4 + drained in Task 5. ✓
- Component 4 frontend panel → Task 6. ✓
- Testing section → per-task tests + regression runs. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. The one non-automated step (Task 6 frontend) is explicitly a manual smoke check because the repo has no JS test harness — its exact verification steps are spelled out.

**Type consistency:** `KeyAllocator.acquire/release`, `set_subagent_context`/`clear_subagent_context`/`take_last_usage`/`_record_usage`/`active_key_pool`, `_pool_size`, `run_subagent(..., on_event=None)`, `run_subagents_parallel(..., on_event=None)`, event dict shapes (`subagent_started/progress/done`), and `_fold_delegate_result` are used consistently across Tasks 1–6. The result dict gains a `tokens` key in Task 4 (`_new_result`) and is read by the telemetry and frontend consistently.
