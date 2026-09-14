# omnidroid CLI reference (agent-facing)

The surface an agent drives. Verified live on macOS arm64 (HVF) against omnidroid
branch `feat/native-window-fast-boot`, 2026-09-12. Run every command from the
omnidroid checkout, `/Users/berat/Desktop/Omni Apps/omnidroid`, as
`omnidroid <cmd>` (the installed launcher) or `python3 -m omnidroid <cmd>`.
Add `--json` to any command you intend to parse.

## Lifecycle

| Command | What it does | JSON you get |
|---|---|---|
| `start <user> [--place ID] [--offset NAME \| --no-offset] [--apk FILE [--apk-once]] [--debug] [--no-window] [--mode M] [--no-token] [--no-warm] [--json]` | Boot an ephemeral instance for a saved account, deliver its Roblox session, land in the place. | `{name, place_id, offset, arch, debug, adb_port, vnc_port, session, booted, ok, reason?}` |
| `stop <user> [--timeout S]` | Power off (in-guest shutdown → QMP quit → kill). Never call it just because a viewer closed. | `{ok}` |
| `list [--stats]` | Running instances: ports, live offset, mode. | rows |
| `debug-info <user> --json` | **Start here when anything is unclear.** Capabilities + fixes (below). | see below |
| `remove <user>` | DESTRUCTIVE: deletes the account entry and runtime. Not a cleanup command. | |

`start` returns `booted:true, ok:false, reason:"no_session"` on a `--no-token`
boot: `ok` means "session delivered", not "guest is up". `--no-token` refuses
nothing; a boot with a saved cookie that Roblox rejects fails early with
`cookie_invalid` (skip the check with `--no-cookie-check`). The result also
carries `app` (below): `app.state` is the only field that says whether the game
process is alive and in front; `start` prints a `WARNING: the game CRASHED` line
when it already died by the time `start` returns.

**Headless agent runs pass `--no-window`.** By default `start` opens a native
QEMU window on the host; a window is a nuisance for an unattended loop and can
fail on a machine with no display session.

## Windows and viewers

| Command | Notes |
|---|---|
| `start … --no-window` | No window at all (headless). Watch via `view`, `screenshot` or `capture`. |
| `start … --window` | Force a native window even in a headless mode (farming). |
| `start … --vnc-viewer` | ALSO open the built-in Python VNC viewer. Only useful when no native window could be opened. |
| `view <user>` | Show the window of a running instance. `--start` boots it first (same pipeline as `start`; `--mode`, `--debug`, `--offset`, `--timeout` apply). |
| `view <user> --hide` | Hide the window (and close an explicit VNC viewer) **without stopping the instance**. |
| `view <user> --vnc-viewer [--viewer 'vncviewer {host}::{port}']` | Open the Python VNC viewer (or an external client template) instead of the native window, for a headless boot. |

## Roblox versions ("offsets") and custom APKs

An offset is a named, thin `/data` overlay carrying one baked Roblox build.
`offset list` shows them (`*` = default); `offset create NAME --apk FILE`
bakes one on purpose; `offset default NAME` switches the default; `offset
remove NAME [--keep-image]` deletes one (refuses while in use).

### `start --apk FILE` is a cached, launchable version

- **First launch of a file:** the build is baked as a content-addressed offset
  named `apk-<sha256(file)[:16]>` (~1–2 min, ~130–450 MB overlay), then booted.
  Log line: `apk cache: baking <file> as offset 'apk-…' (~2 min, once per build)`.
  This is not a hang; the engine's own timeout governs.
- **Every later launch of the same file** (same bytes, any path or name) boots
  that cached offset with **no install** and no `apk_install` stage. Log line:
  `apk cache: hit — booting cached offset 'apk-…' (no install)`.
- `offset list` tags cached entries `[apk-cache]` with `notes: auto-cached by
  start --apk`; `offset show apk-…` prints `kind: "apk-cache"`, `apk_path`,
  `last_used`.
- A cached build **never becomes the default offset**. The cache keeps the last
  `apk_cache_max` (default 3) entries, least-recently-used evicted after a
  successful new bake; entries in use by a live instance are never evicted.
- **Baking refuses while any instance is running**: with something live the
  build is installed into the throwaway instance instead (`apk cache: not
  caching this build while instances run (...)`). Stop instances first if you
  want the cache to fill.
- `--apk-once` keeps the old throwaway-install path: install for this launch
  only, never cache. Use it for a build you will not launch again.
- `--apk` works on any base and needs no `--debug`; a signature mismatch with
  the base's baked build aborts loudly.

To prove "first bakes, second hits": `offset list` before (no entry), first
`start --apk` (bake line + new `[apk-cache]` row), stop, second `start --apk`
(hit line, no `apk_install` stage, same `offset` in the start JSON).

## Debugging surface

`debug-info <user> --json` returns:

