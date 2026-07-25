# Subagent Model Routing & Delegation Doctrine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the main LLM pick a model and custom fallback order per subagent, cost-aware via ladder position plus optional per-model tier tags, and push the orchestrator to delegate far more often.

**Architecture:** Ladder position IS cost. `llm.model_ladder()` flattens every configured text model across provider groups in config order into a rung list; each model's tier is an explicit `model_settings[<model>].tier` tag when present, else derived from position. A subagent's chosen ladder is pushed into the existing `llm` thread-local (`set_subagent_context`), and `ask_llm` swaps `_apply_preference` for `_apply_model_override` on subagent threads. Delegation frequency is raised by a prompt doctrine plus two bounded runtime nudges in `agent.py`.

**Tech Stack:** Python 3, `pytest`, plain stdlib. Frontend is vanilla JS (`frontend/app.js`).

**Spec:** `docs/superpowers/specs/2026-07-25-subagent-model-routing-design.md`

## Global Constraints

- **Never raise for orchestration reasons.** `subagents.run_subagent` returns `{ok: False, report: "<why>"}`; a bad model id or tier must degrade, never kill a wave.
- **`ask_llm` resilience contract is untouchable.** It never gives up: every subagent ladder ends with a last-resort tail so a cheap subagent can still escalate rather than die.
- **Thread-local only.** Per-subagent routing must never leak into the main thread's `ask_llm`, which stays governed by `get_preferred_model()` (the composer dropdown).
- **Tier names are open strings.** `premium` / `standard` / `cheap` are only what the prompt advertises; unknown tiers must resolve, not crash.
- **No nested subagents.** `tool_policy.SUBAGENT_EXCLUDED` stays authoritative.
- **Nudges are bounded.** Each fires at most once per streak/phase and resets per episode, matching the `strategy_review_rounds` precedent (commit `34e22b1`).
- **Default subagent tier is `"standard"`** (`llm.DEFAULT_SUBAGENT_TIER`).
- **Regression bar:** full `pytest` must show no new failures beyond the 2 known pre-existing ones.

## Deviation from the spec (deliberate, applies to Task 2)

The spec's table gave tier→rung as `premium=0`, `standard=N//2`, `cheap=N-1`. That is a *starting-rung* rule, but Layer 2 needs to assign a tier **label to every untagged model**. This plan uses the labeling rule instead:

```
rung 0        -> premium
rung N-1      -> cheap
anything else -> standard
```

It is more stable (adding a model mid-ladder never moves the premium/cheap boundaries) and gives every model exactly one tier so tagged and untagged models resolve uniformly. Consequence on the current 5-model config: `standard` starts at rung 1 (`z-ai/glm-5.2`), not rung 2 (`deepseek-ai/deepseek-v4-pro`). Explicit tags override this entirely.

## File Structure

| File | Responsibility |
|---|---|
| `llm.py` | Cost spine (`model_ladder`, `models_for_tier`), thread-local override, `_apply_model_override`, `take_last_model`, prompt doctrine |
| `subagents.py` | `AgentDef.tier/.models`, `resolve_model_ladder`, `escalate_ladder`, run wiring, telemetry |
| `tools/delegation_tools.py` | `tier`/`models` on dispatch specs, live ladder in the tool description |
| `agent.py` | `delegate="agent@tier"` parsing, two delegation nudges, session state |
| `plugins.py` | `tier:`/`models:` frontmatter, ladder block in the subagents prompt |
| `plugins/*/agents/*.md` | Per-persona default tiers |
| `frontend/app.js` | Tier select in the per-model ⚙ panel |
| `tests/test_model_ladder.py` | Cost spine + override unit tests (new) |
| `tests/test_subagent_routing.py` | Resolution, escalation, telemetry (new) |
| `tests/test_delegation_nudges.py` | Both nudges (new) |

---

## Task 1: Let `tier` survive the config round-trip

`_norm_model_settings` whitelists keys. A `tier` key is silently dropped today by BOTH `_effective` (read) and `_minimize_entry` (save), so every later task would build on data that vanishes. This lands first.

**Files:**
- Modify: `llm.py:421-445` (`_norm_model_settings`), add `_norm_tier` above it
- Test: `tests/test_model_ladder.py` (create)

**Interfaces:**
- Produces: `llm._norm_tier(value) -> str` — lowercase slug or `""`.
- Produces: `_norm_model_settings` now preserves a `"tier"` key per model.

- [ ] **Step 1: Write the failing test**

Create `tests/test_model_ladder.py`:

```python
import llm


def test_norm_tier_slugifies_and_blanks():
    assert llm._norm_tier("Premium") == "premium"
    assert llm._norm_tier("  CHEAP ") == "cheap"
    assert llm._norm_tier("my tier!") == "my-tier"
    assert llm._norm_tier("") == ""
    assert llm._norm_tier(None) == ""


def test_model_settings_preserves_tier():
    out = llm._norm_model_settings(
        {"m-1": {"reasoning_effort": "high", "tier": "Premium"},
         "m-2": {"tier": "cheap"}},
        model_ids=["m-1", "m-2"])
    assert out["m-1"]["tier"] == "premium"
    assert out["m-1"]["reasoning_effort"] == "high"
    assert out["m-2"] == {"tier": "cheap"}


def test_model_settings_drops_unusable_tier():
    out = llm._norm_model_settings({"m-1": {"tier": "   "}}, model_ids=["m-1"])
    assert out == {}


def test_tier_survives_effective_and_minimize_roundtrip():
    raw = {"id": "c1", "name": "n", "provider": "nvidia",
           "api_key": "k", "models": ["m-1", "m-2"],
           "model_settings": {"m-1": {"tier": "premium"}}}
    eff = llm._effective(raw)
    assert eff["model_settings"]["m-1"]["tier"] == "premium"
    saved = llm._minimize_entry(raw)
    assert saved["model_settings"]["m-1"]["tier"] == "premium"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_model_ladder.py -v`
Expected: FAIL — `AttributeError: module 'llm' has no attribute '_norm_tier'`

- [ ] **Step 3: Write minimal implementation**

In `llm.py`, insert directly above `_norm_model_settings` (line 421):

```python
def _norm_tier(value):
    """Normalize a per-model TIER tag to a lowercase slug, or '' when absent.

    Tier names are deliberately OPEN — 'premium'/'standard'/'cheap' are only the
    names the system prompt advertises, so tagging a model 'fast' works with no
    code change. Kept to a slug so it round-trips through JSON and the UI select."""
    v = re.sub(r"[^a-z0-9_-]+", "-", (value or "").strip().lower()).strip("-")
    return v[:32]
```

Then inside `_norm_model_settings`, after the `supports_native_tools` block (line 442) and before `if entry:`:

```python
        tier = _norm_tier(s.get("tier"))
        if tier:
            entry["tier"] = tier
```

Update that function's docstring first line to:

```python
    """Normalize a model_settings map to {model_id: {reasoning_effort?, reasoning_style?, tier?}}.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_model_ladder.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_model_ladder.py
git commit -m "feat(llm): preserve a per-model tier tag through the config round-trip"
```

---

## Task 2: The cost spine — `model_ladder()` and `models_for_tier()`

**Files:**
- Modify: `llm.py` — add after `_ordered_models` (ends line 1766), before `_live_keys`
- Test: `tests/test_model_ladder.py`

**Interfaces:**
- Consumes: `llm._norm_tier` (Task 1).
- Produces: `llm.BUILTIN_TIERS: tuple[str, ...]`, `llm.DEFAULT_SUBAGENT_TIER: str`.
- Produces: `llm._derived_tier(rung: int, n: int) -> str`.
- Produces: `llm.model_ladder() -> list[dict]` — entries `{rung, id, label, model, tier, tagged}`, `[]` when unconfigured.
- Produces: `llm.models_for_tier(tier: str, ladder: list | None = None) -> list[str]` — ordered model ids.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_model_ladder.py`:

```python
def _ladder(*pairs):
    """Build a fake ladder: _ladder(("m-0", "premium"), ("m-1", ""), ...)."""
    entries = [{"rung": i, "id": "c1", "label": "L", "model": m,
                "tier": t, "tagged": bool(t)} for i, (m, t) in enumerate(pairs)]
    n = len(entries)
    for e in entries:
        if not e["tagged"]:
            e["tier"] = llm._derived_tier(e["rung"], n)
    return entries


def test_derived_tier_labels_every_rung():
    assert llm._derived_tier(0, 5) == "premium"
    assert llm._derived_tier(1, 5) == "standard"
    assert llm._derived_tier(3, 5) == "standard"
    assert llm._derived_tier(4, 5) == "cheap"


def test_derived_tier_degenerate_ladders():
    assert llm._derived_tier(0, 1) == "premium"
    assert llm._derived_tier(0, 2) == "premium"
    assert llm._derived_tier(1, 2) == "cheap"


def test_models_for_tier_body_then_reversed_tail():
    lad = _ladder(("m0", ""), ("m1", ""), ("m2", ""), ("m3", ""), ("m4", ""))
    # cheap starts at the last rung; tail escalates to the NEAREST higher rung first
    assert llm.models_for_tier("cheap", lad) == ["m4", "m3", "m2", "m1", "m0"]
    assert llm.models_for_tier("premium", lad) == ["m0", "m1", "m2", "m3", "m4"]
    assert llm.models_for_tier("standard", lad) == ["m1", "m2", "m3", "m4", "m0"]


def test_models_for_tier_honours_explicit_tags():
    lad = _ladder(("m0", ""), ("m1", "cheap"), ("m2", ""), ("m3", ""), ("m4", ""))
    # m1 is TAGGED cheap, so cheap starts at rung 1 even though m4 is last
    assert llm.models_for_tier("cheap", lad)[0] == "m1"


