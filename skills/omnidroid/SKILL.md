---
name: omnidroid
description: Use when running any APK on omnidroid, the native ARM64-Android engine in "Omni Apps/omnidroid" (Rust, no VM) — installing and testing any APK in seconds on the host's warm Android device (start_instance / install_apk / shell / stop_app / uninstall_apk / device_status / stop_device), looking inside a running app (its log, files, process, screen), driving it with input, running a session of its own with an installed plugin's options (args / link_id), the `omnidroid` CLI (`omnidroid <app.apk>`, aosp, play, which, plugins), headless runs and the control channel. Trigger on "run this APK", "install/launch/start this app", "boot omnidroid", "start an instance", "take a screenshot of the instance", "is the app running", or any omnidroid_* / mcp__omnidroid__* tool. For hooking, calling or dumping a .so use the omnidroid-frida skill; for the old QEMU manager (offsets, `omnidroid su`, frida-server) use omnidroid-qemu.
---

# Driving omnidroid

`omnidroid` (the checkout at `Desktop/Omni Apps/omnidroid`) runs Android apps as native desktop
processes: real Android userspace (system_server, SurfaceFlinger, ART…) on omnidroid's own Linux
ABI layer, the APK's arm64 code run by dynarmic, with graphics, audio, input and networking on the
host. **There is no VM, no QEMU, no adb, no frida-server.** Commands such as
`omnidroid start/offset/session/debug-info/su/frida` belong to the old QEMU manager
(`omnidroid-qemu` skill) and do not exist here.

**Any APK runs.** The launcher knows no app: the APK's package and launcher Activity come from its
own manifest, it is installed with `pm install` and started from its launcher, as a device does.

| path | what boots | how |
|---|---|---|
| **real Android** (default, any APK) | real Android on omnidroid's Linux ABI layer; the APK `pm install`ed and started from its launcher | MCP `start_instance {apk}`, or `omnidroid <app.apk>` (= `omnidroid aosp --apk …`) |
| **fast path** (opt-in) | the APK's native code alone, no Java runtime — only apps whose Java side the engine answers itself | `omnidroid play` |

## The MCP tools (preferred for an agent)

omnidroid ships an MCP server, `omni-mcp` (`crates/omni-mcp`). Omni Agent wires it in:

- **pi**: the `omni-mcp.ts` extension registers every tool as `omnidroid_<tool>`
  (`omnidroid_start_instance`, `omnidroid_screenshot`, …).
- **Claude Code**: `node scripts/install.mjs --claude-mcp` registers it as `omnidroid`, tools
  `mcp__omnidroid__<tool>`.

Below, tools are named without the prefix. **No `omnidroid_*` tools?** The binary is not built or
not configured: in the omnidroid repo `cargo build --release -p omnidroid -p omni-mcp`, then in
omni-agent `node scripts/install.mjs` and restart pi. Its path lives in
`~/.pi/agent/omni-agent.json` → `omniMcp.command`.

### Any APK on the warm device

`start_instance {apk}` and `install_apk {apk}` (with no `args` or `link_id`) use the host's **one
warm device** (Android booted and idle, no app of its own): the APK is installed unless the device
already holds the same bytes (SHA-256, not version), another test app is uninstalled first, and
`start_instance` **blocks until the launcher Activity is displayed**, answering `state:
app_on_screen` with seconds per step. No warm device up: the call boots one (~45-60 s from its saved
copy; the first ever ~2 min; the whole first call ~70-80 s) and it stays up for the next APKs, beyond
this server. `apk` is the APK's **host path** (absolute); the user can hand you any APK.

| tool | does |
|---|---|
| `start_instance {apk}` | install by content + start; ~2 s same APK, ~8-10 s a rebuilt/other small APK (a spare app process is kept ready), ~30 s a large game |
| `install_apk {apk}` | install by content now, no start |
| `stop_instance {instance_id, device?}` | force-stop + clear the app; the device stays warm (`device: true` shuts it) |
| `shell {command, uid?}` | adb-shell style on the warm device (`pm`, `am`, `dumpsys`, `input`) |
| `uninstall_apk {package}` / `stop_app {package}` | on the warm device |
| `device_status` / `stop_device` | none/booting/ready + test apps / shut it down |
| `screenshot {instance_id?}` | the latest framebuffer PNG: `path`, `width`, `height` (a vision model in pi also gets the image) |

