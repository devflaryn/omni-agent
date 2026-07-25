# Subagent Model Routing & Delegation Doctrine

**Date:** 2026-07-25
**Status:** Approved design, ready for planning

## Problem

Two independent defects in how this framework uses subagents.

**1. Every subagent runs on the main model.** `subagents.py` calls `llm.ask_llm(...)`,
which always walks the single global ladder produced by `_build_groups()` +
`_apply_preference()`. The only per-subagent knob today is `KeyAllocator` pinning an
API key through `llm.set_subagent_context(pinned_key=...)`. Because the operator pays
per token, a one-line "where is the root check?" lookup costs exactly the same as a
deep architectural analysis — both run on rung 0 (`cline-pass/kimi-k3`).

**2. The agent rarely delegates.** Delegation exists on two paths — a plan step tagged
`delegate=<agent>` (harness-driven, `agent.py:1405`) and `dispatch_agents` (ad-hoc
parallel wave) — but the system prompt mentions it only in passing (`llm.py:216`,
`llm.py:232`). In practice the orchestrator does research inline, burning main context
and forfeiting the parallelism subagents make available.

These compound: cheap subagents are only worth having if the agent actually spawns
them, and spawning more subagents is only affordable if they are not all premium.

## Goals

- The main LLM chooses a model **and a custom fallback order** per subagent.
- Model choice is cost-aware: cheapest model that can actually do the job.
- The agent delegates substantially more often than it does today.
- Adding a provider or model later requires **no code and no prompt edits** — only
  reordering and tagging in LLM Settings.

## Non-goals

- Real per-token price arithmetic or spend tracking. Cost is expressed as ordinal
  position on a ladder the operator controls, not as currency.
- Nested subagents. `SUBAGENT_EXCLUDED` continues to bound delegation depth.
- Changing the vision ladder (`ask_vision`), which keeps its current behavior.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Cost metadata source | Ladder **position**, with optional explicit per-model tags | No second registry of model ids to go stale; the existing drag-to-reorder UI already expresses it |
| Choice syntax | Both `tier` shorthand **and** explicit `models: [...]` | `tier` is low-friction enough that the model will actually use it; `models` delivers the requested custom fallback order |
| Default when unspecified | Per-persona `tier:` in agent `.md`, else `standard` | An unspecified subagent is already cheaper than main without the LLM having to think about it |
| Delegation push | Prompt doctrine **plus** runtime nudges | Prompt text is the lever that is already failing; `strategy.py` sets the in-repo precedent that nudges change behavior |

---

## Component 1 — the cost spine (`llm.py`)

### `model_ladder()`

New public function. Flattens every configured **text** model across provider groups
in config order into the global rung list, most-capable/most-expensive first:

```python
[{"rung": 0, "id": "31186523", "label": "cline pass",
  "model": "cline-pass/kimi-k3", "tier": "premium", "tagged": True},
 {"rung": 1, "id": "612b1972", "label": "nvidia",
  "model": "z-ai/glm-5.2", "tier": "standard", "tagged": False},
 ...]
```

Built from `_build_groups(get_effective_configs())`. Order comes from two things the
operator already controls by dragging in LLM Settings:

- provider order — `frontend/app.js:1765`, *"drag to reorder = change fallback priority"*
- model order within a provider — `frontend/app.js:1945`, *"drag to reorder (top = primary)"*

### Two-layer tier resolution

**Layer 1 — explicit tag (authoritative).** `model_settings[<model_id>].tier`, a free
string, living beside the existing `reasoning_effort` in the same per-model block:

```json
"model_settings": {
  "cline-pass/kimi-k3":            { "reasoning_effort": "high", "tier": "premium" },
  "deepseek-ai/deepseek-v4-flash": { "tier": "cheap" }
}
```

Tier names are **open**. `cheap` / `standard` / `premium` are only the names the prompt
advertises; a model tagged `fast` is addressable as `tier: "fast"` with no code change.

