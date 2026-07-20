# omni-agent: enforce invariants instead of requesting them

**Date:** 2026-07-21
**Status:** Approved design, not yet implemented
**Scope:** omni-agent only (Spec A of three — see "Out of scope")

## Problem

Four reported issues in omni-agent turned out to share one cause: at every point
where the agent could be wrong, the only thing standing between the model's
belief that it succeeded and the delivered artifact is the model itself. There
is no mechanical check anywhere in the pipeline.

The reported symptoms:

1. The model emits non-JSON tool calls that break the agent loop.
2. Stated constraints are ignored ("must produce classes4.dex", "do not add a
   new .so").
3. The code graph goes unused despite ~30k smali/java files.
4. Tool choice is non-deterministic — raw `unzip` where `apktool d` is required.

Each is addressed below. Issue 3 is resolved indirectly (see Component 4).

## Evidence

All findings below come from the user's saved runs, not from reasoning.

### Malformed tool calls are the norm, not an edge case

Counting assistant messages containing `<tool_call` / `<function` across
`memory/*/conversation.json`:

| Session | tag-shaped messages |
|---|---|
| instance create | 331 |
| fourth overnight | 276 |
| first overnight | 175 |
| seventh overnight | 26 |

A representative message:

```
I'll start by inspecting the workspace...<tool_call>list_directory{"directory": "."}
```

Native function-calling is **already enabled** — `llm_config.json` sets
`supports_native_tools: true` for `z-ai/glm-5.2` (the preferred model), and
`llm.py:1156-1163` sends `tool_choice="required"`. The provider accepts the
parameter; GLM writes tag-shaped text into `content` anyway. This is not
fixable by configuration or by prompt wording — `agent.py:199-204` already
contains an instruction forbidding these tags, and the model emits them
hundreds of times per night regardless.

A salvage path also already exists (`extract_json_action` →
`_normalize_nonjson_action`, `llm.py:917`). It fails for three specific
reasons:

1. `_TAG_RE` (`llm.py:893-897`) requires a closing `</tool_call>`. GLM never
   emits one, so the tag branch never matches.
2. The fallbacks `_LEADING_NAME_RE` and `_BARE_NAME_RE` are anchored with
   `^\s*`. GLM prefixes prose, so they fail too. Salvage returns `None` and the
   loop breaks.
3. GLM stacks multiple calls in one message
   (`<tool_call>list_skills{}<tool_call>list_directory{...}`). The loop is
   one-tool-per-turn and has no handling for the extras.

### Constraints are violated silently and shipped

From `~/Desktop/overnight tests/instance create/`:

| APK | classes4.dex | .so count |
|---|---|---|
| `roblox-v2.726.apk` (base) | — | 11 |
| `roblox-work.apk` | present | 12 |
| `roblox-modified.apk` | present | 12 |
| `roblox-final.apk` | **absent** | 12 |
| `roblox-final2.apk` | **absent** | 12 |
| `roblox-final3.apk` | **absent** | 12 |

The 12th native library is `libomni-bypass.so`, newly created by the agent
against an explicit instruction not to add one. `classes4.dex` was present in
the intermediate build and dropped in every `final` build.

The `fourth overnight` run satisfied both constraints. This inconsistency is
the core problem: the artifacts are indistinguishable without manual
inspection, so a correct build and a silently broken one arrive looking the
same.

### Decode discipline is bypassed via the shell

`fourth overnight` produced four decode directories for one APK —
`roblox_extract` (lib only), `roblox_apk_decoded` (res only), `roblox_decoded`
(full apktool), `roblox_decoded_full` (a third format). A rebuild pointed at a
partial tree is a plausible mechanism for the dropped `classes4.dex`.

Critically, the partial trees were not produced by the decode tools. From the
transcript:

```
run_command{"command":"mkdir -p codex_extract roblox_extract && cd codex_extract
&& unzip -o ../codex-v2.726.apk 'lib/*' ..."}
```

The agent shelled out. Restricting `tools/apk_tools.py:unzip_apk` alone would
change nothing.

## Design principles

- **Constraints are user-stated, never hardcoded.** The system must not know
  that Roblox needs `classes4.dex`. It knows how to check a stated constraint.
  Constraint vocabulary is generic and app-agnostic.
- **Repair existing code where it exists.** Components 1 and 3 modify working
  subsystems rather than adding parallel ones.
- **A check the model can route around is not a check.** Enforcement points sit
  where the model cannot bypass them.

## Components

Four components. Component 1 is independent and may ship alone. Component 2 is
the spine; 3 removes a major cause of 2's failures; 4 produces artifacts 2
verifies.

### Component 1 — Tool-call salvage repair

**Location:** `llm.py` (`_TAG_RE`, `_normalize_nonjson_action`,
`extract_json_action`)

**Changes:**

- Relax `_TAG_RE` so the closing tag is optional. An unclosed tag body
  terminates at the next `<tool_call` / `<function` opener or at end of string.
- Add an unanchored name-then-JSON scan for tag bodies with no name attribute,
  so a prose prefix no longer defeats extraction.
- Parse **all** calls present in a message. Execute the first; return the
  remainder to the model as explicit feedback ("you emitted N tool calls; this
  loop accepts one per turn — the first was executed, resend the rest
  individually"). Extras are never silently discarded.
- Increment a per-session `salvaged_tool_calls` counter on every repair and
  surface it in the run report.

**Rationale for the counter:** the existing failure is invisible until a run
dies. A visible count turns a silent protocol mismatch into an observable
metric, and tells us whether a future model change has fixed or worsened it.

**Interface:** unchanged. `extract_json_action(text) -> action | None` keeps its
signature; only its coverage widens.

### Component 2 — Constraint manifest and verification gate

**Location:** new module

**Flow:**

1. **Compile.** At mission start the agent translates constraints stated in the
   user's prompt into an explicit list of assertions drawn from the vocabulary
   below. This step is LLM-driven — natural language in, structured assertions
   out — which is why step 2 exists: the compilation is the one part of this
   component that can be wrong, so it is always shown before it is relied on.
2. **Echo.** The compiled list is shown to the user before work begins, so a
   misunderstanding surfaces at second zero rather than at delivery.
3. **Verify.** At artifact time the gate opens the built APK, diffs it against
   the recorded base, and evaluates each assertion.
4. **Feed back.** On failure the agent receives the specific delta
   (`classes4.dex present in base, absent in output`), not a generic failure.
   Retries are capped; on exhaustion the run stops and writes a report.
5. **Report.** Every run ends with per-constraint pass/fail regardless of
   outcome.

**Constraint vocabulary** (generic, extensible):

- `file_present(path_or_glob)` / `file_absent(path_or_glob)`
- `no_new_files_matching(glob)` — output contains no member matching the glob
  that the base lacked
- `file_set_unchanged(glob)` — the set of members matching the glob is
  identical between base and output
- `file_unmodified(path)` — byte-identical to base

The `instance create` failure is expressible as
`file_present("classes4.dex")` + `no_new_files_matching("lib/**/*.so")`.

**Verification is static** — unzip and compare. No emulator is involved, so
this component is not affected by the open stale-QEMU bug in omnidroid.

**Retry cap:** 3 attempts, then stop and report. Bounded token spend on
unattended runs, while still using the hours productively.

### Component 3 — Decode discipline

**Location:** `tools/apk_tools.py`, plus a guard on `run_command`

**Changes:**

- One canonical decode directory per APK per mission, at a deterministic path.
  Repeat decode requests for the same APK resolve to the existing directory
  instead of creating a variant.
- `run_command` gains a guard rejecting `unzip` / `apktool` invocations that
  target a mission APK, with an error naming the canonical path and the tool to
  use instead.
- The modify path accepts only a full `decode_apk` tree. A partial extraction
  cannot be used as a rebuild source.

**The `run_command` guard is not optional.** Without it the component has no
effect, since the observed bypass went through the shell.

### Component 4 — Diff-replay

**Location:** new module

**Scope:** near-identical inputs (same app, same version, different builds), per
user confirmation. Cross-application technique transfer is explicitly out of
scope.

**Flow:** reference APK + its base → structural diff of decoded trees → concrete
patch set (changed smali files, inserted members, manifest deltas) → replay onto
target → hand the result to Component 2 for verification.

**This component resolves issue 3.** The code graph is currently unused because
nothing in the workflow requires it — the agent can always grep to something
plausible, and prior ergonomic fixes (making `query_type` optional) did not
change adoption. Resolving "this patched method — where is its counterpart in
the target tree" makes the graph the path of least resistance rather than an
optional nicety. Adoption follows from necessity, not from availability.

## Data flow

```
mission prompt
  └─> Component 2: compile constraints ──> echo to user
        │
        ▼
   agent loop  ◄──── Component 1: salvage malformed calls
        │
        ├──> Component 3: canonical decode (run_command guarded)
        ├──> Component 4: diff-replay (optional, reference-driven runs)
        │
        ▼
   built artifact
        │
        ▼
  Component 2: static verify vs base
        ├─ pass ──> deliver + per-constraint report
        └─ fail ──> specific delta fed back, retry (cap 3) ──> report
```

## Error handling

| Failure | Behavior |
|---|---|
| Unparseable model output after salvage | Existing loop-break path, now genuinely last-resort |
| Multiple tool calls in one message | First executed, remainder returned as feedback |
| Constraint violated | Specific delta fed back, retry up to 3, then stop and report |
| Constraint unsatisfiable | Retry cap bounds it; report states which assertion never passed |
| `run_command` decode bypass attempt | Rejected with the canonical path in the error |
| Diff-replay finds no counterpart in target | Reported as a failed patch, not silently skipped |

## Testing

- **Component 1:** the 800+ real tag-shaped messages in
  `memory/*/conversation.json` become the regression corpus. Every one must
  parse to a valid action. Offline.
- **Component 2:** synthetic APK pairs exercising each constraint type, plus
  the real `instance create` artifacts as fixtures — `roblox-final.apk` must
  fail both assertions, `roblox-work.apk` must pass `file_present`. Offline.
- **Component 3:** guard unit tests for shell bypass patterns; canonical-path
  resolution tests. Offline.
- **Component 4:** replay a known patch between two builds and assert the
  output passes Component 2. Offline.

All four are offline-testable. No emulator dependency in the test suite.

## Out of scope

- **Spec B — omnidroid** (mode profiles, boot time, image slimming). Separate
  cycle. Sequenced before Spec C because it changes omnidroid's CLI surface.
- **Spec C — omni-executor** (CLI resync, drop its own VNC viewer in favor of
  omnidroid's existing `view` / `_vncview`). Separate cycle, after Spec B.
- **The instance communication protocol** (bootstrapper command channel between
  omni-executor and the APK). Explicitly deferred by the user; not designed.
- **The stale-QEMU detection bug.** Real and open, but Component 2's
  verification is static, so it does not block this spec. It remains a
  prerequisite for any on-device verification added later.
- **Cross-application technique transfer** in Component 4.

## Sequencing

1. Component 1 — independent, high frequency, immediate relief on overnight runs
2. Component 2 — the spine
3. Component 3 — removes a major cause of Component 2 failures
4. Component 4 — builds on 2 and 3
