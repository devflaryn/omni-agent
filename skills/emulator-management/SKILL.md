---
name: emulator-management
description: Drive the omnidroid QEMU Android manager end to end — register a Roblox account from a .ROBLOSECURITY cookie, launch a saved account straight into a game by numeric place id with no menu or taps, choose or bake which ROBLOX VERSION runs (offsets), boot with the devkit (frida + omni tools) attached to test a custom APK build, run root commands, and confirm a login is REAL (not just a deep-link that fired) from logcat.
when_to_use: Use whenever the task involves logging in / playing / testing on omnidroid with a cookie, a saved account, and/or a place id — "here's a cookie.txt and place 8737899170, get me in-game", "launch account admn1b12farm4 into place …", "test this custom Roblox APK", "bake this Roblox build as a version", "which Roblox version is running", "why did my cookie login land on the Roblox login screen", or any instance lifecycle work (boot/reset/stop/purge, two accounts at once, first-boot slowness). Load this BEFORE reaching for run_apk_test_session / install_apk_on_emulator / launch_app_on_emulator on any Roblox cookie/login/place-id flow — those have no concept of accounts or cookies and will silently strand you on Roblox's own login screen.
allowed-tools: login_roblox_account, list_roblox_accounts, play_roblox, launch_roblox_build, set_roblox_account, manage_roblox_versions, emulator_debug_info, run_root_command, ensure_emulator_running, install_apk_on_emulator, adb_shell, get_logcat, monitor_logcat, take_emulator_screenshot, read_auto_screenshots, record_and_capture_keyframes, observe_screen, tap_element, tap_screen, type_text, swipe_screen, press_key, ensure_frida_server, hide_root_from_app, stop_emulator
---

# Emulator Management Skill

How to drive **omnidroid** — the self-contained headless QEMU + LineageOS **arm64** Android manager that runs natively on this host — to log in, land in a game, and test the custom APKs you build. `emulator-testing` covers *observing* a running app (record/analyze/report); THIS skill covers *getting the right thing running* in the first place: cookies, accounts, place ids, debug boots, and instance lifecycle.

## Mental model (memorize this — most mistakes come from missing it)
- **An instance is EPHEMERAL and named for a Roblox account username.** It is allocated by the launch itself (there is no `create`), boots the shared base with `snapshot=on`, and discards every guest write at power-off. Two *different* names run side by side (two accounts at once).
- **An account = a Roblox `.ROBLOSECURITY` cookie stored in one `accounts.json`, keyed by the account's real USERNAME.** The username is auto-detected from Roblox, not a name you pick, and it doubles as the instance name.
- **You add accounts ONLY by `login_roblox_account` (cookie).** The browser `omnidroid login` is a human step you cannot do — there is no other route for you to create an account.
- **The base ships NO Roblox. A Roblox VERSION is an "offset", chosen per LAUNCH.** Offsets are named, thin `/data` overlays that coexist on one clean base, with exactly one marked default. Omitting the version means the default. **Offsets are never per-account** — nothing about an account selects a version, and cookie injection is unchanged. `manage_roblox_versions` is the tool.
- **Bases are dual-use.** The shipped `base_arm` / `base_x86` images are rooted (Magisk, hidden from the game) and both ship to production AND serve for debugging. There is no separate dev base. **Debug is a per-BOOT option:** pass `debug=true` to attach the `vdc` devkit disk (frida-server + `omni-*` tools) to the same image — needed only for frida/runtime-hooking. APK swap and **root** work on every base without it.
- **Test in `playable` mode** (the default). It sizes itself to the host (4–8 GB / 4–8 vCPU) and renders at high quality, so a screenshot shows what a player sees. `farming` is 480x270 @ 5 fps by design and is REFUSED by `ensure_emulator_running` — every screenshot and UI assertion off one is misleading, and the failure is silent.

## THE CARDINAL RULE — cookie/place-id work never goes through the generic pipeline
This is the exact failure this skill exists to stop (it once burned ~100 turns and reported success while sitting on a login screen):

> A **stock/unmodified Roblox APK has NO code path that reads a session cookie** (`contracts/omni-session.md` §1.2). Installing it and firing the `roblox://…placeId=…` deep link lands on Roblox's OWN login screen — and the tools still report `install: ok` / `launched: true`. The join firing is NOT a login.

