---
name: omnidroid
description: Use when running any APK on omnidroid (the native ARM64-Android engine in "Omni Apps/omnidroid", no VM) through the omnidroid app's MCP server — start_instance {apk, count, options, auto_restart} / wait_instance / list_instances / screenshot / input / stop_instance; recovering a crash (restart_instance, auto_restart, an end's `details`); the warm Androids (list_devices, warm_device, stop_device, shell, settings, pool_log, Omni Agent's wait_device); WebViews (web_pages, web_dom, web_click, web_type, web_eval); and the roblox plugin (a roblox account, a place) — options "--cookie <file or saved name> --place <id>" sign each instance in and join the place, followed in pool_log. Trigger on "run/launch this APK", "N instances", "sign in with this cookie", "join place", "restart the instance", "screenshot/tap the app", or any omnidroid_* / mcp__omnidroid__* instance or device tool. Hooking a .so — omnidroid-frida. Old QEMU manager — omnidroid-qemu.
---

# Driving omnidroid

`omnidroid` (the checkout at `Desktop/Omni Apps/omnidroid`) runs Android apps as native desktop
processes: real Android userspace (system_server, SurfaceFlinger, ART…) on omnidroid's own Linux
ABI layer, the APK's arm64 code run by dynarmic, graphics/audio/input/network on the host. **There
is no VM, no QEMU, no adb, no frida-server.**
`omnidroid start/offset/session/debug-info/su/frida` belong to the old QEMU manager
(`omnidroid-qemu` skill) and do not exist here.

**Any APK runs.** The launcher knows no app: package and launcher Activity come from the APK's own
manifest; it is `pm install`ed and started from its launcher, as a device does.

## Reaching the tools

omnidroid is **an app**: `omnidroid` (no arguments) opens a terminal app that keeps warm Androids
and runs APKs on them, each instance in a window of its own. Agents use **the app's MCP server**
(the person turns it on with `mcp on` at the app's prompt: `http://127.0.0.1:7457/mcp`, this
computer only, kept on at every start). **One pool per computer**: every `omnidroid` window and
`omnidroid serve` are views of one pool — same Androids, instances, log, MCP server. What the
person launches you see in `list_instances`, and the reverse.

- **Claude Code**: tools `mcp__omnidroid__<tool>` (registered by `mcp on`: `claude mcp add
  --transport http --scope user omnidroid <url>`).
- **Omni Agent (OpenCode)**: tools `omnidroid_<tool>`, through `omni-mcp --connect <url>` (a stdio
  bridge); plus Omni's own `omnidroid_wait_device` — see "Omni Agent" below.
- **Any other agent**: the URL (MCP over HTTP), or `omni-mcp --connect <url>` as a stdio server.

**No tools, or "the omnidroid app's MCP server is not reachable"?** No pool is open, or MCP is off:
ask the person to open `omnidroid` and type `mcp on` (or run `omnidroid serve --port 7457` for the
pool without a screen). Don't start the app or devices from a shell unless asked; if asked, start
`omnidroid serve --port 7457` detached with stdin held open (it ends when stdin closes), then
reconnect (`/mcp` in Claude Code).

## The tools

Instance ids and device ids are **numbers** (`#3` → `3`, `D5` → `5`; the server also strips a
leading `#`/`D` from a string). Errors come back as JSON-RPC errors carrying the message quoted.
Pool calls run concurrently (a `wait_instance` does not hold others up).

| tool | args | blocks? | answers |
|---|---|---|---|
| `start_instance {apk, count?, options?}` | `apk` (absolute host path; required), `count` (1-64, default 1; out of range is clamped), `options` (string: installed plugins' options as on the command line, quotes allowed), `auto_restart` (bool, each new instance's own), `package` (bundle of several packages only — see note) | **no**: answers at once | `{instances: [ids], note}`. Errors at once for: unreadable/missing file, no launcher Activity, `max_devices` reached, an option no plugin adds, a plugin's refusal |
| `wait_instance` | `instance_id` (required), `timeout` s (default 300, max 3600) | **yes**, until `running` or `ended: …` (waits through `restarting`) | `{instance_id, state, waited_s, screenshot, auto_restart, restarts, restart_in?, details?/last_end?}`. On timeout it answers the current state — not an error |
| `list_instances` | — | no | `{instances: [{instance_id, package, apk, sha256, device, user, display, state, up_s, screenshot, auto_restart, restarts, restart_in?, details?, last_end?}]}` — every instance the pool has had, ended ones included |
| `screenshot` | `instance_id` (required) | ≤ 3 s (a fresh frame is written on request) | `{path, width, height}` — read the PNG at `path`. Error `#N has no display yet (<state>)` before it starts / after its window is gone |
| `input {instance_id, action, ...}` | `instance_id`, `action` (`tap`\|`swipe`\|`text`\|`key`), `x`,`y` (tap, swipe), `x2`,`y2`,`ms` (swipe; ms default 300), `text`, `key` (`KEYCODE_BACK` or a number) | until the shell `input` returns | `{exit, output}`. Display pixels (`instance_size`, default 1280x720). Error `#N is <state> (not running)` |
| `stop_instance` | `instance_id` | no (closes in the background) | `{instance_id, closing: true}`: app stopped, window gone, no card, no auto restart; its Android stays warm. One ended whose card is still shown: closes the card. One ended with its window gone: error `#N ended already` |
| `restart_instance` | `instance_id`, `delay` s (default 5; 0 = now) | no | the instance as `list_instances` shows it (state `restarting`). Same id, same window; works on running, ended (even closed) or restarting ones. Errors: `#N is still starting`, `#N is closing`, `no instance #N` |
| `auto_restart` | `on` (bool, required), `instance_id` (optional) | no | with id: that instance (its own setting). Without: the **pool's** setting (saved; for every instance without its own) → `{auto_restart, instances: [{instance_id, auto_restart}]}` |
| `shell` | `command` (required), `device` (default: first `ready`), `uid` (0 root, 1000 system, default 2000 shell), `timeout` s (default 120; accepted though not in the schema) | yes | `{device, exit, output}`. Error `no Android is ready (warm_device boots one)` |
| `list_devices` = `device_status` | — | no | `{devices: [{device, state (booting\|ready\|closing), up_s, idle_s, instances, installed: ["pkg (sha256[:12])"], dir, log}]}` — `log` is the Android's whole logcat as a host file |
| `warm_device` | — | **no** | `{device, note: "booting; list_devices shows when it is ready"}` |
| `stop_device` | `device` (required) | no | `{device, stopping: true}`; its instances end. Stopping the last one leaves none warm until a launch or `warm_device` |
| `settings` | `key`, `value` (both strings, both or neither) | no | every setting as strings: `idle_close_minutes`, `keep_warm`, `warm_on_start`, `stop_on_exit`, `max_devices`, `instance_size`, `gpu`, `device_ram_mb`, `auto_restart`, `mcp_enabled`, `mcp_port` (the `mcp_*` ones cannot be changed here) |
| `pool_log` | `lines` (default 60) | no | `{lines: ["HH:MM:SS text", …]}` newest last: launches, installs, boots, starts, a plugin's progress, ends |
| `web_*` | see "WebViews" | — | — |

Bundles: the current source reads `.apkm`/`.xapk`/`.apks`/a zip of APKs (base + splits + OBBs
installed together) and adds `apk_info {apk}` (what a file holds, no launch) and
`start_instance.package`. **If `apk_info` is not in your tool list, the running app predates
that**: pass a plain `.apk` (pick `base.apk` out of the bundle) and tell the person the app needs
rebuilding/reopening for bundles.

**States** (`list_instances`, `wait_instance`): `waiting` (its Android boots) → `installing` →
`starting` → `running` (its launcher Activity displayed) → `closing` → `ended: <why>`;
`restarting` while a restart counts down. `ended: closed` = closed on purpose (stop_instance, the
window closed, force-stopped, the person quit it): no card. Any other `ended: …` (`native crash:
SIGSEGV …`, `Java exception: …`, `its device D5 is gone: …`, `its display: …`) leaves a card in
its window, and `details` holds what the Android's log says (exception and frames, signal and
library, ANR). Once restarted, that becomes `last_end`.

