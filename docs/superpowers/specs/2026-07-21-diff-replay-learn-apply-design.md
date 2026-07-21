# omni-agent Component 4: learn-and-apply modification (diff-replay)

**Date:** 2026-07-21
**Status:** Approved design, not yet implemented
**Scope:** omni-agent only. This is Component 4 of Spec A, deferred from the
2026-07-21 enforcement plan until its dependencies (the constraint gate,
Tasks 6-10) existed. They now do.

## Problem

The user wants to hand the agent a **working modified APK plus its plain base**
and say, in effect: *"learn the bypass used on this APK, then apply it to the
base / a new target."* Two failure modes must be avoided:

1. **Blind copying.** The agent must NOT diff the two trees and copy the changed
   files onto the target. It must *understand* the technique — what the bypass
   does, how it is wired — and reconstruct it, because the target is a different
   build where copied files may not fit.
2. **A silently-wrong result.** As with the rest of Spec A, the agent's belief
   that it applied the technique correctly must be checked mechanically, not
   trusted.

This is also the answer to the original **issue #3** (the code graph goes
unused): mechanical file-copy would never touch the graph, but *comprehending*
a technique and *relocating* its hook points in a different build cannot be done
without it. Component 4 makes the graph load-bearing by necessity.

## Scope (locked during brainstorming)

- **Inputs are near-identical builds** — same app, same/adjacent version,
  different builds. Not cross-application technique transfer.
- **Learn, don't copy.** The reference pair is a *teacher*; the deliverable is a
  reconstruction on the target, informed by understanding.
- **Explicit learned-technique artifact first.** The agent writes down what it
  understood before it touches the target. The artifact is surfaced but the run
  does not block on human approval (consistent with unattended runs); it serves
  as the apply-phase plan.
- **"Done" = structural pass + hand off.** Component 4 owns
  locate → learn → apply → structural-verify (via the Component 2 gate). It then
  hands the APK to omnidroid's EXISTING boot+bypass functional-test flow. It does
  NOT reimplement functional testing, and it does NOT pull the emulator (or the
  open stale-QEMU concern) into itself.

## Non-negotiable constraint: no main-agent hardcoding

**Component 4 makes ZERO changes to `agent.py` or the main loop.** The workflow
lives entirely in a skill (opt-in via `use_skill`) plus one opt-in tool. If the
user asks for something else — e.g. "just run this APK on the emulator" — the
agent never loads the skill, never decodes, never records anything. The
learn→apply workflow governs behavior ONLY when the agent chooses to load the
skill for a learn-and-apply task, exactly as `apk-modding` and
`manifest-resource-editing` are opt-in today. No lifecycle hooks, no forced
ordering in engine code, no `start_session` wiring.

## Architecture

Component 4 = **one skill + one new tool**, orchestrating existing tools.

```
LOCATE      compare_directories (file-level) + diff_code_graphs (method-level)
              → what changed between reference-mod and reference-base
   ↓
COMPREHEND  query_code_graph + jadx_decompile + search_smali on those sites
              → the agent UNDERSTANDS the technique
   ↓
RECORD      record_learned_technique(...)   ← the one new tool
              → structured artifact: technique, mechanism, hook points,
                entry point, native/asset additions
              → surfaced (echo-back); becomes the apply plan
              → auto-derives + declares Component 2 constraints
   ↓
APPLY       for each hook point: resolve the equivalent site in the TARGET via
              query_code_graph (by class+method NAME, never by file path) →
              patch_smali_method / insert_smali_code → recompile_apk
   ↓
VERIFY      constraint gate (Component 2, already built) — structural
   ↓
HAND OFF    existing omnidroid boot+bypass functional-test flow
```

**What is new:** the skill, and the `record_learned_technique` tool.
**What is reused:** everything else — `decode_apk`, `compare_directories`,
`diff_code_graphs`, `query_code_graph`, `jadx_decompile`, `search_smali`,
`patch_smali_method`, `insert_smali_code`, `recompile_apk` + the constraint
gate, and the omnidroid test flow.

## The new primitive: `record_learned_technique`

A tool built exactly like `declare_constraints` (validate → store → echo). It
captures the agent's understanding as structured data:

```json
{
  "technique": "SSL-pinning bypass",
  "mechanism": "hooks TrustManagerImpl.verifyChain() to return without throwing",
  "hook_points": [
    {"class": ".../TrustManagerImpl", "method": "verifyChain",
     "edit": "insert early return / remove throw", "dex": "classes4.dex"}
  ],
  "entry_point": "static init in classes4.dex",
  "native_additions": [],
  "asset_additions": [],
  "notes": "..."
}
```

It does three things, in order of importance:

1. **Echo-back checkpoint.** Written BEFORE the target is edited, surfaced to the
   operator and logged, and it becomes the plan the apply phase follows — the
   same "state what you understood before you act" discipline as
   `declare_constraints`.

