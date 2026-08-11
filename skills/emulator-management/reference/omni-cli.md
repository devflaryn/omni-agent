# omnidroid CLI + engine reference

The emulator-management tools wrap the frozen `omnidroid …` contract (`contracts/omni-session.md`). You drive omnidroid through the **tools**, not by shelling out — this file documents what each tool actually runs, the JSON it returns, and how to read an engine error, plus raw device control via `adb_shell`. Pull it only when a tool result is confusing or you need a subcommand's exact semantics.

> **Two names that do not exist**: there is no `omnidroid create` and no `omnidroid play`. Instances are ephemeral and `omnidroid start <username>` is the one launch command; it allocates the instance itself. Older docs (including `contracts/omni-session.md`) still say `play`/`create` — they are wrong.

## Tool → command map
| Tool | Runs | Returns |
|---|---|---|
| `login_roblox_account(token_file/token)` | `omnidroid login --token-file <f> --json` | `{ok, username, user_id}` — cookie verified headlessly, saved under the auto-detected username. Failure: `bad_token`. |
| `list_roblox_accounts(verify)` | `omnidroid accounts [--verify] --json` | `{ok, accounts:[{username, user_id, has_cookie, valid?}]}` (cookies never returned). |
| `play_roblox(account, place_id, …)` | `omnidroid start <username> --place <id> [--offset --debug --job --launch-data --user-id --timeout] --json` | `{ok, place_id, deeplink, offset, booted, launched, first_boot, adb_port, vnc_port, session, kiosk}`. Failure: `no_place`, `no_token`, `cookie_invalid`, `no_offset`, `boot_timeout`. |
| `set_roblox_account(token, place_id, session_name, clear)` | `omnidroid session <name> [--place --token-file --play --clear] --json` | `{ok, session:{place_id,user_id,has_token,token:'<redacted>'}, applied}`. |
| `launch_roblox_build(…)` | login → decode/inject/recompile/sign/install (if apk) → start | `{ok, username, …}` or `{error, stage}`. |
| `ensure_emulator_running(device_name, reset, mode, offset, debug, boot_timeout)` | `omnidroid start <name> --no-token [--mode --offset/--no-offset --debug --mem]` | log ending `BOOT_OK (serial=…)` or `BOOT_TIMEOUT`. |
| `manage_roblox_versions(action, …)` | `omnidroid offset list\|show\|create\|default\|remove --json` | the engine's JSON for that action. |
| `run_root_command(command)` | `omnidroid su --json --timeout N <name> -- <command>` | `{exit_code, stdout, stderr}`, or `no_root` with the fix. |
| `emulator_debug_info(device_name)` | `omnidroid debug-info <name> --json` | root/devkit/frida state, offset, mode, foreground app, ports, `can{}` map. |
| `install_apk_on_emulator(apk_path, abi, …)` | `omnidroid install <name> <apk> [--abi …] [--require-translation] --json` | ABI-checked confirmation, or `ABI CONTRACT VIOLATION` / `abi_not_translated`. |
| `stop_emulator(device_name, purge)` | `omnidroid stop <name> --json` (or `omnidroid remove <name> --json` when `purge`) | stop/remove output; a missing account is a benign no-op. |
| `ensure_frida_server` / `hide_root_from_app` | Magisk `su` → devkit `omni-fridad` / `omni-hide` (debug boot) | host frida endpoint / what was applied, or a not-a-debug-boot error. |

## Roblox versions ("offsets")
A base ships **no** Roblox. Each version is an *offset*: a named, thin `/data` overlay carrying one baked build, living in `images_dir/base_arm_data_offset_<name>.qcow2`. Offsets are **siblings** — every one overlays the base's pristine `/data`, never another offset — so any number coexist, adding one never disturbs another, and deleting one cannot corrupt another. Exactly one is the **default**.

- `omnidroid offset list [--json]` — every version, `*` = default, plus whether each image is still on disk.
- `omnidroid offset create [<name>] --apk <path> [--default] [--force] [--notes …]` — bake a version (~2 min, ~130 MB). Name defaults to the APK's own `versionName`. **Refuses while any instance is running.**
- `omnidroid offset default <name>` — which version bare launches use. This is also the one-command **rollback**.
- `omnidroid offset remove <name> [--keep-image]` — DESTRUCTIVE; refuses while that version is in use.
- `omnidroid offset show [<name>]` — everything recorded (package, source APK, versionName/Code, size, created).

Per launch: `--offset <name>` picks one, omitting it uses the default, `--no-offset` boots the clean base. **Offsets are per-LAUNCH, never per-account** — nothing about an account selects a version, and cookie injection into the bootstrapped Roblox is unchanged.

