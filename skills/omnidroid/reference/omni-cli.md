# omnidroid — CLI, MCP server config, switches, log markers

The native engine at `Desktop/Omni Apps/omnidroid` (Rust workspace). Binaries in
`target/release/`: `omnidroid[.exe]` (the launcher), `omni-mcp[.exe]` (the MCP server),
`omni-linux-run[.exe]` (the real-AOSP runner, for probing boots by hand).

## The app (what runs apps now)

```text
omnidroid                       the app: warm Androids, any APK in windows of its own, a command line
omnidroid <app.apk> [xN] [plugin options]   the app, launching N instances (e.g. --cookie <c> --place <id>);
                                .apkm / .xapk / .apks bundles too (a zip of APKs: `run <path>` at the prompt)
omnidroid serve [--port <n>]    the app without its screen (pool + MCP), until stdin closes
omnidroid restart <id>...|all   restart instances of the running pool (bare ids: a shell drops `#3`)
omnidroid autorestart on|off <id>...|all   auto restart for instances, or (all) the pool's setting
omnidroid help commands         the one-shot commands below (scripts, and the app's own use)
```

Every window and `serve` on a computer share one pool (`omnidroid host`, a process of its own, found
through `pool.host` beside `app.conf`; its output in `pool.host.log`). At the prompt: `run <apk> [xN]
[plugin options]`, `close`, `restart`, `autorestart`, `warm`, `kill`, `shell`, `plugins`, `settings`,
`set`, `mcp`, `help`, `quit`; MCP: `start_instance {apk, count, options}`. A launch's plugin options run
the plugins' `session-start` hooks as `aosp` does (`crates/omnidroid/src/app/plugged.rs`); their
`OMNI_R_COOKIE` becomes a WebView cookie store (made on the host by `python tools/plant_cookie.py
--new`) planted for the instance's own Android user, their `OMNI_R_LINK` + `OMNI_R_LINK_ID` opened on
its display once `OMNI_R_LINK_READY` or `OMNI_R_SIGNED_IN` is logged, again every 60 s (4 tries) until
`OMNI_R_LINK_TAKEN` is (`omni_pool::extras`). A restart asks the plugins again (a new cookie store, the
link followed again).

Settings (`settings` / `set <key> <value>` in the app, MCP `settings`; `<app-data>/../app.conf`, or
`OMNI_APP_CONFIG`):

| key | default | meaning |
|---|---|---|
| `idle_close_minutes` | 5 | close an Android that has run no app this long (0: never) |
| `keep_warm` | 1 | Androids kept up in all, busy or idle |
| `warm_on_start` | true | warm an Android when the app opens |
| `stop_on_exit` | true | stop every Android when the app quits (else the next start adopts them) |
| `max_devices` | 0 | the most Androids at once (0: no limit) |
| `instance_size` | 1280x720 | a new instance's display and window |
| `gpu`, `device_ram_mb` | auto, 0 | the Androids' GPU backend and RAM |
| `auto_restart` | false | start an app that crashed again on its window after 5 s (an instance's own setting wins) |
| `mcp_enabled`, `mcp_port` | false, 7457 | the MCP server on `http://127.0.0.1:<port>/mcp` (`mcp on|off|register|status`; not changeable over MCP) |

A pool Android is `omnidroid aosp --warm` with `OMNI_MULTI_DISPLAY=1` (displays added at runtime,
each a window), `OMNI_PRIMARY_WINDOW=0`, users visible on displays of their own
(`fw.visible_bg_users=1`), `ro.hw_timeout_multiplier` 5 and no spare app process; its files are
`<temp>/omni-warm-<secs>` (`.log` = its logcat, `.png`, `.d<display>.png` per instance, `.pool`,
`.launcher.log`).

## Build

```text
# Windows, in PowerShell (Git Bash turns the variable into a relative path)
$env:OMNIDROID_DYNARMIC_BUILD_DIR = "C:\od-unified"      # short path: MSVC fails past MAX_PATH
cargo build --release -p omnidroid -p omni-mcp
cargo test --release -p omni-linux --test r_app --no-run           # what `aosp` / a session of its own run
cargo test -p omni-android --release --test gameactivity --no-run  # what `play` runs
```

macOS: `. ~/.cargo/env` first in a non-interactive ssh. One build dir per worktree.

## Commands

```text
omnidroid aosp [--apk <path>] [--minutes <n>] [--size <w>x<h>] [--gpu vulkan|gl|auto]
                 [--with-systemui] [--fresh-device] [--standby] [--instance <dir>]
                 [--root] [--module <id,...>] [--denylist <pkg,...>] [--su all|<pkg,...>] [--no-clipboard]
omnidroid --apk <path> [...]                         # options with no command = aosp
                                                     # (a bare `omnidroid <app.apk>` opens the app instead)
omnidroid aosp --warm [--instance <dir>] [--minutes <n>]   # a warm device, no app
omnidroid play   [--apk <path>] [--minutes <n>] [--fresh] [--phone] [--data-dir <dir>]
                 [--headless] [--no-window] [--control <file>]
omnidroid which  [--apk <path>]
omnidroid modules [add <zip>]                         # the root module catalog
omnidroid plugins [list | add [--link] <dir> | remove | enable | disable | new]
omnidroid help                                       # also every installed plugin's options
```

| flag | meaning |
|---|---|
| `--apk` (or a bare `*.apk` path) | any APK (else `OMNI_APK`, else the repo-root APK with the highest versionCode; `which` prints the choice) |
| `--minutes` | end the session after n minutes (`play`: default when the window closes; `aosp`: default 30) |
| `--fresh` | `play`: a fresh install; use after a killed run |
| `--phone` | `play`: touch screen, the mouse is a finger, no keyboard |
| `--data-dir` | `play`: where the app's storage lives |
| `--headless` | `play`: frames are run and presented, the GPU draws none (`OMNI_HEADLESS=1`) |
| `--no-window` | `play`: no window at all, an off-screen surface (`OMNI_NO_WINDOW=1`; implies headless) |
| `--control <file>` | `play`: commands appended to the file (and stdin): `headless on`, `headless off`, `screenshot <path>`, `status` |
| `--size` | `aosp`: the display's size at boot (at least 320x240) |
| `--gpu` | `aosp`: `vulkan`, `gl` or `auto` (Vulkan with a Vulkan GPU, else the host's GLES; `OMNI_GPU`) |
| `--with-systemui` | `aosp`: keep SystemUI and the launcher (default: a single-app kiosk device) |

Options an app needs beyond install-and-start (a sign-in, a link to open) are an installed
plugin's (`omnidroid plugins`, `plugins/README.md` in the repo); `omnidroid help` lists them.

## `aosp` session files

`omnidroid aosp` = the warm device when one is up (the APK installed and started on it), else
`cargo test --release -q -p omni-linux --test r_app -- --ignored --nocapture` in the repo, with
`OMNI_WINDOW=1`, `OMNI_R_MINUTES`, `OMNI_TEST_APK`, `OMNI_R_PACKAGE` (from the manifest),
`OMNI_WINDOW_SIZE`, `OMNI_GPU`, `OMNI_R_KIOSK` set from the flags. What a session does beyond
install-and-start is a plugin's, as variables (`omni_linux::app_session`): `OMNI_R_COOKIE` (a cookie
file for the app's WebView store), `OMNI_R_LINK` + `OMNI_R_LINK_ID` (a link opened once the app is
ready), the markers `OMNI_R_LINK_READY`, `OMNI_R_SIGNED_IN`, `OMNI_R_LINK_TAKEN`, `OMNI_R_LOADED`,
`OMNI_R_DISCONNECTED`, and `OMNI_R_LOCALE` (default en-US).

- log: `<temp>/omni-linux-r-<pid>.log` (every line)
- frames: `<temp>/omni-linux-r-<pid>-shots/NNNN.png` every 20 s
- live framebuffer: `OMNI_SCREENSHOT` if preset (omni-mcp presets `<temp>/omni-mcp-inst-N.png`)
- `<temp>` is the OS temp dir, except on a tmpfs `/tmp` with no `TMPDIR`: `<app-data>/../aosp`

## The MCP servers

**What agents use: the app's** (`mcp on`; `http://127.0.0.1:<mcp_port>/mcp`, Streamable HTTP; one per
computer). Its instance/device/web tools are the pool's (`crates/omnidroid/src/app/live.rs`,
`web.rs`; numeric instance and device ids); its lab tools are forwarded, one call at a time, to an
`omni-mcp --lab` child started at the first lab call (`OMNI_MCP_BIN` names another binary). If that
child dies it is started again once — every lab session and corpus is gone then.

