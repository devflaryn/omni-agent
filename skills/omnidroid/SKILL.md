---
name: omnidroid
description: Use when running Roblox (or any APK) on omnidroid, the native ARM64-Android engine in "Omni Apps/omnidroid" (Rust, no VM) — booting an instance through the omnidroid MCP tools (start_instance, screenshot, list_instances, stop_instance) or the `omnidroid` CLI (play, aosp, login, which), signing in with a saved cookie, joining a place, picking the APK, headless runs and the control channel, and proving a session really signed in and joined from its log. Trigger on "boot/launch omnidroid", "start an instance", "join place <id>", "run this APK", "sign in with the cookie", "take a screenshot of the instance", "is the game running", or any omnidroid_* / mcp__omnidroid__* tool. For hooking, calling or dumping a .so use the omnidroid-frida skill; for the old QEMU manager (offsets, `omnidroid su`, frida-server) use omnidroid-qemu.
---

# Driving omnidroid

`omnidroid` (the checkout at `Desktop/Omni Apps/omnidroid`) runs the arm64 Android Roblox engine
as a native desktop app: the APK's `lib/arm64-v8a` libraries are loaded by its own ELF loader and
run by dynarmic, with bionic, JNI, the NDK, Vulkan/GLES, audio, input and networking implemented
on the host. **There is no VM, no QEMU, no adb, no `su`, no frida-server.** Commands such as
`omnidroid start/offset/session/debug-info/su/frida` belong to the old QEMU manager
(`omnidroid-qemu` skill) and do not exist here.

Two ways to run a game:

| path | what boots | how |
|---|---|---|
| **real-AOSP** (the current goal) | real Android (system_server, SurfaceFlinger…) on omnidroid's own Linux ABI layer; the APK is `pm install`ed and started from its launcher | MCP `start_instance`, or `omnidroid aosp` |
| **old path** | the engine alone, JNI without a JVM | `omnidroid play` |

## The MCP tools (preferred for an agent)

omnidroid ships an MCP server, `omni-mcp` (`crates/omni-mcp`). Omni Agent wires it in:

- **pi**: the `omni-mcp.ts` extension registers every tool as `omnidroid_<tool>`
  (`omnidroid_start_instance`, `omnidroid_screenshot`, …).
- **Claude Code**: `node scripts/install.mjs --claude-mcp` registers it as `omnidroid`, tools
  `mcp__omnidroid__<tool>`.

Below, tools are named without the prefix. **No `omnidroid_*` tools?** The binary is not built or
not configured: in the omnidroid repo `cargo build --release -p omni-mcp`, then in omni-agent
`node scripts/install.mjs` and restart pi. Its path lives in `~/.pi/agent/omni-agent.json` →
`omniMcp.command`.

### Live instance

| tool | does |
|---|---|
| `start_instance {apk?, cookie?, place?, gpu?, size?, minutes?}` | spawns `omnidroid aosp …` and **returns at once** with `instance_id`, `pid`, `screenshot_path` |
| `screenshot {instance_id?}` | the latest framebuffer PNG: `path`, `width`, `height` (a vision model in pi also gets the image) |
| `list_instances` | every instance this server started: `running`, `uptime_s`, `apk`, `place`, `screenshot_path` |
| `stop_instance {instance_id}` | kills it |
| `install_apk {apk}` / `login {cookie}` / `join_place {place}` | **only record defaults for the NEXT `start_instance`** — they never touch a running instance |
| `launch_app` | the same as `start_instance` |

- `cookie` is a cookie file path or a name `omnidroid login` saved; `place` is the numeric placeId
  (`https://www.roblox.com/games/8737899170/…` → `8737899170`); `gpu` is `vulkan|gl|auto`;
  `size` is `WxH`; `minutes` bounds the session (default 30).
- `apk` falls back to `OMNI_MCP_APK` (set in `omniMcp.env`). There is no auto-pick here: without
  either, `start_instance` fails with "no APK".
- A boot takes **minutes**. `screenshot` answers "no frame yet … (still booting?)" until the
  display has presented one; poll it every 20–30 s, don't spin.
- Instances belong to the omni-mcp process. In pi it is kept across chat switches and closed on
  quit — **quitting pi stops every instance it booted**. A tool call that times out (600 s,
  `omniMcp.timeoutSec`) restarts omni-mcp, which also stops them.

### What `start_instance` actually runs — and why a failure is silent

`omnidroid aosp` runs `cargo test --release -p omni-linux --test r_roblox -- --ignored` in the
repo (`OMNI_MCP_REPO`, default: three levels above the binary). omni-mcp throws that process's
output away, so **a build error, a bad cookie or a missing APK shows up only as
`running: false` in `list_instances`**. Therefore:

