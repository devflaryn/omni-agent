---
name: omnidroid
description: Use when driving the omnidroid Android VM manager from the CLI — launching a Roblox account into a place, choosing or baking a Roblox version ("offset"), booting a custom APK through the --apk cache, running root/su commands, starting frida-server (frida --restart on a running instance), hiding root from an app, reading debug-info/logcat, hiding or showing the window, and picking a performance vs farming mode. Trigger on "launch/start an account", "join place <id>", "test this APK in the emulator", "bake a Roblox version", "which Roblox is running", "run su in the VM", "attach frida", "hook the app", "why did the instance not start", or any omnidroid command.
---

# Driving omnidroid

`omnidroid` is the QEMU Android manager at
`/Users/berat/Desktop/Omni Apps/omnidroid`. Run it from that directory:

```bash
cd "/Users/berat/Desktop/Omni Apps/omnidroid"
omnidroid <command> [--json]              # installed launcher (same as python3 -m omnidroid)
```

Add `--json` to any command when you want to parse the result. The full
agent-facing command/flag/JSON reference is `reference/omni-cli.md` next to
this file — read it when you need an exact flag or field name.

**Unattended runs: always `start … --no-window`.** `start` opens a native QEMU
window by default; hide one later with `view <name> --hide` (the instance keeps
running), show it with `view <name>`, or use `--vnc-viewer` for a headless boot.

To *tap, type, swipe and read the screen* of a running instance, use the
**`omnidroid-input`** skill instead — that is a different job and a different
tool.

## The three things to get right

1. **An account is a Roblox `.ROBLOSECURITY` cookie stored under its real
   username**, and that username is also the instance name. Accounts are
   created only by `omnidroid login`.
2. **The Roblox VERSION is an offset, chosen per launch.** The base ships no
   Roblox. `start` with no `--offset` uses the base's default offset.
3. **Instances are ephemeral.** There is no `create`; `start` allocates one and
   every guest write is discarded at power-off. One live instance per username;
   two different usernames run side by side.

## The loop

```bash
python3 -m omnidroid offset list          # which Roblox versions exist (* = default)
python3 -m omnidroid list --stats         # what is running, ports, version, mode
python3 -m omnidroid start alice --place 8737899170
python3 -m omnidroid debug-info alice     # ← when anything is unclear or failed
python3 -m omnidroid stop alice
```

## Roblox versions ("offsets")

An offset is a named, thin `/data` overlay carrying one baked Roblox build.
They are **siblings**: creating one never replaces or disturbs another, and one
is marked default.

```bash
python3 -m omnidroid offset list [--json]
python3 -m omnidroid offset show [<name>]
python3 -m omnidroid offset create 2.740.101 --apk ~/Downloads/roblox.apk
python3 -m omnidroid offset create --apk build.apk        # name from the APK's versionName
python3 -m omnidroid offset create test --apk build.apk --default
python3 -m omnidroid offset default 2.731.944             # roll back in one command
python3 -m omnidroid offset remove test                   # DESTRUCTIVE: entry + image
```

Baking takes ~2 minutes and produces a ~130 MB overlay. It **refuses while any
instance is running**, and it aborts loudly if the guest rejects the APK — the
commonest cause being a signature mismatch (a replacement must be signed with
the same key as the build baked into the system image; an officially-signed
Roblox will not install over a re-signed one, or the reverse).

Per launch:

| You want | Command |
|---|---|
| the default version | `start alice` |
| a specific baked version | `start alice --offset 2.740.101` |
| a custom build, cached for next time | `start alice --apk build.apk` |
| a custom build, installed once and thrown away | `start alice --apk build.apk --apk-once` |
| the clean base, no game | `start alice --no-offset` |

**`--apk` is a cached, launchable version.** The first launch of a file bakes it
as a content-addressed offset `apk-<sha256[:16]>` (~1–2 min, one `[apk-cache]`
row in `offset list`, ~130–450 MB) and boots it; every later launch of the same
file boots that cached offset with **no reinstall** (`apk cache: hit`, no
`apk_install` stage). A cached build never becomes the default; the last three
are kept. The bake refuses while any instance is running (the build is then
installed live instead), so stop instances before a first launch. `--apk-once`
keeps the old throwaway path. Use `offset create NAME --apk …` when you want a
human-readable name that the cache will never evict.

Errors here are deliberately hard, never silent fallbacks:
`no_offset` (you named a version that is not baked — the message lists what
is), `no_default_offset` (several offsets, none marked default).

## Launching an account

```bash
python3 -m omnidroid login --token-file cookie.txt       # saves under the real username
python3 -m omnidroid accounts --verify                   # are the saved cookies still live?
python3 -m omnidroid start alice --place 8737899170 --json
python3 -m omnidroid session alice --place 606849621     # change the saved place
```