**Layer 2 — positional derivation (fallback).** Applies **only to untagged models**,
over the full ladder of length `N`:

| tier | rung | current config (N=5) |
|---|---|---|
| `premium` | `0` | `cline-pass/kimi-k3` |
| `standard` | `N//2` → 2 | `deepseek-ai/deepseek-v4-pro` |
| `cheap` | `N-1` → 4 | `nvidia/nemotron-3-ultra-550b-a55b` |

This makes the feature work with zero setup on the current config, while tagging
progressively takes over.

> **Stability guarantee.** Once a model carries an explicit tag, adding a provider or
> model never moves it between tiers. Only untagged models are subject to positional
> drift. This is the property that makes the system safe to grow.

### Resolving a tier to a ladder

`tier: X` produces, in order:

1. models tagged `X`, in ladder order;
2. then every model below the first of them, in ladder order (continuation);
3. then the higher rungs, appended as a **last-resort tail**.

The tail preserves the existing "the chat never stops because of an API error"
contract in `ask_llm`: a cheap subagent never silently pays premium, but also never
dies when everything at or below its tier is down.

---

## Component 2 — per-thread model override (`llm.py`)

`set_subagent_context` gains a model list; `clear_subagent_context` clears it:

```python
def set_subagent_context(pinned_key=None, models=None):
    _TL.pinned_key = pinned_key
    _TL.model_ladder = list(models) if models else None
    _TL.is_subagent = True
    _TL.last_usage = None
    _TL.last_model = None
```

In `ask_llm`, the per-cycle group construction becomes:

```python
groups = _build_groups(configs)
override = getattr(_TL, "model_ladder", None)
groups = (_apply_model_override(groups, override) if override
          else _apply_preference(groups, get_preferred_model()))
```

`_apply_model_override(groups, model_ids)` re-emits groups so models are tried in
exactly the requested order, **merging consecutive same-provider models into a single
group**. Merging matters: `_run_group` tracks dead keys per call, so keeping
`[dsv4-pro, dsv4-flash]` (both NVIDIA) in one group preserves key rotation and
dead-key sharing, while `[kimi-k3, glm-5.2]` correctly becomes two groups.

Also record which model answered, mirroring `take_last_usage`:

```python
def take_last_model():
    """Model id that served the last ask_llm on this thread, or None."""
```

Set in `_run_group` on success. Feeds cost visibility in telemetry.

**Isolation.** The override is thread-local, so the main thread's `ask_llm` is
unaffected and the composer dropdown (`get_preferred_model`) still governs it.
`_is_subagent_thread()` already suppresses the active-provider badge and key-rotation
chatter for these threads.

---

## Component 3 — subagent plumbing (`subagents.py`)

`AgentDef` gains `tier=None` and `models=None`.

`run_subagent(agent_def, task, context="", run_dir=None, on_event=None, tier=None,
models=None)` — call-site arguments override persona defaults.

New `resolve_model_ladder(agent_def, tier=None, models=None) -> list[str] | None`:

```
explicit models=[...]      # from the dispatch call
  > explicit tier          # from the dispatch call
  > agent_def.models       # .md frontmatter
  > agent_def.tier         # .md frontmatter
  > DEFAULT_SUBAGENT_TIER  # "standard"
```

- Model ids are validated against `model_ladder()`. Unknown ids are **dropped with a
  warning appended to `result["note"]`** — never fatal, since a typo must not kill a
  wave.
- If nothing survives validation, fall back to the tier default.
- Returns `None` when no models are configured at all, which reproduces today's
  behavior exactly.

`run_subagent` passes the resolved list into
`llm.set_subagent_context(pinned_key=key, models=ladder)`.

`_normalize_spec` accepts `tier` and `models` keys on dict specs, so
`run_subagents_parallel` can carry per-subagent routing through a wave.