- `screenshot` right after a start waits for a fresh frame (<=3 s).
- From a terminal: `python tools/device_ctl.py "<command>"` (control channel `<dir>.ctl`).
- Never two devices per host: a warm device will not boot while a session of its own runs.
- Quitting pi (the MCP server exiting) force-stops the apps it started; the device stays up.

**Proof an app is up**: `start_instance` answering `state: app_on_screen` means Android displayed
its launcher Activity. Then `screenshot` and look at it; `shell "dumpsys window | grep
mCurrentFocus"` names the focused window. If the app dies, the device log (`device_status` →
`log`) has `Process <package> (pid N) has died` and, for a crash, the `FATAL EXCEPTION` /
`Fatal signal` lines above it — quote the line you saw.

**Looking inside a running app** (the warm device has no adb, no frida-server -- the guest kernel
has no `ptrace`, so nothing can be injected into a live process):

| want | how |
|---|---|
| its log | the device's log file on the host -- `device_status` → `log` (`<device dir>.log`): every Android log line (`I/Tag(pid): ...`) lands there; grep it with your file tools. In-guest `logcat -d` is empty here |
| its process | `shell "dumpsys activity processes | grep <package>"` (pid, state). `pidof`/`ps` do not see apps: each runs in a host process of its own |
| what is on screen / its state | `screenshot`; `shell "dumpsys activity top"`, `"dumpsys window | grep mCurrentFocus"` |
| its files, prefs, databases | `shell {command: "ls -R /data/data/com.example.app", uid: 0}`, `cat` a file (root reads any) |
| input | `shell "input tap X Y"`, `"input text hello"`, `"input keyevent KEYCODE_BACK"` |
| a link into the app | `shell "am start -a android.intent.action.VIEW -d '<uri>' <package>"` |
| its native code, hooked | the installed APK is on the host: `<device dir>/data/app/*/<package>-*/base.apk` (`device_status` gives the dir); unzip `lib/arm64-v8a/*.so` and use the **omnidroid-frida** lab (`lab_load`, `intercept`, `call_function`, `dump_module`) |
| a fresh start of it | `stop_app {package}` then `start_instance {apk}` (same bytes: no reinstall) |

### A session of its own (a plugin's options)

What one app needs beyond install-and-start (a sign-in cookie, a link opened once the app is up,
the log lines that say how far it got) is an omnidroid **plugin**'s, never the launcher's
(`omnidroid plugins` lists the installed ones; `omnidroid help` lists their options).
`start_instance {apk, args?, link_id?}` with `args` (e.g. `["--cookie", "acct"]`) or `link_id`
boots a device of its own through `omnidroid aosp` and **returns at once**:

| tool | does |
|---|---|
| `start_instance {apk, args?, link_id?, gpu?, size?, minutes?}` | spawns `omnidroid aosp --apk … <args>`; `link_id` is the id the plugin's link opens once the app is ready |
| `list_instances` | each instance's **`state`**: `booting`, `signed_in`, `link_taken`, `loaded` (+ `loaded_id`), `stopped` — as far as its plugin names markers; `log`, `screenshot_path` — poll this, not screenshots |
| `stop_instance {instance_id}` | ends it (its `stop` file: the device shuts down) |

- An option no installed plugin adds is refused, with a hint naming the repository's plugin that
  adds it.
- Without the plugin's markers a session shows `booting` until it stops: read its log.
- The first session for an APK (and account) boots a new device (minutes) and saves it; later ones
  boot the saved copy. Poll `list_instances` every 10-20 s, don't spin.
