# Tool-Calling Reliability Foundation — Design

**Date:** 2026-07-19
**Status:** Approved (design), pending implementation plan
**Sub-project:** A of A→B→C→D (see "Context & scope" below)

## Context & scope

The omni-agent reverse-engineers and modifies protected APKs (loader `.so` patching,
smali injection, defeating anti-cheat/anti-tamper) for a security competition. The
overarching goal is **deterministic success on complex, layered modifications** —
same prompt + same model should not produce varying results.

That larger goal decomposes into four sub-projects, sequenced prerequisite-first:

| # | Sub-project | Fixes |
|---|-------------|-------|
| **A** | **Reliability foundation** (this spec) | tool-calling JSON errors / `<tool_call>` literals; a chunk of run-to-run variance |
| B | Capability tiering (mechanical vs reasoning models) | hybrid LLM routing (deepseek/glm mechanical, kimi-k3 reasoning) |
| C | Recipe / replay engine (signature relocation, verification gates, record-back) | complex-work determinism; jadx-over-ghidra; decode-vs-unzip confusion; planning role |
| D | The actual recipes (anti-tamper, WebView, Luau injector) | the concrete mods |

**This spec is sub-project A only.** It deliberately does NOT touch jadx/ghidra,
decode-vs-unzip, planning, model tiering, or recipes. Those depend on A being solid
and are specified separately.

## Problem

Root cause, traced in the current code:

1. **Native function-calling is never used.** The request payload is
   `{"model", "messages"}` (+ max_tokens/temperature/reasoning) — no `tools` array is
   ever sent (`llm.py:1017`). The response handler *can* parse a structured
   `tool_calls` reply (`llm.py:1090`) but never receives one, because tools are never
   requested. The model is asked *in prose* (system prompt, `llm.py:164`) to emit
   `{"type":"tool_call",…}` and left to free-text it. Under load, GLM 5.2 — trained
   heavily on harmony/XML tool syntax — drifts to `<tool_call>name</tool_call>`, which
   `extract_json_action` has no branch for, producing the "response was not proper
   JSON" failures.
2. **The correction prompt contradicts itself** (`agent.py:191`): it asks for
   *"keys: action, tool, arguments"* and then shows `{"type","tool","args"}` — telling
   an already-confused model to switch to a *different* schema than it was given.
3. **Sampling variance**: `MAIN_LOOP_TEMPERATURE = 0.3` (`agent.py:373`) leaves
   avoidable run-to-run drift on models that honor sampling.

## Goal & success criteria

Make the tool-calling protocol robust and low-variance without changing agent behavior
or tool semantics.

- **SC1** — On a provider flagged native, the model emits structured `tool_calls`;
  `<tool_call>`/harmony/malformed-JSON failures do not occur.
- **SC2** — On any provider (native or prose), a reply containing a recognizable
  tool intent in a non-JSON shape (`<tool_call>…</tool_call>`, harmony, name-then-json,
  bare tool name) is parsed into a valid action instead of erroring.
- **SC3** — `final_answer` is a first-class tool; with `tool_choice="required"` a native
  provider physically cannot emit free-text outside a structured call.
- **SC4** — Tool schemas are generated from *live* function signatures and never served
  stale after a code change.
- **SC5** — Existing prose-JSON behavior is unchanged when a model is not flagged native.

## Constraints

- Layer onto existing code; do not rewrite the agent loop or `ask_llm` fallback chain.
- Progressive tool disclosure (core + active groups shown; rest catalog-only) must be
  preserved — native mode must NOT dump all ~105 tool schemas every turn.
- `supports_native_tools` is set **manually per model** (no auto-probe): the user
  controls the backends (GLM, DeepSeek, Kimi) and manual flags keep startup
  deterministic and avoid probe edge cases.
- Schema generation must never persist baked-in knowledge that could go stale across
  versions.

## Architecture — three layers

Every turn passes through three layers, each a fallback for the one above. Native-vs-prose
is decided **per model**, orthogonal to the existing `ask_llm` transport-error fallback
(429/503 key/model rotation), which is untouched.

```
REQUEST  ─ Layer 1 ─ model flagged native?  ──► send tools=[…] + tool_choice="required"
                     else                    ──► prose-JSON prompt (today's behavior)
                          │
RESPONSE ─ Layer 2 ─ message.tool_calls present?  ──► use directly (llm.py:1090, exists)
                     content only?                ──► HARDENED PARSER (new pre-stage + today's salvager)
                          │
TURN     ─ Layer 3 ─ still unparseable?  ──► fixed correction retry, bounded (agent.py:2599, exists)
```

**Key property:** Layer 2's hardened parser is always active, even in native mode — so a
model that ignores `tools=` and free-texts anyway is still covered.

## Component 1 — Native function-calling path

**What it does:** For a model flagged `supports_native_tools`, sends real OpenAI-style
`tools` + `tool_choice="required"` so the model returns structured `tool_calls`.

**Schema generation (`tool_registry`):**
- A generator walks each registered tool. The function *signature* is the authoritative
  schema (as `_validate_args` already treats it, `tool_registry.py:244`): params without
  defaults → `required`; with defaults → optional. The existing `params_schema` text
  (`{name: description}`) supplies each field's `description`. JSON type inferred from the
  annotation when present, else `string`.
- **No stale knowledge (SC4):** schemas are generated from live signatures at process
  startup and held in memory. If an on-disk cache is used at all, each entry is keyed by a
  **content hash of the tool's signature + `params_schema`**; a changed tool auto-invalidates
  and regenerates. The system always checks against current code.