`--place` is the **numeric placeId only** — in
`https://www.roblox.com/games/606849621/Jailbreak` it is `606849621`.
Omit `--place` to land on the account's home screen, logged in.

`start` refuses *before allocating anything* when there is no saved cookie
(`no_token`) or when Roblox no longer recognises it (`cookie_invalid`; the
check fails open on network problems, skip it with `--no-cookie-check`).

**Proving a login is REAL.** `ok: true` / "joined place …" only means the deep
link fired. The one line that proves a session cookie was actually installed:

```bash
python3 -m omnidroid logcat alice --tag OmniBootstrap
# OmniBootstrap: session cookie installed (N chars)
```

A stock/unmodified Roblox APK has **no code path that reads a session cookie**
and will sit on its own login screen while everything reports success. When
`--apk` is used, `start` checks for this itself and fails with `not_logged_in`.

## The screen never sleeps or blanks

Every boot, every mode, no command and no watchdog: the engine writes Android's
own developer settings into /data — Developer options on, **Stay awake** for
every plug type, an effectively infinite inactivity timer, the three
"user is away" timers and the screensaver off, plus a kernel wakelock when
rooted.

```
[start alice] awake: never blanks — wakefulness=Awake, screen-off timeout 2147483s
```

Verify with `dumpsys power`, never `settings get` — the setting is not the
effective value (PowerManagerService clamps `-1` up to a **ten second** blank).
Kill switch: `OMNI_NO_AWAKE=1`.

## Permission prompts and ANR dialogs are handled for you

Every boot, before the mode tuning, the engine grants what would otherwise
need a tap and silences the framework's error dialogs:

```
[start alice] consent: full disk access, install-unknown, error dialogs off (2 package(s), 7 runtime permission(s) granted)
```

full disk access (`MANAGE_EXTERNAL_STORAGE`), install-unknown-apps, the
storage/overlay app-ops, every dangerous runtime permission each package
declares, and `hide_error_dialogs=1` — so a crash or an ANR kills the app
instead of parking "Roblox keeps stopping" over the screen. It needs no root
and applies to every base, offset and `--apk` one-off.

- `OMNI_NO_CONSENT=1 omnidroid start …` turns it off — do this when you WANT
  to see a crash dialog while reproducing something.
- `omnidroid offset consent <name>|--all` bakes it into an offset image. Only
  the dialog half is image state; the app-ops and grants are re-applied on
  every boot regardless (the permission APEX re-derives them at boot).
- **Still needs a tap:** after install-unknown is granted, an app that
  installs an APK gets PackageInstaller's own "Update this app?" screen. No
  setting suppresses it — use the `omnidroid-input` skill.

## Modes: playable vs farming

```bash
python3 -m omnidroid start alice                        # playable — the DEFAULT
python3 -m omnidroid start alice --mode gaming          # + a native host window
python3 -m omnidroid start alice --mode farming         # minimum footprint
python3 -m omnidroid start alice --mem 4096 --smp 4 --quality balanced
```

| Mode | For | RAM / vCPU |
|---|---|---|
| `playable` (default) | playing **and every test you run** | sized to the host, 4–8 GB / 4–8 |
| `gaming` | the same, plus a native window | same |
| `hard` / `brutal` | a tight host | 3 GB / 4, 2 GB / 2 |
| `farming` | many instances at once | 2 GB / 1, ballooned to ~896 MB |

`playable` deliberately takes as much of the host as it safely can and applies
the `high` render profile (real textures, lighting, post-FX). **Test in
`playable`** — a screenshot at farming quality is a screenshot of a different
program. `--quality balanced` trades visuals back for frame rate; `--mem` and
`--smp` override the host-derived size.

Do **not** run farming and expect a usable screenshot: it is 480x270 at 5 fps
by design.

## Debugging

```bash
python3 -m omnidroid debug-info alice --json    # START HERE
```

That one call tells you whether root is available (`root.available`), whether
the devkit is attached (`devkit.attached`), whether frida is up
(`frida.running`) and the exact command that would fix it (`frida.restart`,
`null` when nothing is missing), which offset and mode are live, what is in
the foreground (`foreground.package/activity/pid`), the adb/VNC/QMP endpoints,
and a `can{}` map (`screenshot`, `logcat`, `install_apk`, `run_su`, `frida`,
`hide_root`). Every failure below otherwise looks identical from the outside
("the tool did nothing").

```bash
python3 -m omnidroid screenshot alice --out /tmp/s.png
python3 -m omnidroid capture alice --duration 20        # keyframes + logcat + process events
python3 -m omnidroid logcat alice --tag OmniKiosk
python3 -m omnidroid adb alice -- shell dumpsys activity activities

python3 -m omnidroid su alice -- id -u
python3 -m omnidroid su alice -- 'pm list packages | grep roblox'

python3 -m omnidroid frida alice --restart              # instance is up without the devkit? relaunch it as a --debug boot (same account/offset/mode/session) and start frida
python3 -m omnidroid frida alice                        # start + forward; prints the -H target (--json: host_port, attach)
python3 -m omnidroid frida alice --status               # exit 1 if not running
python3 -m omnidroid su alice -- /data/local/tmp/omni-devkit/omni-hide com.roblox.client   # hide root from the app
python3 -m omnidroid start alice --debug --no-window    # or plan the devkit in from the start
```