def test_models_for_tier_custom_tag_resolves():
    lad = _ladder(("m0", ""), ("m1", "fast"), ("m2", ""))
    assert llm.models_for_tier("fast", lad)[0] == "m1"


def test_models_for_tier_unknown_falls_back_to_default():
    lad = _ladder(("m0", ""), ("m1", ""), ("m2", ""))
    assert llm.models_for_tier("nonsense", lad) == llm.models_for_tier(
        llm.DEFAULT_SUBAGENT_TIER, lad)


def test_models_for_tier_empty_ladder():
    assert llm.models_for_tier("cheap", []) == []


def test_models_for_tier_single_model_ladder():
    lad = _ladder(("only", ""))
    assert llm.models_for_tier("cheap", lad) == ["only"]
    assert llm.models_for_tier("premium", lad) == ["only"]


def test_tagged_model_does_not_drift_when_ladder_grows():
    """The stability guarantee: a TAGGED model keeps its tier as models are added."""
    small = _ladder(("m0", ""), ("m1", "premium"), ("m2", ""))
    big = _ladder(("m0", ""), ("m1", "premium"), ("x", ""), ("y", ""), ("m2", ""))
    assert llm.models_for_tier("premium", small)[0] == "m1"
    assert llm.models_for_tier("premium", big)[0] == "m1"


def test_model_ladder_shape(monkeypatch):
    cfgs = [{"id": "c1", "provider": "nvidia", "base_url": "", "label": "nv",
             "api_keys": ["k"], "models": ["a", "b"], "vision_models": [],
             "model_settings": {"b": {"tier": "cheap"}}, "name": "nv"}]
    monkeypatch.setattr(llm, "get_effective_configs", lambda: cfgs)
    lad = llm.model_ladder()
    assert [e["model"] for e in lad] == ["a", "b"]
    assert [e["rung"] for e in lad] == [0, 1]
    assert lad[0]["tier"] == "premium" and lad[0]["tagged"] is False
    assert lad[1]["tier"] == "cheap" and lad[1]["tagged"] is True


def test_model_ladder_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(llm, "get_effective_configs", lambda: [])
    assert llm.model_ladder() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_model_ladder.py -v`
Expected: FAIL — `AttributeError: module 'llm' has no attribute '_derived_tier'`

- [ ] **Step 3: Write minimal implementation**

In `llm.py`, insert after `_ordered_models` (after line 1766):

```python
# --- the COST SPINE: one global model ladder, ordered most-expensive first ----
# LADDER POSITION IS COST. The operator orders providers (drag-to-reorder,
# frontend/app.js:1765) and the models within a provider (frontend/app.js:1945);
# the flattened result is the spine every subagent routes against. A model may
# ALSO carry an explicit tier tag in model_settings[<model>]["tier"], which always
# wins over position — so adding a provider never reshuffles a TAGGED model
# between tiers. Only untagged models drift with position.
BUILTIN_TIERS = ("premium", "standard", "cheap")
DEFAULT_SUBAGENT_TIER = "standard"


def _derived_tier(rung, n):
    """Positional tier for an UNTAGGED model at `rung` of a ladder of length `n`.
    Top rung is premium, bottom rung is cheap, everything between is standard —
    a labeling rule (not a starting-rung rule) so every model has exactly one
    tier and tagged/untagged models resolve through the same code path."""
    if n <= 1 or rung <= 0:
        return "premium"
    if rung >= n - 1:
        return "cheap"
    return "standard"


def model_ladder():
    """The global cost spine: every configured TEXT model flattened across
    provider groups in config order, most capable/expensive first.

    Each entry: {rung, id, label, model, tier, tagged}. `tier` is the explicit
    model_settings tag when present (tagged=True), else derived from position.
    Returns [] when nothing is configured — callers treat that as "no override"
    and keep today's behavior."""
    configs = get_effective_configs()
    if not configs:
        return []
    tags = {}
    for c in configs:
        for model, s in (c.get("model_settings") or {}).items():
            t = _norm_tier((s or {}).get("tier"))
            if t:
                tags[model] = t
    out = []
    for g in _build_groups(configs):
        for m in g.get("models") or []:
            out.append({"id": m.get("id"),
                        "label": g.get("label") or g.get("provider") or "",
                        "model": m["model"]})
    n = len(out)
    for rung, e in enumerate(out):
        tag = tags.get(e["model"])
        e["rung"] = rung
        e["tier"] = tag or _derived_tier(rung, n)
        e["tagged"] = bool(tag)
    return out


def models_for_tier(tier, ladder=None):
    """Ordered model ids a subagent on `tier` should try.

    Body: the first model carrying `tier`, then everything BELOW it in ladder
    order (so it fails over to cheaper models first). Tail: the rungs ABOVE it,
    nearest first, appended as a LAST RESORT — this is what preserves ask_llm's
    "never give up" contract without silently paying premium prices. An unknown
    tier resolves to DEFAULT_SUBAGENT_TIER; an empty ladder yields []."""
    ladder = model_ladder() if ladder is None else ladder
    if not ladder:
        return []
    want = _norm_tier(tier) or DEFAULT_SUBAGENT_TIER
    matches = [e for e in ladder if e["tier"] == want]
    if not matches:
        matches = [e for e in ladder if e["tier"] == DEFAULT_SUBAGENT_TIER]
    if not matches:
        matches = ladder[:1]        # degenerate ladder — every tier is the top rung
    start = matches[0]["rung"]
    body = [e["model"] for e in ladder[start:]]
    tail = [e["model"] for e in reversed(ladder[:start])]
    return body + tail
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_model_ladder.py -v`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_model_ladder.py
git commit -m "feat(llm): model_ladder() cost spine with tag-or-position tiers"
```

---

## Task 3: Per-thread model override in `ask_llm`

**Files:**
- Modify: `llm.py:1592-1608` (thread-local), `llm.py:2129` (`_run_group` success), `llm.py:2191` (`ask_llm`), add `_apply_model_override` after `_apply_preference` (line 1983)
- Test: `tests/test_model_ladder.py`

**Interfaces:**
- Consumes: `llm.model_ladder` (Task 2).
- Produces: `llm.set_subagent_context(pinned_key=None, models=None)` — `models` is an ordered list of model ids.
- Produces: `llm.take_last_model() -> str | None` — clears on read, like `take_last_usage`.
- Produces: `llm._apply_model_override(groups, model_ids) -> list[dict]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_model_ladder.py`:

```python
import threading


def teardown_function():
    llm.clear_subagent_context()


def _groups():
    def mk(model):
        return {"id": "c", "name": "n", "model": model, "cfg": {"model": model}}
    return [
        {"provider": "cline", "label": "cline", "keys": ["k1"], "models": [mk("kimi")]},
        {"provider": "nvidia", "label": "nv", "keys": ["k2", "k3"],
         "models": [mk("glm"), mk("pro"), mk("flash")]},
    ]


def test_apply_model_override_honours_exact_order():
    out = llm._apply_model_override(_groups(), ["flash", "kimi"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["flash"], ["kimi"]]


def test_apply_model_override_merges_consecutive_same_provider():
    out = llm._apply_model_override(_groups(), ["pro", "flash", "kimi"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["pro", "flash"], ["kimi"]]
    assert out[0]["keys"] == ["k2", "k3"]   # key pool preserved for dead-key sharing


def test_apply_model_override_splits_non_consecutive_same_provider():
    out = llm._apply_model_override(_groups(), ["pro", "kimi", "flash"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["pro"], ["kimi"], ["flash"]]


def test_apply_model_override_skips_unknown_ids():
    out = llm._apply_model_override(_groups(), ["nope", "glm"])
    assert [[m["model"] for m in g["models"]] for g in out] == [["glm"]]


def test_apply_model_override_all_unknown_returns_empty():
    assert llm._apply_model_override(_groups(), ["nope", "nada"]) == []


def test_apply_model_override_does_not_mutate_source_groups():
    src = _groups()
    llm._apply_model_override(src, ["pro", "flash"])
    assert [m["model"] for m in src[1]["models"]] == ["glm", "pro", "flash"]


def test_set_subagent_context_stores_and_clears_ladder():
    llm.set_subagent_context(pinned_key="k", models=["a", "b"])
    assert llm._thread_model_ladder() == ["a", "b"]
    llm.clear_subagent_context()
    assert llm._thread_model_ladder() is None


def test_take_last_model_roundtrip_and_clear():
    llm._TL.last_model = "some-model"
    assert llm.take_last_model() == "some-model"
    assert llm.take_last_model() is None


def test_override_is_thread_local(monkeypatch):
    """A subagent thread's ladder must never leak into the main thread."""
    llm.clear_subagent_context()
    seen = {}

    def worker():
        llm.set_subagent_context(pinned_key="k", models=["flash"])
        seen["sub"] = llm._thread_model_ladder()

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    assert seen["sub"] == ["flash"]
    assert llm._thread_model_ladder() is None


def test_ask_llm_uses_override_on_subagent_thread(monkeypatch):
    """With an override set, ask_llm must try the overridden model and must NOT
    consult get_preferred_model()."""
    monkeypatch.setattr(llm, "get_effective_configs", lambda: [{"x": 1}])
    monkeypatch.setattr(llm, "_build_groups", lambda cfgs: _groups())
    monkeypatch.setattr(llm, "get_preferred_model",
                        lambda: (_ for _ in ()).throw(AssertionError("preference consulted")))
    tried = []

    def fake_run_group(group, messages, temperature, **kw):
        tried.append(group["models"][0]["model"])
        return {"ok": True, "content": "hi", "model": group["models"][0],
                "key": "k", "cfg": {}}

    monkeypatch.setattr(llm, "_run_group", fake_run_group)
    monkeypatch.setattr(llm, "_await_or_stop", lambda fn, poll=0.1: fn())
    llm.set_subagent_context(pinned_key="k", models=["flash"])
    assert llm.ask_llm([{"role": "user", "content": "hi"}]) == "hi"
    assert tried == ["flash"]


def test_ask_llm_falls_back_to_full_ladder_when_override_matches_nothing(monkeypatch):
    monkeypatch.setattr(llm, "get_effective_configs", lambda: [{"x": 1}])
    monkeypatch.setattr(llm, "_build_groups", lambda cfgs: _groups())
    monkeypatch.setattr(llm, "get_preferred_model", lambda: None)
    tried = []

    def fake_run_group(group, messages, temperature, **kw):
        tried.append(group["models"][0]["model"])
        return {"ok": True, "content": "hi", "model": group["models"][0],
                "key": "k", "cfg": {}}

    monkeypatch.setattr(llm, "_run_group", fake_run_group)
    monkeypatch.setattr(llm, "_await_or_stop", lambda fn, poll=0.1: fn())
    llm.set_subagent_context(pinned_key="k", models=["ghost"])
    assert llm.ask_llm([{"role": "user", "content": "hi"}]) == "hi"
    assert tried == ["kimi"]   # full ladder, not an empty group list
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_model_ladder.py -v`
Expected: FAIL — `AttributeError: module 'llm' has no attribute '_apply_model_override'`