**Where an instance goes**: an APK is known by its bytes (SHA-256), not package/version. The same
APK again runs on the Android that has it (each extra instance is an Android user of its own, on a
display of its own); another package goes into a warm Android beside the others; another build of
a package that is **running** gets an Android of its own (booted: minutes); a build installed but
not running is replaced. A first start on an Android takes seconds (install, a user, `am start`);
a new Android ~1-2 min. Androids idle `idle_close_minutes` are closed; `keep_warm` stay up.

## The normal sequence

1. `start_instance {apk: "C:/abs/app.apk"}` → `{instances: [7]}`.
2. `wait_instance {instance_id: 7}` → `running` (or `ended: …` with `details`).
3. `screenshot {instance_id: 7}` and look at the PNG; `input` to drive it.
4. Done: `stop_instance {instance_id: 7}`. Don't stop instances the person started.

Need a device first (nothing to launch yet)? `warm_device`, then wait for `ready` (Omni Agent:
`omnidroid_wait_device`; Claude Code: `list_devices` every ~15-30 s — booting takes minutes, so
don't hammer it). `start_instance` does not need this: it boots one itself.

## Crashes and recovery

- `ended: native crash …` / `Java exception …`: quote `details` (that *is* the log's verdict); read
  more in the Android's log (`list_devices` → `log`, grep `FATAL EXCEPTION|Fatal signal|has died`).
- `restart_instance {instance_id, delay: 0}` starts it again on the same window, same id;
  `wait_instance` then waits for `running`. A plugin's work is redone (cookie re-planted, link
  followed again).
- `auto_restart {on: true, instance_id}` (or `start_instance {…, auto_restart: true}`) restarts it
  5 s after a crash. After **3 ends in a row within a minute of starting** it stops ("Not restarted
  automatically: …" in `details`) — a crash on start is not cured by restarting; investigate.
  Without `instance_id` it changes the pool's saved setting for everyone: ask the person first.
- An instance stuck `waiting`/`installing`: its Android is booting or busy — check `pool_log`.

## A plugin's options on a launch (the roblox plugin: an account's sign-in, a place)

The launcher knows no app; what one app needs beyond install-and-start (an account's sign-in, a
link to open) is an installed plugin's, passed as `start_instance`'s `options` string, exactly as on
the command line (`plugins` at the app's prompt lists the installed ones). The repo's `roblox`
plugin adds `--cookie <file or saved name>` and `--place <id>`:

```text
start_instance {apk: "C:/abs/game.apk", count: 1, options: "--cookie C:/abs/acct1.txt --place <placeId>"}
wait_instance  {instance_id: <id>}           # running = the app is up, not yet signed in or joined
pool_log       {lines: 40}                   # the sign-in and join progress (below)
screenshot     {instance_id: <id>}           # the proof: in the place, or still on the sign-in screen
```

- `--cookie`: a cookie **file** (absolute path) or a name `omnidroid login` saved
  (`<app-data>/../cookies/<name>.txt`) — never the cookie's value (a pool launch refuses it), and
  never read or print the file. The cookie is planted in the instance's own Android user, so
  several accounts run side by side on one Android. `count: N` = N instances of the **same**
  account; one `start_instance` per account for different ones.
- `--place <id>` (integer ≥ 1): the place link, opened on the instance's display once the app is
  ready or signed in, re-sent every 60 s (4 tries) until the app logs that it is joining.
- Option errors come back from `start_instance` at once, prefixed `[roblox]` (no such file, not
  for this APK, `--join-delay` is `play`-only) or `the cookie store: …`.
- **Follow it in `pool_log`** (`list_instances` only says `running`): `#N: signed in with the
  cookie (never shown)` (store **planted**, not yet a sign-in) → `#N: signed in` → `#N: link sent`
  → `#N: the link was taken` (joining). Bad ends: `#N: the cookie store was not planted`, `#N: the
  link was never taken`. Then `screenshot` and look.
- On the sign-in screen with no `#N: signed in`: expired/rotated cookie or the host's network —
  ask the person for a fresh cookie file. Link never taken: `screenshot`, then `restart_instance`
  (a restart asks the plugin again: cookie re-planted, link followed again).

Every log marker, failure message and what to do: `reference/roblox-plugin.md`. The same options
work at the app's prompt (`run <apk> [xN] --cookie … --place …`) and as `omnidroid <apk> [xN]
--cookie … --place …`.

## WebViews (sign-in pages, captchas, store pages)

The instance must be `running`. `page` (an id or its prefix) defaults to the visible page.

| tool | args | answers |
|---|---|---|
| `web_pages` | `instance_id` | `{pages: [{page, url, title, visible, screen: [x,y,w,h]}]}` |
| `web_dom` | `instance_id`, `page?`, `selector?` (CSS, every frame), `html?` (with selector: outerHTML ≤ 4000 chars), `limit?` (200, max 2000) | `{page, url, viewport, device_px_per_css_px, count, elements: [{ref, tag, attrs…, text, frame, box (CSS px), tap (display point)}]}` |
| `web_eval` | `instance_id`, `expression`, `page?`, `frame?` (part of a frame's url) | `{value}` (promises awaited, runs as a user gesture), or `{frames: [{frame, value\|error}]}`; a throw → `the script threw: …` |
| `web_click` | `instance_id`, one of `ref` / `selector` (+`index`) / `text` (shown text, case-insensitive substring), `via` (`touch` default, `cdp`), `page?` | `{clicked, ref, box, tap, via}` |
| `web_tap` | `instance_id`, `x`, `y`, `space` (`css` default, `screen`), `via?`, `page?` | `{css, tap, via}` |
| `web_type` | `instance_id`, `text` (what is typed), `ref` or `selector` (+`index`) to click first, `submit?` (Enter after), `page?` | `{typed, into}` — `text` is always the text typed; name the field by `ref`/`selector`, not by text |
| `web_screenshot` | `instance_id`, `page?` | `{path, width, height}` |

Errors: `the instance shows no web page (no WebView, or its app has not made one yet)`, `no page X
(web_pages lists them)`, `#N is not running`.

## Omni Agent (OpenCode)

Omni Agent runs on OpenCode, which serves omnidroid's `omni-mcp` as the MCP server `omnidroid`: the
tools are `omnidroid_<tool>` and answer **the omnidroid MCP server's own results**, unchanged —
nothing is trimmed, retried or rewritten. Omni adds one tool:

- **`omnidroid_wait_device {device?, timeout?}`** (default 300 s) — Omni's own tool, not the
  server's: it polls `list_devices` every 3 s and returns once the named `device` is `ready`, or,
  without `device`, once at least one Android exists and none is `booting`/`closing` (`ready after
  Ns: …` or `still not ready after Ns …`). Use it after `warm_device` instead of calling
  `omnidroid_list_devices` in a loop. With no Android at all it waits the full timeout —
  `warm_device` first.

What that means in practice:

- **`stop_instance` / `stop_app` / `stop_device` on something already gone** return the server's
  error (`#N ended already`, `no instance #N`): it was already stopped — take it as done, don't
  retry it.
- **`list_instances` lists every instance**, ended ones included, in full. A long list is mostly
  old ended instances: look at the live ones (and the newest ended ones) unless you need an older id.
- Polling the same `list_devices` / `list_instances` again and again changes nothing: wait
  (`wait_instance`, `omnidroid_wait_device`) or act instead.
- Number args are the schema's types: pass numbers as numbers (addresses are strings, `"0x…"`).

## Looking inside a running app (no adb, no ptrace)

| want | how |
|---|---|
| its log | `list_devices` → `log` (host file: every logcat line of that Android, `I/Tag(pid): …`); grep it with your file tools |
| what is on screen | `screenshot`; `shell {command: "dumpsys activity activities \| grep -E 'Display #\|ActivityRecord'"}` |
| its files | `shell {command: "ls -R /data/user/<user>/com.example.app", uid: 0}` (`user` from `list_instances`) |
| its native code, hooked | the installed APK is a host file under the Android's `dir` (`data/app/*/<package>-*/base.apk`); unzip `lib/arm64-v8a/*.so` into the **omnidroid-frida** lab |

## The app (for the person, not the agent)

```text
omnidroid                         open the app (it warms an Android)
omnidroid <app.apk> [xN] [opts]   open it and launch N instances
omnidroid serve [--port <n>]      the pool and MCP without a screen, until stdin closes
omnidroid restart <id>…|all       restart instances of the running pool (bare ids: 3, not #3)
omnidroid autorestart on|off <id>…|all
```

At its prompt: `run <apk> [xN] [opts]`, `close <#id>…|all`, `restart <#id>…|all`,
`autorestart on|off [#id…|all]`, `warm`, `kill <D#>…|all`, `shell <D#> <cmd>`, `plugins …`,
`settings`, `set <key> <value>`, `mcp on|off|register|status`, `help`, `quit`. Settings live in
`<app-data>/../app.conf`. Full flags: `reference/omni-cli.md`.

## Things that will bite you

- **Credentials**: never print, log or copy a cookie value or password; pass cookie *files* or
  saved names.
- **Never build on Windows while an app is being run** — a build exhausted the commit limit once
  and killed guest threads. Builds may run in parallel with each other.
- A full `C:` shows up as `ENOMEM` in every spawn: prune `target/*/incremental`.
- From Git Bash, `export MSYS_NO_PATHCONV=1` before anything that takes guest paths.
- **An app's "Unable to contact server / check your internet connection"**, or Sign In although
  the cookie is valid, is usually the host's network: apps give up after ~10-15 s. Check a TCP
  connect from the host (well under a second when healthy); the app's own files under
  `/data/user/<user>/<package>/files` show connection timeouts.
- An APK whose native libraries are only for another ABI (armeabi-v7a, x86) has no arm64 code.
- `list_instances` keeps every ended instance for the pool's life; filter by `state`.

## Related

- `omnidroid-frida` skill — the lab debugger and RE workbench over the same MCP server.
- `reference/roblox-plugin.md` — the roblox plugin on a pool launch: options, markers, failures.
- `reference/omni-cli.md` — the CLI, settings, the standalone `omni-mcp`, log markers, switches.
- omnidroid repo: `docs/HANDOFF.md` ("Running"), `crates/omni-mcp/README.md`, `plugins/README.md`,
  `crates/omnidroid/src/app/live.rs` + `web.rs` (the pool's tools).
- `omnidroid-qemu` / `omnidroid-input` — the retired QEMU manager (`Omni Apps/omnidroid-old`).
