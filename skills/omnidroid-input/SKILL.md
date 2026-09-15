---
name: omnidroid-input
description: Use when you need to drive an omnidroid Android VM's screen yourself — tapping buttons, typing into fields, pressing keys, swiping, or reading what is currently on screen. Trigger on "click/tap in the VM", "type into the emulator", "drive the instance", "what's on screen", "press back/enter", or any step that would otherwise be handed to the user to do by hand in the GUI.
---

# Driving an omnidroid VM

You can operate a running omnidroid instance directly. Do not ask the user to
click things in the VM for you — do it, then verify: with a screenshot when you
can see images, with `state`/`ui`/logcat when you cannot (see "Driving without
vision" below).

Tool: `tools/omni_input.py` in the omnidroid checkout
(`/Users/berat/Desktop/Omni Apps/omnidroid`). Run it with `python3`.

```bash
cd "/Users/berat/Desktop/Omni Apps/omnidroid"
python3 tools/omni_input.py [--name INSTANCE] [--json] <command>
```

`--name` is optional when exactly one instance is running; it is **required**
when several are. `omnidroid list` shows them.

To *launch* an instance, choose a Roblox version, bake one, run root commands
or start frida, use the **`omnidroid`** skill — this one is only about driving
a screen that is already up.

**Drive in `playable` mode** (the default). A farming instance is 480x270 at
5 fps by design: coordinates are cramped, the render is the lowest possible,
and a screenshot off it is not what a player sees. If an instance is in
farming mode (`omnidroid list` shows the mode), restart it in `playable`
before trying to read or drive its screen.

## The loop

This works on **any app** — nothing here is app-specific. Always
**look → act → verify**; never fire a tap at a coordinate you have not
confirmed this turn, because the screen moves.

1. `state` — which instance, screen size, foreground app, lock-task state.
2. **`shot --grid` and Read the PNG.** This is the primary path: look at the
   screen, find the thing you want, read its pixel off the overlaid grid.
3. Act: `tap X Y`, `text`, `key`, `swipe`.
4. Verify: `shot` again and Read it.

Screenshots are **1:1 with device pixels** (a 1280x800 device gives a 1280x800
PNG), so a coordinate read off the image is the coordinate to tap — no scaling.

**Always pass `--grid` when you intend to tap.** Estimating a pixel from a bare
screenshot drifts by tens of pixels, which is enough to miss a button; the
labelled gridlines turn it into counting to the nearest line. `--grid 50` for
denser rules, `--grid` alone for every 100px. Omit it when you just want to
look at the screen unobstructed.

`ui [pattern]` is a **secondary** convenience: on Android-native screens it
lists elements with their tap centres, so `tap --text "Settings"` saves a round
trip and costs far less context than an image. It is blind inside games and
other GL apps (see below), so the screenshot path is the one that always works.

## Commands

```bash
python3 tools/omni_input.py state
python3 tools/omni_input.py shot --grid --out /tmp/s.png   # then Read it
python3 tools/omni_input.py shot --grid 50 --out /tmp/s.png

python3 tools/omni_input.py tap 640 423           # by pixel — the main path
python3 tools/omni_input.py tap 640 423 --shot --grid --settle 2

python3 tools/omni_input.py ui                    # native screens only
python3 tools/omni_input.py ui download           # filter text/desc/id/class
python3 tools/omni_input.py tap --text "Settings" # shortcut on native screens
python3 tools/omni_input.py tap --id dl_text
python3 tools/omni_input.py tap --desc "Navigate up"

python3 tools/omni_input.py text "hello world"    # into the FOCUSED field
python3 tools/omni_input.py key BACK
python3 tools/omni_input.py key MOVE_END DEL DEL  # several, in order
python3 tools/omni_input.py swipe 640 700 640 300 --ms 400
python3 tools/omni_input.py launch com.android.settings
```

Every acting command takes `--settle SECONDS` (wait for the UI to catch up)
and `--shot [--grid] [--out PATH]` (capture a PNG afterwards and print its
path, ready to Read). `--json` makes any command machine-readable.

## Driving without vision

A text-only model (no image input) still gets a full loop; it just replaces
"read the PNG" with text signals, and it must compare **before vs after** for
every action:

1. `state --json` — `top` (foreground package/activity), screen size,
   `lock_task`. Record it.
2. `ui --json` — on Android-native screens: every element with its text,
   resource id, bounds and tap centre, and which one is `focused`. Pick the
   target from this list; `tap --text "…"` / `tap --id …` need no coordinates.
3. Act (`tap`, `text`, `key`, `swipe`, `launch`) with `--settle 2`.
4. Verify: `state --json` again (did `top` change?), `ui --json` again (did
   the element you tapped disappear, a new screen appear, the field's text
   change?), and for launches/dialogs `omnidroid logcat <name> --tag
   ActivityTaskManager` (a `Displayed <pkg>/<activity>` line proves a new
   activity came up) or `omnidroid adb <name> -- shell dumpsys window | grep
   mCurrentFocus`.
5. Inside a game or any GL surface `ui` is empty. There, drive by known
   coordinates (the screen is 1280x800 in `playable`) and verify through the
   app's own logcat output (`--tag` the app's tag), `state`'s `top`, or a
   process/pid change in `omnidroid debug-info <name> --json` → `foreground`.