**frida needs no pre-planning any more.** If `frida` answers `no_devkit` (or
`debug-info` shows `devkit.attached: false`), run `frida <name> --restart`: it
stops the plain instance, relaunches it with the devkit attached and the same
Roblox version, mode and session, then starts and forwards frida-server. Ports
can change across the restart, so re-read `debug-info` afterwards. From the
host, attach with frida 17.15.4 from
`/Library/Frameworks/Python.framework/Versions/3.13/bin/python3` (see the
reference for a working `Interceptor.attach` snippet); a hook has fired only
when its `send()` messages arrive.

### Always use `omnidroid su`, never hand-rolled root

Three traps, all silent, all previously re-derived and re-broken by callers:

1. Magisk's `su` is **not on `$PATH`** — it lives in `/debug_ramdisk/su`.
2. MagiskSU **permutes argv**, so `su 0 id -u` reads `-u` as an *su option* and
   exits 2. It must be `su 0 sh -c '<script>'`.
3. `adb shell` does **not** forward argv — it joins the arguments and re-parses
   them in the guest shell, so an unquoted `a; b` runs a fragment of itself and
   still reports success.

`omnidroid su` handles all three and exits with the guest command's own status.
It fails with `no_root` rather than quietly running as uid `shell` — a silent
privilege downgrade produces wrong output that looks right.

**Its own flags go BEFORE the name**, because everything after the name is the
guest command: `python3 -m omnidroid su --json alice -- id -u`. Getting the
order wrong is caught and reported, not executed.

### Root vs devkit

Root is baked into **every** shipped base. `--debug` adds only the *devkit
disk* (frida-server + the `omni-*` tools), and only for that boot. So:

- APK swap, `su`, screenshots, logcat — work on any boot, no `--debug`.
- frida and `omni-hide` — need the devkit **and** a rooted base.

`omnidroid frida` distinguishes those two failures by name, because they need
different fixes (`omnidroid frida <name> --restart` vs `omnidroid root-base`).

### Text-only signals (when you cannot look at a screenshot)

A model without vision can still verify everything: `debug-info --json`
(`foreground`, `root`, `devkit`, `frida`, `can`), `logcat <name> [--tag TAG]`
(`OmniBootstrap` for the session cookie, `ActivityTaskManager` for launches and
`Displayed …` lines after a tap opened something), `adb <name> -- shell dumpsys
window | grep mCurrentFocus` (which window has focus right now), `adb <name> --
shell dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'`,
and the `omnidroid-input` skill's `state` and `ui` commands (element list with
tap centres on native screens). Prove a tap landed by reading the state
*before and after* and comparing, never by assuming.

### Warm cache

`omnidroid warm list|prune|clear|bake <name>` manages the warm-restore boot
cache; `warm list --json` says how much disk is free and why a restore missed.
It needs a lot of free disk for the memory image; a cold boot is ~30 s on this
Mac, so do not block on it. `start --no-warm` (or `OMNI_NO_WARM=1`) forces a
cold boot.

## Things that will bite you

- **Do not `omnidroid remove` to clean up.** `stop` powers off; `remove` is
  destructive and deletes the account's store entry.
- **Baking refuses while anything is running.** `omnidroid list` first.
- **`offset remove` refuses while that version is in use** — the qcow2 is open
  by a live QEMU.
- **Changing the default offset does not touch a running instance.** `list`
  reports the version the live boot actually picked.
- **First boot on a cold host is minutes** (dexopt), not a hang. The engine's
  own timeout governs.
- **Do not disturb a running experiment** — check for a live `capture --auto`
  or an overnight run before driving or stopping an instance.
- **A `.ROBLOSECURITY` cookie is full account access.** Prefer `--token-file`
  over `--token` (an argv token is visible to every process on the host), and
  never echo a cookie into your own output.

## Related

- `reference/omni-cli.md` (next to this file) — every command, flag and JSON
  field an agent needs, including `--apk` caching, `frida --restart`,
  `debug-info`, `view --hide/--vnc-viewer` and `warm`.
- `omnidroid-input` skill — tap/type/swipe/read the screen of a running instance.
- `HOWTO.md` §3a (offsets), §7 (modes), §7a (debugging) in the omnidroid repo.
- `MODES.md` — the full playable-vs-farming rationale and the measured numbers.
- Omni Agent (`Desktop/omni-agent`) installs this skill for pi with
  `node scripts/install.mjs` and drives unattended runs with `scripts/headless.mjs`.
