# omnidroid — CLI, MCP server config, switches, log markers

The native engine at `Desktop/Omni Apps/omnidroid` (Rust workspace). Binaries in
`target/release/`: `omnidroid[.exe]` (the launcher), `omni-mcp[.exe]` (the MCP server),
`omni-linux-run[.exe]` (the real-AOSP runner, for probing boots by hand).

## Build

```text
# Windows, in PowerShell (Git Bash turns the variable into a relative path)
$env:OMNIDROID_DYNARMIC_BUILD_DIR = "C:\od-unified"      # short path: MSVC fails past MAX_PATH
cargo build --release -p omnidroid -p omni-mcp
cargo test --release -p omni-linux --test r_roblox --no-run        # what `aosp` / start_instance run
cargo test -p omni-android --release --test gameactivity --no-run  # what `play` runs
```

macOS: `. ~/.cargo/env` first in a non-interactive ssh. One build dir per worktree.

## Commands

```text
omnidroid [play] [--apk <path>] [--cookie <file|name|value>] [--place <id>] [--join-delay <s>]
                 [--minutes <n>] [--fresh] [--phone] [--data-dir <dir>]
                 [--headless] [--no-window] [--control <file>]
omnidroid aosp   [--apk <path>] [--cookie <file|name>] [--place <id>] [--minutes <n>]
                 [--size <w>x<h>] [--gpu vulkan|gl|auto] [--with-systemui]
omnidroid which  [--apk <path>]
omnidroid login  [<username> [<password>]] [--dir <dir>]
omnidroid help
```

| flag | meaning |
|---|---|
| `--apk` | the APK (else `OMNI_APK`, else the repo-root APK with the highest versionCode; `which` prints the choice) |
| `--cookie` | a file holding a `.ROBLOSECURITY` cookie, or a name `login` saved (`<app-data>/../cookies/<name>.txt`); `play` also takes the value itself. Storage is per account (`<app-data>/../accounts/<name>`) |
| `--place` | numeric placeId, joined once signed in (`OMNI_JOIN_PLACE`) |
| `--join-delay` | `play`: seconds before joining (default 20; `OMNI_JOIN_DELAY`) |
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

`login` with no arguments opens Chromium for you to sign in; with a username and password they are
typed for you; a username alone uses its saved password.

## `aosp` session files

`omnidroid aosp` = `cargo test --release -q -p omni-linux --test r_roblox -- --ignored
--nocapture` in the repo, with `OMNI_WINDOW=1`, `OMNI_R_MINUTES`, `OMNI_TEST_APK`,
`OMNI_R_COOKIE`, `OMNI_R_PLACE`, `OMNI_WINDOW_SIZE`, `OMNI_GPU`, `OMNI_R_KIOSK` set from the flags.

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
| `OMNI_MCP_COOKIE` | default cookie file or saved name |
| `OMNI_MCP_PLACE` | default place id |
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

`DID_LOG_IN` · `Joining game` · `JOIN: ... returned 1` · `submitStartGameTask` ·
`onGameLoaded: placeId:...` (in-world timing starts after it plus ~2 min) ·
`FRAMES: +Ns ..., T presents (+X in the last 5s)` (fps = X/5) · `GUEST THREAD DIED` (always a bug) ·
the close's `SessionHistory "IAB"`/`"IB"` (clean) · `Upgrade required` (APK too old) ·
`[r] cookie planted: …` / `[r] relaunched: 0` (aosp sign-in).

## Environment switches (read once at start; each announces itself in the log)

| switch | effect |
|---|---|
| `OMNI_KEYBOARD_MOUSE=1` | host keyboard and mouse as the device's (`play`'s default; `--phone` = touch) |
| `OMNI_FPS_CAP=<fps>` | pace frames from underneath |
| `OMNI_GRAPHICS_QUALITY=1..10` | the game's saved quality |
| `OMNI_AUDIO=off` | no audio |
| `OMNI_GUEST_MEMORY_MB`, `OMNI_GUEST_CPUS` | the device's RAM and CPU count |
| `OMNI_WINDOW_SIZE=<w>x<h>` | initial window size; on the real-AOSP path the display's size at boot |
| `OMNI_WINDOW_CONTROL=<file>` | real-AOSP window: lines `size`, `key`, `click`, `point`, `move`, `wheel`, `flood <hz> <s>`, `chrome show|hide` |
| `OMNI_APP_ONLY=0`, `OMNI_R_KIOSK=0` | real-AOSP: present the whole display / keep SystemUI and the launcher |
| `OMNI_DEVICE_APPS=full|lean|lean-hw|kiosk` | real-AOSP: what the device image leaves out (default lean) |
| `OMNI_MEM_REPORT=1` / `=every:<s>` | `MEMREPORT` lines: memory by owner |
| `OMNI_PERF=<s>` | per-thread PERF blocks every s seconds |
| `OMNI_PAUSE_IN_BACKGROUND=1` | Android's pause-in-background (default: keep playing) |
| `OMNI_JOIN_PLACE`, `OMNI_JOIN_DELAY`, `OMNI_DEEPLINK` | join a place |
| `OMNI_GUEST_ENV=K=V,..` | extra guest environment |
| `OMNI_LOG_TIME=1` | stamp log lines |
| `OMNI_NET_TRACE=1`, `OMNI_GPU_TRACE=1`, `OMNI_INIT_TRACE=1`, `OMNI_TRACE_SERVICE=<name>` | real-AOSP diagnostics |

The full, current table is `docs/HANDOFF.md` → "Running" → "Switches" in the omnidroid repo.
