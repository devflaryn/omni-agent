# omni-agent — macOS port + omnidroid-changes handoff

Written 2026-09-12 from a session that just shipped a large batch of omnidroid
changes (branch `feat/native-window-fast-boot`). This document hands the next
session everything it needs to (1) run omni-agent on macOS instead of Windows,
(2) adapt it to the new omnidroid, and (3) prove a cheap test model can drive
the whole loop end-to-end. **Read this whole file before starting.**

---

## 1. What omni-agent is

A Python agent that reverse-engineers and drives Android/Roblox builds. It was
built and mostly run on **Windows**; the desktop GUI is a `pywebview` window,
and there is a headless runner (`run_headless.py`) that drives the exact same
`AgentApi` loop without the GUI.

- **The "custom LLM" ("Pi").** The normal driver model is a local, uncensored
  **Qwen3.8-27B** served OpenAI-style. `llm_config.json` currently points at it
  via an ngrok tunnel (`https://upfront-immersion-smartly.ngrok-free.dev/v1`,
  model `Qwen3.8-27B-Uncensored-...`), which mirrors the **modal.com**
  deployment. **That deployment is down right now**, which is why testing uses
  a hosted model instead (section 4). The production model IS multimodal (it
  reads screenshots); the test model below is not.
- **Claude Code** is the coding/harness layer beside it (`.claude/`, `AGENTS.md`,
  `CLAUDE.md`, the `skills/` and `superpowers` machinery).
- **The engine it drives is omnidroid**, a sibling checkout at
  `../omnidroid` (i.e. `/Users/berat/Desktop/Omni Apps/omnidroid`). omni-agent
  never re-implements the guest; it shells out to the omnidroid CLI. See
  `tools/android_emulator.py::_find_qemu_manager` — resolution order is
  `QEMU_MANAGER_PATH` env override, then the canonical
  `<Omni Apps>/omnidroid/manager/omni.py` (run with the current interpreter),
  then a bundled fallback. The tool→command map lives in
  `skills/emulator-management/reference/omni-cli.md`.
- **LLM configuration** is data, not code: `PROVIDERS` in `llm.py` defines
  presets (openai / anthropic / gemini / nvidia / cline / lmstudio / ollama /
  **"other" = any OpenAI-compatible base_url**), and `llm_config.json` stores
  the active choice. Two request protocols cover everything: `openai`
  (`POST {base_url}/chat/completions`) and `anthropic` (`POST {base_url}/messages`).

Runtime facts an agent must respect (already true — do not "fix"):
- Instances are **ephemeral**; `omnidroid start <username>` is the one launch
  command and allocates the instance itself. There is no `create`/`play`.
- **Root is baked into every base**; frida hiding (Magisk DenyList + Shamiko)
  makes the app see an unrooted device. The devkit disk (frida-server + the
  `omni-*` tools) attaches **only on a `--debug` boot**.

---

## 2. The new omnidroid changes (what to know and use)

All on omnidroid branch `feat/native-window-fast-boot` (live-verified on this
Mac 2026-09-12; not yet merged). The agent-relevant ones:

1. **frida works on any running instance now, with no pre-planning.**
   New `omnidroid frida <name> --restart` stops a plain instance and relaunches
   it as a `--debug` boot with the SAME account/offset/mode/session, then starts
   frida-server and forwards it. **omni-agent already consumes this** — Task 12
   (commit `ab96843` on the current `ui-revision` branch) added
   `_require_debug_boot(name)`, which `ensure_frida_server` /
   `hide_root_from_app` / `frida_tools._connect` call first: if the instance is
   up without the devkit, they issue `frida --restart` automatically instead of
   dead-ending on "not a debug boot". `ensure_emulator_running(debug=true)` also
   restarts an already-running plain instance. **So the frida side is DONE** —
   your job is to verify it live on macOS, not rewrite it.

