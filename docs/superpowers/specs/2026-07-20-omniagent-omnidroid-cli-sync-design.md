# omni-agent ↔ omnidroid CLI Sync (A2.2 surface + B `--apk`)

**Date:** 2026-07-20
**Repo:** omni-agent (changes here); depends on omnidroid's current CLI surface (sub-projects A2.2 + B, both merged on omnidroid `main`).
**Status:** Approved direction.

## Problem

omni-agent drives omnidroid by shelling out to the `omni` CLI (`_run_qemu`). omnidroid's
command surface changed across sub-project A2.2 (diskless model: `start` absorbed `play`;
`--ephemeral`/`--wait` dropped; `session --show` dropped) and sub-project B (new
`start --dev --apk` one-shot + loud `not_logged_in`). **omni-agent was never updated**, so
against the current omnidroid:

- **`play_roblox` is outright broken** — it calls `omnidroid play … --ephemeral`; `play` is no
  longer a subcommand and `--ephemeral` is not a flag. This is the core "boot + join" tool.
- Three more dead-flag sites (see drift table).
- The B `--apk` one-shot and its loud `not_logged_in` signal are not used at all.

The agent therefore cannot reliably boot an instance, and the "convert a plain Roblox into a
bootstrapped one and log in" flow (`launch_roblox_build`) uses a wasteful, silent-failure-prone
path.

## Verified drift (empirical, against current omnidroid `main`)

| omni-agent site | Current call | Status | Fix |
|---|---|---|---|
| `roblox_session.py:134,139` `play_roblox` | `["play", name, "--place", …, "--ephemeral"]` | **BROKEN** (`play` deleted, `--ephemeral` deleted) | → `["start", name, "--place", …]` (+`--dev`), no `--ephemeral` |
| `android_emulator.py:631` `_ensure_qemu_running` | `["start", name, "--wait", "--timeout", …]` | **BROKEN** (`--wait` deleted) | drop `--wait` |
| `android_emulator.py:448` `_qemu_create` | `argv += ["--ephemeral"]` on a `start`/create argv | **BROKEN** (dead flag) | drop `--ephemeral` |
| `roblox_session.py:205` `set_roblox_account` | `["session", name, "--json", "--show"]` (read-only case) | **BROKEN** (`session --show` deleted) | drop `--show`; bare `session name --json` already returns current state |
| `launch_roblox_build` apk path | throwaway `play` → `install` → `play` | works but wasteful + silent-Sign-In-prone | collapse to one `start --dev --apk … --place` |
| `dev-ui --show`, `install`, `list`, `accounts`, `login`, `remove`, `run-app`, `version`, `doctor` | — | ✓ still valid | no change |

`omnidroid start` flags today: `--place --dev --apk --token/--token-file/--token-stdin --no-token
--job --access-code --link-code --launch-data --user-id --window/--no-window --mode --mem
--accel --timeout --json`. `omnidroid session` flags: `--place --play --clear --token* --job
--launch-data --user-id --json` (no `--show`).

## Design

### Role split (the key semantic)

The old `play` conflated two roles that are now distinct commands:

- **Fresh boot + join a NEW instance** → `omnidroid start <name> --place <id> [--dev] [--apk <apk>]`.
  `start` refuses if the instance is already running (`already running`).
- **Re-deliver to an ALREADY-RUNNING instance** (switch account/place, cold-restart Roblox,
  re-join) → `omnidroid session <name> --play [--place …] [--token* …]`. `set_roblox_account`
  already uses `session` and is correct except for the dead `--show`.

`play_roblox` takes the **fresh-boot** role (→ `start`). Re-delivery to a live instance stays
`set_roblox_account` (→ `session --play`). This matches how omnidroid split the surface.

### Changes (all in omni-agent)

1. **`play_roblox`** (`tools/roblox_session.py`): build `["start", session_name, "--place",
   str(place_id), "--json"]`; append `--dev` when dev; **remove** the `--ephemeral` append
   (diskless is the only model now — there is no non-ephemeral path). Keep `--job`,
   `--launch-data`, `--user-id`, `--timeout`, token-file wiring unchanged (all still valid on
   `start`). The `ephemeral` parameter becomes a no-op/removed (see test note).

2. **`_qemu_create` / `_ensure_qemu_running`** (`tools/android_emulator.py`): remove the dead
   `--ephemeral` (line ~448) and `--wait` (line ~631) from the `start` argv. `start` is already
   synchronous (it boots, delivers, and returns a JSON result), so `--wait` was only ever an
   outer hint; the existing `--timeout` + the `_run_qemu` outer timeout still govern.

