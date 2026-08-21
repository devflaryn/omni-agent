# omni CLI + engine reference (omnidroid)

The emulator-management tools wrap the frozen `omni …` contract (`contracts/omni-session.md`, `omnidroid-api.md`). You drive omnidroid through the **tools**, not by shelling out to `omni` — this file documents what each tool actually runs, the JSON it returns, and how to read an engine error, plus raw device control via `adb_shell`. Pull it only when a tool result is confusing or you need a subcommand's exact semantics.

## Tool → command map
| Tool | Runs | Returns |
|---|---|---|
| `login_roblox_account(token_file/token)` | `omni login --token-file <f> --json` | `{ok, username, user_id}` — cookie verified headlessly, saved under the auto-detected username. Failure: `bad_token`. |
| `list_roblox_accounts(verify)` | `omni accounts [--verify] --json` | `{ok, accounts:[{username, user_id, has_cookie, valid?}]}` (cookies never returned). |
| `play_roblox(account, place_id, …)` | `omni play <username> --place <id> [--debug --job --launch-data --user-id --timeout] --json` | `{ok, place_id, deeplink, booted, launched, first_boot, adb_port, vnc_port, session, kiosk}`. Failure: `no_place`, `no_token`, `boot_timeout`. |
| `set_roblox_account(token, place_id, session_name, clear)` | `omni session <name> [--place --token-file --play --show --clear] --json` | `{ok, session:{place_id,user_id,has_token,token:'<redacted>'}, applied}`. |
| `launch_roblox_build(…)` | login → decode/inject/recompile/sign/install (if apk) → play | `{ok, username, …}` or `{error, stage}`. |
| `ensure_emulator_running(device_name, reset, dev, mode, boot_timeout)` | `omni create`/`start` (contract) | log ending `BOOT_OK (serial=…)` or `BOOT_TIMEOUT`. |
| `install_apk_on_emulator(apk_path, abi, …)` | `omni install <name> <apk> [--abi …] [--require-translation] --json` | ABI-checked confirmation, or `ABI CONTRACT VIOLATION` / `abi_not_translated`. |
| `stop_emulator(device_name, purge)` | `omni stop <name> --json` (or `omni remove <name> --json` when `purge`) | stop/remove output; a missing account is a benign no-op. |
| `ensure_frida_server` / `hide_root_from_app` | Magisk `su` → devkit `omni-fridad` / `omni-hide` (debug boot) | host frida endpoint / what was applied, or a not-a-debug-boot error. |