`offset create` vs `--apk`: use `create` when the build is worth **keeping** (survives reboots, launchable by name, sits next to the others); use `apk_path`/`--apk` for a one-off test that dies with the instance.

`bake-data-game` still works as a deprecated alias for `offset create --default --force`.

## Modes
Modes declare a **profile** and the engine branches on that, not on the name.

| Mode | Profile | RAM / vCPU | Notes |
|---|---|---|---|
| `playable` (default) | performance | **sized to the host**, 4–8 GB / 4–8 | high render quality, no balloon, game on `top-app`. **The mode to test in.** |
| `gaming` | performance | same | plus a native host window |
| `hard` / `brutal` | performance | 3 GB / 4, 2 GB / 2 | fixed smaller tiers for a tight host |
| `farming` | density | 2 GB / 1, ballooned to ~896 MB | 480x270 @ 5 fps — **useless for screenshots** |

`--quality high|balanced|low` overrides the render profile; `--mem`/`--smp` override the host-derived size. `ensure_emulator_running` refuses `mode='farming'` outright, because every screenshot and UI assertion taken from a farming instance is misleading and the failure is silent.

## Key subcommands (exact flags)
- **`omnidroid login`** — default opens a VISIBLE browser (a HUMAN step; you can't do it). With `--token-file F` / `--token T` / `--token-stdin`: adopt a cookie you already have, verified in a HEADLESS browser in a few seconds. Saves under the account's real USERNAME (auto-detected). `--json`.
- **`omnidroid accounts`** — `--verify`, `--remove <username>`, `--set-custom-name <username> "<label>"` (display-only), `--json`.
- **`omnidroid start <username>`** — `--place <numericId>` (persisted), `--offset <name>` / `--no-offset` (which Roblox version), `--apk <path>` (install a custom build for this launch; works on any base, needs no `--debug`), `--job <gameInstanceId>`, `--access-code`/`--link-code`, `--launch-data "<=200B>"`, `--user-id N`, `--no-token` (no login → Roblox's own login screen), `--no-cookie-check`, `--debug` (attach the devkit/frida disk for THIS boot), `--mode`/`--mem`/`--smp`/`--quality`, `--window`/`--no-window`, `--timeout N`, `--json`.
- **`omnidroid session <name>`** — `--place`, `--token*`, `--play` (if running, re-join now), `--clear`, `--json`.
- **`omnidroid list [--stats] [--json]`** — accounts/instances, their state, live `offset` and `mode`.
- **`omnidroid install <name> <apk>`** — `--abi <abi>` (default `arm64-v8a` on x86 accounts to exercise libndk translation; none on arm), `--no-abi-pin`, `--require-translation`, `--json`.
- **`omnidroid su [--json] [--timeout N] <name> -- <command>`** — run as root. **omnidroid's own flags go BEFORE the name** (everything after it is the guest command; the wrong order is detected and refused rather than executed).
- **`omnidroid frida <name> [--status|--stop] [--port N]`** — start the devkit's hidden frida-server and `adb forward` it to a host port. Needs a `--debug` boot on a rooted base; it names those two failures separately.
- **`omnidroid debug-info <name> [--json]`** — what is actually possible on this instance.
- **`omnidroid stop <name>`** — graceful power-off (adb shutdown → QMP quit → kill), `--timeout` (default 90). A viewer disconnecting must NOT stop the instance.
- **`omnidroid remove <name>`** — DESTRUCTIVE: stop then delete the store entry + `runtime/<name>/`. This is what `stop_emulator(purge=true)` runs.
- **`omnidroid logcat <name>`** — `--tag <T>`, `--clear`, `--timeout`.
- **`omnidroid screenshot <name> [--out F]`** — one framebuffer PNG.
- **`omnidroid capture <name>`** — millisecond keyframe capture; `--auto` is continuous and auto-starts on a debug boot (read frames with `read_auto_screenshots`).
- **`omnidroid adb <name> -- <args…>`** — raw adb. Prefer `adb_shell(command=…)`, and `run_root_command` for anything needing root.
- **`omnidroid version --json`** — the handshake. `capabilities.offsets` / `capabilities.debug` say what this engine supports; `offsets.<base>.default` says whether a bare `start` will even resolve.
- **`omnidroid doctor --json`** — readiness, plus the baked versions and a hint when none is default.

## Root vs devkit — they are different things
Root (Magisk) is **baked into every shipped base**. `--debug` adds only the *devkit disk* (frida-server + the `omni-*` tools), for that boot only.

- APK swap, `run_root_command`, screenshots, logcat → any boot, **no** `--debug`.
- `ensure_frida_server`, `hide_root_from_app` → need `--debug` **and** a rooted base.

## Raw device control (via `adb_shell`)
`adb_shell(command="…")` runs `adb shell <command>` as uid **shell**: `input tap X Y`, `input keyevent 4` (back) / `3` (home), `input text "…"`, `pm list packages -3`, `dumpsys activity activities`, `getprop …`. For anything needing root use `run_root_command` — never hand-roll `su` (see the table below).

## Failure → cause → fix
| Symptom | Cause | Fix |
|---|---|---|
| `no_offset` from start | You named a Roblox version that is not baked, or nothing is baked at all and no `--apk` was given. **No instance is created.** | `manage_roblox_versions(action='list')`; bake with `action='create'`, or pass `apk_path` for a one-off, or `offset='none'` for a deliberately game-less boot. |
| `no_default_offset` | Several versions are baked and none is marked default. | `manage_roblox_versions(action='default', name=…)`, or pass `offset=` for this launch. |
| `no_token` from start | No saved account for that name and no `--token*`/`--no-token`. **No instance is created** (the gate runs before any allocation). | `login_roblox_account` first, then `play_roblox(account=<username>, …)`. |
| `cookie_invalid` | Roblox no longer recognises the saved cookie. The check fails **open** on network problems, so this is a real answer from Roblox. | Get a fresh cookie. (`--no-cookie-check` skips the check; it does not fix the cookie.) |
| `bad_token` from login | Cookie empty/expired, or Roblox never resolved it to a signed-in user. | Get a FRESH cookie; don't retry the same one. Browser `omnidroid login` is a human step. |
| `no_place` | No place id passed and none persisted. | Pass `place_id` (numeric). |
| Join succeeds but sits on Roblox's login screen | Stock APK with no session-bootstrap; the deep link fired but nothing planted the cookie. **Missing `OmniBootstrap: session cookie installed` in logcat.** | Use `launch_roblox_build` (injects the bootstrap) — not `install_apk_on_emulator`+launch. `start --apk` now detects this itself and fails `not_logged_in`. |
| `boot_timeout` | First boot runs dexopt (minutes); or host too tight. | Wait / raise `boot_timeout`; or `mode="hard"/"brutal"`; reuse (`reset=false`). |
| `instance_running` from an offset bake | A bake boots its own builder VM and must be the only thing running. | `stop_emulator` everything, then retry. |
| Offset bake fails with the APK "REJECTED" | Signature mismatch: a replacement must be signed with the SAME key as the build baked into the system image (an officially-signed Roblox will not install over a re-signed one, or the reverse). | Re-sign the build with the matching key. The shipping image was **not** touched. |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | APK ships no `arm64-v8a`/`armeabi-v7a` native libs. | Rebuild with an arm64 split; the base is arm64. |
| `ABI CONTRACT VIOLATION` / `abi_not_translated` | On an x86 account the intended ARM-translation path wasn't exercised (wrong `abi`). | Let install default (`arm64-v8a` on x86); don't force `x86_64`. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` / "signatures do not match" / `DELETE_FAILED_APP_PINNED` on a **reused** instance | A differently-signed build of the SAME package is installed and the kiosk PINS it (Lock Task). | **Auto-handled** — `omnidroid install` clears the kiosk's game target, force-stops + unpins + uninstalls, then reinstalls. |
| `no_root` from `run_root_command` | The base is not rooted, or this boot's Magisk grant is missing. | `omnidroid root-base`, then restart the instance. It refuses rather than silently running as uid `shell`. |
| A root command "worked" but changed nothing | Hand-rolled `su` through `adb_shell`. Three silent traps: Magisk's `su` is off `$PATH`; MagiskSU permutes argv (`su 0 id -u` reads `-u` as an su option); `adb shell` joins+reparses argv so an unquoted `a; b` runs a fragment of itself and still exits 0. | Use `run_root_command`, which handles all three. |
| not-a-debug-boot / not-rooted from `ensure_frida_server`/`hide_root_from_app` | The devkit is not attached (not a debug boot) **or** the base is not rooted — different problems. | `emulator_debug_info` says which. Boot with `debug=true`; root with `omnidroid root-base`. |
| `the host 'frida' Python binding is not importable` | The host runtime has no `frida` module — the guest server can be up while every host-side hook fails. | `pip install frida==17.15.4` (match the devkit frida-server exactly). |
| frida attach: "'<pkg>' is not running" although it clearly is | (fixed) Android frida reports the app LABEL, not the package, in `enumerate_processes()`. | `frida_run_script(mode="attach")` resolves the pid via `enumerate_applications()`. Use `mode="spawn"` if truly not started. |
| Screenshots are tiny/ugly and UI checks fail | The instance is in `farming` mode: 480x270 @ 5 fps by design. | Restart in `playable`. `ensure_emulator_running` refuses `mode='farming'` for this reason. |