So, for anything shaped like "a cookie and a place id (and maybe an APK)":
- **DO NOT** use `run_apk_test_session`, `install_apk_on_emulator`+`launch_app_on_emulator`, or `ensure_emulator_running` as the login path. They have no concept of accounts or cookies.
- **DO** use `launch_roblox_build` (one call, end to end) or `login_roblox_account` → `play_roblox`.
- **Real login is proven by ONE logcat line:** `OmniBootstrap: session cookie installed (N chars)`. `OmniKiosk: joined place …` only means the deep link fired. If the OmniBootstrap line is absent after a join, the build has no bootstrap and is showing its own login screen — do not report login as working.

## Choose the launch path
| You have… | Call | Notes |
|---|---|---|
| a **cookie (file/string) + place id**, maybe a **new APK to test** | `launch_roblox_build(place_id, token_file=… | token=…, apk_path=… , debug=…)` | THE default for "cookie + place (+ apk)". Does login → (if apk: decode→inject_session_bootstrap→recompile→sign→install) → play. `debug` defaults false (APK swap needs no debug boot); pass `debug=true` only for frida hooking. Fails with a `stage` name; every stage is idempotent, so fix that stage and re-call. |
| a **cookie**, want it saved as a reusable account first | `login_roblox_account(token_file=… \| token=…)` → returns `username` | Idempotent; the same cookie always resolves to the same username (never a duplicate). Then `play_roblox(account=username, place_id=…)`. |
| a **saved account username** + place id (build already installed) | `list_roblox_accounts()` then `play_roblox(account="<username>", place_id=…)` | The product's real launch path: cold-starts Roblox, kiosk fires the deep link, lands in-game, no menu/taps. |
| to **swap** the live account/place on a running instance | `set_roblox_account(token=…, place_id=…, session_name=…)` | Cold-starts Roblox before re-joining (the client caches the authed user in-process). |
| a **non-Roblox** APK, or generic Android work | `ensure_emulator_running(...)` → `install_apk_on_emulator` → `launch_app_on_emulator` | Only here is the generic pipeline correct — there's no cookie/account involved. |

`place_id` is the **numeric placeId only** — in `https://www.roblox.com/games/606849621/Jailbreak` it is `606849621`, never the URL.