- [ ] **Step 3: Write minimal implementation**

**3a.** Replace `llm.py:1592-1608` (`set_subagent_context` through `_is_subagent_thread`) with:

```python
def set_subagent_context(pinned_key=None, models=None):
    """Mark THIS thread as a subagent: pin its API key, optionally pin its own
    MODEL LADDER (ordered model ids — see subagents.resolve_model_ladder),
    suppress the main-thread provider badge, and start fresh usage accounting.
    Thread-local, so the main thread's ask_llm is entirely unaffected."""
    _TL.pinned_key = pinned_key
    _TL.model_ladder = list(models) if models else None
    _TL.is_subagent = True
    _TL.last_usage = None
    _TL.last_model = None

def clear_subagent_context():
    _TL.pinned_key = None
    _TL.model_ladder = None
    _TL.is_subagent = False
    _TL.last_usage = None
    _TL.last_model = None

def _pinned_key():
    return getattr(_TL, "pinned_key", None)

def _thread_model_ladder():
    """This thread's pinned model ladder, or None to use the global one."""
    return getattr(_TL, "model_ladder", None)

def _is_subagent_thread():
    return getattr(_TL, "is_subagent", False)
```

**3b.** Add after `take_last_usage` (line 1618):

```python
def take_last_model():
    """Model id that served the last successful request on THIS thread, or None.
    Cleared on read, like take_last_usage — feeds per-subagent cost telemetry so
    the UI can show which model actually answered, not just which was requested."""
    m = getattr(_TL, "last_model", None)
    _TL.last_model = None
    return m
```

**3c.** In `_run_group`, in the success branch, insert immediately after
`_MODEL_COOLDOWN.pop(m["model"], None)   # it works again` (line 2122):

```python
            _TL.last_model = m["model"]             # thread-local; feeds take_last_model()
```

**3d.** Add after `_apply_preference` (after line 1983):

```python
def _apply_model_override(groups, model_ids):
    """Re-emit `groups` so models are tried in EXACTLY `model_ids` order.

    Consecutive ids belonging to the SAME source group are merged into one
    emitted group so `_run_group`'s per-call dead-key set is still shared between
    them — splitting every model into its own group would re-probe keys already
    known dead. Ids not present in `groups` are skipped; returns [] if none match
    (the caller then keeps the full ladder rather than having nothing to call)."""
    index = {}
    for g in groups:
        for m in g.get("models") or []:
            index.setdefault(m["model"], (g, m))
    out = []
    cur_src = None
    for mid in model_ids:
        hit = index.get(mid)
        if hit is None:
            continue
        src, m = hit
        if out and cur_src is src:
            out[-1]["models"].append(m)
            continue
        ng = dict(src)
        ng["models"] = [m]
        out.append(ng)
        cur_src = src
    return out
```

**3e.** In `ask_llm`, replace line 2191 and its two comment lines (2189-2191):

```python
        # A SUBAGENT thread routes on its own pinned ladder (cost-aware, chosen by
        # the orchestrator); the MAIN thread starts at the user's selected model
        # (composer dropdown) and falls DOWNWARD only. Re-read each cycle so a
        # changed selection — or a changed config — takes effect mid-run.
        groups = _build_groups(configs)
        override = _thread_model_ladder()
        if override:
            groups = _apply_model_override(groups, override) or groups
        else:
            groups = _apply_preference(groups, get_preferred_model())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_model_ladder.py tests/test_llm_subagent_context.py -v`
Expected: PASS (all, including the pre-existing subagent-context tests)

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_model_ladder.py
git commit -m "feat(llm): per-thread model ladder override for subagents"
```

---

## Task 4: `resolve_model_ladder` and subagent wiring

**Files:**
- Modify: `subagents.py:186-213` (`AgentDef`), `319-322` (`_new_result`), `366-426` (`run_subagent`), `501-507` (`_normalize_spec`), `510-549` (`run_subagents_parallel`)
- Test: `tests/test_subagent_routing.py` (create)

**Interfaces:**
- Consumes: `llm.model_ladder`, `llm.models_for_tier`, `llm.DEFAULT_SUBAGENT_TIER` (Task 2); `llm.set_subagent_context(models=)`, `llm.take_last_model` (Task 3).
- Produces: `AgentDef(..., tier=None, models=None)` with `.tier` / `.models` attributes.
- Produces: `subagents.resolve_model_ladder(agent_def, tier=None, models=None) -> tuple[list[str] | None, str]` — `(ladder, note)`.
- Produces: `run_subagent(agent_def, task, context="", run_dir=None, on_event=None, tier=None, models=None)`.
- Produces: `_normalize_spec(spec) -> (agent_def, task, context, tier, models)` — a 5-tuple.
- Produces: result dict gains `"model"` and `"escalated"` keys.

- [ ] **Step 1: Write the failing test**

Create `tests/test_subagent_routing.py`:

```python
import llm
import subagents
from subagents import AgentDef


def _fake_ladder():
    return [{"rung": 0, "id": "c", "label": "L", "model": "kimi",
             "tier": "premium", "tagged": False},
            {"rung": 1, "id": "c", "label": "L", "model": "glm",
             "tier": "standard", "tagged": False},
            {"rung": 2, "id": "c", "label": "L", "model": "flash",
             "tier": "cheap", "tagged": False}]


def _patch_ladder(monkeypatch, ladder=None):
    lad = _fake_ladder() if ladder is None else ladder
    monkeypatch.setattr(llm, "model_ladder", lambda: lad)
    return lad


def test_explicit_models_win_over_everything(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="premium", models=["kimi"])
    ladder, note = subagents.resolve_model_ladder(ad, tier="premium", models=["flash"])
    assert ladder[0] == "flash" and note == ""


def test_explicit_models_get_the_rest_appended(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(AgentDef("a", "p"), models=["flash"])
    assert ladder == ["flash", "kimi", "glm"]


def test_explicit_tier_beats_frontmatter(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="premium")
    ladder, _ = subagents.resolve_model_ladder(ad, tier="cheap")
    assert ladder[0] == "flash"


def test_frontmatter_models_beat_frontmatter_tier(monkeypatch):
    _patch_ladder(monkeypatch)
    ad = AgentDef("a", "p", tier="cheap", models=["glm"])
    ladder, _ = subagents.resolve_model_ladder(ad)
    assert ladder[0] == "glm"


def test_frontmatter_tier_used_when_call_is_silent(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(AgentDef("a", "p", tier="cheap"))
    assert ladder[0] == "flash"


def test_default_tier_when_nothing_specified(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, _ = subagents.resolve_model_ladder(AgentDef("a", "p"))
    assert ladder == llm.models_for_tier(llm.DEFAULT_SUBAGENT_TIER, _fake_ladder())


def test_unknown_model_ids_are_dropped_with_a_note(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, note = subagents.resolve_model_ladder(
        AgentDef("a", "p"), models=["ghost", "flash"])
    assert ladder[0] == "flash"
    assert "ghost" in note


def test_all_unknown_models_fall_back_to_tier(monkeypatch):
    _patch_ladder(monkeypatch)
    ladder, note = subagents.resolve_model_ladder(
        AgentDef("a", "p", tier="cheap"), models=["ghost"])
    assert ladder[0] == "flash"
    assert "ghost" in note


def test_no_configured_models_returns_none(monkeypatch):
    _patch_ladder(monkeypatch, [])
    ladder, note = subagents.resolve_model_ladder(AgentDef("a", "p"), tier="cheap")
    assert ladder is None and note == ""


def test_normalize_spec_shapes():
    ad = AgentDef("a", "p")
    assert subagents._normalize_spec((ad, "t")) == (ad, "t", "", None, None)
    assert subagents._normalize_spec((ad, "t", "c")) == (ad, "t", "c", None, None)
    assert subagents._normalize_spec(
        {"agent_def": ad, "task": "t", "tier": "cheap"}) == (ad, "t", "", "cheap", None)


def test_run_subagent_pins_the_resolved_ladder(monkeypatch):
    _patch_ladder(monkeypatch)
    seen = {}
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context",
                        lambda pinned_key=None, models=None: seen.update(models=models))
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(subagents, "ask_llm",
                        lambda messages, temperature=0.3: '{"type":"final_answer","content":"done"}')
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 5})
    monkeypatch.setattr(llm, "take_last_model", lambda: "flash")
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "task", tier="cheap")
    assert out["ok"] is True
    assert seen["models"][0] == "flash"
    assert out["model"] == "flash"


