---
name: screen-driving
description: Operate the emulator's screen directly — look at what is displayed, find the button/field you want, tap it, type into it, swipe, press hardware keys, and verify the screen actually changed. The observe → act → verify loop that lets you USE an app on the VM instead of only watching it run.
when_to_use: Use whenever a step needs the app's own UI driven by hand — dismiss a dialog, accept a permission prompt, fill in a login form, press PLAY in a game menu, navigate Settings, scroll a list, reproduce a bug that only happens after N taps, or check that a patched button now does something. Also use it whenever you catch yourself about to say "the user needs to tap this" — you can tap it yourself.
allowed-tools: observe_screen, tap_element, tap_screen, type_text, swipe_screen, press_key, take_emulator_screenshot, analyze_image, set_emulator_ui, launch_app_on_emulator, adb_shell, ensure_emulator_running, get_logcat
---

# Screen Driving Skill

You can *use* the emulator, not just watch it. Same shape as driving a browser: look at the
screen, pick a target, act on it, look again to confirm. The one rule that makes it work is
that **every action is followed by an observation** — an input tool returning `ok` only means
adb accepted the event, never that the UI responded to it.

## The loop

```
observe_screen()                  # what's on screen + coordinates for everything tappable
tap_element(text="Log In")        # act — by LABEL when the element has one
observe_screen(settle_ms=800)     # verify: did the screen actually change?
```

Never chain two actions without observing between them. A tap that landed on nothing looks
exactly like a tap that worked, right up until you report success on the wrong screen.

## Two ways to see, and which one you get

`observe_screen` picks automatically — you don't choose, but you must recognise which you got:

| Channel | When | Accuracy |
|---|---|---|
| **View hierarchy** (`ELEMENTS` table) | Ordinary Android UI: login screens, dialogs, Settings, permission prompts, most app chrome | **Exact.** The coordinates are Android's own bounds. Use `tap_element`. |
| **Vision on a grid-annotated frame** | The hierarchy is empty — the screen draws its own frames (a game's SurfaceView, video, canvas). Roblox gameplay is ONE SurfaceView, so it is always this case. | **Estimated, and only usable if you zoom** — see the next section. Use `tap_screen`, then verify. |

When `ELEMENTS` lists something, prefer `tap_element(text=…)` over retyping its coordinates —
it re-reads the live hierarchy at tap time, so it cannot go stale or drift.

When `ELEMENTS: none`, that is not a broken screen. It is the game/canvas case, and it has its
own procedure — see below.

## Finding something on a self-drawn screen (zoom in, don't guess harder)

A vision model asked "what's on this whole screen" answers with coordinates that are roughly
**100–200 px out** — enough to miss almost any button. It gets dramatically better when you
shrink the area it has to search and name what you want. Measured against a button whose true
position was known from the view hierarchy:

| Look | Result |
|---|---|
| whole screen, "list every control" | ~230 px off — missed |
| `region="center"` + `target="the UPGRADE button"` | ~54 px off — near miss |
| refine: `region="675,415,975,615"` + same target | **inside the button** |

So the procedure is *narrow the window*, not *stare harder*:

1. `observe_screen()` — a wide look. Which third of the screen is the thing in?
2. `observe_screen(region="center", target="the green PLAY button")` — zoomed and named.
   Coordinates come back in FULL-SCREEN pixels, ready to tap as-is; no arithmetic.
3. If the tap misses, don't re-tap nearby. Refine: `region="<x-150>,<y-100>,<x+150>,<y+100>"`
   around the estimate, same `target`. Each halving of the window roughly halves the error.
4. Tap, then `observe_screen(settle_ms=…)` to confirm.

Always pass `target` when you know what you are looking for — an open "list everything" question
is both less accurate and, on a magnified crop, liable to make the model read the grid labels
back at you. `NOT FOUND` is a real answer: the thing is not in that region, so look elsewhere
rather than tapping the last number you saw.

The tool flags coordinates that fall outside the screen (or the region) with a WARNING — when
you see it, the model is not reading this screen's coordinate space and none of its numbers
should be trusted.

## Acting

- `tap_element(text=… | desc=… | element_id=…)` — press a labelled button, focus a field.
  Exact label wins; otherwise substring. If several match it refuses to guess and lists them —
  re-call with the exact label or `index=N`.
- `tap_screen(x, y)` — the pixel path, for self-drawn screens. Coordinates are checked against
  the real screen size, so an off-screen coordinate errors instead of silently doing nothing.
- `type_text("...")` — goes to the **focused** field, so tap the field first. Spaces are handled.
- `press_key("ENTER" | "BACK" | "HOME" | 66 | 4 | 3)` — submit, dismiss, navigate.
- `swipe_screen(x1, y1, x2, y2, duration_ms)` — scroll a list, drag a slider. Same start and end
  with a long duration is a **long-press**.

Use `observe_screen(settle_ms=…)` after anything that animates — a transition mid-flight
photographs as a half-drawn screen and reads as a failure that never happened.

## Reading the header line

`observe_screen`'s first line is diagnostic in its own right:

- **`foreground:`** names the activity you are actually looking at. If a tap was supposed to open
  a new screen and this is unchanged, the tap missed — do not proceed as if it worked.
- **`lock_task=LOCKED`** means the kiosk holds Lock Task Mode. Taps and typing work normally; what
  gets refused is *foregrounding a non-whitelisted app* (`am start` fails, `am task lock stop` is
  refused even to root). So a failure to switch apps under LOCKED is the kiosk, not your input.
- **`SCREEN <w>x<h>`** is the coordinate space. Screenshots are 1:1 with device pixels, so a
  coordinate read off the image needs no scaling.

## Failure patterns worth recognising

- **Tap "succeeded", nothing changed.** Either it landed off-target (re-observe and use
  `tap_element`, or zoom in per the section above), or the element was disabled — the ELEMENTS
  table marks `<disabled>`. On a self-drawn screen, assume the coordinate before assuming the app.
- **An off-screen coordinate.** `tap_screen` refuses it and names the real resolution. That means
  the coordinate came from somewhere that doesn't know this device — re-observe, don't retry.
- **`type_text` typed into nowhere.** No field had focus. Tap the field, confirm `<focused>` in the
  next `observe_screen`, then type.
- **A black screen.** On a dev instance, pressing HOME drops to the kiosk, which renders black when
  no game is running. That is not a crash. Confirm with `get_logcat` before calling anything dead.
- **The UI dump fails outright** (`ELEMENTS: none — the UI dump failed …`). uiautomator occasionally
  cannot reach an idle state on a busy screen; retry once with `settle_ms=1000`, then fall back to
  the grid + `tap_screen`.

## Where this fits

`emulator-management` gets the right thing *running* (accounts, cookies, place ids, dev base);
`emulator-testing` *observes* an unattended run (keyframes, logcat, reports). This skill is for
when the next step needs a human-shaped interaction — and you are the one who performs it.