**Telemetry.** `subagent_started` gains `tier` and `model` (ladder head);
`subagent_done` gains `model` (what actually answered, via `take_last_model()`) and
`escalated` (see Component 4). The frontend Subagents HUD renders the model per bar so
the operator can see what each subagent cost.

---

## Component 4 — escalation safety valve (`subagents.py`)

Defaulting personas to cheap models is only safe if a weak model failing the strict
JSON protocol self-corrects rather than returning garbage.

`_run_loop` already counts consecutive parse errors and salvages at 3. Insert an
escalation before that: on the **2nd consecutive parse error**, if the head of the
subagent's current ladder is not already rung 0, re-pin the thread to a ladder whose
head is the **next rung up from that head** — remaining rungs unchanged behind it —
via `llm.set_subagent_context(pinned_key=..., models=<escalated ladder>)`, and continue.

- Fires **at most once** per subagent run.
- Records `escalated: True` and a `note` naming both models.
- The existing 3-error salvage path stays as the final backstop.

Without this, "cheap by default" degrades output quality invisibly. With it, a persona
that genuinely needs a stronger model pays for one wasted turn and recovers.

---

## Component 5 — model-facing surface

**`dispatch_agents` (`tools/delegation_tools.py`).** Spec objects gain `tier` and
`models`. The tool description renders the **live** ladder from `model_ladder()` so it
can never go stale as providers are added:

```json
{"specs": [
  {"agent": "researcher", "tier": "cheap",
   "task": "where is the root check?"},
  {"agent": "native-analyst",
   "models": ["deepseek-ai/deepseek-v4-pro", "z-ai/glm-5.2"],
   "task": "map the JNI entry points"}
]}
```

**Plan steps.** Encode the tier in the existing `delegate` string —
`delegate="researcher@cheap"` — rather than threading a new field through the six
places `delegate` appears in `planning.py` and `tools/plan_tools.py`. One parse point
in `agent.py`'s delegate resolution, and it renders readably in the plan text at
`planning.py:433`. A bare `delegate="researcher"` keeps persona defaults.

**`plugins.py`.** `_load_agent_md` parses `tier:` and `models:` frontmatter.
`get_agents_prompt()` shows each agent's default tier and appends a live MODEL LADDER
block listing rung, model id, and tier.

**Persona defaults** (agent `.md` frontmatter):

| agent | tier |
|---|---|
| `researcher` | `cheap` |
| `implementer` | `standard` |
| `native-analyst` | `standard` |
| `architect` | `premium` |
| `brainstormer` | `premium` |
| `verifier` | `premium` |

**Frontend (`frontend/app.js`).** Add a tier `_miniSelect` to the per-model ⚙ panel
beside the existing `llm-model-effort` control (`app.js:2126`), persisted into
`model_settings[<model>].tier` through the existing save path (`app.js:2185`, `:2280`).
The select offers the built-in three plus any tier string already present anywhere in
the config, so custom tiers survive a round-trip through the UI. **Coining a new tier
name is a JSON edit** (or a future free-text option); the UI's job is to preserve and
reassign existing ones, not to invent them.

---

## Component 6 — delegation doctrine and nudges

### Prompt (`llm.py`, `get_static_system_prompt`)

Replace the two passing mentions at `llm.py:216` and `llm.py:232` with a
DELEGATE BY DEFAULT block covering:

- **Default posture:** if a sub-task is self-contained and its *intermediate* output is
  not needed in the main thread, delegate it. Delegation costs ~0 main context.
- **Hard rule:** 2+ independent questions is always one `dispatch_agents` wave, never a
  sequence of inline reads.
- **Cost routing:** worked examples pairing task shape to tier — a symbol lookup or
  "where is X" is `tier: "cheap"`; a bounded implementation is `standard`; an
  architectural judgment call or a final verification is `premium`.
- **Framing:** failing to fan out a fan-out-able investigation is a mistake, not a
  neutral choice.

### Runtime nudges (`agent.py`)