def test_run_subagent_emits_tier_and_model_telemetry(monkeypatch):
    _patch_ladder(monkeypatch)
    events = []
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(subagents, "ask_llm",
                        lambda messages, temperature=0.3: '{"type":"final_answer","content":"x"}')
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: "flash")
    subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "task",
                           tier="cheap", on_event=events.append)
    started = next(e for e in events if e["type"] == "subagent_started")
    done = next(e for e in events if e["type"] == "subagent_done")
    assert started["tier"] == "cheap" and started["model"] == "flash"
    assert done["model"] == "flash"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagent_routing.py -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'tier'`

- [ ] **Step 3: Write minimal implementation**

**4a.** In `subagents.py`, extend `AgentDef.__init__` (line 196) — add the two params and assignments, and extend the class docstring's `Fields:` line to mention them:

```python
    def __init__(self, name, system_prompt, mode="read", description="",
                 toolsets=None, allowed_tools=None, temperature=None,
                 max_steps=DEFAULT_MAX_STEPS, allow_optin_read=False,
                 include_contract=True, tier=None, models=None):
```

and inside the body, after `self.include_contract = include_contract`:

```python
        # Cost routing defaults for THIS persona. `tier` names a rung band on the
        # global cost spine (llm.model_ladder); `models` pins an explicit ladder.
        # Both are overridable per dispatch — see resolve_model_ladder.
        self.tier = (tier or "").strip().lower() or None
        self.models = list(models) if models else None
```

**4b.** Add after `resolve_allowed_tools` (after line 250):

```python
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
    note = ""
    for candidate in (models, agent_def.models):
        if not candidate:
            continue
        picked = [m for m in candidate if m in known]
        dropped = [m for m in candidate if m not in known]
        if dropped:
            note = "unknown model(s) ignored: " + ", ".join(dropped)
        if picked:
            rest = [e["model"] for e in spine if e["model"] not in picked]
            return picked + rest, note
        break   # every id was bogus -> fall through to the tier paths
    for t in (tier, agent_def.tier, llm.DEFAULT_SUBAGENT_TIER):
        if t:
            return llm.models_for_tier(t, spine), note
    return None, note


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
```

**4c.** `_new_result` (line 319) — add the two keys:

```python
def _new_result(agent_def):
    return {"agent": agent_def.name, "ok": False, "report": "", "raw_report": None,
            "artifacts": [], "verified": None, "steps": 0, "tools_used": [], "note": "",
            "tokens": 0, "model": None, "escalated": False}
```

**4d.** `run_subagent` (line 366) — new signature and wiring. Change the `def` line to:

```python
def run_subagent(agent_def, task, context="", run_dir=None, on_event=None,
                 tier=None, models=None):
```

In the setup `try` block, after `messages = _build_messages(...)` (line 391) add:

```python
        ladder, ladder_note = resolve_model_ladder(agent_def, tier, models)
        if ladder_note:
            result["note"] = ladder_note
        eff_tier = (tier or agent_def.tier or llm.DEFAULT_SUBAGENT_TIER)
```

Replace the `key = ...` / `set_subagent_context` / `_emit_event` block (lines 401-405) with:

```python
        key = _KEY_ALLOCATOR.acquire(llm.active_key_pool())
        llm.set_subagent_context(pinned_key=key, models=ladder)
        _emit_event(on_event, {"type": "subagent_started", "agent": agent_def.name,
                               "task": task[:160], "key_label": _mask(key), "mode": agent_def.mode,
                               "sub_id": sub_id, "tier": eff_tier,
                               "model": (ladder[0] if ladder else None)})
```

Pass the ladder and key into the loop — replace the `out = _run_loop(...)` call (lines 409-411):

```python
        out = _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
                        on_event=on_event, agent_name=agent_def.name, max_steps_total=max_steps,
                        started=started, key_label=_mask(key), sub_id=sub_id,
                        ladder=ladder, key=key)
```

And extend the `subagent_done` event (line 421) with the served model:

```python
    _emit_event(on_event, {"type": "subagent_done", "agent": agent_def.name,
                           "ok": bool(out.get("ok")), "tokens": out.get("tokens", 0),
                           "steps": out.get("steps", 0),
                           "elapsed_s": round(time.monotonic() - started, 1),
                           "key_label": _mask(key), "sub_id": sub_id,
                           "model": out.get("model"), "escalated": out.get("escalated", False)})
```

**4e.** `_run_loop` (line 429) — accept the new params and record the served model. Change the signature to:

```python
def _run_loop(agent_def, messages, allowed, temperature, max_steps, result,
              on_event=None, agent_name="", max_steps_total=None, started=None, key_label="",
              sub_id="", ladder=None, key=None):
```

Add `escalated = False` beside the other counters (after `tokens = 0`, line 437), and immediately after the `u = llm.take_last_usage()` line (442) add:

```python
        served = llm.take_last_model()
        if served:
            result["model"] = served
```

**4f.** `_normalize_spec` (line 501) — return a 5-tuple:

```python
def _normalize_spec(spec):
    """Accept (agent_def, task), (agent_def, task, context), or a dict with
    {agent_def, task, context?, tier?, models?}. Returns a 5-tuple
    (agent_def, task, context, tier, models)."""
    if isinstance(spec, dict):
        return (spec["agent_def"], spec.get("task", ""), spec.get("context", ""),
                spec.get("tier"), spec.get("models"))
    if len(spec) == 2:
        return spec[0], spec[1], "", None, None
    return spec[0], spec[1], spec[2], None, None
```

**4g.** `run_subagents_parallel` (line 510) — unpack 5-tuples and forward routing. Replace the body's unpacking and both dispatch sites:

```python
    norm = [_normalize_spec(s) for s in specs]
    results = [None] * len(norm)
    read_idx = [i for i, n in enumerate(norm) if not n[0].is_write]
    write_idx = [i for i, n in enumerate(norm) if n[0].is_write]
```

the read submit (line 534):

```python
                futs = {ex.submit(run_subagent, norm[i][0], norm[i][1], norm[i][2],
                                  run_dir, on_event, norm[i][3], norm[i][4]): i
                        for i in read_idx}
```

and the write loop (line 546):

```python
        for i in write_idx:  # sequential; each write subagent takes the workspace lock
            results[i] = run_subagent(norm[i][0], norm[i][1], norm[i][2], run_dir,
                                      on_event, norm[i][3], norm[i][4])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_subagent_routing.py tests/test_subagents.py tests/test_subagents_waves.py tests/test_subagents_subid.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add subagents.py tests/test_subagent_routing.py
git commit -m "feat(subagents): per-subagent model ladder resolution and wiring"
```

---

## Task 5: Parse-error escalation valve

**Files:**
- Modify: `subagents.py:453-462` (the `rtype == "error"` branch in `_run_loop`)
- Test: `tests/test_subagent_routing.py`

**Interfaces:**
- Consumes: `subagents.escalate_ladder` (Task 4), `_run_loop(..., ladder=, key=)` (Task 4).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_subagent_routing.py`:

```python
def _replies(monkeypatch, seq):
    """Feed ask_llm a fixed sequence of raw replies."""
    it = iter(seq)
    monkeypatch.setattr(subagents, "ask_llm", lambda messages, temperature=0.3: next(it))


def test_escalates_once_after_two_parse_errors(monkeypatch):
    _patch_ladder(monkeypatch)
    pins = []
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context",
                        lambda pinned_key=None, models=None: pins.append(models))
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["garbage", "still garbage",
                           '{"type":"final_answer","content":"ok now"}'])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="cheap")
    assert out["ok"] is True
    assert out["escalated"] is True
    assert pins[0][0] == "flash"      # started cheap
    assert pins[1][0] == "glm"        # escalated exactly one rung up
    assert "glm" in out["note"]


def test_no_escalation_when_already_top_rung(monkeypatch):
    _patch_ladder(monkeypatch)
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["garbage", "garbage",
                           '{"type":"final_answer","content":"ok"}'])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="premium")
    assert out["escalated"] is False


def test_three_parse_errors_still_salvage(monkeypatch):
    """The escalation must not consume the 3-error salvage backstop."""
    _patch_ladder(monkeypatch)
    monkeypatch.setattr(llm, "active_key_pool", lambda: ["k1"])
    monkeypatch.setattr(llm, "set_subagent_context", lambda pinned_key=None, models=None: None)
    monkeypatch.setattr(llm, "clear_subagent_context", lambda: None)
    monkeypatch.setattr(llm, "take_last_usage", lambda: {"total": 1})
    monkeypatch.setattr(llm, "take_last_model", lambda: None)
    _replies(monkeypatch, ["bad one", "bad two", "bad three"])
    out = subagents.run_subagent(AgentDef("a", "p", allowed_tools=set()), "t", tier="premium")
    assert out["ok"] is True
    assert "salvaged" in out["note"]


def test_escalate_ladder_helper(monkeypatch):
    _patch_ladder(monkeypatch)
    assert subagents.escalate_ladder(["flash", "kimi"]) == ["glm", "flash", "kimi"]
    assert subagents.escalate_ladder(["kimi", "glm"]) is None
    assert subagents.escalate_ladder(["ghost"]) is None
    assert subagents.escalate_ladder([]) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_subagent_routing.py -k escalat -v`
Expected: FAIL — `assert False is True` on `out["escalated"]`

- [ ] **Step 3: Write minimal implementation**

