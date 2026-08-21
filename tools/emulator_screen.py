"""The agent's EYES on the emulator screen, in text.

android_emulator.py gives the agent hands — tap_screen / type_text /
swipe_screen / press_key. Hands alone leave it *watching*: a screenshot comes
back as a file path, and the main model is text-only, so it had nothing to
aim at. These two tools close the loop the way a browser agent works:

    observe_screen()  ->  what is on screen, with tap coordinates
    tap_element(...) / tap_screen(x, y) / type_text(...)  ->  act
    observe_screen()  ->  confirm the screen actually changed

`observe_screen` reads the screen through whichever channel the screen
supports, automatically:

  * the UI hierarchy (uiautomator) for ordinary Android UI — exact bounds, so
    coordinates are facts rather than estimates;
  * a grid-annotated screenshot handed to the vision model for screens that
    draw their own frames (a game's SurfaceView, video, canvas), where the
    hierarchy is empty and there is nothing else to go on.
"""

import os
import re
import subprocess
import time

import devices
from tool_registry import registry
from tools.common import resolve_workspace_path
from tools._emulator_screen_read import (
    parse_screen_size, parse_top_activity, parse_lock_task_state,
    parse_ui_nodes, interesting_nodes, format_elements, labels_of,
    match_nodes, draw_grid, in_bounds, resolve_region,
)
from tools.android_emulator import _resolve_serial, _run, _DEFAULT_BACKEND
from tools.vision_tools import analyze_image
from llm import has_vision_model

_SHOT_DIR = "screenshots/observe"

# What the vision model is asked when the hierarchy is blind. It must return
# COORDINATES, not prose — the whole point is producing something tappable —
# and the grid overlay is what makes that possible. The screen's real size goes
# INTO the question: without it a vision model happily answers in some other
# device's coordinate space (portrait-phone pixels on a landscape tablet
# screen), which reads as a confident answer and taps nothing.
_VISION_QUESTION_TEMPLATE = (
    "This is an Android screen that is EXACTLY {w} pixels wide and {h} pixels tall, with a "
    "labelled coordinate grid drawn over it: magenta lines every {step} pixels, and each yellow "
    "label is the exact 'x,y' pixel of the line intersection it sits on. "
    "First say what screen this is in one or two sentences. Then list every button, field or "
    "control a user could tap, ONE PER LINE, in the form:  LABEL -> x,y  "
    "where x,y is the CENTER of that control. Read x,y off the nearest yellow labels and "
    "interpolate between gridlines; do not guess from memory of other apps. "
    "EVERY coordinate must satisfy 0 <= x < {w} and 0 <= y < {h} — a coordinate outside that "
    "range is wrong by definition and will be discarded. Precision matters: these are used to "
    "tap the screen."
)

# The zoomed variant. Same contract, but the model only has to localize inside
# a fraction of the screen — which is what actually makes the answer accurate.
_VISION_ZOOM_TEMPLATE = (
    "This image is a {scale}x magnified CROP of an Android screen. It covers the region "
    "x={x1}..{x2}, y={y1}..{y2} of a screen that is {w}x{h} pixels in total. A coordinate grid is "
    "drawn over the crop: magenta lines every {step} screen-pixels, and each yellow label gives "
    "that intersection's FULL-SCREEN 'x,y' coordinate (already translated for you — quote them "
    "as-is, do not add the crop offset yourself). "
    "First say what this part of the screen shows in one or two sentences. Then list every "
    "button, field or control visible HERE, ONE PER LINE, as:  LABEL -> x,y  where LABEL is the "
    "control's own visible text or purpose and x,y is its CENTER in FULL-SCREEN coordinates, read "
    "off the nearest yellow labels. "
    "The yellow grid labels are NOT controls — never list a coordinate as its own label, and "
    "never list a gridline. Only list things a user could actually tap. "
    "Every coordinate must lie within x={x1}..{x2}, y={y1}..{y2}. Precision matters: these are "
    "used to tap the screen."
)