Two counters on the agent instance, both **reset per episode** — mirroring the
`strategy_review_rounds` reset established in commit `34e22b1` — and each firing **at
most once** per streak/phase so they inform rather than nag.

**1. Solo-read streak.** Increment on each read-only tool call executed on the main
thread; reset on any delegation. At the threshold (default 8, env-overridable via
`OMNI_SOLO_READ_NUDGE`), inject once:

> `[SYSTEM]` That's 8 read-only calls in a row in your own context. Those are subagent
> waves — fan the next batch out with `dispatch_agents` (`tier: "cheap"` for lookups)
> and keep this conversation lean.

**2. Plan shape.** When a phase gains ≥2 independent research-flavored steps carrying
no `delegate`, inject once, naming the specific step ids and the exact tag to add:

> `[SYSTEM]` Steps 3, 4 and 5 are independent research. Tag them
> `delegate="researcher@cheap"` — they'll run as one parallel wave at ~0 context cost
> to you.

---

## Testing

New `tests/test_subagent_model_selection.py`, plus additions to existing suites.

**Tier resolution**
- Positional derivation across ladder lengths 1–6, including degenerate `N=1` and `N=2`.
- Explicit tags win over position; untagged models still derive.
- Custom tier strings (`fast`) resolve without code changes.
- Adding a model to the config does not move a *tagged* model between tiers (the
  stability guarantee).

**Ladder construction**
- `_apply_model_override` honors requested order exactly.
- Consecutive same-provider models merge into one group; non-consecutive do not.
- Last-resort tail present, and ordered above-tier-last.

**Precedence**
- Full chain: `models` > `tier` > frontmatter `models` > frontmatter `tier` > default.
- Unknown model ids dropped with a note; all-unknown falls back to the tier default.
- No configured models → `None` → today's behavior.

**Isolation**
- A subagent thread's override never leaks into a concurrent main-thread `ask_llm`.
- `get_preferred_model()` still governs the main thread while an override is active.

**Escalation**
- Two consecutive parse errors escalate exactly one rung, exactly once, and set
  `escalated`/`note`.
- A subagent already at rung 0 does not escalate.
- The 3-error salvage backstop still fires.

**Nudges**
- Streak nudge fires at the threshold, once, and resets on delegation.
- Plan-shape nudge fires once per phase and names the correct step ids.
- Both reset per episode.

**Loading**
- `_load_agent_md` parses `tier:` and `models:`; malformed values degrade to defaults
  rather than raising.

**Regression.** Full `pytest` sweep must show no new failures against the two known
pre-existing failures.

---

## Files touched

| File | Change |
|---|---|
| `llm.py` | `model_ladder()`, tier resolution, `_apply_model_override`, `take_last_model`, `set_subagent_context(models=)`, prompt doctrine |
| `subagents.py` | `AgentDef.tier/.models`, `resolve_model_ladder`, `run_subagent` args, `_normalize_spec`, escalation, telemetry |
| `tools/delegation_tools.py` | `tier`/`models` on specs, live ladder in description |
| `agent.py` | `delegate="agent@tier"` parsing, two nudge counters |
| `plugins.py` | frontmatter `tier`/`models`, ladder block in `get_agents_prompt` |
| `plugins/*/agents/*.md` | persona default tiers |
| `frontend/app.js` | tier select in the per-model ⚙ panel |
| `frontend/wave_stats.js` | model/tier per subagent bar |
| `tests/` | new suite + additions |

## Risks

- **`cheap` = rung `N-1` is literal.** In the current config that is
  `nvidia/nemotron-3-ultra-550b-a55b`, a 550B model in last position. Ladder-position-
  is-cost means the framework treats it as cheapest. Mitigated by explicit tags; the
  operator reorders or tags if that is wrong.
- **Cheap models and the strict JSON protocol.** Mitigated by Component 4 escalation
  and the existing salvage path.
- **Nudge fatigue.** Mitigated by once-per-streak/phase firing, per-episode reset, and
  an env-tunable threshold.
