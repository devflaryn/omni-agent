# omnidroid — CLI, MCP server config, switches, log markers

The native engine at `Desktop/Omni Apps/omnidroid` (Rust workspace). Binaries in
`target/release/`: `omnidroid[.exe]` (the launcher), `omni-mcp[.exe]` (the MCP server),
`omni-linux-run[.exe]` (the real-AOSP runner, for probing boots by hand).

## The app (what runs apps now)

```text
omnidroid                       the app: warm Androids, any APK in windows of its own, a command line
omnidroid <app.apk> [xN] [plugin options]   the app, launching N instances (e.g. --cookie <c> --place <id>)
omnidroid serve [--port <n>]    the app without its screen (pool + MCP), until stdin closes
omnidroid help commands         the one-shot commands below (scripts, and the app's own use)
```

Every window and `serve` on a computer share one pool (`omnidroid host`, a process of its own, found
through `pool.host` beside `app.conf`; its output in `pool.host.log`). At the prompt: `run <apk> [xN]
[plugin options]`; MCP: `start_instance {apk, count, options}`. A launch's plugin options run the
plugins' `session-start` hooks as `aosp` does; their `OMNI_R_COOKIE` is planted for the instance's own
Android user, their `OMNI_R_LINK` + `OMNI_R_LINK_ID` opened on its display once `OMNI_R_LINK_READY` or
`OMNI_R_SIGNED_IN` is logged (`omni_pool::extras`).

Settings (`settings` / `set <key> <value>` in the app; `<app-data>/../app.conf`, or `OMNI_APP_CONFIG`):

| key | default | meaning |
|---|---|---|
| `idle_close_minutes` | 5 | close an Android that has run no app this long (0: never) |
| `keep_warm` | 1 | Androids kept up in all, busy or idle |
| `warm_on_start` | true | warm an Android when the app opens |
| `stop_on_exit` | true | stop every Android when the app quits (else the next start adopts them) |
| `max_devices` | 0 | the most Androids at once (0: no limit) |
| `instance_size` | 1280x720 | a new instance's display and window |
| `gpu`, `device_ram_mb` | auto, 0 | the Androids' GPU backend and RAM |
| `mcp_enabled`, `mcp_port` | false, 7457 | the MCP server on `http://127.0.0.1:<port>/mcp` (`mcp on|off|register|status`) |

A pool Android is `omnidroid aosp --warm` with `OMNI_MULTI_DISPLAY=1` (displays added at runtime,
each a window), `OMNI_PRIMARY_WINDOW=0`, users visible on displays of their own
(`fw.visible_bg_users=1`), `ro.hw_timeout_multiplier` 5 and no spare app process; its files are
`<temp>/omni-warm-<secs>` (`.log`, `.png`, `.d<display>.png` per instance, `.pool`, `.launcher.log`).

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
omnidroid <app.apk> [aosp options]                   # = omnidroid aosp --apk <app.apk>
omnidroid [aosp] [--apk <path>] [--minutes <n>] [--size <w>x<h>] [--gpu vulkan|gl|auto]
                 [--with-systemui] [--fresh-device] [--standby] [--instance <dir>]
                 [--root] [--module <id,...>] [--su all|<pkg,...>] [--no-clipboard]
omnidroid aosp --warm [--instance <dir>] [--minutes <n>]   # a warm device, no app
omnidroid play   [--apk <path>] [--minutes <n>] [--fresh] [--phone] [--data-dir <dir>]
                 [--headless] [--no-window] [--control <file>]
omnidroid which  [--apk <path>]
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

## The MCP server (`omni-mcp`)

JSON-RPC 2.0 over stdio, one message per line; protocol `2024-11-05`. Tool errors come back as
JSON-RPC errors carrying the server's message. `omni-mcp --help` lists the env.

| env (all optional; in pi put them in `~/.pi/agent/omni-agent.json` → `omniMcp.env`) | meaning |
|---|---|
| `OMNI_MCP_APK` | default APK for `start_instance` |
| `OMNI_MCP_ARGS` | default launcher options for a session of its own (a plugin's), whitespace separated. Leave unset for general use: with it every `start_instance` boots a session instead of using the warm device |
| `OMNI_MCP_LINK_ID` | default id a session's link opens |
| `OMNI_MCP_GPU` | `vulkan` / `gl` / `auto` (default `auto`) |
| `OMNI_MCP_SIZE` | display `WxH` |
| `OMNI_MCP_DEVICE_RAM_MB` | device RAM, passed on as `OMNI_DEVICE_RAM_MB` |
| `OMNI_MCP_MINUTES` | session minutes |
| `OMNIDROID_BIN` | the launcher (default: `omnidroid` beside `omni-mcp`) |
| `OMNI_MCP_REPO` | the repo the launcher runs `cargo test` in (default: three levels above the binary) |
| `OMNIDROID_DYNARMIC_BUILD_DIR` | pass it through so a rebuild inside `aosp` works on Windows |

Other `omniMcp` keys in `omni-agent.json`: `command` (the binary; the installer fills it in),
`args`, `timeoutSec` (default 600; a call that exceeds it restarts the server), `prefix` (default
`omnidroid_`), `enabled` (`false` turns the extension off).

Claude Code: `node scripts/install.mjs --claude-mcp` (in omni-agent) runs
`claude mcp add --scope user omnidroid [-e K=V …] -- <command>` with the same env.

## Log markers

`[r] boot_completed=1` · `[r] pm install: 0` · `[r] package <pkg>` / `[r] launcher <activity>` ·
`[r] am start: 0` · `[zygote] launching <pkg>` · `frames presented` ·
`Process <pkg> (pid N) has died` (with `FATAL EXCEPTION` / `Fatal signal` above it for a crash) ·
`GUEST THREAD DIED` (always a bug) · `[r] cookie planted: ok` (a plugin's sign-in) ·
`[r] link for <id>` (a plugin's link sent) · `FRAMES: +Ns ..., T presents (+X in the last 5s)`
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
