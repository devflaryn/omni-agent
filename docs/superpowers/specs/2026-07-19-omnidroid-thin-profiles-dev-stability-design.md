# Omnidroid Thin Profiles + Dev Stability + Agent Interaction — Design

**Date:** 2026-07-19
**Status:** Approved (design), implementing
**Repos:** omnidroid (engine) + omni-agent (bridge/tools)

## Goal

Make omnidroid instances thin and username-named, the dev base reliably usable for
build→install→test, and give omni-agent direct screen interaction — as one coherent change.

## Decisions (from brainstorming)

- **Normal accounts = fully shared disk, no persistence, concurrent.** A profile is just the
  `accounts.json` record `{username, user_id, cookie, alias(custom_name)}` — NO per-account
  disk dir. Boot attaches the shared provisioned base (system+data pair) with QEMU
  `snapshot=on`, so each running instance gets its own ephemeral writable layer (concurrency
  works; nothing persists). Cookie is pushed at RUNTIME to log in. Every boot is fresh.
- **Instance/console name = the exact Roblox username** (never display name). `alias`
  (custom_name) is a display-only label.
- **Dev base = shared, APK baked in.** One shared dev image; installing the built APK modifies
  the shared dev base (persists there). Dev instance is still named by the account username
  whose cookie it uses.
- **Dev boots to the production kiosk** (root-cause + fix the Magisk-screen bug), with an agent
  control to switch to the Magisk/root UI on demand.
- **New omni-agent interaction tools:** first-class `tap_screen(x,y)`, `type_text`, `swipe`,
  `press_key` via adb `input`, documented to pair with screenshot-coordinate reading.
- **Screenshots:** per-install-session folder named `<apk_basename>_<DDMMHHMM>` (e.g.
  `intermadiate_test_v4_19070641`) instead of the single `screenshots/auto/`.

## Components

### A. Thin username profiles + shared ephemeral disk (omnidroid)
- Profile model: `accounts.json` record only; drop per-account `data.qcow2`/`efivars` dirs for
  normal accounts. `efivars` is copied ephemerally per boot.
- `qemu_command_arm`: attach shared system+data base with `snapshot=on` (read-only base +
  per-process temp overlay). Verify N concurrent instances boot (2 accounts registered; more
  cookies available for testing).
- Cookie injected at runtime (existing login/cookie-push path).

### B. Dev base stability (omnidroid)
- Root-cause why the dev base boots to the Magisk app/setup instead of the kiosk; ensure the
  dev data carries the kiosk launcher + device-owner like the production `base_arm_data`.
- Shared dev base; `install <apk>` bakes the APK into the shared dev image (persisted).
- Agent-facing control to switch the active launcher between kiosk and the Magisk/root UI.

### C. omni-agent naming + screenshots
- Remove the hardcoded `_DEFAULT_QEMU_SESSION = "omniagent"`; resolve the Roblox username from
  the cookie (Roblox API) / selenium login and name the instance that.
- Auto-screenshot dir → `screenshots/<apk_basename>_<DDMMHHMM>` per install session
  (`%d%m%H%M`), replacing the single `screenshots/auto/`. `read_auto_screenshots` reads the
  current session dir.

### D. Agent interaction tools (omni-agent)
- `tap_screen(x, y)`, `type_text(text)`, `swipe(x1,y1,x2,y2,duration_ms?)`, `press_key(keycode)`
  implemented over adb `input`. Documented to pair with the screenshot capture (read coords,
  then act). Registered in the emulator toolset.

### E. Verification
- Concurrent boot of the 2 registered accounts on the shared disk.
- Dev boots to kiosk; build→install→launch→test the APK on the shared dev base; Magisk toggle.
- Per-session screenshot folder + username naming end-to-end.
- Unit tests where logic is host-side; live-boot checks run on the real engine.

## Risks
- "No persistence" ⇒ every boot re-logs-in (cookie push). Accepted for now.
- Shared `snapshot=on` requires the system overlay + data to open read-only concurrently —
  verify FBE-key matched pair still boots under snapshot mode.
- The Magisk-screen fix requires live investigation on the real dev base.