In `subagents.py` `_run_loop`, replace the `if rtype == "error":` branch (lines 453-462) with:

```python
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
                salvage = strip_reasoning(raw)
                note = "; ".join(p for p in (result.get("note"),
                                             "salvaged from non-JSON output") if p)
                result.update(ok=True, report=salvage, raw_report=salvage, steps=steps,
                              tools_used=tools_used, note=note, tokens=tokens)
                return result
            messages.append({"role": "user", "content": _JSON_NUDGE})
            continue
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_subagent_routing.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add subagents.py tests/test_subagent_routing.py
git commit -m "feat(subagents): escalate one rung after repeated protocol errors"
```

---

## Task 6: `dispatch_agents` accepts `tier` / `models`

**Files:**
- Modify: `tools/delegation_tools.py:77-130`
- Test: `tests/test_delegation.py` (append)

**Interfaces:**
- Consumes: `subagents.run_subagents_parallel` 5-tuple/dict specs (Task 4); `llm.model_ladder` (Task 2).
- Produces: `dispatch_agents` spec objects accept `tier` (string) and `models` (array of ids).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_delegation.py`:

```python
import llm
import subagents as _subagents
from tools import delegation_tools


def test_dispatch_agents_forwards_tier_and_models(monkeypatch):
    captured = {}

    def fake_wave(specs, pool_size=None, run_dir=None, on_event=None):
        captured["specs"] = specs
        return [{"agent": "researcher", "ok": True, "report": "r", "steps": 1}
                for _ in specs]

    monkeypatch.setattr(delegation_tools, "run_subagents_parallel", fake_wave)
    ad = _subagents.AgentDef("researcher", "p", mode="read")
    monkeypatch.setattr(delegation_tools.plugins, "get_registry",
                        lambda: type("R", (), {"get_agent": staticmethod(lambda n: ad)})())
    out = delegation_tools.dispatch_agents([
        {"agent": "researcher", "task": "t1", "tier": "cheap"},
        {"agent": "researcher", "task": "t2", "models": ["glm"]},
    ])
    assert "error" not in out
    assert captured["specs"][0]["tier"] == "cheap"
    assert captured["specs"][1]["models"] == ["glm"]


def test_ladder_hint_lists_configured_models(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [
        {"rung": 0, "id": "c", "label": "L", "model": "kimi",
         "tier": "premium", "tagged": True},
        {"rung": 1, "id": "c", "label": "L", "model": "flash",
         "tier": "cheap", "tagged": False}])
    hint = delegation_tools._ladder_hint()
    assert "kimi" in hint and "premium" in hint
    assert "flash" in hint and "cheap" in hint


def test_ladder_hint_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [])
    assert delegation_tools._ladder_hint() == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delegation.py -k "tier or ladder_hint" -v`
Expected: FAIL — `AttributeError: module 'tools.delegation_tools' has no attribute '_ladder_hint'`

- [ ] **Step 3: Write minimal implementation**

In `tools/delegation_tools.py`, add `import llm` beside the existing imports, and add after `_REPORT_CAP` (line 26):

```python
def _ladder_hint():
    """One-line-per-model rendering of the LIVE cost spine, folded into the tool
    description so the model always sees the models actually configured right now
    — adding a provider never requires touching this file or the prompt."""
    lad = llm.model_ladder()
    if not lad:
        return ""
    rows = " | ".join(f"{e['model']} ({e['tier']})" for e in lad)
    return " CONFIGURED MODELS, most expensive first: " + rows + "."
```

Extend the `params_schema` `specs` entry and add the routing guidance to the description. Replace the `description=(...)` and `params_schema={...}` blocks (lines 79-92) with:

```python
    description=(
        "Run a WAVE of read-only subagents IN PARALLEL, each in its own isolated context, and get back only "
        "their distilled reports — the dozens of reads/queries they make never touch your context. Use it to "
        "chase several INDEPENDENT questions at once (e.g. 'locate the root check', 'locate the signature "
        "check', 'map the license flow'). Name each subagent from AVAILABLE SUBAGENTS. Each spec may pick its "
        "own MODEL: 'tier' (cheap/standard/premium) or an explicit 'models' fallback order. Match the model to "
        "the job — a symbol lookup does NOT need your most expensive model." + _ladder_hint() +
        " Read-only by design: for an actual code change, tag a plan step with delegate=<write-agent> instead. "
        "This is the ad-hoc fan-out path; a planned, self-contained step should use the plan's delegate field."
    ),
    params_schema={
        "specs": ("array of objects, each {\"agent\": \"<subagent name>\", \"task\": \"<what to investigate>\", "
                  "\"context\": \"<optional focusing hints>\", \"tier\": \"<optional cheap|standard|premium>\", "
                  "\"models\": [\"<optional explicit model ids, best first>\"]} — the read-only subagents to "
                  "run in parallel. Omit tier/models to use the subagent's own default."),
        "synthesize": ("boolean (optional, default false) — if true, a synthesizer subagent distills all the "
                       "reports into ONE merged summary, keeping your context smallest."),
    },
```

Then in the body, replace the `runnable.append(...)` line (124) with:

```python
        runnable.append({"agent_def": ad, "task": task, "context": spec.get("context", ""),
                         "tier": spec.get("tier"), "models": spec.get("models")})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_delegation.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/delegation_tools.py tests/test_delegation.py
git commit -m "feat(delegation): per-spec tier/models routing in dispatch_agents"
```

---

## Task 7: Persona defaults — frontmatter and the subagents prompt

**Files:**
- Modify: `plugins.py:66-81` (`_load_agent_md`), `plugins.py:236-250` (`get_agents_prompt`)
- Modify: `plugins/omni-agents/agents/{researcher,implementer,native-analyst}.md`, `plugins/planning-superpowers/agents/{architect,brainstormer}.md`, `plugins/verification/agents/verifier.md`
- Test: `tests/test_delegation.py` (append)

**Interfaces:**
- Consumes: `AgentDef(tier=, models=)` (Task 4), `llm.model_ladder` (Task 2).
- Produces: agent `.md` frontmatter keys `tier:` and `models:` (comma-separated).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_delegation.py`:

```python
import plugins


def test_agent_md_parses_tier_and_models(tmp_path):
    p = tmp_path / "x.md"
    p.write_text("---\nname: x\nmode: read\ntier: cheap\n"
                 "models: a, b\n---\nbody\n", encoding="utf-8")
    ad = plugins._load_agent_md(str(p))
    assert ad.tier == "cheap"
    assert ad.models == ["a", "b"]


def test_agent_md_without_tier_defaults_to_none(tmp_path):
    p = tmp_path / "y.md"
    p.write_text("---\nname: y\nmode: read\n---\nbody\n", encoding="utf-8")
    ad = plugins._load_agent_md(str(p))
    assert ad.tier is None and ad.models is None


def test_agents_prompt_shows_tier_and_ladder(monkeypatch):
    monkeypatch.setattr(llm, "model_ladder", lambda: [
        {"rung": 0, "id": "c", "label": "L", "model": "kimi",
         "tier": "premium", "tagged": False},
        {"rung": 1, "id": "c", "label": "L", "model": "flash",
         "tier": "cheap", "tagged": False}])
    reg = plugins.PluginRegistry()
    reg.agents = {"r": _subagents.AgentDef("r", "p", mode="read",
                                           description="d", tier="cheap")}
    text = reg.get_agents_prompt()
    assert "tier: cheap" in text
    assert "MODEL LADDER" in text
    assert "kimi" in text and "flash" in text


def test_researcher_persona_defaults_to_cheap():
    reg = plugins.get_registry()
    ad = reg.get_agent("researcher")
    assert ad is not None and ad.tier == "cheap"
```

(`PluginRegistry` is the class declared at `plugins.py:208` — verified.)

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delegation.py -k "tier or ladder" -v`
Expected: FAIL — `AssertionError: assert None == 'cheap'`

- [ ] **Step 3: Write minimal implementation**

**7a.** In `plugins.py`, add `import llm` after `import os` (line 26). This direction is safe: `llm` imports `plugins` only *lazily*, inside a function (`llm.py:287-289`), precisely to avoid the `plugins -> subagents -> llm` cycle — a top-level `import llm` here does not close it.

Then extend `_load_agent_md`'s `AgentDef(...)` call (line 72) with two more kwargs:

```python
        allow_optin_read=_as_bool(meta.get("allow_optin_read")),
        tier=meta.get("tier"),
        models=_as_list(meta.get("models", "")) or None,
    )
```

**7b.** Replace `get_agents_prompt` (lines 236-250) with:

```python
    def get_agents_prompt(self):
        """System-prompt segment describing the delegatable subagents, so the
        planner can target them with a plan step's `delegate` field (Phase 4).
        Each agent shows its DEFAULT cost tier, and the live model ladder is
        appended so the model can pick a cheaper rung per dispatch without any
        hardcoded model names in this file."""
        if not self.agents:
            return ""
        lines = ["\nAVAILABLE SUBAGENTS (delegation targets)",
                 ("Delegate a bounded sub-task to one of these by tagging a plan step with "
                  "delegate=\"<name>\" (or delegate=\"<name>@<tier>\" to pick the model tier; or via "
                  "dispatch_agents for a parallel wave). Each runs in its OWN isolated context and returns "
                  "only a distilled report — keeping this conversation lean. READ agents can run in "
                  "parallel; WRITE agents run one at a time.\n")]
        for a in self.list_agents():
            ts = f" [toolsets: {', '.join(sorted(a.toolsets))}]" if a.toolsets else ""
            tier = f" [tier: {a.tier}]" if getattr(a, "tier", None) else ""
            lines.append(f"- {a.name} ({a.mode}){ts}{tier}: {a.description}")
        ladder = llm.model_ladder()
        if ladder:
            lines.append("\nMODEL LADDER (cost spine — most expensive first). Pick the CHEAPEST rung "
                         "that can actually do the job:")
            for e in ladder:
                lines.append(f"  {e['rung']}. {e['model']} — tier: {e['tier']}")
        lines.append("END OF SUBAGENTS.\n")
        return "\n".join(lines)