2. **`start --apk <file>` is a cached, launchable version.** The first launch
   bakes the build as a content-addressed offset `apk-<sha256[:16]>` (~2 min,
   ~130-400 MB `/data` overlay); every later launch of the **same file** boots
   that cached offset with **no reinstall**. `--apk-once` keeps the old
   throwaway-install path. A cached build never becomes the default offset.
   `offset list` tags cached entries `[apk-cache]`. The agent's
   `play_roblox(apk_path=...)` / `launch_roblox_build(...)` pass `--apk`
   already, so they inherit this for free — but the FIRST run of a new build now
   spends ~2 min baking, and the agent should not treat that as a hang.

3. **`debug-info --json`** now reports `devkit.attached` and, under `frida`, a
   `restart` field naming the exact fix command. `_devkit_attached(name)` in
   `android_emulator.py` reads it.

4. **Native window + faster boot + warm cache** (mostly irrelevant to the
   headless agent, but do not be surprised): `omnidroid start` opens a native
   QEMU window by default; `view`/`view --hide`/`--vnc-viewer` manage it;
   `wait_for_boot` polls faster; there is a new `omnidroid warm
   list|prune|clear|bake` command and the warm-restore cache now says why it
   misses. For headless agent runs, pass `--no-window` (the agent already boots
   headless via `ensure_emulator_running`).

**Adapt work that remains (small):** update
`skills/emulator-management/reference/omni-cli.md` so the documented CLI surface
includes the new commands/flags — `frida <name> --restart`, `--apk`'s caching
behavior + `--apk-once`, `debug-info`'s `frida.restart`, `view --hide` /
`--vnc-viewer`, and the `omnidroid warm …` command — so the model knows they
exist. Do NOT change the tool code for frida (Task 12 did it); only the docs and
whatever the live macOS test proves broken.

---

## 3. Making it run on macOS (it was Windows-native)

omni-agent is mostly cross-platform Python and already has `sys.platform ==
"darwin"` branches, but Windows was the primary target. The things to check, in
order:

1. **Python + venv.** Use the repo's `.venv` (`.venv/bin/python`). Confirm
   `requirements.txt` is installed and `frida==17.15.4` imports (it does — the
   omnidroid live test attached with it). Note: the system `python3` on this Mac
   is Homebrew 3.14 without pytest; the working interpreter for tests is
   `/Library/Frameworks/Python.framework/Versions/3.13/bin/python3`, and the
   venv has pytest.
2. **`host_exec.py`.** This is the biggest Windows assumption. On Windows it
   hunts for Git-for-Windows/MSYS2/WSL `bash.exe`; on macOS it must use the
   system shell (`/bin/zsh` or `/bin/bash`). Confirm its `darwin` branches
   (around the `sys.platform == "darwin"` checks) actually pick a real shell and
   that `git`/`adb` resolve on PATH. Run its guard tests: `.venv/bin/python -m
   pytest -q tests/test_host_exec.py`.
3. **adb.** The emulator tools call `adb` (docstrings say `adb.exe`). Ensure a
   macOS `adb` is on PATH (`brew install android-platform-tools` or the SDK's
   `platform-tools`); `adb version` should work. omnidroid itself already runs
   natively on this arm64 Mac under HVF (no translation) — that is the whole
   reason to be on macOS.
4. **The GUI vs headless.** Don't fight `pywebview` for testing. Use
   `run_headless.py` (it exercises the real loop, tools, guards, skills and
   subagents). Only bring up the pywebview desktop app if the user wants the
   window; on macOS pywebview uses the WKWebView backend.