**Progressive disclosure preserved:**
- `tools=` carries only **core + active-group** schemas — the same set shown in full in the
  prose prompt today, NOT all ~105.
- One always-present meta-tool `expand_toolset(group)` lets the model pull a hidden group's
  schemas into the next turn — the native equivalent of the current auto-expand behavior.

**`final_answer` as a native tool (SC3):**
- `final_answer(content)` is registered as a tool. With `tool_choice="required"`, every turn
  is a structured call — no free-text action channel. Reasoning content still streams
  separately (the reasoning field), it just cannot leak into the action.

**Capability flag:**
- New per-model setting `supports_native_tools` in `model_settings` (config-level value as
  the default; absent → `false`, the safe prose path). Set manually per verified model.

**Depends on:** `tool_registry` (schema source), `_openai_request` (payload + response,
`llm.py:1006`).

## Component 2 — Hardened parser (Layer 2 fallback + prose providers)

**What it does:** Normalizes non-JSON tool-intent shapes into the canonical action before
`extract_json_action`'s existing JSON salvage runs. Recognizes:
- Harmony/XML tags: `<tool_call>name</tool_call>`, `<tool_call>{json}</tool_call>`,
  `<function_call name="x">{args}</function_call>`, `<function=name>{args}</function>`.
- Name-then-json: a bare tool-name line followed by a `{…}` args object.
- Bare tool-name line: a lone known tool name with no args → `{tool: name, args: {}}`
  (validated downstream).
- Everything the current salvager already handles (fences, prose-wrapped JSON, trailing
  commas, `action`/`arguments` aliases) is retained.

Matched shapes map onto `{"type":"tool_call","tool":…,"args":…}` and flow through the
existing `_normalize_action`.

**Correction prompt fix (`agent.py:191`):** remove the contradictory
*"keys: action, tool, arguments"* line; show one concrete correct example matching the
system-prompt schema; add *"Do not use `<tool_call>` tags — emit the raw JSON object."*
One consistent signal instead of two conflicting ones.

**Depends on:** `extract_json_action` (`llm.py:908`), the registered tool-name set (to
recognize bare names), the correction path (`agent.py:2599`).

## Component 3 — Determinism knobs

- **Temperature:** mechanical-loop default lowered from `0.3` to **`0.15`** (low, not 0 —
  absolute 0 can push some models into degenerate repetition loops), and kept configurable.
  Honest caveat: GLM/DeepSeek in reasoning mode largely ignore sampling temperature, so this
  is a minor lever — `tool_choice="required"` + native schemas is what actually buys
  determinism. The hook is left so sub-project B can set temperature per tier.
- **`seed` passthrough:** optional per-config `seed` added to the OpenAI payload for
  providers that honor it (best-effort reproducibility). Off unless set.

**Depends on:** `MAIN_LOOP_TEMPERATURE` (`agent.py:373`), `_openai_request` payload build.

## Data flow (worked example — native provider)

1. Agent loop calls `ask_llm(messages, temperature=0.15)`.
2. `_openai_request` sees the active model is flagged native → attaches
   `tools=[core + active groups + expand_toolset + final_answer]`, `tool_choice="required"`.
3. Model returns `message.tool_calls=[{function:{name, arguments}}]`.
4. `llm.py:1090` converts it to `{"type":"tool_call","tool":…,"args":…}` — no free text,
   no parse risk.
5. Agent executes the tool as it does today.

*Prose provider (flag false):* steps 2–4 are today's behavior, except a `<tool_call>` /
harmony / name-then-json reply now normalizes cleanly via Component 2 instead of erroring.

## Error handling

- **Native request rejected** (provider 400s on `tools`): treated as a normal request
  failure by the existing `ask_llm` fallback; operator corrects the flag. (Manual-flag
  decision means this is a config error, surfaced clearly, not silently absorbed.)
- **Model ignores `tools=` and free-texts:** Layer 2 hardened parser catches it (SC2).
- **Unparseable after Layer 2:** existing bounded correction retry (Layer 3), then re-prompt
  next turn — a parse failure never ends the session (unchanged).
- **`ask_llm` transport fallback (429/503/timeout):** entirely unchanged.

## Testing

- **Parser unit tests** (`tests/`): a fixture table of real malformed samples —
  `<tool_call>` variants, harmony, name-then-json, bare tool name, fenced, trailing-comma,
  `action`/`arguments` aliases — each asserting the correct extracted action. This is the
  regression net proving the `<tool_call>` failures are dead (SC2).
- **Schema-gen tests:** every registered tool yields a valid OpenAI JSON schema;
  required/optional derived correctly from signatures; the content-hash cache invalidates
  when a signature changes (SC4); generated args round-trip through `_validate_args`.
- **Live smoke test** (one per model flagged native): a real round-trip forcing a known
  tool call and a `final_answer`, asserting structured `tool_calls` come back (SC1, SC3).
  Doubles as the manual verification before flipping a model's flag to `true`.
- **Regression:** with `supports_native_tools=false`, the prose-JSON path parses exactly as
  before (SC5).

## Out of scope (later sub-projects)

- Model tiering / routing mechanical vs reasoning (B).
- jadx-over-ghidra, decode-vs-unzip tool selection, recipe/replay engine, planning role (C).
- The concrete anti-tamper / WebView / Luau recipes (D).
- Constrained/grammar decoding (Approach 3) — back-pocket option if a specific self-hosted
  model still drifts after this lands.