```

**7c.** Add a `tier:` line to each agent's frontmatter. In
`plugins/omni-agents/agents/researcher.md`, the frontmatter becomes:

```yaml
---
name: researcher
description: General read-only investigator — answers a focused "how/where/why does X work" question about the workspace with file:line evidence. Runs in parallel.
mode: read
max_steps: 16
tier: cheap
---
```

Apply the same one-line addition to the others, using these values:

| file | line to add |
|---|---|
| `plugins/omni-agents/agents/implementer.md` | `tier: standard` |
| `plugins/omni-agents/agents/native-analyst.md` | `tier: standard` |
| `plugins/planning-superpowers/agents/architect.md` | `tier: premium` |
| `plugins/planning-superpowers/agents/brainstormer.md` | `tier: premium` |
| `plugins/verification/agents/verifier.md` | `tier: premium` |

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_delegation.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins.py plugins/*/agents/*.md tests/test_delegation.py
git commit -m "feat(plugins): per-persona default tiers and a live ladder in the subagents prompt"
```

---

## Task 8: `delegate="agent@tier"` on plan steps

**Files:**
- Modify: `agent.py:1423-1487` (`_maybe_dispatch_delegated_steps`), `agent.py:1493-1547` (`_run_delegated_read_wave`), add `_split_delegate` near `_best_path_arg` (agent.py:432)
- Modify: `tools/plan_tools.py:99`, `:139` (the two `delegate` param descriptions)
- Test: `tests/test_agent_delegation_wave.py` (append)

**Interfaces:**
- Consumes: `run_subagent(..., tier=)` and dict specs (Task 4).
- Produces: `agent._split_delegate(raw) -> (name: str, tier: str | None)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_agent_delegation_wave.py`:

```python
import agent as agent_mod


def test_split_delegate_parses_tier():
    assert agent_mod._split_delegate("researcher@cheap") == ("researcher", "cheap")
    assert agent_mod._split_delegate("  researcher @ CHEAP ") == ("researcher", "cheap")
    assert agent_mod._split_delegate("researcher") == ("researcher", None)
    assert agent_mod._split_delegate("researcher@") == ("researcher", None)
    assert agent_mod._split_delegate("") == ("", None)
    assert agent_mod._split_delegate(None) == ("", None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_agent_delegation_wave.py -k split_delegate -v`
Expected: FAIL — `AttributeError: module 'agent' has no attribute '_split_delegate'`

- [ ] **Step 3: Write minimal implementation**

**8a.** In `agent.py`, add above `_best_path_arg` (before line 432):

```python
def _split_delegate(raw):
    """Split a plan step's delegate tag into (agent_name, tier).

    'researcher@cheap' -> ('researcher', 'cheap'); a bare 'researcher' ->
    ('researcher', None), meaning the persona's own default tier applies. The
    tier rides inside the existing string field so no new plan-step column has
    to be threaded through planning.py and plan_tools.py."""
    name, _, tier = (raw or "").strip().partition("@")
    return name.strip(), (tier.strip().lower() or None)
```

**8b.** In `_maybe_dispatch_delegated_steps`, change `_resolve` to return the tier too:

```python
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
```

Update its caller (line 1455) to carry the tier through both lists:

```python
            for step in candidates:
                ad, tier = _resolve(step)
                if ad is None:
                    continue
                dispatched.add(step["id"])
                if parallel and step.get("status") != "in_progress":
                    # Harness-initiated start of a pulled-forward step: mark it live so
                    # the plan/UI reflect it, exactly like a model-started step.
                    plan.update_item(step["id"], status="in_progress")
                (writes if ad.is_write else reads).append((step, ad.name, ad, tier))
```

Update the read-wave failure fallback (line 1470):

```python
                    for step, _name, _ad, _tier in reads:
```

and the write loop (line 1475):

```python
            for step, name, ad, tier in writes:
                try:
                    task = self._compose_delegate_task(step)
                    context = self._compose_delegate_context(plan)
                    self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                                "content": f"Delegating step ({step['id']}) to subagent '{name}' ({ad.mode})…"})
                    result = subagents.run_subagent(ad, task, context=context,
                                                    run_dir=getattr(self, "_delegate_run_dir", None),
                                                    tier=tier)
                    self._fold_delegate_result(plan, step, name, ad, result)
```

**8c.** In `_run_delegated_read_wave`, build dict specs and unpack 4-tuples — replace lines 1506-1510:

```python
        specs = [{"agent_def": ad, "task": self._compose_delegate_task(step),
                  "context": self._compose_delegate_context(plan), "tier": tier}
                 for (step, _name, ad, tier) in reads]
        for step, name, ad, _tier in reads:
            self._emit({"type": "delegate_running", "agent": name, "mode": ad.mode,
                        "content": f"Delegating step ({step['id']}) to subagent '{name}' (read) in a parallel wave…"})
```

and the two remaining unpack sites (lines 1538 and 1546):

```python
            for step, name, ad, _tier in reads:
```

```python
        for (step, name, ad, _tier), result in zip(reads, results):
```

**8d.** In `tools/plan_tools.py`, extend the two `delegate` descriptions. Append this sentence to the string at line 99 and again at line 139:

```
 Append '@<tier>' to pick the model tier for this step (e.g. delegate="researcher@cheap" for a lookup, "implementer@standard", "verifier@premium"); a bare name uses the subagent's own default tier.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_agent_delegation_wave.py tests/test_strategy_delegate_slice.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent.py tools/plan_tools.py tests/test_agent_delegation_wave.py
git commit -m "feat(agent): delegate=\"agent@tier\" routes a plan step's subagent model"
```

---

## Task 9: The delegate-by-default prompt doctrine

**Files:**
- Modify: `llm.py:216-217` and `llm.py:232-236` (inside `get_static_system_prompt`)
- Test: `tests/test_model_ladder.py` (append)

**Interfaces:**
- Consumes: nothing. Pure prompt text.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_model_ladder.py`:

```python
def test_prompt_contains_delegation_doctrine():
    p = llm.get_static_system_prompt()
    assert "DELEGATE BY DEFAULT" in p
    assert "dispatch_agents" in p
    assert "@cheap" in p


def test_prompt_keeps_parallel_wave_rule():
    p = llm.get_static_system_prompt()
    assert "parallel wave" in p.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_model_ladder.py -k prompt -v`
Expected: FAIL — `assert 'DELEGATE BY DEFAULT' in p`

- [ ] **Step 3: Write minimal implementation**

In `llm.py`, replace lines 216-217 (the two `- Independent RESEARCH steps…` lines) with:

```python
- Independent RESEARCH steps tagged delegate=<read-agent> may be marked in_progress TOGETHER — they run as one
  parallel wave. Dependent steps and delegate=<write-agent> steps must be started one at a time.

DELEGATE BY DEFAULT — subagents are your main lever on both context and speed:
- DEFAULT POSTURE: if a sub-task is self-contained and you only need its CONCLUSION (not the twenty reads it took
  to get there), delegate it. A subagent works in its own private context and hands back one distilled report, so
  delegating costs you almost NO context — the reads, greps and decompiles never enter this conversation.
- HARD RULE: 2+ INDEPENDENT questions is ALWAYS one dispatch_agents wave, never a sequence of inline reads. They
  run CONCURRENTLY, so three delegated lookups take about as long as one. Doing them yourself, one at a time, is
  strictly slower AND strictly more expensive in context. Not fanning out a fan-out-able investigation is a
  mistake, not a neutral style choice.
- WHAT STAYS YOURS: the judgment calls — deciding what the findings mean, choosing between approaches, the final
  answer. Delegate the LEGWORK, keep the thinking.
- MATCH THE MODEL TO THE JOB (you pay per token — the ladder is listed under AVAILABLE SUBAGENTS, most expensive
  first): a symbol/where-is lookup or a grep-and-summarize is tier="cheap"; real analysis or a bounded change is
  "standard"; an architectural judgment or a final verification is "premium". Never spend your most expensive
  model on a lookup. In a plan step write delegate="researcher@cheap"; in dispatch_agents pass "tier":"cheap"
  (or "models":[...] to pin an exact fallback order).
- EXAMPLE — three unknowns at once, in ONE call:
  {"type":"tool_call","tool":"dispatch_agents","args":{"specs":[
    {"agent":"researcher","tier":"cheap","task":"locate the root check and cite file:line"},
    {"agent":"researcher","tier":"cheap","task":"locate the signature check and cite file:line"},
    {"agent":"native-analyst","tier":"standard","task":"map which .so loads those checks"}]}}
```

Then replace the PARALLELISM bullet at lines 232-236 with:

```python
- PARALLELISM: steps in the SAME phase run CONCURRENTLY by default — starting one delegated step fans out every
  independent delegated step in that phase at once. So GROUP independent research/probes into one phase, TAG each
  with delegate="<agent>@<tier>", and they all run in parallel; when a step truly needs another's result, either
  set its `depends_on` to that step's id (same phase) or put it in a LATER phase. Writes to the shared workspace
  are always serialized for you. Prefer the smallest action that reduces uncertainty; avoid over-planning and
  inventing unconfirmed details.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_model_ladder.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add llm.py tests/test_model_ladder.py
