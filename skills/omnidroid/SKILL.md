---
name: omnidroid
description: Use when running any APK on omnidroid, the native ARM64-Android engine in "Omni Apps/omnidroid" (Rust, no VM), through the omnidroid app's MCP server — launching any APK as one or many instances (start_instance {apk, count} / wait_instance / list_instances / screenshot / input / stop_instance), managing the app's warm Androids (list_devices / warm_device / stop_device / shell / settings / pool_log), looking inside a running app (its log, files, screen), and what to tell the person when the tools are missing (open `omnidroid`, `mcp on`). Trigger on "run this APK", "launch 3 instances of", "install/launch/start this app", "start an instance", "take a screenshot of the instance", "tap/type in the app", "is the app running", or any omnidroid_* / mcp__omnidroid__* tool. For hooking, calling or dumping a .so use the omnidroid-frida skill; for the old QEMU manager (offsets, `omnidroid su`, frida-server) use omnidroid-qemu.
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
| **real Android** (default, any APK) | real Android on omnidroid's Linux ABI layer; the APK `pm install`ed and started from its launcher | MCP `start_instance {apk, count}`, or `run <apk>` in the omnidroid app |
| **fast path** (opt-in) | the APK's native code alone, no Java runtime — only apps whose Java side the engine answers itself | `omnidroid play` |

## The MCP tools (how an agent drives omnidroid)

omnidroid is **an app** now: `omnidroid` (no arguments) opens a full-screen terminal app that keeps
warm Androids and runs any APK on them, each instance in a window of its own. Agents do not run
`omnidroid` commands in a terminal; they use **the app's MCP server**, which the person turns on in
the app (`mcp on`: `http://127.0.0.1:7457/mcp`, this computer only, from then on at every start).

- **Claude Code**: `mcp on` in the app registers it (`claude mcp add --transport http --scope user
  omnidroid <url>`); tools `mcp__omnidroid__<tool>`.
- **pi (Omni Agent)**: `omni-mcp.ts` runs `omni-mcp --connect <url>` (the stdio bridge to the app;
  `node scripts/install.mjs` sets it up); tools `omnidroid_<tool>`.
- **Any other agent**: the URL (MCP over HTTP), or `omni-mcp --connect <url>` as a stdio server.

**No tools, or "the omnidroid app's MCP server is not reachable"?** The app is not open, or MCP is
off in it: ask the person to open `omnidroid` and type `mcp on`. Never start the app or devices from a
shell yourself.

| tool | does |
|---|---|
| `start_instance {apk, count?}` | launch any APK (an absolute host path) as `count` instances (1-64); answers their ids **at once** |
| `wait_instance {instance_id, timeout?}` | wait until it runs (its launcher Activity displayed) or ends; answers its state and screenshot path |
| `list_instances` | each: package, `device` (the Android), `user`, `display`, `state` (`waiting`, `installing`, `starting`, `running`, `closing`, `ended: <why>`), `screenshot` |
| `screenshot {instance_id}` | its display as a PNG (written every second): path, width, height |
| `input {instance_id, action, ...}` | `tap {x,y}`, `swipe {x,y,x2,y2,ms}`, `text {text}`, `key {key: KEYCODE_BACK}` on its display |
| `stop_instance {instance_id}` | close it: the app stopped, its window gone; the Android stays warm |
| `shell {command, device?, uid?}` | adb-shell style on an Android (`uid: 0` root); default the first ready one |
| `list_devices` / `warm_device` / `stop_device {device}` | the warm Androids: state, idle time, builds installed, instances |
| `settings {key?, value?}` / `pool_log {lines?}` | the app's settings (idle_close_minutes, keep_warm, ...) / its log |

**Where an instance goes**: an APK is known by its bytes, not its package and version. The same APK
file again runs on the Android that has it (each instance is an Android user of its own on a display
of its own); another package goes into a warm Android beside the others; another build of a package
that is **running** gets an Android of its own, while a build installed but not running is replaced.
A first launch on a fresh Android takes ~1-2 min (install, a user, the start); the next ones less.
Androids idle (no app) for `idle_close_minutes` are closed, `keep_warm` stay up.

**Proof an app is up**: `wait_instance` answering `running` means Android displayed its launcher
Activity. Then `screenshot` it and look. `ended: the app stopped` means its Activity left its display
(a crash, or the app closed itself): read the Android's log (`list_devices` → `log`) for
`FATAL EXCEPTION` / `Fatal signal` / `has died` and quote the line.

**Looking inside a running app** (no adb, no frida-server -- the guest kernel has no `ptrace`):

| want | how |
|---|---|
| its log | `list_devices` → `log`: every Android log line of that Android (`I/Tag(pid): ...`); grep it with your file tools |
| what is on screen | `screenshot {instance_id}`; `shell "dumpsys activity activities | grep -E 'Display #|ActivityRecord'"` |
| its files | `shell {command: "ls -R /data/user/<user>/com.example.app", uid: 0}` (each instance is its own user) |
| its native code, hooked | the installed APK is on the host under the Android's dir (`data/app/*/<package>-*/base.apk`); unzip `lib/arm64-v8a/*.so` and use the **omnidroid-frida** lab |

## The app (for the person, not the agent)

```text
omnidroid                       open the app (it warms an Android)
omnidroid <app.apk> [xN]        open it and launch N instances
omnidroid serve [--port <n>]    the app without its screen: the pool and MCP, until stdin closes
```

At its prompt: `run <apk> [xN]`, `close <#id>|all`, `warm`, `kill <D#>|all`, `shell <D#> <cmd>`,
`plugins ...`, `settings`, `set <key> <value>`, `mcp on|off|register|status`, `help`, `quit`.
Settings live in `<app-data>/../app.conf`. The one-shot commands scripts used (`omnidroid aosp`,
`play`, `which`) still exist (`omnidroid help commands`) but are not how an agent runs apps; full
flags: `reference/omni-cli.md`.

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