## Key subcommands (exact flags)
- **`omni login`** — default opens a VISIBLE browser (a HUMAN step; you can't do it). With `--token-file F` / `--token T` / `--token-stdin`: adopt a cookie you already have, verified in a HEADLESS browser in a few seconds. Saves under the account's real USERNAME (auto-detected). `--json`.
- **`omni accounts`** — `--verify` (re-check each cookie authenticates), `--remove <username>`, `--set-custom-name <username> "<label>"` (display-only; the USERNAME stays the real identity + instance name), `--json`.
- **`omni play <username>`** — `--place <numericId>` (persisted, reused next time), `--job <gameInstanceId>` (join a specific server), `--access-code` / `--link-code` (private servers), `--launch-data "<=200B>"` (readable in-game via `Player:GetJoinData()`), `--user-id N` (informational), `--no-token` (join with NO login → lands on Roblox's login screen; almost never what you want), `--debug` (attach the devkit/frida disk for THIS boot; same dual-use image), `--no-window`/`--window`, `--timeout N`, `--json`. The instance is auto-created thin and reused.
- **`omni session <name>`** — `--show` (print stored session, token redacted), `--place`, `--token*`, `--play` (if running, re-join now), `--clear` (forget token+place and log the live instance out), `--json`.
- **`omni list [--stats] [--json]`** — accounts/instances and their state.
- **`omni install <name> <apk>`** — `--abi <abi>` (default `arm64-v8a` on x86 accounts to exercise libndk translation; none on arm), `--no-abi-pin`, `--require-translation`, `--json`.
- **`omni stop <name>`** — graceful power-off (adb shutdown → QMP quit → kill), `--timeout` (default 90). A viewer disconnecting must NOT stop the instance — VMs stay headless by default.
- **`omni remove <name>`** — DESTRUCTIVE: stop then delete `accounts/<name>/` (overlay + data.qcow2 + state), frees ports. Only ever deletes inside `accounts/`. This is what `stop_emulator(purge=true)` runs.
- **`omni logcat <name>`** — `--tag <T>`, `--clear`, `--timeout`. (`get_logcat`/`monitor_logcat` are the tools.)
- **`omni screenshot <name> [--out F]`** — one framebuffer PNG via ADB `screencap` (window-state-independent). `take_emulator_screenshot` is the tool.
- **`omni capture <name>`** — millisecond keyframe capture; `--auto` continuous mode is DEV-BASE only and auto-starts on a dev boot (read frames with `read_auto_screenshots`). `record_and_capture_keyframes` is the tool.
- **`omni adb <name> -- <args…>`** — raw adb to that instance. Prefer `adb_shell(command=…)` for shell commands.

## Raw device control (via `adb_shell`)
`adb_shell(command="…")` runs `adb shell <command>` against the instance: `input tap X Y`, `input keyevent 4` (back) / `3` (home), `input text "…"`, `pm list packages -3`, `dumpsys activity activities`, `getprop ro.build.version.release`, `am start -a android.intent.action.VIEW -d 'roblox://…'`. Use for taps/inspection the higher-level tools don't cover.

## Failure → cause → fix
| Symptom | Cause | Fix |
|---|---|---|
| `no_token` from play | No saved account for that name and no `--token*`/`--no-token`. **No instance is created** (the gate runs before any disk write). | `login_roblox_account` first, then `play_roblox(account=<username>, …)`. |
| `bad_token` from login | Cookie empty/expired, or Roblox never resolved it to a signed-in user. | Get a FRESH cookie; don't retry the same one. Browser `omni login` is a human step. |
| `no_place` | No place id passed and none persisted. | Pass `place_id` (numeric). |
| Join succeeds but sits on Roblox's login screen | Stock APK with no session-bootstrap; the deep link fired but nothing planted the cookie. **Missing `OmniBootstrap: session cookie installed` in logcat.** | Use `launch_roblox_build` (injects the bootstrap) — not `install_apk_on_emulator`+launch. |
| `boot_timeout` | First boot runs dexopt (minutes); or host too tight. | Wait / raise `--timeout`; or `mode="hard"/"brutal"`; reuse (`reset=false`) after the first provision. |
| `no_deeplink_handler` on a fresh dev instance | Roblox isn't installed yet on a brand-new dev instance. | Expected — `launch_roblox_build` installs first; the FINAL play after install is the real one. |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | APK ships no `arm64-v8a`/`armeabi-v7a` native libs. | Rebuild with an arm64 split; the base is arm64 — there is no other backend to switch to. |
| `ABI CONTRACT VIOLATION` / `abi_not_translated` | On an x86 account the intended ARM-translation path wasn't exercised (wrong `abi`). | Let install default (`arm64-v8a` on x86); don't force `x86_64`. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / "signatures do not match" / `DELETE_FAILED_APP_PINNED` on a **reused** instance | A differently-signed / version-incompatible build of the SAME package is already installed, and the kiosk PINS it (Lock Task), so it can't be replaced or uninstalled in place. | **Auto-handled now** — `omni install` clears the kiosk's game target, force-stops + unpins + uninstalls the stale build, then reinstalls fresh. If you ever hit it manually: `settings put global omni_game_package none` → `am force-stop <pkg>` → `am start -n com.omni.kiosk/.MainActivity` → `pm uninstall <pkg>` → reinstall. A bare force-stop→uninstall loses a race with the kiosk's re-pin. |
| not-a-debug-boot / not-rooted error from `ensure_frida_server`/`hide_root_from_app` | The devkit is not attached (not a debug boot) or the base is not rooted. | Boot with `debug=true`; root the base with `omni root-base`. |
| `the host 'frida' Python binding is not importable` | The host runtime has no `frida` module — `ensure_frida_server` (guest side) can succeed while every host-side hook still fails. | `pip install frida==17.15.4` (match the devkit frida-server exactly). It's in the agent's requirements.txt; a fresh host needs it installed. |
| frida attach: "'<pkg>' is not running" although it clearly is | (fixed) Android frida reports the app LABEL, not the package, in `enumerate_processes()`. | `frida_run_script(mode="attach")` now resolves the pid via `enumerate_applications()` (package → pid). If a target is truly not started, use `mode="spawn"`. |