1. **Build first**, where you can see the output (Windows: PowerShell, not Git Bash — Git Bash
   mangles the variable into a relative path):
   ```powershell
   $env:OMNIDROID_DYNARMIC_BUILD_DIR = "C:\od-unified"     # a SHORT path; MSVC fails past MAX_PATH
   cargo build --release -p omnidroid -p omni-mcp
   cargo test --release -p omni-linux --test r_roblox --no-run
   ```
   and give omni-mcp the same variable in `omniMcp.env` so a rebuild inside `aosp` works too.
2. **Read the session's own log**, never trust the tool's `ok`: every line goes to
   `<temp>/omni-linux-r-<pid>.log` (the newest one; `%TEMP%` on Windows, `$TMPDIR`/`/tmp`
   elsewhere), and a frame every 20 s to `<temp>/omni-linux-r-<pid>-shots/NNNN.png`.

### Proof, in order — quote the line you saw

| line in the log | means |
|---|---|
| `[r] cookie planted: …` then `[r] relaunched: 0` | the cookie went into the app's own cookie store |
| `DID_LOG_IN` | signed in |
| `Joining game` | the place's deep link was taken (the gate fails a `--place` run without it) |
| `onGameLoaded: placeId:…` | in the world; in-world figures start ~2 min after it |
| `Upgrade required` | the APK is too old for Roblox's servers |
| `GUEST THREAD DIED` | always a bug — report it with the lines around it |

`start_instance` returning an `instance_id`, a PNG existing, or `running: true` is **not** proof
the game is up. Say which log line you read, and when.

## The CLI

```bash
cd "Omni Apps/omnidroid"
target/release/omnidroid which [--apk X]            # which APK a run would use, and why
target/release/omnidroid login [<user> [<pass>]]    # sign in in Chromium once; keeps the cookie by name
target/release/omnidroid aosp --apk X --cookie <name|file> --place 8737899170 --minutes 30 [--size 1600x900] [--gpu vulkan|gl|auto] [--with-systemui]
target/release/omnidroid play --cookie <name> --place 8737899170 [--minutes N] [--fresh] [--phone] [--headless|--no-window] [--control cmds.txt]
```

Full flags, environment switches and the `--control` commands: `reference/omni-cli.md`.

- **APK choice**: `--apk`, else `OMNI_APK`, else the APK in the repo root with the highest
  versionCode. The stock `Roblox-2.738.1397.apk` in the repo root is no longer accepted by
  Roblox's servers; real runs use a newer APK passed with `--apk` (since 2026-09-29 the owner's
  `~/Desktop/Roblox-2.740.931.apk`, a Delta build that is never kicked).
- **Cookies**: `login` keeps them as `<app-data>/../cookies/<name>.txt`; `--cookie` takes that
  name, a file, or (`play` only) the value. Storage is per account.
- **`play` runs until the window closes** (or `--minutes`). End every run cleanly — a killed run
  is judged a crash at the next launch of that storage; after one, pass `--fresh`.
- **Headless `play`**: `--headless` runs and presents every frame without drawing; `--no-window`
  has no window at all. With `--control FILE`, append lines to FILE (or type on stdin):
  `headless on|off`, `screenshot <path>` (a real frame, rendered and saved), `status`.

## Things that will bite you

- **Credentials**: never print, log, or copy a cookie value or password; pass cookie *files* or
  saved names. A dead cookie: ask the owner. Never work around Roblox security (captchas, the
  country check).
- **Network**: Roblox is ISP-blocked here; each host needs a bypass (WARP / VPN). The accounts are
  Turkish, and a cookie used through another country's exit gets killed. Check `loc=TR` at
  `https://www.cloudflare.com/cdn-cgi/trace` first. GoodbyeDPI breaks UDP/QUIC and teleports. A
  `TlsVerificationFail` means no bypass is on.
- **Never build on Windows while a game is being played** — a build exhausted the commit limit
  once and killed guest threads. One live run per host at a time; builds may run in parallel.
- A full `C:` shows up as `ENOMEM` in every spawn: prune `target/*/incremental`.
- From Git Bash, `export MSYS_NO_PATHCONV=1` before anything that takes guest paths.
- Graphics buffers of finished sessions (`omni-shm-*` in the temp dir) are cleaned by the next
  `aosp` run, not by a killed one.
- Measure in Pet Simulator 99, place `8737899170` (joined directly, no teleport).

## Related

- `omnidroid-frida` skill — the lab debugger over the same MCP server: load a `.so`, call its
  functions with crafted inputs, intercept, patch, dump.
- `reference/omni-cli.md` — every flag, switch and log marker.
- The omnidroid repo: `docs/HANDOFF.md` (current state, "Running"), `docs/STATUS.md`,
  `crates/omni-mcp/README.md`.
- `omnidroid-qemu` / `omnidroid-input` skills — the retired QEMU manager (`Omni Apps/omnidroid-old`).