git commit -m "feat(prompt): delegate-by-default doctrine with cost-aware tier routing"
```

---

## Task 10: Solo-read streak nudge

**Files:**
- Modify: `agent.py` — constant near line 385, import at line 421, session keys at ~2219, resets at ~2372 and ~2421, new method near `_code_graph_guard` (line 3099), call site after line 3399, reset in `_fold_delegate_result`
- Test: `tests/test_delegation_nudges.py` (create)

**Interfaces:**
- Consumes: `tool_policy.is_readonly_tool`.
- Produces: `agent.SOLO_READ_NUDGE: int`, `agent.DELEGATION_TOOLS: set[str]`.
- Produces: `AgentApi._maybe_nudge_delegation(s, tool_name) -> None`.
- Produces: session keys `solo_read_streak: int`, `_solo_read_nudged: bool`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_delegation_nudges.py`:

```python
import agent as agent_mod


class _Stub:
    """Minimal stand-in exposing only what the nudge methods touch."""
    _maybe_nudge_delegation = agent_mod.AgentApi._maybe_nudge_delegation


def _sess():
    return {"messages": [], "solo_read_streak": 0, "_solo_read_nudged": False}


def _sys_msgs(s):
    return [m for m in s["messages"] if m["content"].startswith("[SYSTEM]")]


def test_streak_nudge_fires_at_threshold():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    msgs = _sys_msgs(s)
    assert len(msgs) == 1
    assert "dispatch_agents" in msgs[0]["content"]


def test_streak_nudge_fires_only_once_per_streak():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE * 3):
        a._maybe_nudge_delegation(s, "grep_directory")
    assert len(_sys_msgs(s)) == 1


def test_delegation_resets_the_streak_and_rearms():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    assert len(_sys_msgs(s)) == 1
    a._maybe_nudge_delegation(s, "dispatch_agents")
    assert s["solo_read_streak"] == 0
    for _ in range(agent_mod.SOLO_READ_NUDGE):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    assert len(_sys_msgs(s)) == 2


def test_non_readonly_tools_do_not_advance_the_streak():
    s, a = _sess(), _Stub()
    for _ in range(agent_mod.SOLO_READ_NUDGE * 2):
        a._maybe_nudge_delegation(s, "write_file")
    assert s["solo_read_streak"] == 0
    assert _sys_msgs(s) == []


def test_zero_threshold_disables_the_nudge(monkeypatch):
    monkeypatch.setattr(agent_mod, "SOLO_READ_NUDGE", 0)
    s, a = _sess(), _Stub()
    for _ in range(20):
        a._maybe_nudge_delegation(s, "read_file_chunk")
    assert _sys_msgs(s) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delegation_nudges.py -v`
Expected: FAIL — `AttributeError: type object 'AgentApi' has no attribute '_maybe_nudge_delegation'`

- [ ] **Step 3: Write minimal implementation**

**10a.** In `agent.py`, add after `EXPLANATION_CADENCE_NUDGE = 6` (line 385):

```python
# Read-only tool calls the ORCHESTRATOR may run inline before it's reminded that
# those are exactly what a parallel subagent wave does for ~0 context. Bounded and
# self-re-arming (see _maybe_nudge_delegation); 0 disables the nudge entirely.
try:
    SOLO_READ_NUDGE = max(0, int(os.environ.get("OMNI_SOLO_READ_NUDGE", "8")))
except ValueError:
    SOLO_READ_NUDGE = 8

# Tools that MEAN the model delegated — they reset the solo-read streak.
DELEGATION_TOOLS = {"dispatch_agents", "ask_codebase"}
```

**10b.** Extend the `tool_policy` import (line 421):

```python
from tool_policy import (
    MUTATING_TOOLS, VALIDATION_TOOLS,
    NATIVE_SPECULATION_TOOLS, OBSERVE_RUN_TOOLS,
    is_readonly_tool,
)
```

**10c.** Add the session keys after `"assumption_nudges_sent": 0,` (line 2231):

```python
            # --- delegation nudges (bounded; see _maybe_nudge_delegation) ---
            "solo_read_streak": 0,              # consecutive inline read-only calls
            "_solo_read_nudged": False,         # streak nudge already fired this streak
            "_delegation_phase_nudged": set(),  # phase ids already nudged (Task 11)
```

**10d.** Add to BOTH reset blocks — after `s["assumption_nudges_sent"] = 0` (~line 2372):

```python
        s["solo_read_streak"] = 0
        s["_solo_read_nudged"] = False
        s["_delegation_phase_nudged"] = set()
```

and after `self.session["assumption_nudges_sent"] = 0` (~line 2421):

```python
        self.session["solo_read_streak"] = 0
        self.session["_solo_read_nudged"] = False
        self.session["_delegation_phase_nudged"] = set()
```

**10e.** Add the method immediately before `_code_graph_guard` (line 3099):

```python
    def _maybe_nudge_delegation(self, s, tool_name):
        """Delegation nudge #1 — the SOLO-READ STREAK.

        Read-only calls the orchestrator runs inline are precisely the work a
        parallel subagent wave does for ~0 main context, so a long streak of them
        is the delegation opportunity the model is most likely to miss. Any real
        delegation resets the streak and re-arms the nudge; it fires at most ONCE
        per streak so it informs instead of nagging. SOLO_READ_NUDGE=0 disables it."""
        if not SOLO_READ_NUDGE:
            return
        if tool_name in DELEGATION_TOOLS:
            s["solo_read_streak"] = 0
            s["_solo_read_nudged"] = False
            return
        if not is_readonly_tool(tool_name):
            return
        s["solo_read_streak"] = s.get("solo_read_streak", 0) + 1
        if s["solo_read_streak"] < SOLO_READ_NUDGE or s.get("_solo_read_nudged"):
            return
        s["_solo_read_nudged"] = True
        s["messages"].append({"role": "user", "content": (
            f"[SYSTEM] That's {s['solo_read_streak']} read-only tool calls in a row in your OWN "
            "context. Independent look-ups like these are exactly what a parallel subagent wave "
            "does for almost no context cost to you — and they run concurrently, so a batch of "
            "them takes about as long as one. Group the next batch into ONE dispatch_agents call "
            "(tier=\"cheap\" for symbol/where-is lookups, \"standard\" for real analysis), or tag "
            "the corresponding plan steps delegate=\"researcher@cheap\". Keep only the work that "
            "genuinely needs your own judgment inline."
        )})
```

**10f.** Add the call site after the explanation-cadence block, immediately before
`self._plan_bookkeeping_after_tool(...)` (line 3403):

```python
        # Delegation nudges: a long inline read streak is a subagent wave not taken.
        self._maybe_nudge_delegation(s, tool_name)

```