## Choose the Roblox VERSION (offsets)
| You want | Call |
|---|---|
| know what versions exist / which is default | `manage_roblox_versions(action="list")` |
| launch the version everything else uses | nothing — omit `offset`; that IS the default |
| launch a specific baked version | `ensure_emulator_running(offset="2.740.101")` (or `--offset` via `play_roblox`'s engine call) |
| test a build ONCE and throw it away | `launch_roblox_build(apk_path=…)` / `install_apk_on_emulator` — the build dies with the instance |
| KEEP a build as a launchable version | `manage_roblox_versions(action="create", apk_path=…, name="candidate")` — ~2 min, needs every instance stopped |
| promote a version to default, or ROLL BACK | `manage_roblox_versions(action="default", name=…)` |
| delete a version | `manage_roblox_versions(action="remove", name=…)` |

Baking a new version **never** replaces or disturbs an existing one — they are siblings. So the safe way to test a candidate is `create` (without `make_default`) → launch with `offset="candidate"` → `remove` when done; production keeps running the version it was on the whole time.

A launch that fails `no_offset` means the version you named is not baked (or nothing is); `no_default_offset` means several are baked and none is default. Neither ever falls back silently — running the wrong Roblox under the right name is the most expensive way for a test to be wrong.

## Recipe A — cookie file + place id, end to end (the common ask)
1. `launch_roblox_build(place_id=8737899170, token_file="cookie.txt")` — omit `apk_path` to log in and play whatever Roblox build is already installed; pass `apk_path="build.apk"` to build+install a new one first (APK swap works on any base; add `debug=true` only if you also need frida).
2. On success you get `{ok, username, place_id, booted, launched, …}`. On failure you get `{error, stage}` — `stage` ∈ login/decode/inject/recompile/sign/install/play. Fix that stage and re-call; earlier stages are idempotent.
3. **Prove the login is real:** `get_logcat(...)` (or `monitor_logcat`) and confirm `OmniBootstrap: session cookie installed (N chars)`. A `bad_token` at the login stage means the cookie is empty/expired or Roblox never resolved it to a signed-in user — get a fresh cookie; do NOT retry the same one.

## Recipe B — launch an already-saved account
1. `list_roblox_accounts()` (add `verify=True` to check each cookie still authenticates — Roblox kills a cookie on sign-out / password change).
2. `play_roblox(account="admn1b12farm4", place_id=8737899170)`. The instance named for that account is auto-created if missing and reused otherwise. First boot on a fresh instance runs dexopt (minutes) — that is normal, not a hang; the engine's timeout governs.
3. Confirm the `OmniBootstrap` line as in Recipe A before claiming it's logged in.

## Recipe C — testing a custom Roblox build on the DEV instance
A debug boot gives you frida + the omni-* tools and always-on screenshots; APK swap and root are available on every base.
1. `launch_roblox_build(place_id=…, token_file=…, apk_path="mybuild.apk")` — this builds (with session bootstrap injected), installs, and plays as the cookie's account. For a pre-built/already-signed apk you still want tested by the login flow, this is the one call. It stages intermediates under `omni_build/<username>_decoded` (~400 MB) + `omni_build/<username>_build.apk` in the workspace and **auto-cleans them on success** — they remain ONLY when a stage failed (that's where you inspect a decode/inject/recompile failure), keyed by the `stage` in the error.
2. If the app has **root/frida detection**, before it renders: `ensure_frida_server(device_name=<username>)` → `hide_root_from_app("<target.package>", device_name=<username>)`. Both require a debug boot on a rooted base (they return a clear error otherwise — the fix is `omnidroid root-base`, then boot with `debug=true`). `ensure_frida_server` returns a `127.0.0.1:<port>` host endpoint to attach the frida toolset (`expand_tools("frida")` → `frida_trace` / `frida_run_script`). NOTE: the host needs the `frida` Python binding installed and version-matched to the devkit frida-server (`pip install frida==17.15.4`) — `ensure_frida_server` starting cleanly does NOT prove the host can attach; the binding is separate. `frida_run_script(mode="attach", package_name="<pkg>")` attaches to the running app BY PACKAGE (resolved via the app list); use `mode="spawn"` to hook startup.
3. Verify by observation → load the `emulator-testing` skill for the record/analyze/report loop, or read the debug boot's always-on frames with `read_auto_screenshots`.

## Debugging: start with `emulator_debug_info`
When an emulator step fails for an unclear reason, or "did nothing", call
`emulator_debug_info(device_name=…)` **first**. It reports what is actually
true right now — root available? devkit attached? frida up? which offset and
mode is the live boot on? what is in the foreground? — with a fix attached to
each missing capability. Missing root and a missing devkit disk are completely
different problems with different fixes, and from the outside they look
identical: every affected tool just appears to do nothing.