# Asking for ONE named control instead of "list everything" is worth roughly a
# 4x accuracy improvement on this provider, and it is the difference between a
# usable answer and the model transcribing the grid at you.
_VISION_TARGET_TEMPLATE = (
    "This image shows an Android screen{crop_note}. A coordinate grid is drawn over it: magenta "
    "lines every {step} screen-pixels, and each yellow label is that intersection's FULL-SCREEN "
    "'x,y' coordinate — quote those numbers as-is. "
    "Find this one thing on the screen: {target}. "
    "Reply with EXACTLY ONE line in the form:  {target} -> x,y  where x,y is the CENTER of that "
    "control in full-screen pixels. Do NOT interpolate to the nearest label if the center sits "
    "between gridlines — give the center's actual position, estimating between the labels. "
    "Every coordinate must satisfy {xrange} and {yrange}. If you genuinely cannot find it, reply "
    "with the single word NOT_FOUND and nothing else."
)

# A "label" that is itself a number/coordinate is the grid talking, not a
# control — a vision model handed a dense grid will happily transcribe it.
_JUNK_LABEL_RE = re.compile(r"^[\d\s,.:;x×()\[\]/_-]*$")

# A "LABEL -> x,y" line from the vision answer.
_COORD_LINE_RE = re.compile(r"^\s*[-*\d.]*\s*(.+?)\s*(?:->|:|=|→)\s*\(?\s*(\d{1,5})\s*[,\s]\s*(\d{1,5})\s*\)?\s*$")


def _extract_targets(vision_text, width, height, box=None):
    """Split the vision answer's 'LABEL -> x,y' lines into (in-range, out-of-range).

    A vision model that answers in the wrong coordinate space still sounds
    confident, so the coordinates are checked against the area it was actually
    shown — the screen, or the region when the look was zoomed — instead of
    being handed to the agent as fact.
    """
    on, off = [], []
    for line in (vision_text or "").splitlines():
        m = _COORD_LINE_RE.match(line)
        if not m:
            continue
        label, x, y = m.group(1).strip(), int(m.group(2)), int(m.group(3))
        if len(label) > 60 or len(label) < 2 or _JUNK_LABEL_RE.match(label):
            continue
        ok = (box[0] <= x <= box[2] and box[1] <= y <= box[3]) if box \
            else in_bounds(x, y, width, height)
        (on if ok else off).append((label, x, y))
    return on, off


def _target_verdict(vision_text, width, height, custom_question, box=None, target=None):
    """Turn the vision answer into an honest verdict about its coordinates.

    Vision-estimated coordinates are the ONLY channel on a self-drawn screen,
    and a model answering in the wrong coordinate space sounds exactly like one
    answering correctly. So the coordinates it produced are checked against the
    real screen and the agent is told which of the two situations it is in —
    silently passing them through is how a drive loop ends up tapping nothing
    for twenty turns and concluding the app is broken.
    """
    if custom_question or not width or not height:
        return []
    on, off = _extract_targets(vision_text, width, height, box)
    if not on and not off:
        if target and re.search(r"\bNOT[_ ]FOUND\b", vision_text or "", re.IGNORECASE):
            return [f"NOT FOUND: the vision model could not see {target!r} in this "
                    f"{'region' if box else 'screen'}. Look at a different region, or take a "
                    f"whole-screen observe_screen first to locate it roughly."]
        return ["NOTE: the description above lists no 'LABEL -> x,y' coordinates. Read the "
                "target's position off the grid-annotated screenshot yourself, or re-call "
                "observe_screen with region=… and target='the thing you want' — a named target "
                "is answered several times more accurately than an open 'what is on screen'."]
    out = []
    if on:
        out.append("CANDIDATE TAP TARGETS (on-screen, from the description above — ESTIMATES: "
                   "tap one, then call observe_screen again to confirm it did something):")
        out.extend(f"  ({x:>4},{y:>4})  {label}" for label, x, y in on[:20])
        if not box:
            out.append("Accuracy note: a whole-screen visual estimate is typically off by ~100 px "
                       "on this setup — enough to miss a button. Before tapping something small, "
                       "re-call observe_screen(region=…) on the area it is in; the zoomed read is "
                       "several times more accurate and returns full-screen coordinates.")
    if off:
        where = (f"the region {box[0]},{box[1]}-{box[2]},{box[3]}" if box
                 else f"the {width}x{height} screen")
        out.append(f"WARNING: {len(off)} of {len(on) + len(off)} coordinates the vision model gave "
                   f"fall OUTSIDE {where} (e.g. "
                   f"{off[0][1]},{off[0][2]} for {off[0][0]!r}) — it is not reading this screen's "
                   f"coordinate space reliably. Treat ALL of them as weak: prefer targets you can "
                   f"confirm, tap one and verify with observe_screen before tapping again, and do "
                   f"not report a UI step as done on the strength of these numbers alone.")
    return out