**10g.** In `_fold_delegate_result`, reset the streak so a delegated step counts as
delegation. Add near the top of the method body (after line 1583's docstring):

```python
        self.session["solo_read_streak"] = 0
        self.session["_solo_read_nudged"] = False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_delegation_nudges.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add agent.py tests/test_delegation_nudges.py
git commit -m "feat(agent): nudge toward a subagent wave after a long inline read streak"
```

---

## Task 11: Plan-shape delegation nudge

**Files:**
- Modify: `agent.py` — `_looks_like_research` helper near `_split_delegate` (line 432), method beside `_maybe_nudge_delegation`, call site in `_plan_bookkeeping_after_tool` (line 3076)
- Test: `tests/test_delegation_nudges.py` (append)

**Interfaces:**
- Consumes: `planning.get_active_plan`, `planning.DONE_STATUSES`, session key `_delegation_phase_nudged` (Task 10).
- Produces: `agent._looks_like_research(item) -> bool`.
- Produces: `AgentApi._maybe_nudge_plan_delegation(s) -> None`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_delegation_nudges.py`:

```python
import planning


class _PlanStub:
    def __init__(self, items, phase="p1"):
        self.items = items
        self.current_phase_id = phase


def _step(sid, content, delegate="", status="pending", deps=None):
    return {"id": sid, "content": content, "delegate": delegate,
            "status": status, "phase_id": "p1", "depends_on": deps or []}


class _Stub2:
    _maybe_nudge_plan_delegation = agent_mod.AgentApi._maybe_nudge_plan_delegation


def _sess2():
    return {"messages": [], "_delegation_phase_nudged": set()}


def test_looks_like_research_accepts_investigation():
    assert agent_mod._looks_like_research(_step(1, "locate the root check"))
    assert agent_mod._looks_like_research(_step(2, "map the license flow"))


def test_looks_like_research_rejects_changes():
    assert not agent_mod._looks_like_research(_step(3, "patch the root check"))
    assert not agent_mod._looks_like_research(_step(4, "rebuild and sign the apk"))


def test_plan_nudge_fires_for_two_untagged_research_steps(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    msgs = _sys_msgs(s)
    assert len(msgs) == 1
    assert "researcher@cheap" in msgs[0]["content"]
    assert "1, 2" in msgs[0]["content"]


def test_plan_nudge_fires_once_per_phase(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    a._maybe_nudge_plan_delegation(s)
    assert len(_sys_msgs(s)) == 1


def test_plan_nudge_ignores_already_tagged_steps(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check", delegate="researcher"),
                      _step(2, "locate the signature check", delegate="researcher")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_ignores_dependent_steps(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "locate the signature check", deps=[1])])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_needs_two_candidates(monkeypatch):
    plan = _PlanStub([_step(1, "locate the root check"),
                      _step(2, "patch the root check")])
    monkeypatch.setattr(planning, "get_active_plan", lambda: plan)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []


def test_plan_nudge_no_plan_is_safe(monkeypatch):
    monkeypatch.setattr(planning, "get_active_plan", lambda: None)
    s, a = _sess2(), _Stub2()
    a._maybe_nudge_plan_delegation(s)
    assert _sys_msgs(s) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delegation_nudges.py -k plan_nudge -v`
Expected: FAIL — `AttributeError: module 'agent' has no attribute '_looks_like_research'`

- [ ] **Step 3: Write minimal implementation**

**11a.** In `agent.py`, add below `_split_delegate` (Task 8a):

```python
# Wording that reads as INVESTIGATION (a read-only subagent could own it end to
# end) vs. wording that reads as a CHANGE. Used only to decide whether to NUDGE —
# never to auto-delegate, so a false positive costs one advisory line, nothing more.
_RESEARCH_HINTS = ("find", "locate", "identify", "investigate", "research", "map ",
                   "search", "inspect", "analyze", "analyse", "where", "which",
                   "how does", "determine", "audit", "survey", "trace", "enumerate")
_CHANGE_HINTS = ("patch", "edit", "rebuild", "build", "sign", "install", "write",
                 "modify", "implement", "fix ", "remove", "replace")


def _looks_like_research(item):
    """True when a plan step reads as an investigation rather than a change."""
    text = " ".join(str(item.get(k) or "")
                    for k in ("content", "action", "purpose")).lower()
    if any(w in text for w in _CHANGE_HINTS):
        return False
    return any(h in text for h in _RESEARCH_HINTS)
```

**11b.** Add the method directly after `_maybe_nudge_delegation`:

```python
    def _maybe_nudge_plan_delegation(self, s):
        """Delegation nudge #2 — PLAN SHAPE.

        A phase holding 2+ independent, still-pending, research-flavored steps
        with no `delegate` is a parallel wave the model left on the table. Name
        the exact step ids and the exact tag to add. Fires at most ONCE per phase,
        and never auto-delegates — tagging stays the model's decision."""
        plan = planning.get_active_plan()
        if plan is None or not getattr(plan, "current_phase_id", None):
            return
        nudged = s.setdefault("_delegation_phase_nudged", set())
        if plan.current_phase_id in nudged:
            return
        cands = [it for it in plan.items
                 if it.get("phase_id") == plan.current_phase_id
                 and it.get("status") not in planning.DONE_STATUSES
                 and not (it.get("delegate") or "").strip()
                 and not [d for d in (it.get("depends_on") or []) if d]
                 and _looks_like_research(it)]
        if len(cands) < 2:
            return
        nudged.add(plan.current_phase_id)
        ids = ", ".join(str(it["id"]) for it in cands)
        s["messages"].append({"role": "user", "content": (
            f"[SYSTEM] Steps {ids} in this phase are independent research with no delegate. "
            "Tag each one delegate=\"researcher@cheap\" (plan_update_task) — they'll fan out as "
            "ONE parallel wave, run on a cheap model, and cost you almost no context. Leave "
            "untagged only the steps that genuinely need your own judgment."
        )})
```

**11c.** Add the call site in `_plan_bookkeeping_after_tool`, immediately after
`self._maybe_dispatch_delegated_steps()` (line 3076):

```python
                self._maybe_nudge_plan_delegation(s)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_delegation_nudges.py -v`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add agent.py tests/test_delegation_nudges.py
git commit -m "feat(agent): nudge untagged independent research steps toward a delegated wave"
```

---

## Task 12: Tier select in the per-model ⚙ panel

**Files:**
- Modify: `frontend/app.js` — tier options near the effort family map (~line 1952), the row renderer (~line 2126), the save path (~line 2185), the load path (~line 2334)
- Test: manual (no JS test harness in this repo)

**Interfaces:**
- Consumes: `model_settings[<model>].tier` persisted by Task 1.

- [ ] **Step 1: Read the surrounding code**

Run: `sed -n '1940,2200p' frontend/app.js`

Identify exactly: the `_miniSelect` helper signature, the per-model settings object built at ~2185, and the config load at ~2334. The edits below must match those shapes — adapt names if they differ.

- [ ] **Step 2: Add the tier options constant**

Insert next to the reasoning-effort family map (~line 1952):

```javascript
// COST TIER for a model — the band a subagent asks for by name (see
// llm.model_ladder). '' means "derive from ladder position", which is the
// default for every model until the user tags one.
const MODEL_TIERS = [
  { value: '',         label: 'auto (by position)' },
  { value: 'premium',  label: 'premium' },
  { value: 'standard', label: 'standard' },
  { value: 'cheap',    label: 'cheap' },
];

// A tier already in the config that isn't one of the builtins (the user hand-
// edited llm_config.json) must survive a round-trip through this select.
function _tierOptions(current) {
  const opts = MODEL_TIERS.slice();
  if (current && !opts.some(o => o.value === current)) {
    opts.push({ value: current, label: current + ' (custom)' });
  }
  return opts;
}
```

- [ ] **Step 3: Render the select in the ⚙ row**

At the row renderer (~line 2126), after the existing effort select is appended:

```javascript
  const tierLab = document.createElement('label');
  tierLab.textContent = 'cost tier';
  rowEl.append(tierLab, _miniSelect('llm-model-tier', _tierOptions(s.tier), s.tier || ''));
```

- [ ] **Step 4: Persist and load it**

In the settings-collection block (~line 2185), add `tier` beside `reasoning_effort`:

```javascript
    tier: (rowEl.querySelector('.llm-model-tier') || {}).value || '',
```

and in the object actually stored (the `settings[id] = {...}` at ~2046), keep the key
only when set, mirroring how `reasoning_effort` is handled:

```javascript
    const tier = (raw.tier || '').trim();
    if (eff || tier) {
      settings[id] = {};
      if (eff) settings[id].reasoning_effort = eff;
      if (tier) settings[id].tier = tier;
    }
```

The load path at ~2334 already copies `model_settings` verbatim, so no change is
needed there — confirm this while reading in Step 1.

- [ ] **Step 5: Verify manually and commit**

Launch the app, open LLM Settings, expand a model's ⚙ panel, set a tier, save,
reopen — the tier must still be selected. Then confirm it reached disk:

```bash
python -c "import json;d=json.load(open('llm_config.json'));print([c.get('model_settings') for c in d['configs']])"
```

Expected: the chosen tier appears under the right model id.

```bash
git add frontend/app.js
git commit -m "feat(frontend): per-model cost tier select in the LLM settings panel"
```

---

## Task 13: Documentation and full regression sweep

**Files:**
- Modify: `AGENTS.md`
- Test: the whole suite

- [ ] **Step 1: Document the feature in AGENTS.md**

Add a section (match the surrounding heading style — check how the Strategic Brief
section is written, added in commit `c38cc93`):

```markdown
## Subagent model routing

Ladder position is cost. The order of providers in LLM Settings, and of models
within a provider, IS the cost spine — drag to reorder it. `llm.model_ladder()`
flattens it into rungs, most expensive first.

Each model's tier is either an explicit tag (`model_settings[<model>].tier`, set
in the per-model ⚙ panel) or derived from position (top rung `premium`, bottom
rung `cheap`, everything between `standard`). **A tagged model never changes tier
when you add providers or models** — only untagged models drift.

The orchestrator picks a model per subagent:
- plan step: `delegate="researcher@cheap"`
- `dispatch_agents` spec: `"tier": "cheap"` or `"models": ["<id>", ...]`
- persona default: `tier:` in the agent's `.md` frontmatter
- fallback: `llm.DEFAULT_SUBAGENT_TIER` (`standard`)

A subagent's ladder always ends with the higher rungs as a last-resort tail, and a
subagent that fails the JSON protocol twice escalates one rung once
(`subagents.escalate_ladder`).

Two bounded nudges push delegation: a solo-read streak (`OMNI_SOLO_READ_NUDGE`,
default 8, `0` disables) and a plan-shape check for 2+ untagged independent
research steps. Both fire at most once per streak/phase and reset per episode.
```

- [ ] **Step 2: Run the full suite**

Run: `python -m pytest -q 2>&1 | tail -30`
Expected: only the 2 known pre-existing failures. Any other failure must be fixed
before this task is complete — do not accept a new failure as pre-existing without
confirming it on `git stash`.

- [ ] **Step 3: Sanity-check the real config end to end**

Run:

```bash
python -c "
import llm, subagents
from subagents import AgentDef
for e in llm.model_ladder():
    print(e['rung'], e['model'], '->', e['tier'], '(tagged)' if e['tagged'] else '')
print('cheap  :', llm.models_for_tier('cheap'))
print('default:', subagents.resolve_model_ladder(AgentDef('r', 'p', tier='cheap'))[0])
"
```

Expected: 5 rungs from the real `llm_config.json`, `kimi-k3` at rung 0 as
`premium`, and the cheap ladder starting at the last rung.

- [ ] **Step 4: Refresh the knowledge graph**

Run: `graphify update .`

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md graphify-out
git commit -m "docs: document subagent model routing and the delegation nudges"
```

---

## Self-Review Notes

**Spec coverage:** Component 1 → Tasks 1-2. Component 2 → Task 3. Component 3 →
Task 4. Component 4 → Task 5. Component 5 → Tasks 6, 7, 8. Component 6 → Tasks 9,
10, 11. Frontend → Task 12. Testing/docs → across all tasks plus Task 13.

**Known deviation:** the derived-tier rule (documented at the top of this plan)
replaces the spec's `standard = N//2` starting-rung formula with a labeling rule.

**Type consistency:** `resolve_model_ladder` returns `(ladder, note)` everywhere;
`_normalize_spec` returns a 5-tuple, and both call sites in
`run_subagents_parallel` were updated (Task 4g); `_resolve` in `agent.py` returns
`(ad, tier)` and all four `reads`/`writes` unpack sites were updated (Task 8b-8c).