5. **No hard-coded `C:\` paths, `CREATE_NO_WINDOW`, or cp1252 assumptions** in
   any path you touch — grep `sys.platform`, `os.name == "nt"`, `win32`,
   `.exe`, `C:\\` and make sure each Windows branch has a working non-Windows
   counterpart. Most already do.

Do NOT commit `configs`/keys. The omni-agent repo keeps `tests/` gitignored;
force-add only test files you must, and never commit `openrouter.txt`.

---

## 4. Test model: DeepSeek via OpenRouter (Qwen/modal is down)

For testing the Pi ↔ omnidroid integration while the normal model is offline,
drive the agent with **DeepSeek on OpenRouter** (OpenAI-compatible).

- **Key:** put the OpenRouter API key in `openrouter.txt` at the repo root
  (this file does NOT exist yet — create it, one line, just the key; it is
  gitignored, never commit it). Read it with `open("openrouter.txt").read().strip()`.
- **Provider:** use the built-in **"other" (OpenAI-compatible)** provider —
  `base_url = https://openrouter.ai/api/v1`, `protocol = openai`, api_key = the
  openrouter.txt key. Wire it via `llm_config.json` (add a config with
  `provider: "other"`, that base_url, the key, and the model) OR the provider UI;
  `run_headless.py` reads `llm_config.json`.
- **Model:** the DeepSeek chat model dated **0731** ("deepseek flash 0731").
  Confirm the exact OpenRouter slug at <https://openrouter.ai/models?q=deepseek>
  before setting it (candidates: `deepseek/deepseek-chat-v3-0324`,
  `deepseek/deepseek-chat`, or the 0731-dated variant / its `:free` tier). Set
  `max_tokens`/`context_window` sanely for it. **It is NOT multimodal** — the
  production Qwen model is, so **skip every screenshot/vision step** during this
  test (no `observe_screen` image analysis, no vision cache); test only the
  non-visual control path. Note this limitation is temporary.

### What the test must prove (AI drives it all, automatically)

Run through `run_headless.py --project <a folder with a Roblox APK> --task "…"`
so the MODEL chooses and executes every action (no hand-holding). Confirm
DeepSeek can, on its own:

1. **Boot an instance** — `ensure_emulator_running` (headless) reaches `BOOT_OK`.
2. **Control the machine (clicks land correctly)** — `tap_screen(x,y)`,
   `type_text`, `swipe_screen`, `press_key` on the running instance. These go
   through **adb** (cross-platform), so verify a tap actually lands where
   intended (e.g. tap a known on-screen control and confirm the app reacts via
   logcat / foreground state — NOT via a screenshot, since the model can't see).
3. **Interact with the application** — drive the app under test (launch it,
   send it through a couple of states) using the tap/type/key tools + `adb_shell`
   + `emulator_debug_info` to read foreground/pid state instead of images.
4. **Run frida hooks** — `ensure_frida_server()` (which now auto-restarts into a
   debug boot via `omnidroid frida --restart`), then a `frida_run_script` /
   `frida_trace` hook attaches and returns output; `hide_root_from_app(<pkg>)`
   applies. Prove a real hook fires.
5. **Boot a custom APK** — `play_roblox(apk_path=...)` or a `start --apk <file>`
   path: first run bakes the cached offset, a second run of the same file boots
   it with no reinstall (check `offset list` shows `[apk-cache]` and the second
   run has no `apk_install` stage). This is the "set the application using an
   apk tag and boot the instance with a custom apk" flow.

Because the model can't see images, lean on **text signals** for every check:
`emulator_debug_info` (`foreground`, `root`, `frida`, `can{}`), `get_logcat` /
`monitor_logcat`, `run_root_command`, and omnidroid's own JSON. Confirm the
whole loop runs unattended (the headless runner streams a compact live log;
`--max-seconds 0` = no cap, `--resume` continues a crashed run).

---

## 5. The full working prompt (structured)

Paste this into a fresh omni-agent session (Claude Code in
`/Users/berat/Desktop/Omni Apps/omni-agent`) to do the work:

> Read `HANDOFF.md` in this repo first, then `AGENTS.md`,
> `skills/emulator-management/SKILL.md`, and
> `skills/emulator-management/reference/omni-cli.md`. Work in three phases,
> committing after each, and use the brainstorming/plan skills before writing
> code. **Phase 1 — macOS port:** make omni-agent run on this arm64 Mac instead
> of Windows. Audit every `sys.platform`/`os.name == "nt"`/`win32`/`.exe`/`C:\`
> branch (start with `host_exec.py`'s shell discovery — it must pick `/bin/zsh`
> or `/bin/bash` on darwin, not `bash.exe`), make sure `adb` and `git` resolve
> on PATH, and get `run_headless.py` to start a run without the pywebview GUI.
> Prove it with `.venv/bin/python -m pytest -q tests/test_host_exec.py` and a
> dry `run_headless.py` boot. **Phase 2 — adapt to the new omnidroid** (branch
> `../omnidroid` @ `feat/native-window-fast-boot`, live-verified): the frida
> tool code is ALREADY adapted (Task 12 added `_require_debug_boot` +
> `frida --restart` auto-restart — do not rewrite it), so only update
> `skills/emulator-management/reference/omni-cli.md` to document the new surface
> (`frida <name> --restart`, `--apk` content-addressed caching + `--apk-once`,
> `debug-info`'s `frida.restart`/`devkit.attached`, `view --hide`/`--vnc-viewer`,
> and `omnidroid warm list|prune|clear|bake`), and fix anything the Phase-3 live
> test proves broken on macOS. **Phase 3 — test with DeepSeek on OpenRouter**
> (the normal Qwen/modal model is down): create `openrouter.txt` (one line, the
> key; gitignored, never commit it), configure the "other" OpenAI-compatible
> provider in `llm_config.json` with `base_url=https://openrouter.ai/api/v1`,
> that key, and the DeepSeek "flash 0731" model (verify its exact slug on
> openrouter.ai/models first). Then, via `run_headless.py`, prove the DeepSeek
> model drives the WHOLE loop unattended: boots an instance, sends taps/types/
> swipes that land correctly (verify via logcat/foreground, not screenshots),
> interacts with the app, runs a real frida hook (`ensure_frida_server` →
> `frida_run_script`) and `hide_root_from_app`, and boots a custom APK through
> the `--apk` cache (first bakes, second hits with no reinstall). DeepSeek is
> NOT multimodal, so SKIP all screenshot/vision steps for now and rely on text
> signals (`emulator_debug_info`, logcat, JSON) for every check — the real
> production model has vision, this test model doesn't. Report exactly which of
> the five capabilities (boot, clicks, app interaction, frida, custom-APK) the
> model drove successfully on its own.

---

## 6. One-paragraph prompt (copy-paste into the new session)

> Read HANDOFF.md in this repo (omni-agent) top to bottom, then port omni-agent
> from Windows to this arm64 macOS in three committed phases: (1) fix every
> Windows-only branch so it runs on macOS — start with host_exec.py's shell
> discovery (use /bin/zsh or /bin/bash, not bash.exe), make sure adb and git are
> on PATH, and get run_headless.py to start without the pywebview GUI; (2) adapt
> to the new omnidroid at ../omnidroid@feat/native-window-fast-boot — the frida
> tools are ALREADY updated (Task 12: `_require_debug_boot` auto-runs `omnidroid
> frida --restart`, don't rewrite it), so just update
> skills/emulator-management/reference/omni-cli.md to document the new surface
> (`frida --restart`, `--apk` content-addressed caching + `--apk-once`,
> `debug-info.frida.restart`, `view --hide/--vnc-viewer`, `omnidroid warm`); (3)
> because the normal Qwen/modal model is down, create openrouter.txt (one line,
> the key, gitignored) and configure the "other" OpenAI-compatible provider in
> llm_config.json with base_url https://openrouter.ai/api/v1 and the DeepSeek
> "flash 0731" model (verify the exact slug on openrouter.ai/models), then use
> run_headless.py to prove DeepSeek drives the whole loop unattended — boots an
> instance, sends taps/types/swipes that land correctly (verify via logcat and
> foreground state, not screenshots), interacts with the app, runs a real frida
> hook and hide_root_from_app, and boots a custom APK via the --apk cache (first
> bakes, second hits with no reinstall); DeepSeek is NOT multimodal so skip all
> screenshot/vision steps and use text signals (emulator_debug_info, logcat,
> JSON) for every check, and finally report which of boot/clicks/app-interaction/
> frida/custom-APK the model handled on its own.