```json
{"ok": true, "name": "…", "base": "arm", "arch": "arm", "mode": "playable",
 "debug_boot": false, "offset": "omniexec-2.735.1138-lock2", "offset_default": "…",
 "offsets_available": ["…"], "adb_serial": "127.0.0.1:PORT", "vnc": "127.0.0.1:PORT",
 "qmp_port": N, "game_package": "com.roblox.client",
 "app": {"package": "com.roblox.client", "pid": 13210, "running": true, "foreground": true,
         "foreground_activity": "com.roblox.client/.ActivityNativeMain",
         "last_crash": {"when": "09-13 12:43:28.719", "pid": 13210, "line": "… FATAL EXCEPTION: main", "detail": "java.lang.NoClassDefFoundError: …"},
         "state": "running", "hint": "the game process is alive and in the foreground"},
 "foreground": {"package": "…", "activity": "…", "pid": N},
 "root":   {"available": true, "su": "/debug_ramdisk/su", "fix": null},
 "devkit": {"attached": false, "mount": "…", "tools": "/data/local/tmp/omni-devkit",
            "fix": "restart with: omnidroid start <user> --debug"},
 "frida":  {"running": false, "guest_port": 27142,
            "start": "omnidroid frida <user>",
            "restart": "omnidroid frida <user> --restart"},
 "can": {"screenshot": true, "logcat": true, "install_apk": true,
         "run_su": true, "frida": false, "hide_root": false}}
```

- `devkit.attached` — whether this boot carries the devkit disk (frida-server +
  `omni-*` tools). Only a `--debug` boot has it.
- `frida.restart` — the exact command that fixes "not a debug boot" (`null`
  when the devkit is already attached). `frida.start` starts/forwards the server.
- `can.frida` / `can.hide_root` are `true` only with root **and** the devkit.
- `foreground` is the text signal for "did my tap land / which app is up".

Other text signals: `logcat <user> [--tag TAG] [--clear]`,
`adb <user> -- shell dumpsys activity activities`, `adb <user> -- shell
dumpsys window | grep mCurrentFocus`, `su <user> -- '<script>'` (its own flags
go BEFORE the name), `screenshot <user> --out X.png`, `capture <user>
--duration S`.

## frida

```bash
omnidroid frida <user>             # start the hidden frida-server + forward it; prints the -H target
omnidroid frida <user> --status    # exit 1 if not running
omnidroid frida <user> --stop      # stop it and drop the host forwards
omnidroid frida <user> --restart   # THE fix for "not a debug boot" (see below)
omnidroid frida <user> --json      # {ok, running, guest_port, host_port, attach: "frida -H 127.0.0.1:PORT", detail}
```

**`--restart` works on any running instance, with no pre-planning.** It stops
the plain instance and relaunches it as a `--debug` boot with the **same
account, offset, mode and session** (a stale cookie does not block it), then
starts frida-server and forwards it. Use it instead of dead-ending on
`no_devkit`. The relaunch is a real boot (~30 s plus app start); the adb/VNC
ports may change, so re-read `debug-info` afterwards.

Failures are named separately because they need different fixes: `no_root`
(root the base: `omnidroid root-base`) vs `no_devkit` (`frida --restart`, or
`omnidroid build-devkit` if the disk was never built).

Attaching from the host (frida 17.15.4 is importable from
`/Library/Frameworks/Python.framework/Versions/3.13/bin/python3`; there is no
`frida` CLI on PATH):

```python
import frida
dev = frida.get_device_manager().add_remote_device("127.0.0.1:HOST_PORT")
sess = dev.attach("com.roblox.client")          # or a pid from debug-info.foreground.pid
script = sess.create_script("""
// frida 17 API: the static Module.getExportByName('lib', 'sym') is GONE (TypeError: not a function).
// Resolve through the module object, or Module.getGlobalExportByName('open') for any module.
const openPtr = Process.getModuleByName('libc.so').getExportByName('open');
Interceptor.attach(openPtr, {
  onEnter(args) { const p = args[0].readUtf8String(); if (p && p.indexOf('/proc') === 0) send('open ' + p); }
});
""")
script.on("message", lambda m, d: print(m))
script.load()
```

A hook has fired when `send(...)` messages arrive on the host — that is the
proof, not the absence of an error. A `{'type': 'error', 'description':
'TypeError: not a function'}` message right after `script.load()` is a frida
17 API mismatch in the JS (old `Module.getExportByName(lib, sym)` /
`Module.findExportByName`), not anti-tamper; use the form above. Quiet Roblox
processes rarely `open('/proc…')` on their own: hook `open`/`openat` without
the `/proc` filter, or `read`, to see traffic within seconds. Hide root from an app with the devkit tool:

```bash
omnidroid su <user> -- /data/local/tmp/omni-devkit/omni-hide com.roblox.client
```

## Warm-restore boot cache

```bash
omnidroid warm list [--json]                       # entries + host_qemu + free_gib + why a restore missed
omnidroid warm bake <user> [--mode M] [--offset O]  # boot, freeze, keep as the warm image
omnidroid warm prune                               # drop stale entries
omnidroid warm clear                               # drop everything
omnidroid start … --no-warm                        # cold-boot this launch (OMNI_NO_WARM=1 for every launch)
```

A warm restore needs free disk for the memory image (on a 16 GB host ~15.6 GiB
free); `warm list` says why it misses (`free_gib`, stale reason). A plain cold
boot on this Mac is ~29 s, so a missing warm cache is not a blocker.

## Accounts and sessions

`login` (visible browser or `--token-file`), `accounts [--verify]`, `session
<user> [--place ID] [--clear]`. `--place` is the numeric placeId only. A
`.ROBLOSECURITY` cookie is full account access: never print one.
