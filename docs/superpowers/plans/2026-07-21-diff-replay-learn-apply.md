# Component 4: Learn-and-Apply Modification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a `record_learned_technique` tool and a `learn-and-apply-modification` skill so it can learn a modification from a working modified APK + its base, then reconstruct it on a target — with the learned technique auto-arming the Component 2 constraint gate.

**Architecture:** One new pure tool module (`tools/learned_technique.py`) that validates a structured learned-technique artifact, stores it, derives Component 2 constraints from it, and declares the UNION of those with any pre-existing user constraints (never clobbering). One opt-in skill orchestrating the existing locate/comprehend/apply/verify tools around that primitive. ZERO changes to `agent.py` — the workflow is skill guidance loaded via `use_skill`, never engine code.

**Tech Stack:** Python 3, pytest (repo-root imports, no config), stdlib only. Reuses `tools/mission_constraints.py` (`declare_constraints`, `get_mission_constraints`, `KINDS` via `tools/constraints.py`).

## Global Constraints

- Run tests from repo root: `python3 -m pytest tests/<file> -q`. No pytest config; tests use repo-root imports (`from tools import ...`).
- **`/tests/` is gitignored (`.gitignore:38`), NO test file is tracked — deliberate project policy.** Write tests, run them locally, but **commit SOURCE ONLY**. Never `git add tests/...`, never `git add -f`. A tests-only task has nothing to commit — say so.
- **ZERO `agent.py` / main-loop changes.** Component 4 is one opt-in tool + one opt-in skill. No lifecycle hooks, no forced ordering in engine code, no `start_session` wiring. (The tool's only stateful side effect — declared constraints — already resets at `start_session` via the existing mission-constraints lifecycle.)
- Tools register via `@registry.register(name=, description=, params_schema=, output=, when_to_use=)` from `tool_registry`; the decorator returns the function unchanged (directly callable in tests).
- Constraint vocabulary stays app-agnostic. `KINDS` = `("file_present", "file_absent", "no_new_files_matching", "file_set_unchanged", "file_unmodified")`. `fnmatch` `*` matches `/`, so use `*.so`, never `lib/**/*.so`.
- `declare_constraints(list)` REPLACES the mission set and resets the retry counter; it validates each `{kind, pattern}` and returns `{"message": ...}` or `{"error": ...}`. `get_mission_constraints()` returns `list(_DECLARED)`.
- Work directly on `main`. Every task ends with a commit of its SOURCE, where it has any.

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `tools/learned_technique.py` | Artifact schema validate + store + echo; constraint derivation + union-merge | Create (Tasks 1, 2) |
| `tests/test_learned_technique.py` | Tool validation/echo + derivation/union tests | Create (Tasks 1, 2) |
| `skills/learn-and-apply-modification/SKILL.md` | The opt-in learn→apply→verify workflow | Create (Task 3) |
| `tests/test_learn_apply_skill.py` | Skill loads + allowed-tools resolve | Create (Task 3) |

---

## Task 1: The `record_learned_technique` tool — validate, store, echo

**Files:**
- Create: `tools/learned_technique.py`
- Test: `tests/test_learned_technique.py`

**Interfaces:**
- Consumes: `tool_registry.registry`.
- Produces:
  - `record_learned_technique(technique=None, mechanism=None, hook_points=None, entry_point=None, native_additions=None, asset_additions=None, notes=None)` — registered tool. Returns `{"message": <echo>}` on success, `{"error": <str>}` on invalid input. (Constraint side effect added in Task 2 — not yet here.)
  - `get_learned_technique() -> dict | None` (a copy of the stored artifact).
  - `reset_learned_technique()` — clears the store (for test isolation; NOT wired to agent.py).

- [ ] **Step 1: Write the failing test**

Create `tests/test_learned_technique.py`:

```python
from tools import learned_technique as lt


def setup_function():
    lt.reset_learned_technique()


def _valid_hook():
    return [{"class": "La/b/TrustManagerImpl;", "method": "verifyChain",
             "edit": "insert early return", "dex": "classes4.dex"}]


def test_valid_record_stores_and_echoes():
    res = lt.record_learned_technique(
        technique="SSL-pinning bypass",
        mechanism="hooks verifyChain() to return without throwing",
        hook_points=_valid_hook())
    assert "error" not in res
    assert "SSL-pinning bypass" in res["message"]
    assert "verifyChain" in res["message"]
    stored = lt.get_learned_technique()
    assert stored["technique"] == "SSL-pinning bypass"
    assert stored["hook_points"][0]["method"] == "verifyChain"


def test_missing_technique_label_rejected():
    res = lt.record_learned_technique(
        technique="", mechanism="x", hook_points=_valid_hook())
    assert "error" in res
    assert lt.get_learned_technique() is None


def test_missing_mechanism_rejected():
    res = lt.record_learned_technique(
        technique="t", mechanism="   ", hook_points=_valid_hook())
    assert "error" in res


def test_no_hook_points_rejected():
    res = lt.record_learned_technique(
        technique="t", mechanism="m", hook_points=[])
    assert "error" in res
    assert "hook_point" in res["error"]


def test_hook_point_missing_class_or_method_rejected():
    res = lt.record_learned_technique(
        technique="t", mechanism="m",
        hook_points=[{"class": "La/b;", "edit": "x"}])  # no method
    assert "error" in res


def test_get_returns_copy_not_live_ref():
    lt.record_learned_technique(
        technique="t", mechanism="m", hook_points=_valid_hook())
    got = lt.get_learned_technique()
    got["technique"] = "mutated"
    assert lt.get_learned_technique()["technique"] == "t"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_learned_technique.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'tools.learned_technique'`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/learned_technique.py`:

```python
"""Learn-and-apply: the learned-technique artifact primitive.

Component 4 of the enforcement work. The agent studies a working modified APK
against its base, then records — as a STRUCTURED artifact — what it understood
BEFORE it touches the target. This is the echo-back checkpoint and the plan the
apply phase follows. Constraint derivation (auto-arming the Component 2 gate) is
added in the neighbouring function `_derive_constraints` / the record path.

Pure module: no agent.py coupling, no sandbox I/O. Durable per-project
persistence of the artifact (write_file learned_technique.json) is done by the
skill, keeping this tool offline-testable."""
from tool_registry import registry

# Live handle for the current mission's learned technique (or None). A learn
# task REPLACES it wholesale; a non-learn task never reads it, so a stale value
# is harmless and needs no session reset.
_LEARNED = {"artifact": None}

_ARTIFACT_KEYS = ("technique", "mechanism", "hook_points", "entry_point",
                  "native_additions", "asset_additions", "notes")


def get_learned_technique():
    """A copy of the current mission's learned-technique artifact, or None."""
    a = _LEARNED["artifact"]
    return dict(a) if a else None


def reset_learned_technique():
    """Clear the stored artifact (test isolation; not wired to agent.py)."""
    _LEARNED["artifact"] = None


def _validate(technique, mechanism, hook_points):
    """Return an error string if the core fields are invalid, else None."""
    if not isinstance(technique, str) or not technique.strip():
        return "record_learned_technique needs a non-empty 'technique' label."
    if not isinstance(mechanism, str) or not mechanism.strip():
        return "record_learned_technique needs a non-empty 'mechanism'."
    if not isinstance(hook_points, list) or not hook_points:
        return ("record_learned_technique needs at least one hook_point "
                "{class, method, edit}.")
    for i, hp in enumerate(hook_points):
        if not isinstance(hp, dict) or not hp.get("class") or not hp.get("method"):
            return f"hook_point {i} needs at least 'class' and 'method'."
    return None


@registry.register(
    name="record_learned_technique",
    description=(
        "Record — as a structured artifact — the modification technique you "
        "learned from a working modified APK and its base, BEFORE you edit the "
        "target. This is a mandatory checkpoint in the learn-and-apply workflow: "
        "it echoes back what you understood (so a misread is caught early), it "
        "is the plan the apply phase follows, and it auto-declares the build "
        "constraints that verify your reconstruction. Do NOT edit the target "
        "before calling this."),
    params_schema={
        "technique": "string — short label, e.g. 'SSL-pinning bypass'.",
        "mechanism": "string — how it works in one or two sentences.",
        "hook_points": ("array of objects, each {\"class\": string, "
                        "\"method\": string, \"edit\": string, \"dex\": string "
                        "optional}. At least one. class+method are how the apply "
                        "phase RELOCATES the site in the target via the code "
                        "graph (name-based, not file path)."),
        "entry_point": "string (optional) — how the hook gets installed.",
        "native_additions": ("array of strings (optional) — .so files the "
                             "technique ADDS, e.g. ['libX.so']. Empty/omitted "
                             "means it adds none."),
        "asset_additions": "array of strings (optional) — assets added.",
        "notes": "string (optional).",
    },
    output=("A confirmation echoing the recorded technique and the constraints "
            "it armed, or an error naming the missing/invalid field."),
    when_to_use=(
        "In the learn-and-apply workflow, immediately AFTER you have understood "
        "the reference technique (via diff_code_graphs / query_code_graph / "
        "jadx) and BEFORE you edit the target. Never edit the target first."),
)
def record_learned_technique(technique=None, mechanism=None, hook_points=None,
                             entry_point=None, native_additions=None,
                             asset_additions=None, notes=None):
    hook_points = hook_points or []
    err = _validate(technique, mechanism, hook_points)
    if err:
        return {"error": err}
    artifact = {
        "technique": technique.strip(),
        "mechanism": mechanism.strip(),
        "hook_points": hook_points,
        "entry_point": entry_point or "",
        "native_additions": native_additions or [],
        "asset_additions": asset_additions or [],
        "notes": notes or "",
    }
    _LEARNED["artifact"] = artifact

    lines = [f"  - {hp['class']}->{hp['method']}: {hp.get('edit', '')}"
             for hp in hook_points]
    echo = ("Learned technique recorded:\n"
            f"  technique: {artifact['technique']}\n"
            f"  mechanism: {artifact['mechanism']}\n"
            "  hook points:\n" + "\n".join(lines))
    return {"message": echo}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_learned_technique.py -q`
Expected: PASS — 6 passed.

- [ ] **Step 5: Commit (source only)**

```bash
git add tools/learned_technique.py
git commit -m "feat(learn-apply): record_learned_technique artifact tool

Validate + store + echo the structured technique the agent learned from a
reference APK pair. Echo-back checkpoint + apply plan. Pure module, no
agent.py coupling. Constraint auto-arming follows in the next commit."
```

---

## Task 2: Derive constraints and declare the UNION (never clobber)

**Files:**
- Modify: `tools/learned_technique.py`
- Test: `tests/test_learned_technique.py`

**Interfaces:**
- Consumes: `tools.mission_constraints.declare_constraints`, `get_mission_constraints` (existing); the Task 1 `record_learned_technique`.
- Produces:
  - `_derive_constraints(artifact) -> list[dict]` — maps a learned artifact to `{kind, pattern}` constraints.
  - `record_learned_technique` now, after storing, declares the de-duplicated UNION of any pre-existing mission constraints and the derived ones, and names them in the echo. A pre-existing user constraint is never clobbered.

**Derivation rules (exact):**
- `native_additions` empty → add `{"no_new_files_matching", "*.so"}`.
- `native_additions` non-empty → for each `so`, add `{"file_present", so}` (the technique is expected to add it).
- each `hook_point` with a truthy `dex` → add `{"file_present", <dex>}`.
- de-duplicate on `(kind, pattern)`, preserving order.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_learned_technique.py`:

```python
from tools import mission_constraints as mc


def _pairs():
    return {(c["kind"], c["pattern"]) for c in mc.get_mission_constraints()}


def test_no_native_arms_no_new_so():
    mc.reset_mission_constraints()
    lt.record_learned_technique(
        technique="t", mechanism="m", hook_points=_valid_hook(),
        native_additions=[])
    assert ("no_new_files_matching", "*.so") in _pairs()
    # the classes4.dex hook also armed a file_present
    assert ("file_present", "classes4.dex") in _pairs()


def test_declared_native_arms_file_present_for_each():
    mc.reset_mission_constraints()
    lt.record_learned_technique(
        technique="t", mechanism="m",
        hook_points=[{"class": "La;", "method": "m"}],
        native_additions=["libomni-bypass.so"])
    assert ("file_present", "libomni-bypass.so") in _pairs()
    assert ("no_new_files_matching", "*.so") not in _pairs()


def test_union_does_not_clobber_user_constraints():
    mc.reset_mission_constraints()
    mc.declare_constraints([{"kind": "file_absent", "pattern": "*.bak"}])
    lt.record_learned_technique(
        technique="t", mechanism="m", hook_points=_valid_hook(),
        native_additions=[])
    pairs = _pairs()
    assert ("file_absent", "*.bak") in pairs          # user constraint kept
    assert ("no_new_files_matching", "*.so") in pairs  # derived added


def test_derived_constraints_are_deduped():
    mc.reset_mission_constraints()
    # two hook points in the same dex → only one file_present for it
    lt.record_learned_technique(
        technique="t", mechanism="m",
        hook_points=[{"class": "La;", "method": "x", "dex": "classes4.dex"},
                     {"class": "Lb;", "method": "y", "dex": "classes4.dex"}],
        native_additions=[])
    c4 = [p for p in _pairs() if p == ("file_present", "classes4.dex")]
    assert len(c4) == 1


def test_echo_names_the_armed_constraints():
    mc.reset_mission_constraints()
    res = lt.record_learned_technique(
        technique="t", mechanism="m", hook_points=_valid_hook(),
        native_additions=[])
    assert "no_new_files_matching" in res["message"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_learned_technique.py::test_no_native_arms_no_new_so -q`
Expected: FAIL — `AssertionError` (no constraints declared; `record_learned_technique` doesn't touch them yet).

- [ ] **Step 3: Write minimal implementation**

In `tools/learned_technique.py`, add the import near the top:

```python
from tools import mission_constraints as _mission
```

Add the derivation helper above `record_learned_technique`:

```python
def _derive_constraints(artifact):
    """Map a learned technique to Component 2 constraints (deduped, ordered)."""
    derived = []
    native = artifact.get("native_additions") or []
    if native:
        for so in native:
            derived.append({"kind": "file_present", "pattern": so})
    else:
        derived.append({"kind": "no_new_files_matching", "pattern": "*.so"})
    for hp in artifact.get("hook_points", []):
        dex = hp.get("dex")
        if dex:
            derived.append({"kind": "file_present", "pattern": dex})
    seen, out = set(), []
    for c in derived:
        key = (c["kind"], c["pattern"])
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out
```

Then, in `record_learned_technique`, immediately after `_LEARNED["artifact"] = artifact` and before building the echo, insert:

```python
    # Auto-arm the Component 2 gate. UNION with any constraints already declared
    # so a user-stated constraint is never clobbered (declare_constraints
    # REPLACES its set). De-dup on (kind, pattern), existing first.
    derived = _derive_constraints(artifact)
    union, seen = [], set()
    for c in _mission.get_mission_constraints() + derived:
        key = (c["kind"], c["pattern"])
        if key not in seen:
            seen.add(key)
            union.append(c)
    _mission.declare_constraints(union)
```

Then extend the echo (replace the `echo = (...)` assignment) to name the armed constraints:

```python
    armed = ", ".join(f"{c['kind']}({c['pattern']})" for c in union) or "none"
    echo = ("Learned technique recorded:\n"
            f"  technique: {artifact['technique']}\n"
            f"  mechanism: {artifact['mechanism']}\n"
            "  hook points:\n" + "\n".join(lines)
            + f"\n  constraints armed: {armed}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_learned_technique.py tests/test_mission_constraints.py -q`
Expected: PASS. All Task 1 tests still pass; the 5 new derivation/union tests pass; `test_mission_constraints.py` is unaffected.

- [ ] **Step 5: Commit (source only)**

```bash
git add tools/learned_technique.py
git commit -m "feat(learn-apply): derive + union-declare constraints from technique

native_additions [] -> no_new_files_matching *.so; declared .so -> file_present;
dex hook -> file_present dex. Declares the UNION with existing mission
constraints (deduped), never clobbering user-stated ones. The learned claim
becomes the machine-check on the applied result."
```

---

## Task 3: The `learn-and-apply-modification` skill

**Files:**
- Create: `skills/learn-and-apply-modification/SKILL.md`
- Test: `tests/test_learn_apply_skill.py`

**Interfaces:**
- Consumes: the `record_learned_technique` tool (Tasks 1-2) and existing tools (`decode_apk`, `compare_directories`, `diff_code_graphs`, `query_code_graph`, `jadx_decompile`, `search_smali`, `patch_smali_method`, `insert_smali_code`, `recompile_apk`, `sign_apk`, `verify_apk`).
- Produces: an opt-in skill loadable via `use_skill`, whose `allowed-tools` all resolve against the live registry.

- [ ] **Step 1: Write the failing test**

Create `tests/test_learn_apply_skill.py`:

```python
import importlib
import skills_loader
import tool_registry
# Import the tool modules so the registry is populated before we check refs.
importlib.import_module("tools.apk_tools")
importlib.import_module("tools.investigation_tools")  # registers write_file
importlib.import_module("tools.learned_technique")    # registers the new tool

SKILL = "learn-and-apply-modification"


def _load(name):
    # load_skills() returns a dict keyed by skill name; each value is a dict
    # with keys: name, description, when_to_use, allowed_tools (a LIST),
    # body, dir, resources, source.
    return skills_loader.load_skills().get(name)


def test_skill_loads_with_frontmatter():
    s = _load(SKILL)
    assert s is not None
    assert s.get("when_to_use", "").strip()
    assert s.get("description", "").strip()


def test_allowed_tools_all_registered():
    s = _load(SKILL)
    tools = s.get("allowed_tools") or []          # already a parsed list
    assert isinstance(tools, list)
    assert "record_learned_technique" in tools
    reg = tool_registry.registry
    unregistered = [t for t in tools if not reg.is_registered(t)]
    assert unregistered == [], f"unregistered allowed-tools: {unregistered}"


def test_skill_mandates_record_before_editing_target():
    s = _load(SKILL)
    body = (s.get("body") or "").lower()
    # the hard rule must be present in the skill body
    assert "record_learned_technique" in body
    assert "before" in body and "target" in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_learn_apply_skill.py -q`
Expected: FAIL — `_load(SKILL)` returns None (skill dir doesn't exist yet), so `test_skill_loads_with_frontmatter` fails on `assert s is not None`.

- [ ] **Step 3: Write the skill**

Create `skills/learn-and-apply-modification/SKILL.md`:

```markdown
---
name: learn-and-apply-modification
description: Learn a modification technique from a WORKING modified APK plus its plain base, then reconstruct it on a target APK — understanding the technique, not copying files. Records what it learned as a checkpoint that also arms the build-constraint gate.
when_to_use: Use when the user gives a working modified APK and its base and asks to learn the change/bypass and apply it to the base or a new target (e.g. "learn the bypass on this APK and add it to the base"). NOT for a from-scratch mod (use apk-modding) or a whole-file swap (use apk-toolchain's unzip path).
allowed-tools: decode_apk, compare_directories, diff_code_graphs, query_code_graph, jadx_decompile, search_smali, record_learned_technique, patch_smali_method, insert_smali_code, recompile_apk, sign_apk, verify_apk, write_file
---

# Learn-and-apply modification

You are given a **reference modified APK** and its **plain base**, and a
**target** to reconstruct the change on (often the base itself, or a new
build). Your job is to UNDERSTAND what the reference did and rebuild it on the
target — **never blindly copy the changed files**, because the target is a
different build where copied files may not fit. Read
`android-package-anatomy` and `apk-toolchain` first if you are unsure of APK
internals or the decode-vs-unzip rule.

## The hard rule

**Do NOT edit the target until you have called `record_learned_technique`.**
That call is the checkpoint: it echoes back what you understood, becomes your
apply plan, and arms the constraint gate that verifies your result. Editing
first means you are guessing, not applying an understood technique.

## Phase 1 — Locate what changed

1. `decode_apk` the reference-modified APK and the reference-base into their
   canonical decode dirs.
2. `compare_directories` on the two decoded trees → the file-level change set
   (which smali files differ, which libs/assets were added).
3. `diff_code_graphs` on the two → the METHOD-level change set (which methods
   changed), which is what tells you where the technique actually lives.

## Phase 2 — Comprehend the technique

For each changed site: `query_code_graph` (by name), `jadx_decompile`, and
`search_smali` until you can state, in plain terms, WHAT the technique does and
HOW it is wired — which methods are hooked, what the edit is, how the hook is
installed, and whether any native `.so`/asset was added.

## Phase 3 — Record (the checkpoint)

Call `record_learned_technique` with: `technique`, `mechanism`, a `hook_points`
list ({class, method, edit, dex}), `entry_point`, and `native_additions` /
`asset_additions` (empty if none). This echoes your understanding and arms the
gate — e.g. `native_additions: []` means the gate will now REJECT a build that
adds a new `.so`. Then `write_file learned_technique.json` with the same
structure so a durable per-project copy exists for review.

## Phase 4 — Apply to the target

`decode_apk` the target. For EACH hook point, resolve the site in the target by
**`query_code_graph` on class+method NAME — never by the reference's file
path** (apktool/APKEditor can renumber smali paths between builds; the graph
finds the method wherever it landed). Apply the edit with `patch_smali_method`
or `insert_smali_code`. Reproduce the entry-point wiring the same way.

## Phase 5 — Verify and hand off

`recompile_apk` the target **with `original_apk` set to the target's base** so
the constraint gate runs (constraints omitted with a base = unverified = the
tool refuses). The gate checks your reconstruction against what you recorded:
if you said "no new .so" and a `.so` slipped in, the build fails with the
delta — fix and rebuild (bounded retries). Once it passes, `sign_apk` +
`verify_apk`, then hand the signed APK to the normal on-device test flow to
confirm the technique works at runtime. This skill's job ends at a
structurally-verified, signed APK.

## Related skills
- **android-package-anatomy** — what the APK members are; why signing breaks.
- **apk-toolchain** — decode vs unzip; the tool map.
- **apk-modding** — building a modification from scratch (no reference).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_learn_apply_skill.py -q`
Expected: PASS — 3 passed. If `test_allowed_tools_all_registered` reports `write_file` or any tool unregistered, confirm the tool name against the registry (`grep -rn 'name="write_file"' tools/`) and correct the frontmatter to the real name.

- [ ] **Step 5: Commit (source only)**

```bash
git add skills/learn-and-apply-modification/
git commit -m "feat(skills): learn-and-apply-modification workflow

Opt-in skill orchestrating locate (compare_directories/diff_code_graphs) ->
comprehend (query_code_graph/jadx) -> record (checkpoint, arms the gate) ->
apply (name-based hook resolution) -> verify (constraint gate) -> hand off.
No agent.py changes; loaded via use_skill only when the task calls for it."
```

---

## Self-review notes (for the executor)

- **Spec coverage:** Task 1 = artifact validate/store/echo; Task 2 = derivation + union-merge (the keystone synergy); Task 3 = the skill (workflow, hard rule, name-based apply, hand-off). The full learn→apply loop is validated by a REAL run, not unit tests — expected per spec.
- **No `agent.py`:** confirm none of the three tasks touch `agent.py`. If a task feels like it needs to, stop — that violates the core constraint; the behaviour belongs in the skill body.
- **`write_file` in allowed-tools:** verified a real registered tool (registered in `tools/investigation_tools.py`); the Task 3 test imports that module so the registry check passes.
- **Deliberate spec deviation — asset derivation omitted.** The spec floated `asset_additions: [] → no_new_files_matching assets/*` "(as applicable)". Task 2 derives constraints from `native_additions` and `dex` hooks ONLY, not assets: auto-blocking every asset addition would over-constrain legitimate mods (assets change routinely). This is intentional, not a gap. The agent can still `declare_constraints` an asset rule explicitly when a mission needs it.