- **Root:** `run_root_command("<cmd>")`. Use it for anything uid `shell` cannot
  do (an app's private data dir, `/proc/sys` writes, cpuset/lmkd, `resetprop`,
  the devkit's `omni-*` helpers). **Never hand-roll `su` through `adb_shell`** —
  three traps make that fail silently: Magisk's `su` is off `$PATH`; MagiskSU
  permutes argv so `su 0 id -u` reads `-u` as an *su option*; and `adb shell`
  joins-and-reparses argv so an unquoted `a; b` runs a fragment of itself and
  still exits 0. `run_root_command` handles all three, and fails loudly rather
  than downgrading to uid `shell` (a silent downgrade produces wrong output
  that looks right).
- **Root works on every base, with no debug boot.** Only frida and `omni-hide`
  need `debug=true`.
- **Screens:** `take_emulator_screenshot`, `record_and_capture_keyframes`,
  `observe_screen` — all in `playable`, never `farming`.

## Instance lifecycle
- **Reuse vs reset:** the account-named instance is reused across calls. Instances are diskless — every boot is already a clean device — so `ensure_emulator_running(reset=true)` (its default) just means "stop the live one and boot fresh"; `reset=false` reuses the running one (much faster).
- **Two at once:** distinct account usernames / `session_name`s run concurrently — one per account.
- **Teardown:** QEMU VMs run **detached and outlive the agent process**, so `stop_emulator(device_name=<username>)` when done to free RAM/CPU. `stop_emulator(purge=true)` also deletes the account's store entry — destructive; use it to reclaim state, not between ordinary test runs.
- **Modes:** `playable` (default, maximum resources + high render quality — use this), `gaming` (adds a host window), `hard`/`brutal` (3G/2G) when the host is tight. `farming` is refused.
- **Never `omnidroid remove`/delete an instance's files by hand** to clean up — power off with `stop_emulator`, and only `purge=true` when you truly mean to destroy it.
- **A version bake needs every instance stopped**, and `manage_roblox_versions(action="remove")` refuses while that version is in use.

## Direct `omni` CLI — the deep reference
Every tool above wraps the frozen `omni …` contract. When you need a subcommand no tool exposes (e.g. `omnidroid session --show`, `omnidroid accounts --set-custom-name`, raw `omnidroid logcat`/`omnidroid screenshot`, `omnidroid adb …`), or you're diagnosing an engine-level error, load `reference/omni-cli.md` with `read_skill_resource` — it lists the exact commands, flags, JSON shapes, and a failure→cause→fix table.

## Common mistakes
- **Using `run_apk_test_session` / `install_apk_on_emulator` for a cookie login.** Wrong tool class — see the Cardinal Rule. It "succeeds" onto a login screen.
- **Not checking WHICH Roblox version a result came from.** `emulator_debug_info` / `list` report the live offset. A test result is only meaningful against a named version.
- **Baking a candidate as the default.** `manage_roblox_versions(action="create", make_default=True)` repoints every bare launch at your test build. Leave it false and launch with `offset=` instead.
- **Hand-rolling `su` through `adb_shell`.** It fails silently three different ways — use `run_root_command`.
- **Testing in `farming` mode.** 480x270 at 5 fps; every screenshot and UI assertion is misleading. `ensure_emulator_running` refuses it.
- **Passing a raw cookie to `play_roblox(token=…)` when you meant to save the account.** That's an ephemeral, UNSAVED session. Use `login_roblox_account` to make it a real de-duplicated account, then `play_roblox(account=…)`.
- **Reporting login from the join result.** `launched:true` / `joined place …` ≠ logged in. Only the `OmniBootstrap: session cookie installed` logcat line proves it.
- **Passing a game URL as `place_id`.** Numeric placeId only.
- **Retrying an expired cookie.** `bad_token` / `no_token` won't fix itself — you need a fresh cookie (a browser `omnidroid login` is a human step; you can only refresh via a new cookie string/file).
- **`ensure_frida_server`/`hide_root_from_app` on a non-debug or un-rooted boot.** They only work on a debug boot (`debug=true`) of a rooted base (`omnidroid root-base`).
- **Treating first-boot dexopt as a hang.** A fresh instance's first boot is minutes; the engine's timeout governs. Reuse (`reset=false`, or an existing account name) for fast subsequent boots.
- **Panicking at an install failure on a REUSED instance.** Installing a differently-signed build over an existing one (stock Roblox vs a re-signed test build) used to dead-end with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` + `DELETE_FAILED_APP_PINNED` (the kiosk pins the old build). The engine now auto-recovers (unpin → uninstall → reinstall), so `install_apk_on_emulator` just succeeds — don't hand-roll uninstall dances or abandon the instance.

## Critical rules
- Cookie/place-id/login work → `launch_roblox_build` or `login_roblox_account`→`play_roblox`. NEVER the generic install/launch pipeline.
- Anything unclear or "did nothing" → `emulator_debug_info` FIRST, before guessing.
- Anything needing root → `run_root_command`, never `adb_shell("su …")`.
- Test in `playable`. Report which Roblox version (offset) a result came from.
- A `.ROBLOSECURITY` cookie is full account access. Prefer `token_file` over `token` (a raw cookie in a tool call is logged in the transcript); the tools already write cookies to 0600 temp files and redact them from output — never echo a cookie into your own text.
- Confirm real login with the `OmniBootstrap` logcat line, every time, before you claim it worked.
- Stop instances you started (`stop_emulator`); only `purge=true` when you deliberately want to destroy the instance.
