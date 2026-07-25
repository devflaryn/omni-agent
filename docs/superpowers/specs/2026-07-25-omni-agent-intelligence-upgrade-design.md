# Omni-Agent intelligence upgrade — design

Date: 2026-07-25
Status: implemented

## Goal

Make omni-agent (a) reliably reach for the APK-modding knowledge and code-graph
tools it already has, (b) know the concrete procedures/structure it kept getting
wrong in overnight runs, and (c) show a working subagent telemetry UI — concurrent
agents, tokens used, and elapsed time.

## Key finding that shaped the design

Almost everything the goal asked for **already existed** and was well-built:

- 21 APK/RE skills (apk-modding, native-patching, the bypasses, code-graph-analysis,
  emulator-management, …), plus a deep `android-package-anatomy` and `apk-toolchain`.
- Code-graph tools (`build_code_graph`/`query_code_graph`, 9 query types) and
  `ask_codebase`.
- A subagent concurrency dock in `frontend/app.js`, and backend telemetry events
  (`wave_started`/`subagent_*`/`wave_done`) carrying tokens + elapsed + steps.
- Guards in `agent.py`: a skill guard, a code-graph "stop reading files one-by-one"
  guard, a watchdog, and an opt-in post-mutation validation nudge.

The overnight logs (`overnight tests/arceus clone`, `concurrency test`) showed the
agent actually decoded, injected custom smali, stripped ABIs, rebuilt, signed,
verified, and launched the APK. The failures were **not missing knowledge**:

1. It burned huge effort chasing a native anti-tamper patch that wasn't needed
   (the plain re-signed APK launched fine) — never validated the assumption.
2. Path confusion between the apktool layout (`lib/`) and the APKEditor layout
   used for Roblox (`root/lib/`).
3. Tool friction (emulator account hardcoding, `sign_apk` arg name).
4. The subagent dock **never appeared** for deliberate delegation.

So the work is targeted fixes, not greenfield.

## Workstream A — Subagent session HUD

**Root cause of "doesn't show up":** `dispatch_agents` and the synthesizer called
`run_subagents_parallel`/`run_subagent` with **no `on_event`**, so deliberate
delegation emitted zero telemetry. Only the planner's auto read-wave (which does
thread `on_event`) and a dev demo button fed the dock.

**Backend fix:** a process-global UI sink in `subagents.py` (`set_ui_sink`/`ui_emit`),
wired to `AgentApi._emit`. `dispatch_agents` now runs its wave in a background
thread and drains the telemetry queue on the agent-loop thread into `ui_emit`
(mirroring `_run_delegated_read_wave`), so the webview is only ever poked from one
thread. The synthesizer is wired the same way.

**Frontend:** the per-wave dock gains a **persistent session HUD** — elapsed timer,
live "N running · M done", and a cumulative token total across all subagents. It
spans a whole run of subagent activity (survives across waves), appears on the
first subagent, and freezes (keeping the tally) when the run ends. All accounting
lives in a DOM-free `SessionHudModel` (wave_stats.js) so it unit-tests under node;
app.js is only the ticker + DOM writes. Instantiated lazily because app.js is not
deferred but wave_stats.js is.

## Workstream C — Make it use what it has

The code-graph guard and post-mutation validation guard already existed, so the
real gap was the **skill guard latching off permanently after the first
`use_skill`** — load apk-modding once and it never steers again, exactly the
anti-tamper rabbit hole. Fix: the guard no longer permanently disarms; loading a
skill resets the counter but a fresh streak of domain work re-arms it and emits a
**specific** nudge naming the prior skill and the sub-task shift (and the
"confirm the crash before chasing a native anti-tamper patch" lesson). Bounded to
`MAX_SKILL_NUDGES` per task so it can never nag.

## Workstream B — Deepen the knowledge (procedural)

The anatomy/toolchain skills were already deep on concepts; the gap was concrete
procedure. Added two bundled references under `apk-toolchain` (auto-discovered,
pulled via `read_skill_resource`) and linked them from `apk-toolchain` and
`apk-modding`:

- `reference/decoded-tree-layout.md` — the two real on-disk layouts `decode_apk`
  produces: apktool (`lib/<abi>/`) vs APKEditor (auto-used for multi-package apps
  **like Roblox**, libs at `root/lib/<abi>/`), how to tell them apart, and the
  consequences for ABI-strip / .so swap / adding a dex.
- `reference/known-traps.md` — overnight-verified traps: re-signing usually beats
  chasing anti-tamper (confirm the crash first); native `bl→RET` breaking JNI
  `RegisterNatives`; `sign_apk` uses `apk_filename`; `$` in inner-class smali
  filenames; assembling a dex when the tool finds 0 files; verifying dex count;
  emulator account/signature-mismatch pitfalls.

## Tests

- `tests/test_dispatch_agents_telemetry.py` — dispatch_agents forwards ordered
  telemetry to the UI sink, only from the calling thread; silent with no sink.
- `tests/test_skill_guard_rearm.py` — first-streak nudge, re-arm after a skill
  load, no nagging when skills are used periodically, bounded nudges.
- `tests/frontend/test_wave_stats.mjs` — formatDuration/formatTokens/
  computeSessionHud and the full SessionHudModel lifecycle.
- `tests/frontend/test_hud_integration.mjs` — loads the REAL shipped `app.js` (+
  `wave_stats.js`) in a VM over a minimal DOM shim, fires the exact delegating-run
  telemetry sequence through `window.__agent.onEvent`, and asserts the HUD element
  appears and shows 2→1→0 running, 0→2 done, 7k cumulative tokens, 03:42 elapsed.
  Together with the backend telemetry test this proves the full chain
  (dispatch_agents → events → HUD renders) against real code, no browser/LLM.

## Bonus: false-success bug found by running the pipeline

Driving the real agent loop through a full ABI-strip mod (scripted tool selection,
real tools) surfaced a concrete reliability bug: `delete_path` runs `rm -rf`, which
exits 0 even on a missing/unmounted path, so a **no-op was reported as success**.
The rebuilt APK still had all 3 ABIs (214 MB) while every tool said `[ok]` and
`verify_apk` passed — because verify checks signature/structure, not "did my
intended change happen." This is the exact false-success class behind the flaky
overnight mods. Fixed in `tools/filesystem.py`: `delete_path` now probes existence
first (errors with a `root/`-layout hint if absent) and confirms removal after
(errors if still present). After the fix, the same pipeline produced a genuinely
arm64-only APK (125 MB, `lib/arm64-v8a/` only), signed and verified.
`tests/test_delete_path_no_op.py` locks in the behavior (absent → error,
present→removed → success, present→still-present → error, rm-failure propagated,
workspace-root guarded).

## Out of scope (deferred)

Tool friction (emulator account targeting, path resolution for
`launch_roblox_build`) — real but separate hardening, not this pass.

## Verification

499 passed / 3 skipped (one pre-existing unrelated collection error in
`test_thought_wrap.py`). Frontend node tests green. Live GUI smoke of the HUD
(open app → delegate, or `__demoWave(3)` in console) is the human confirmation
step; the desktop GUI can't be launched headlessly.