2. **Auto-arms the gate.** `record_learned_technique` derives constraints from
   its own fields and calls `declare_constraints` internally:
   - `native_additions: []` → `no_new_files_matching *.so`
   - a `classes4.dex` hook point → `file_present classes4.dex`
   - `asset_additions: []` → `no_new_files_matching assets/*` (as applicable)
   So the agent's *claim* about the technique becomes the machine-check on its
   *application*. If it says "no new .so" and then adds one, the Component 2 gate
   fails the build. Learn and verify reinforce each other with no extra step.

   **Merge, don't clobber.** `declare_constraints` REPLACES the constraint set
   (Task 8 semantics). So `record_learned_technique` must NOT blindly call it —
   that would erase any constraints the user already stated for the mission.
   Instead it reads `get_mission_constraints()`, forms the UNION of the existing
   set and its derived set (de-duplicated on `(kind, pattern)`), and declares
   that union. Result: user-stated constraints and technique-derived constraints
   coexist; neither silently wins. If the two genuinely conflict (e.g. the user
   said `file_present libX.so` but the learned technique says
   `no_new_files_matching *.so`), both are declared and the build simply cannot
   satisfy both — the gate reports it, which is the correct, visible outcome
   rather than a silent override.

3. **Apply plan.** The `hook_points` list is the checklist the apply phase walks.

**Storage:** a workspace-local file (`learned_technique.json` in the per-project
workspace) plus a `record_finding` entry for the evidence trail. Because it is
workspace-local, it is naturally project-scoped and needs NO process-global
reset — and its only cross-cutting side-effect (the declared constraints) already
resets at `start_session` via the existing mission-constraints lifecycle. No new
`agent.py` wiring.

## The skill: `learn-and-apply-modification`

A standard skill (`skills/learn-and-apply-modification/SKILL.md`) with
frontmatter `name` / `description` / `when_to_use` / `allowed-tools`. Loaded via
`use_skill` only when the task is "learn a modification from a reference APK and
apply it."

`allowed-tools`: `decode_apk`, `compare_directories`, `diff_code_graphs`,
`query_code_graph`, `jadx_decompile`, `search_smali`,
`record_learned_technique`, `patch_smali_method`, `insert_smali_code`,
`recompile_apk`, `sign_apk`, `verify_apk`.

The skill body enforces the workflow ordering **as instructions to the agent**
(not as engine code). Its one hard rule: **do not edit the target before
`record_learned_technique` has been called** — the checkpoint is mandatory. It
also directs name-based hook resolution in the apply phase (see below).

## The one real risk: hook relocation

Reference and target are near-identical, but apktool/APKEditor can rename or
renumber smali paths between builds, so a hook at
`classes4.dex/.../verifyChain` in the reference may live at a different path in
the target. The apply phase therefore resolves each hook point by
**`query_code_graph` on class+method NAME, never by file path** — the graph
finds the method wherever it landed. This is the load-bearing use of the code
graph (issue #3), and a mis-resolution is caught downstream by the constraint
gate.

## Error handling

| Situation | Behavior |
|---|---|
| Reference pair not near-identical (large divergence) | Locate step surfaces the scale of divergence; agent reports it can't reliably learn rather than guessing. Out-of-scope inputs fail loudly, not silently. |
| A hook point has no counterpart in the target | Reported as a failed apply step (like a failed patch), not silently skipped. |
| Applied build violates a derived constraint | Component 2 gate fails the build, feeds back the specific delta, capped retries — the existing machinery. |
| Agent tries to edit target before recording the technique | The skill instructs against it; there is no engine gate (per the no-hardcoding rule), so this is a skill-adherence expectation, surfaced in the skill body as the hard rule. |

## Testing

- **`record_learned_technique`** (unit, offline): schema validation, echo
  content, and the auto-constraint derivation (`native_additions: []` →
  `no_new_files_matching *.so`; a `classes4.dex` hook → `file_present
  classes4.dex`) — mirrors the `declare_constraints` tests. Also: after
  recording, `get_mission_constraints()` reflects the UNION of any pre-existing
  user-declared constraints and the derived set (de-duplicated), and a
  pre-existing user constraint is NOT clobbered by recording a technique.
- **Skill loads + `allowed-tools` resolve** against the live registry — the same
  check applied to `android-package-anatomy` / `apk-toolchain`.
- **Full learn→apply→verify loop**: needs the LLM + real APKs, so it is
  validated by a REAL run, not a unit test. The user's `instance create/` pairs
  (modified + base) are natural fixtures for the LOCATE step.

No `agent.py` changes means no new session/loop tests are required.

## Out of scope

- **Cross-application technique transfer** (learn from app A, apply to unrelated
  app B). Near-identical builds only.
- **Functional verification** (does the bypass actually work at runtime) — owned
  by the existing omnidroid test flow, which Component 4 hands off to.
- **Any `agent.py` / main-loop change.** Explicitly excluded.
- **The stale-QEMU concern** — Component 4 doesn't touch the emulator, so it is
  unaffected; it remains an omnidroid-side issue.

## Sequencing

1. `record_learned_technique` tool (+ auto-constraint derivation, + tests) —
   the one new primitive, offline-testable, no dependencies beyond the existing
   `declare_constraints`.
2. `learn-and-apply-modification` skill (+ load/allowed-tools test) — wires the
   workflow around the primitive and existing tools.
3. Documentation cross-links (relate it to `apk-modding`, `apk-toolchain`,
   `android-package-anatomy`).