def _shell(adb, serial, command, timeout=30):
    """One `adb shell <command>` as a single argv token list."""
    return _run([adb, "-s", serial, "shell"] + command.split(), timeout=timeout)


def _screencap(adb, serial):
    """The current frame as PNG bytes, straight off the device framebuffer
    (works when the VM window is minimized/occluded — it never looks at the
    host window). Returns None on failure."""
    try:
        proc = subprocess.run([adb, "-s", serial, "exec-out", "screencap", "-p"],
                              capture_output=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        return None
    return proc.stdout if proc.returncode == 0 and proc.stdout else None


def _read_ui(adb, serial):
    """(interesting_nodes, error_or_None). uiautomator writes the dump to a file
    and prints only a confirmation, so we cat it back in the same shell round
    trip. A dump failure is NOT fatal — the screenshot channel still works."""
    guest = "/data/local/tmp/_agent_ui.xml"
    res = _run([adb, "-s", serial, "shell",
                f"uiautomator dump {guest} >/dev/null 2>&1; cat {guest}"],
               timeout=90)
    if res.get("error"):
        return [], res["error"]
    try:
        return interesting_nodes(parse_ui_nodes(res.get("stdout") or "")), None
    except ValueError as e:
        return [], str(e)


def _capture(adb, serial, grid, label=None, box=None, scale=1):
    """Save the current frame (plus a grid-annotated copy) under the workspace.
    With `box`, the annotated copy is a magnified crop whose labels still carry
    full-screen coordinates. Returns (rel_paths, grid_rel_or_None, error)."""
    png = _screencap(adb, serial)
    if not png:
        return [], None, "screencap failed (no frame returned)"
    try:
        host_dir = resolve_workspace_path(_SHOT_DIR)
    except RuntimeError as e:
        return [], None, str(e)
    os.makedirs(host_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    prefix = f"{label}_" if label else ""
    name = f"{prefix}{stamp}.png"
    host_png = os.path.join(host_dir, name)
    with open(host_png, "wb") as f:
        f.write(png)

    rels = [f"{_SHOT_DIR}/{name}"]
    grid_rel = None
    if grid:
        try:
            host_grid = draw_grid(host_png, step=int(grid), box=box, scale=scale)
            grid_rel = f"{_SHOT_DIR}/{os.path.basename(host_grid)}"
            rels.append(grid_rel)
        except Exception as e:                     # Pillow/codec issue only
            return rels, None, f"grid overlay failed: {e}"
    return rels, grid_rel, None


@registry.register(
    name="observe_screen",
    description=(
        "LOOK at the emulator screen and get back everything needed to ACT on it: the screen "
        "resolution, which app/activity is in the foreground, and a list of the on-screen elements "
        "with the exact pixel to tap for each. Saves the frame (and a grid-annotated copy) to the "
        "workspace. This is the counterpart to tap_screen/tap_element/type_text — call it before "
        "acting to find your target, and again after acting to CONFIRM the screen changed. "
        "Element coordinates come from Android's own view hierarchy, so they are exact. On a screen "
        "that draws its own frames (a game's SurfaceView, video, canvas) the hierarchy is empty — "
        "the tool detects that and instead has the VISION model read the grid-annotated screenshot "
        "and report each control's coordinates, so you still get something to tap. "
        "On such a screen, ZOOM AND NAME WHAT YOU WANT: region='bottom-right' (or 'x1,y1,x2,y2') "
        "plus target='the PLAY button' re-looks at just that part, magnified, asking for that one "
        "control. Measured against a button whose true position was known, an open whole-screen "
        "look missed by ~230 px; the zoomed, named look came back ~4x closer. So when a coordinate "
        "does not work, zoom and name the target rather than tapping near it again."
    ),
    params_schema={
        "region": "string (optional — look at ONE part of the screen, magnified, for a much more accurate coordinate: a name ('top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right','top-half','bottom-half','left-half','right-half') or explicit 'x1,y1,x2,y2' pixels. Coordinates come back in FULL-SCREEN pixels, ready to tap. Use after a whole-screen look has told you roughly where the target is.)",
        "target": "string (optional — the ONE control you are looking for, in plain words, e.g. 'the green PLAY button' or 'the username field'. Asks the vision model for just that instead of an inventory of the screen, which is markedly more accurate; combine with region for the best result. Answers NOT FOUND rather than inventing a coordinate.)",
        "grid": "integer (optional, default 100 — pixel spacing of the labelled coordinate grid drawn on the saved copy; halved automatically when region is set; 0 disables it)",
        "describe": "boolean (optional — force the vision description on/off. Default: automatic, i.e. describe only when the view hierarchy has nothing tappable in it)",
        "question": "string (optional — ask the vision model something specific about the screen instead of the default 'list every control with its coordinates')",
        "settle_ms": "integer (optional, default 0 — wait this long before capturing, to let an animation/transition finish after a tap)",
        "max_elements": "integer (optional, default 40 — cap on how many elements are listed)",
        "label": "string (optional — short label prefixed to the saved screenshot filename, e.g. 'after_login_tap')",
        "backend": "string (optional, default 'qemu')",
        "device_name": "string (optional — the omnidroid instance/account name; must match the running instance)",
    },
    output=("Text: 'SCREEN <w>x<h>', the foreground activity and lock-task state, the saved "
            "screenshot path(s), then either an ELEMENTS table ('(x,y) [tap] Button text=...') or, "
            "for a self-drawn screen, the vision model's description with coordinates. Plus a "
            "'files' list of the saved image paths."),
    when_to_use=("Call this FIRST whenever you need to interact with the screen rather than just "
                 "watch it — it is how you find what to tap. Call it AGAIN after every tap/type/"
                 "swipe to verify the result; an input tool reporting ok only means adb accepted "
                 "the event, never that the UI responded.")
)
def observe_screen(region=None, target=None, grid=100, describe=None, question=None, settle_ms=0,
                   max_elements=40, label=None, backend=_DEFAULT_BACKEND, device_name=None):
    _err = devices.require_local("observe_screen")
    if _err:
        return _err
    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err

    try:
        settle_ms = max(0, min(int(settle_ms), 15000))
    except (TypeError, ValueError):
        settle_ms = 0
    if settle_ms:
        time.sleep(settle_ms / 1000.0)
    try:
        grid = max(0, int(grid))
    except (TypeError, ValueError):
        grid = 100
    try:
        max_elements = max(1, min(int(max_elements), 200))
    except (TypeError, ValueError):
        max_elements = 40

    width, height = parse_screen_size((_shell(adb, serial_or_err, "wm size", 20)
                                       .get("stdout") or ""))
    dump = (_shell(adb, serial_or_err, "dumpsys activity activities", 60).get("stdout") or "")
    top, lock = parse_top_activity(dump), parse_lock_task_state(dump)
    nodes, ui_err = _read_ui(adb, serial_or_err)

    box, region_err = resolve_region(region, width, height)
    zoom = 2 if box else 1
    # Grid density is a real trade-off, measured rather than guessed. A vision
    # model quotes the nearest labelled intersection instead of interpolating,
    # so a FINER grid means a more precise answer — but a label-dense crop makes
    # it transcribe the grid instead of naming controls when the question is an
    # open "list everything". So: subdivide only when a specific target was
    # named (the question is then narrow enough to stay on task).
    step = max(20, grid // 2) if (box and grid and target) else grid
    rels, grid_rel, cap_err = _capture(adb, serial_or_err, step, label, box=box, scale=zoom)
    if box:
        # Anything VISIBLE in the region, not just centered in it — a wide
        # button crossing the boundary is still one of the things being
        # looked at, and dropping it would read as "not on this screen".
        nodes = [n for n in nodes
                 if n["bounds"][0] <= box[2] and n["bounds"][2] >= box[0]
                 and n["bounds"][1] <= box[3] and n["bounds"][3] >= box[1]]
        # Zooming is only ever asked for to find something visually; describe by
        # default rather than making the caller pass describe=True as well.
        if describe is None:
            describe = True

    lines = [f"SCREEN {width}x{height}" if width else "SCREEN size unknown"]
    if region_err:
        lines.append(f"NOTE: {region_err} Showing the whole screen instead.")
    if box:
        lines.append(f"REGION {box[0]},{box[1]} → {box[2]},{box[3]} (magnified {zoom}x; all "
                     f"coordinates below are FULL-SCREEN pixels, ready to tap as-is)")
    if top:
        lines[0] += f" · foreground: {top}"
    if lock and lock not in ("NONE", "LOCK_TASK_MODE_NONE"):
        lines[0] += f" · lock_task={lock} (only whitelisted apps can be foregrounded)"
    for rel in rels:
        lines.append(f"Screenshot: {rel}")
    if cap_err:
        lines.append(f"NOTE: {cap_err}")

    if nodes:
        lines.append(f"ELEMENTS — {len(nodes)} on screen; the (x,y) is the exact tap center. "
                     f"Prefer tap_element(text=...) over retyping these coordinates.")
        lines.append(format_elements(nodes, max_elements))
    else:
        why = (f"the UI dump failed ({ui_err})" if ui_err else
               "no tappable elements here" if box else
               "this screen draws its own frames (one SurfaceView/canvas — a game, video "
               "or custom renderer), so Android exposes no tappable elements")
        lines.append(f"ELEMENTS: none — {why}. Read the target's position off the "
                     f"grid-annotated screenshot and use tap_screen(x, y).")

    want_vision = (not nodes) if describe is None else bool(describe)
    if want_vision and (rels or grid_rel):
        if not has_vision_model():
            lines.append("NOTE: no vision model is configured, so the screenshot could not be "
                         "described automatically — add one under LLM Settings > vision models.")
        else:
            # With grid=0 there is no annotated frame; the templates still hold
            # (they describe a grid the model simply won't see) so name the
            # nominal spacing rather than formatting a nonsensical "every 0px".
            step = step or 100
            if question:
                asked = question
            elif target:
                asked = _VISION_TARGET_TEMPLATE.format(
                    target=target, step=step,
                    crop_note=(f", cropped to the region x={box[0]}..{box[2]}, y={box[1]}..{box[3]} "
                               f"of a {width}x{height} screen and magnified {zoom}x" if box
                               else f" that is exactly {width} pixels wide and {height} tall"),
                    xrange=(f"{box[0]} <= x <= {box[2]}" if box else f"0 <= x < {width}"),
                    yrange=(f"{box[1]} <= y <= {box[3]}" if box else f"0 <= y < {height}"))
            elif box:
                asked = _VISION_ZOOM_TEMPLATE.format(
                    scale=zoom, x1=box[0], y1=box[1], x2=box[2], y2=box[3],
                    w=(width or "?"), h=(height or "?"), step=step)
            else:
                asked = _VISION_QUESTION_TEMPLATE.format(
                    w=(width or "?"), h=(height or "?"), step=step)
            seen = analyze_image(image_path=(grid_rel or rels[0]), question=asked)
            if isinstance(seen, dict) and seen.get("stdout"):
                header = (f"WHERE IS {target!r} (read by the vision model off the "
                          f"{'zoomed ' if box else ''}grid-annotated frame):" if target else
                          "WHAT THE SCREEN LOOKS LIKE (read by the vision model off the "
                          "grid-annotated frame):")
                lines.append(header)
                lines.append(seen["stdout"])
                lines.extend(_target_verdict(seen["stdout"], width, height, bool(question), box,
                                             target))
            elif isinstance(seen, dict) and seen.get("error"):
                lines.append(f"NOTE: vision description unavailable ({seen['error']}).")

    return {"stdout": "\n".join(lines), "files": rels}


@registry.register(
    name="tap_element",
    description=(
        "Taps an on-screen element BY ITS LABEL — visible text, accessibility description, or "
        "resource id — instead of by guessed pixels. Looks the element up in Android's live view "
        "hierarchy and taps the exact center of its bounds, so it cannot drift the way a coordinate "
        "read off a screenshot can. Matching is exact-first, then case-insensitive substring. "
        "This is the preferred way to press buttons, open menus and focus text fields on ordinary "
        "Android UI (login screens, settings, dialogs, permission prompts). It cannot work on a "
        "screen that renders its own frames (a game surface) — there use observe_screen + tap_screen."
    ),
    params_schema={
        "text": "string (optional — the element's visible text, e.g. 'Log In')",
        "desc": "string (optional — the element's accessibility content-description)",
        "element_id": "string (optional — the resource id, with or without the package, e.g. 'login_btn')",
        "index": "integer (optional, default 0 — which match to tap when several match; the error message lists them in order)",
        "backend": "string (optional, default 'qemu')",
        "device_name": "string (optional — the omnidroid instance/account name)",
    },
    output=("JSON confirming what was tapped and at which coordinates, or an error that LISTS the "
            "candidate/available elements so the next call can name the right one."),
    when_to_use=("Use this instead of tap_screen whenever the target has a label — it removes the "
                 "coordinate-estimation error entirely. Fall back to observe_screen + tap_screen "
                 "only when the hierarchy is empty (a game/video surface).")
)
def tap_element(text=None, desc=None, element_id=None, index=0,
                backend=_DEFAULT_BACKEND, device_name=None):
    _err = devices.require_local("tap_element")
    if _err:
        return _err
    selectors = [s for s in (text, desc, element_id) if s not in (None, "")]
    if len(selectors) != 1:
        return {"error": "Give exactly ONE selector: text=, desc=, or element_id=."}

    adb, serial_or_err = _resolve_serial(backend, device_name)
    if adb is None:
        return serial_or_err
    try:
        index = max(0, int(index))
    except (TypeError, ValueError):
        index = 0

    nodes, ui_err = _read_ui(adb, serial_or_err)
    if not nodes:
        why = (f"the UI dump failed ({ui_err})" if ui_err else
               "this screen exposes no elements — it draws its own frames (a game/video surface)")
        return {"error": (f"Cannot tap by label: {why}. Call observe_screen to see the screen "
                          f"(it will describe a self-drawn screen visually), then tap_screen(x, y).")}

    hits = match_nodes(nodes, text=text, desc=desc, rid=element_id)
    want = text or desc or element_id
    if not hits:
        return {"error": (f"No element matches {want!r}. On screen now: "
                          f"{labels_of(nodes)}. Call observe_screen for the full list with "
                          f"coordinates.")}
    if len(hits) > 1 and index >= len(hits):
        index = 0
    if len(hits) > 1 and index == 0 and not _unambiguous(hits, want):
        listed = "; ".join(f"[{i}] {(n['text'] or n['desc'] or n['id'])!r} at "
                           f"{n['center'][0]},{n['center'][1]}" for i, n in enumerate(hits[:8]))
        return {"error": (f"{len(hits)} elements match {want!r} — refusing to guess. "
                          f"Re-call with the exact label, or with index=N: {listed}")}

    node = hits[index]
    x, y = node["center"]
    res = _run([adb, "-s", serial_or_err, "shell", "input", "tap", str(x), str(y)], timeout=30)
    if isinstance(res, dict) and res.get("error"):
        return res
    if isinstance(res, dict) and res.get("returncode", 0) != 0:
        return {"error": f"adb input tap failed (exit {res.get('returncode')}): "
                         f"{(res.get('stderr') or '').strip()[:300]}"}
    return {"ok": True, "tapped": [x, y],
            "element": {k: node[k] for k in ("text", "desc", "id", "cls", "clickable", "bounds")},
            "note": "Call observe_screen to confirm the screen actually changed."}


def _unambiguous(hits, want):
    """True when one hit matches the selector EXACTLY — an exact label beating
    a pile of substring matches is a real choice, not a guess."""
    exact = [n for n in hits
             if want in (n["text"], n["desc"], n["id"], n["full_id"])]
    return len(exact) == 1 and exact[0] is hits[0]