- Instances belong to the omni-mcp process: **quitting pi stops every instance it booted**. A tool
  call that times out (600 s, `omniMcp.timeoutSec`) restarts omni-mcp, which also stops them.

**A session's failures are silent to the tool** (omni-mcp throws the launcher's output away): a
build error or a missing APK shows only as `running: false`. Build first where you can see the
output (`cargo build --release -p omnidroid -p omni-mcp`, and
`cargo test --release -p omni-linux --test r_app --no-run`), then read the session's own log:
`<temp>/omni-linux-r-<pid>.log` (`%TEMP%` on Windows, `$TMPDIR`/`/tmp` elsewhere; the MCP's are
`omni-linux-r-mcp-*`), a frame every 20 s in `<temp>/omni-linux-r-<pid>-shots/NNNN.png`.

| line in a session's log | means |
|---|---|
| `[r] boot_completed=1` | Android is up |
| `[r] pm install: 0` | installed |
| `[r] package <pkg>` / `[r] launcher <activity>` | what will be started |
| `[r] am start: 0` | the launcher Activity was started |
| `frames presented` | the app drew |
| `GUEST THREAD DIED` | always a bug — report it with the lines around it |

## The CLI

```bash
cd "Omni Apps/omnidroid"
target/release/omnidroid ~/apks/app.apk                 # any APK on real Android (a warm device if one is up)
target/release/omnidroid aosp --apk X --minutes 30 [--size 1600x900] [--gpu vulkan|gl|auto] [--with-systemui]
target/release/omnidroid aosp --warm                     # a warm device, no app (what start_instance uses)
target/release/omnidroid play --apk X [--minutes N] [--fresh] [--phone] [--headless|--no-window] [--control cmds.txt]
target/release/omnidroid which [--apk X]                 # which APK a run would use, and why
target/release/omnidroid plugins                         # installed plugins (their options: omnidroid help)
```

Full flags, environment switches and the `--control` commands: `reference/omni-cli.md`.

- **APK choice**: a bare `*.apk` path or `--apk`, else `OMNI_APK`, else the APK in the repo root with
  the highest versionCode. Pass the user's APK explicitly.
- **`play` is the fast path for the few apps it serves** (it has no Java runtime); it refuses an APK
  whose manifest names no native Activity library. Use the default (`aosp`) for anything else.
- **`play` runs until the window closes** (or `--minutes`). End every run cleanly — a killed run
  is judged a crash at the next launch of that storage; after one, pass `--fresh`.
- **Headless `play`**: `--headless` runs and presents every frame without drawing; `--no-window`
  has no window at all. With `--control FILE`, append lines to FILE (or type on stdin):
  `headless on|off`, `screenshot <path>` (a real frame, rendered and saved), `status`.

## Things that will bite you

- **Credentials**: never print, log, or copy a cookie value or password; pass cookie *files* or
  saved names to a plugin's option.
- **Never build on Windows while an app is being run** — a build exhausted the commit limit once
  and killed guest threads. One live device per host at a time; builds may run in parallel.
- A full `C:` shows up as `ENOMEM` in every spawn: prune `target/*/incremental`.
- From Git Bash, `export MSYS_NO_PATHCONV=1` before anything that takes guest paths.
- Graphics buffers of finished sessions (`omni-shm-*` in the temp dir) are cleaned by the next
  `aosp` run, not by a killed one.
- An APK whose native libraries are only for another ABI (armeabi-v7a, x86) has no arm64 code to
  run; split APKs / `.xapk` / `.apks` bundles need their base APK picked out first.

## Related

- `omnidroid-frida` skill — the lab debugger over the same MCP server: load a `.so`, call its
  functions with crafted inputs, intercept, patch, dump.
- `reference/omni-cli.md` — every flag, switch and log marker.
- The omnidroid repo: `docs/HANDOFF.md` (current state, "Running"), `docs/STATUS.md`,
  `crates/omni-mcp/README.md`, `plugins/README.md`.
- `omnidroid-qemu` / `omnidroid-input` skills — the retired QEMU manager (`Omni Apps/omnidroid-old`).