- Claude Code: `claude mcp add --transport http --scope user omnidroid <url>` (`mcp on` / `mcp
  register` does it).
- pi: `~/.pi/agent/omni-agent.json` → `omniMcp: {command: "<omnidroid>/target/release/omni-mcp[.exe]",
  args: ["--connect", "<url>"], timeoutSec: 600}` — `omni-mcp --connect <url>` is a stdio↔HTTP
  bridge. Other `omniMcp` keys: `env`, `prefix` (default `omnidroid_`), `enabled` (`false` turns the
  extension off), `waitPollMs` (wait_device's poll, default 3000). A call past `timeoutSec` is not
  killed: pi answers "still running" and posts the late result.

**The standalone `omni-mcp`** (no arguments: JSON-RPC 2.0 over stdio, protocol `2024-11-05`) is a
different, older surface that drives one warm device itself, outside the pool: string ids
(`inst-1`), `start_instance {apk, args[], link_id, gpu, size, minutes, root, modules}`, `install_apk`,
`launch_app`, `uninstall_apk`, `stop_app`, `device_status` (the single warm device), states
`app_on_screen`/`app_running`/`booting`/`signed_in`/`link_taken`/`loaded`/`stopped`, and no
`wait_instance`, `restart_instance`, `auto_restart`, `list_devices`, `settings`, `pool_log` or `web_*`.
Don't mix it with the app's pool. Its env (`omni-mcp --help`, `crates/omni-mcp/README.md`):
`OMNI_MCP_APK`, `OMNI_MCP_ARGS`, `OMNI_MCP_LINK_ID`, `OMNI_MCP_GPU`, `OMNI_MCP_SIZE`,
`OMNI_MCP_DEVICE_RAM_MB`, `OMNI_MCP_MINUTES`, `OMNI_MCP_STANDBY[_MINUTES]`, `OMNI_MCP_WARM[_MINUTES|_WAIT]`,
`OMNIDROID_BIN`, `OMNI_MCP_REPO`. `omni-mcp --lab` serves the lab tools alone.

## Log markers

`[r] boot_completed=1` · `[r] pm install: 0` · `[r] package <pkg>` / `[r] launcher <activity>` ·
`[r] am start: 0` · `[zygote] launching <pkg>` · `frames presented` ·
`Process <pkg> (pid N) has died` (with `FATAL EXCEPTION` / `Fatal signal` above it for a crash) ·
`GUEST THREAD DIED` (always a bug) · `[r] cookie planted: ok` (a plugin's sign-in) ·
`[r] link for <id>` (a plugin's link sent; on a pool launch: `pool_log` `#N: link sent`) · `FRAMES: +Ns ..., T presents (+X in the last 5s)`
(`play`: fps = X/5). A plugin's own markers are logged again as `[t] +<secs>s <line>`.

## Environment switches (read once at start; each announces itself in the log)

| switch | effect |
|---|---|
| `OMNI_KEYBOARD_MOUSE=1` | host keyboard and mouse as the device's (`play`'s default; `--phone` = touch) |
| `OMNI_FPS_CAP=<fps>` | pace frames from underneath |
| `OMNI_AUDIO=off` | no audio |
| `OMNI_GUEST_MEMORY_MB`, `OMNI_GUEST_CPUS` | the device's RAM and CPU count |
| `OMNI_WINDOW_SIZE=<w>x<h>` | initial window size; on the real-AOSP path the display's size at boot |
| `OMNI_WINDOW_CONTROL=<file>` | real-AOSP window: lines `size`, `key`, `click`, `point`, `move`, `wheel`, `flood <hz> <s>`, `chrome show|hide` |
| `OMNI_APP_ONLY=0`, `OMNI_R_KIOSK=0` | real-AOSP: present the whole display / keep SystemUI and the launcher |
| `OMNI_DEVICE_APPS=full|lean|lean-hw|kiosk` | real-AOSP: what the device image leaves out (default lean) |
| `OMNI_MEM_REPORT=1` / `=every:<s>` | `MEMREPORT` lines: memory by owner |
| `OMNI_PERF=<s>` | per-thread PERF blocks every s seconds |
| `OMNI_PAUSE_IN_BACKGROUND=1` | Android's pause-in-background (default: keep playing) |
| `OMNI_GUEST_ENV=K=V,..` | extra guest environment |
| `OMNI_LOG_TIME=1` | stamp log lines |
| `OMNI_NET_TRACE=1`, `OMNI_GPU_TRACE=1`, `OMNI_INIT_TRACE=1`, `OMNI_TRACE_SERVICE=<name>` | real-AOSP diagnostics |

The full, current table is `docs/HANDOFF.md` → "Running" → "Switches" in the omnidroid repo.
