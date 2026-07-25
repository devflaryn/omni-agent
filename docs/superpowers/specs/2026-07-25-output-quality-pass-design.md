# Omni-Agent output-quality pass — design

Date: 2026-07-25
Status: approved (user away — full automation mandate)

## Goal

Improve the *output quality* of the reverse-engineering / APK-modding agent
**without changing model quality**. The lever is reliability and ground-truth:
make a fixed model waste fewer turns, stop trusting false signals, and reach for
the correct APK procedure. Plus one explicit UX ask: the Stop button must abort
**immediately**.

User picked a focused high-leverage set (not a full roadmap). Priority levers:
tool ground-truth / anti-false-success, and anti-rabbit-hole assumption checks.

## Workstreams

### 1. Immediate stop

**Problem.** `AgentEngine.stop()` sets `self._stop = True`, checked only *between*
loop steps ("will halt before the next LLM call"). The two blocking operations —
the buffered `requests.post` to the LLM (up to `REQUEST_TIMEOUT=300s`) and a
running `docker exec` tool subprocess (`_run_polling`) — never observe it, so a
press can hang for minutes.

**Decision.** Truly instant stop, accepting the cost: the in-flight LLM request's
tokens are wasted and a killed tool's inner container command may still finish.

**Design.**
- **LLM side (llm.py).** A helper `_await_or_stop(fn)` runs `fn` on a daemon
  thread and polls `_stop_requested()` every ~0.1s; on stop it returns the
  `_stopped_response()` sentinel immediately and abandons the orphan thread.
  Wrap the `_run_group(...)` call inside `ask_llm`'s loop with it — one call site,
  covers every provider/protocol (openai + anthropic) without touching the three
  `requests.post` bodies. State left partially updated by an abandoned group is
  acceptable for a stop.
- **Tool side (docker_sandbox.py).** Add a module-level stop predicate
  (`set_stop_check` mirroring llm.py) polled inside `_run_polling`'s
  `reader.join(window)` loop using a short (~0.2s) window; on stop, `proc.kill()`
  and return `{"stdout":..., "stderr":"[stopped by user]", "returncode":130,
  "stopped": True}`. `agent.py` registers the same `lambda: self._stop` it already
  registers with llm.
- **UX (agent.py).** `stop()`'s emitted message becomes "Stopping now — aborting
  the current step." (was "will halt before the next LLM call").

**Approaches rejected.** (A) Streaming + per-chunk poll — 3 request paths and
native tool-calling make streaming high-blast-radius. (C) `response.close()` from
the stop handler — fiddly cross-thread teardown of a buffered POST.

### 2. Tool ground-truth (anti-false-success)

**Problem.** The `delete_path` `rm`-exits-0 no-op bug (already fixed) is one
instance of a class: mutating file tools trust `returncode == 0` and report
success on a silent no-op (wrong path, bad mount, APKEditor `root/` layout). A
downstream `verify_apk` checks structure/signature, not "did my change happen",
so the false success survives to the end of a run.

