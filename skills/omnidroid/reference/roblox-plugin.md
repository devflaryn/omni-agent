# The roblox plugin on a pool launch — sign in as an account, join a place

Source: the omnidroid repo's `plugins/roblox` (`omnidroid-plugin.json`, `src/main.rs`), the pool's
side in `crates/omnidroid/src/app/plugged.rs` and `crates/omni-pool/src/extras.rs`. The plugin is
installed into the pool (`plugins` at the app's prompt lists it; `omnidroid plugins add --link
plugins/roblox` installs it). Its `session-start` hook is built by `cargo run --release` on first use:
the first launch with options is slow once.

## Options (in `start_instance` `options`, one string, quotes allowed)

| option | value | on a pool launch |
|---|---|---|
| `--cookie` | a file holding the account's `.ROBLOSECURITY` cookie (the bare value, `.ROBLOSECURITY=<v>`, or a Netscape `cookies.txt`), or a name `omnidroid login` saved | the file (or `<app-data>/../cookies/<name>.txt`: `%LOCALAPPDATA%\Omnidroid\cookies\<name>.txt` on Windows, `~/Library/Application Support/Omnidroid/cookies` on macOS) becomes a WebView cookie store, planted in the instance's own Android user before its start. **Not the cookie's value** (refused). Absolute path; `~` is expanded |
| `--place` | integer ≥ 1 | the link `-a android.intent.action.VIEW -d "roblox://experiences/start?placeId=<id>" -n com.roblox.client/com.roblox.client.ActivityProtocolLaunch`, opened on the instance's display |
| `--join-delay` | — | `play` only: a pool launch refuses it (`unknown option`) |

Only for `com.roblox.client`; another APK with `--cookie`/`--place` is refused. The device language
the plugin sets for its own sessions (`OMNI_R_LOCALE` tr-TR) is not applied on a pool launch.

```text
start_instance {apk: "C:/abs/roblox.apk", options: "--cookie C:/abs/acct1.txt --place 1818"}
start_instance {apk: "C:/abs/roblox.apk", options: "--cookie acct2 --place 1818"}     # a saved name
```

`count: N` gives N instances of the **same** account. Different accounts: one `start_instance` per
account. They can share one Android (one Android user each, that user's app data emptied before the
cookie goes in).

## What happens, and how to follow it

1. The plugin answers at once (in `pool_log` under the `launch …` line):
   `[roblox] signed in with --cookie (never printed)`, `[roblox] joining place <id> once signed in`.
2. The instance starts: `#N: signed in with the cookie (never shown)` = the cookie store was
   **planted** (not proof of a sign-in); `#N: the cookie store was not planted` = it starts signed out.
3. `#N com.roblox.client running on D<d> (user <u>, display <x>)` — `wait_instance` answers `running`.
4. The link waits for the app to be ready — the device log's `com.roblox.client/.ActivityNativeMain}`
   for this user — or signed in (`DID_LOG_IN`, logged as `#N: signed in`); at most 15 min.
5. `#N: link sent`, then every 60 s `link sent (try k)` up to 4 tries, until the app logs `Joining
   game` → `#N: the link was taken`. After 4 unanswered tries: `#N: the link was never taken`.
   Several instances of the app on one Android take turns: `#N: its link waits for the
   com.roblox.client beside it on D<d> to join`.
6. Verify by looking: `screenshot` (in the game, or Sign In / Home). The Android's log
   (`list_devices` → `log`, a host file; grep it) also says `onGameLoaded()
   SessionReporterState_GameLoaded placeId:<id>` once loaded, `Client has been disconnected` when
   the server ended the session.

`list_instances` only shows `running`; the sign-in and join progress is `pool_log`'s.

## Failures and what to do

| symptom | cause | do |
|---|---|---|
| `start_instance` error `[roblox] --cookie: no file … (aosp takes a cookie file or a name `login` saved, not the cookie's value)` | wrong path/name, or a value given | an absolute path to the file, or the saved name; never paste the value |
| `[roblox] --cookie: <file> holds no .ROBLOSECURITY cookie` | the file's content | ask the person for a proper cookie file; don't open it yourself |
| `[roblox] --cookie and --place are for a Roblox APK (com.roblox.client), not <pkg>` | another APK | the right APK, or no options |
| `--place wants a whole number, not …` / `--place wants 1 or more …` | bad id | an integer place id |
| `unknown option `--join-delay`…` | `play`-only option | drop it |
| `the cookie store: …` | the host could not run `python <repo>/tools/plant_cookie.py` | a host Python on `PATH`; report the message |
| `#N: the cookie store was not planted` | the plant shell failed in the guest | `restart_instance` (plants again); else report |
| running, but Sign In on screen; no `#N: signed in` | the cookie is expired, or Roblox rotated it while an app ran, or the host network is slow | check the network (see the skill); otherwise ask the person to refresh it (`omnidroid login <name>` opens a browser they complete; it rewrites `<name>.txt`) |
| `#N: the link was never taken`, signed in | the app sat on a dialog/Home | `screenshot`; `restart_instance` (the plugin is asked again: new cookie store, link followed again) |
| ended (`ended: native crash …`) | the app crashed | `details`; `restart_instance`, or `auto_restart` for unattended runs |

Never print, copy or read a cookie's value; pass files or saved names only.