A typed string is verified by reading the focused element's `text` back from
`ui`; a swipe by the element list changing (a list scrolled, a page turned).
Never report "tapped X" without one of these signals.

## Where `ui` stops working

`ui` only sees Android views, so it is empty in anything that draws its own
frames — games, GL/Canvas apps, video. Roblox gameplay is a single
`SurfaceView`: the dump is a stack of unnamed FrameLayouts, no buttons, no
labels. `state`'s `top=` field tells you which kind of screen you are on.

The screenshot-and-coordinate path has no such limit and is the one to reach
for by default. `screencap` captures GL surfaces correctly — a game frame comes
back in full colour, not black.

## Things that will bite you

- **Tap the field before typing.** `text` goes to whatever has focus. Tap it
  first, confirm `<focused>` in the `ui` output, then type.
- **Lock Task Mode.** The kiosk pins itself, and the OS refuses `am task lock
  stop` even to root ("Activity manager is in lockTaskMode"), so a plain
  `am start` fails with error 101. `launch` still works for packages the
  kiosk whitelists — verified: `com.omni.kiosk` and `com.topjohnwu.magisk`
  foreground fine via root + `monkey` while `lock_task=LOCKED`, while
  `com.android.settings` does not. `launch` checks the foreground app
  afterwards and exits non-zero rather than claiming a launch that did not
  happen, so trust its exit code. If it is blocked, drive the pinned app.
- **The kiosk is not just a pinner — it also self-heals.** If a screenshot
  shows a headline like "Roblox crashed"/"Roblox was killed (signal 9)", an
  error code `OMNI-<REASON>-<attempt>`, and a ⟳ countdown instead of the game,
  that is the kiosk's own failure screen (no more black-screen-on-death), and
  it is already relaunching the game by itself (5 s, then 15, 30, 60, then 60 s
  forever). `tap` anywhere on it relaunches immediately — no need to hunt for a
  button. Verify the game is actually back with `state`/`debug-info`, not just
  by the screen changing. Full detail and the reason codes are in the
  `omnidroid` skill.
- **Ambiguous labels.** `tap --text` refuses when several elements match and
  prints the candidates; narrow the string, use `--id`, or pass `--first`. When
  a label and its button both match, the clickable one is chosen.
- **Spaces in `text`** are encoded as `%s`, which is the only way Android's
  `input text` accepts them. A literal `%s` in your string therefore arrives as
  a space.
- **Stale instances.** The tool verifies the pid in `run.json` is alive *and*
  is the QEMU named `omni-<instance>` before sending anything, so a recycled
  port cannot silently route your taps to a different VM. If it says an
  instance is not running, believe it.
- **Do not disturb a running experiment.** Check for a live `capture --auto` or
  an overnight run (`ps aux | grep capture`) before driving that instance.
- **Leave the screen as you found it** when you were only probing: dismiss
  dialogs with `key BACK` and return to the original screen.

## Root

**Every** shipped base is Magisk-rooted, not just a "dev" one. Do not hand-roll
the invocation — use the engine's command, which gets the three silent traps
right (off-`$PATH` su, MagiskSU's argv permutation, adb's argv re-parse):

```bash
python3 -m omnidroid su <name> -- 'pm list packages | grep roblox'
```

If you must do it inline anyway: `su` is at `/debug_ramdisk/su` (not
`/system/bin/su`) and must be invoked as `/debug_ramdisk/su 0 sh -c '<cmd>'` —
MagiskSU permutes argv, so a bare trailing flag is misread as an su option.

## Related

- **`omnidroid` skill** — launching accounts, Roblox versions (offsets), modes,
  `su`, frida, and `debug-info`. Reach for it whenever the problem is not
  "what is on screen right now".
- `omnidroid screenshot <name> --out X.png` — the plain screenshot path.
- `omnidroid debug-info <name>` — why a step silently did nothing.
- `omnidroid adb <name> -- <args>` — arbitrary adb, slower (full engine start).
- `omnidroid` skill's `reference/omni-cli.md` — the CLI reference (frida,
  `--apk` cache, `debug-info` fields, `view --hide`).