**Design.** Post-condition verification on each mutating file tool, mirroring the
`delete_path` fix. A small `_confirm_*` helper in `tools/filesystem.py` runs a
`test -e` / `stat` probe via `run_cmd`:
- `write_file` → file exists **and** byte size == `len(content.encode())`.
- `move_file` → source **absent** and destination **present**.
- `duplicate_file` → destination **present**.
- `recompile_apk` → output APK exists and is non-empty (audit current impl in
  `tools/apk_tools.py`; harden only if it doesn't already confirm this).

On mismatch, return an `{"error": ...}` with a layout hint (same style as
`delete_path`), so the agent must react instead of trusting a phantom success.
Scope is deliberately the file-mutation class + recompile; byte/smali patches are
validated by later disassembly/build and are out of scope here.

### 3. Anti-rabbit-hole assumption check

**Problem.** The overnight failure where the agent spent large effort patching a
native anti-tamper check that was never the cause — the plain re-signed APK
launched fine. It ran the *expensive* speculation before the *cheap* check.

**Design.** An assumption gate built on the existing `evidence_guards` session
flags in `agent.py`. Track whether an **observed run of the current build** has
happened — an `install_apk_on_emulator` / `launch_app_on_emulator` /
`run_apk_test_session` (or a logcat read) **since the last `recompile_apk`/
`sign_apk`**. When a costly native-mutation tool is requested while that signal is
absent, inject **one** bounded `[SYSTEM]` nudge:

> Before patching native code, confirm the plain re-signed APK actually crashes —
> install and observe. A native `bl→RET`/NOP that yields `UnsatisfiedLinkError`
> broke JNI `RegisterNatives`, not an anti-tamper check.

Costly native-mutation tools (new policy set `NATIVE_SPECULATION_TOOLS` in
`tool_policy.py`): `nop_function`, `patch_function_return`, `assemble_and_patch`,
`compile_c_and_patch`, `binary_patch`, `patch_at_offset_with_bytes`,
`patch_bytes_at_offset`, `patch_binary_string`. Bounded by a
`MAX_ASSUMPTION_NUDGES` counter (reset per task) so it can never nag, exactly like
the skill/graph guards.

### 4. Ghidra: verify, then decide

Ghidra is **not** missing a headless option — `tools/binary_analysis.py`
::`ghidra_decompile` runs `analyzeHeadless`, and the Dockerfile installs Ghidra
11.3.2 + JDK 21 with `JAVA_HOME` pinned. The historical failure is a **stale
sandbox image** (built before the JDK-21 fix → JDK 17 → silent launch failure).

**Procedure (fully automated by the agent, user away).**
1. Rebuild the sandbox image (`docker build -t re_sandbox_env .`).
2. Decode/unzip the test APK
   `~/Desktop/overnight tests/arceus webview/roblox-v2.730.790.apk`, pick a
   **lightweight** `.so`, run `ghidra_decompile` on one function.
3. **Keep** if it yields C pseudocode: add a fast `preflight` self-check (a
   1-function probe surfacing "image needs rebuild" clearly) and keep the
   "first call is slow" UX note. **Remove** only if it genuinely fails on a fresh
   image: delete the tool + Dockerfile install + refs, and document
   `radare2` / `llvm-objdump` as the substitute for reading native logic.

Evidence decides; no assumption-based removal.

**Outcome (verified end-to-end, clean image → clean container → real tool): KEEP.**
The verify step found the failure was **not** JDK — it was two real bugs:
1. **No arm64 decompiler native.** Ghidra ships prebuilt decompiler binaries only
   for linux_x86_64 / mac_* / win; on the Apple-Silicon host the sandbox is arm64
   Linux, so analysis succeeded but the decompiler failed with
   `os/linux_arm_64/decompile does not exist`. Fixed by building it from Ghidra's
   bundled C++ source in the Dockerfile (arm64 only; `make ARCH_TYPE= ghidra_opt`,
   ~20-30s, placed at `os/linux_arm_64/decompile`). The stock Makefile assumes x86
   (defaults `-m32`); clearing `ARCH_TYPE` yields a native aarch64 build.
2. **Jython non-ASCII SyntaxError.** `_ghidra_decompile.py` runs under Ghidra's
   Python-2 Jython, which rejects the em-dashes in its comments without a PEP-263
   `# -*- coding: utf-8 -*-` line — so the post-script never parsed and the tool
   ALWAYS reported "no decompiler output" even when Ghidra ran fine. Fixed by
   adding the coding line.
Also rewrote `ghidra_decompile`'s error diagnostics to name these two causes
(missing arm64 native / Jython encoding) distinctly instead of blaming JDK/path.
Verified: `ghidra_decompile` returns real C pseudocode for arm64 `.so` functions
(e.g. `ANativeWindow_getWidth`, `_FINI_1`) in ~6-8s on a small library.

### 5. Finalize decode-vs-unzip skills

The in-flight (uncommitted) `apk-toolchain` / `apk-modding` rewrite already makes
the governing rule explicit ("code/manifest/resource change → `decode_apk`
(apktool); only whole-file blob swaps → `unzip_apk`") with the tree-layout and
known-traps references. This ask is essentially **done** — light correctness pass
only, no rebuild.

## Testing (TDD)

- `test_stop_immediate.py` — `_await_or_stop` returns the stopped sentinel
  promptly when the wrapped fn blocks and stop flips; `_run_polling` kills and
  returns `stopped` when the stop predicate flips mid-wait. (Uses a fake slow fn /
  a `sleep` docker command; no real LLM.)
- `test_false_success.py` — `write_file` errors on a size mismatch / missing dir;
  `move_file` errors if source remains or dest missing; `duplicate_file` errors if
  dest missing; happy paths still succeed. (`run_cmd` monkeypatched to simulate
  no-op vs real effect — real on-disk round-trip where feasible.)
- `test_assumption_gate.py` — native-speculation tool without an observed run of
  the current build fires exactly one nudge; a prior `launch`/`test_session`
  clears it; bounded by `MAX_ASSUMPTION_NUDGES`; a fresh recompile re-arms it.

## Git

No commits until the user asks. The batch (this pass + the existing uncommitted
intelligence-upgrade work) is staged and reported when green.

## Out of scope

Streaming LLM refactor; hardening every binary/smali patch tool; the deferred
imaging/roblox-extraction, density, and daemon threads from prior specs.