3. **`set_roblox_account`** (`tools/roblox_session.py:205`): in the read-only branch (no token,
   no place), **drop** the `--show` append — `omnidroid session <name> --json` returns the current
   session (place_id + redacted token) on its own.

4. **`launch_roblox_build`** (`tools/roblox_session.py`, apk_path branch): replace the current
   *throwaway `play_roblox` → build chain → `install_apk_on_emulator` → second `play_roblox`*
   with:
   - build chain unchanged: `decode_apk → inject_session_bootstrap → recompile_apk → sign_apk`
     (produces `omni_build/<user>_build.apk`);
   - a single **`omnidroid start --dev --apk <built.apk> --place <id>`** (via the same `_run_qemu`
     layer / a `play_roblox`-style call extended with `apk_path`), which on the dev base:
     installs the APK, delivers the cookie, joins, and runs omnidroid's post-delivery
     `OmniBootstrap` probe;
   - **stage mapping** from omnidroid's result: `error: "apk_install_failed"` → return
     `{stage: "install", …}`; `error: "not_logged_in"` → return `{stage: "login_check", …}`
     with omnidroid's message (points at inject_session_bootstrap); a delivered+logged-in
     result → success.
   - The instance must be freshly bootable for the one-shot. Since `launch_roblox_build` owns
     the whole flow, it targets a stopped instance; if a stale instance is running for that
     username, stop it first (`omnidroid stop <name>`) before the `start --dev --apk`. (Idempotency:
     the build stages remain re-callable; a re-run stops + re-installs, consistent with the
     diskless "re-install per boot" model.)
   - The wasteful first `play_roblox` boot and the separate `install_apk_on_emulator` call are
     removed from this branch. `install_apk_on_emulator` remains as a standalone tool for other
     callers (reused-instance installs); it is not deleted.

5. **Tests** (`tests/`): update the tests that assert the OLD surface so they assert the new one
   and actually guard the sync:
   - `test_ephemeral_wiring.py` asserts `--ephemeral in argv` — rewrite to assert the new
     `start`-based argv has NO `--ephemeral` (and `play_roblox` emits `start`, not `play`).
     If the `ephemeral` toggle no longer exists, retire the test's non-ephemeral half.
   - `test_command_surface.py`, `test_launch_build_account.py`, `test_launch_build_cleanup.py`:
     audit for `play`/`--wait`/`--show` assumptions; update to the new argv and to the collapsed
     `launch_roblox_build` apk flow (build chain → single `start --dev --apk`, stage mapping for
     `apk_install_failed`/`not_logged_in`). Add a case asserting `not_logged_in` →
     `stage: "login_check"`.
   - Add/extend a focused unit test for `play_roblox` argv (`start … --place [--dev]`, no
     `--ephemeral`) and for `set_roblox_account` read-only (`session … --json`, no `--show`).

### Verification (no on-device boot needed for these)

1. omni-agent test suite green after the test updates.
2. A live CLI contract smoke on this host: for each omnidroid subcommand/flag omni-agent emits,
   assert it is accepted by the installed `omni` (`--help` / argparse), i.e. no repeat of the
   `play`/`--ephemeral`/`--wait`/`--show` drift. Produced as a **feature matrix**: {omni-agent
   tool → omnidroid command+flags → valid? → which A2.2/B feature it exercises}.
3. Static confirmation that every `_run_qemu`/argv site in `tools/` is on the current surface.

### Out of scope / boundary

- **No on-device end-to-end run here.** The final proof (logcat `OmniBootstrap: session cookie
  installed` + in-game screenshot on the dev base) runs against `~/OmniImages` by the user, via
  the handoff prompt — it is the same gate as omnidroid B Task 4.
- **omni-agent does not change the bootstrap METHOD** — the existing smali-inject chain
  (`inject_session_bootstrap`) stays; the anti-tamper single-`.so`-swap alternative is a
  separate future decision, not this sync.
- No changes to omnidroid (already merged). No new omni-agent tools; this edits existing ones.

## Deliverables

1. omni-agent CLI-sync code change (items 1–4) + updated tests (item 5).
2. The feature matrix (verification #2).
3. A **handoff prompt** for the user: a natural-language instruction that drives the agent to
   convert a plain Roblox APK into a bootstrapped one and log in, end-to-end, via
   `launch_roblox_build` (account/cookie + apk + place id), expecting the loud `not_logged_in`
   on a bad build and an in-game login on a good one.
