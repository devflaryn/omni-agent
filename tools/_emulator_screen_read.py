"""Turn an Android screen into something a TEXT-ONLY model can act on.

The main LLM cannot see pixels — it only ever reads tool output — so a raw
screenshot tells it nothing it can tap. Everything here exists to close that
gap by producing COORDINATES in text:

  * ``parse_ui_nodes`` — the accurate channel. uiautomator's view hierarchy
    gives every labelled/clickable node exact bounds, so "Log In" becomes a
    precise tap center with no guessing at all.
  * ``draw_grid`` — the fallback channel, for screens uiautomator is blind to
    (anything that draws its own frames: a game's single SurfaceView, a video,
    a canvas). Ruled, labelled lines let the vision model report a position by
    reading the nearest label off the image instead of estimating a pixel —
    estimates drift by tens of pixels, which is enough to miss a button.

Pure functions over captured text/images: no adb, no I/O beyond the image file
it is handed, so all of it is testable without a booted VM.
"""

import re
import xml.etree.ElementTree as ET

# `wm size` prints "Physical size: WxH" and, when a different resolution has
# been forced, an additional "Override size: WxH" — the override is what is
# actually on screen, so it wins.
_PHYSICAL_RE = re.compile(r"Physical size:\s*(\d+)x(\d+)")
_OVERRIDE_RE = re.compile(r"Override size:\s*(\d+)x(\d+)")
_TOP_ACT_RE = re.compile(r"topResumedActivity=ActivityRecord\{\S+\s+\S+\s+(\S+)")
_LOCK_TASK_RE = re.compile(r"mLockTaskModeState=(\S+)")
_BOUNDS_RE = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


def parse_screen_size(wm_size_stdout):
    """(width, height) from `wm size` output, or (None, None) if unreadable."""
    text = wm_size_stdout or ""
    m = _OVERRIDE_RE.search(text) or _PHYSICAL_RE.search(text)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def parse_top_activity(dumpsys_stdout):
    """The foreground 'package/.Activity', or None. Names WHICH app the agent is
    looking at — the difference between 'the tap worked' and 'the tap opened
    something else'."""
    m = _TOP_ACT_RE.search(dumpsys_stdout or "")
    return m.group(1) if m else None


def parse_lock_task_state(dumpsys_stdout):
    """Kiosk Lock Task Mode state ('NONE'/'LOCKED'/'PINNED'), or None. LOCKED
    explains why a launch/back press gets refused."""
    m = _LOCK_TASK_RE.search(dumpsys_stdout or "")
    return m.group(1) if m else None


def parse_ui_nodes(xml_text):
    """Flatten a uiautomator dump into dicts carrying a ready-to-tap `center`.

    Tolerates the tool's own chatter before the XML ("UI hierchary dumped
    to: ..."), which is why it slices from the first <hierarchy rather than
    parsing the whole payload. Raises ValueError when there is no hierarchy at
    all (a failed dump), so callers can degrade instead of taping blind.
    """
    xml = (xml_text or "").strip()
    start = xml.find("<hierarchy")
    if start < 0:
        raise ValueError("uiautomator produced no <hierarchy> "
                         f"({xml[:200] or 'empty output'})")
    try:
        root = ET.fromstring(xml[start:])
    except ET.ParseError as e:
        raise ValueError(f"could not parse the UI hierarchy: {e}")

    nodes = []
    for el in root.iter("node"):
        m = _BOUNDS_RE.match(el.get("bounds") or "")
        if not m:
            continue
        x1, y1, x2, y2 = (int(v) for v in m.groups())
        rid = el.get("resource-id") or ""
        nodes.append({
            "text": el.get("text") or "",
            "desc": el.get("content-desc") or "",
            "id": rid.split("/")[-1] if rid else "",
            "full_id": rid,
            "cls": (el.get("class") or "").split(".")[-1],
            "clickable": el.get("clickable") == "true",
            "focused": el.get("focused") == "true",
            "enabled": el.get("enabled") != "false",
            "bounds": [x1, y1, x2, y2],
            "center": [(x1 + x2) // 2, (y1 + y2) // 2],
        })
    return nodes


def interesting_nodes(nodes):
    """Nodes worth showing the model: anything labelled, identified, or
    clickable. An empty result is itself the signal that this screen draws its
    own frames and must be driven visually."""
    return [n for n in nodes if n["text"] or n["desc"] or n["id"] or n["clickable"]]


def format_node(n):
    bits = [f"({n['center'][0]:>4},{n['center'][1]:>4})",
            "[tap]" if n["clickable"] else "     ",
            f"{n['cls']:<14}"]
    if n["text"]:
        bits.append(f"text={n['text']!r}")
    if n["desc"]:
        bits.append(f"desc={n['desc']!r}")
    if n["id"]:
        bits.append(f"id={n['id']}")
    if n["focused"]:
        bits.append("<focused>")
    if not n["enabled"]:
        bits.append("<disabled>")
    return "  " + " ".join(bits)


def format_elements(nodes, max_elements=40):
    """A tap-center table. Truncates loudly — a silently cut list would read as
    'that button isn't on screen'."""
    shown = nodes[:max_elements]
    lines = [format_node(n) for n in shown]
    if len(nodes) > len(shown):
        lines.append(f"  … and {len(nodes) - len(shown)} more elements "
                     f"(raise max_elements to see them)")
    return "\n".join(lines)


def labels_of(nodes, limit=25):
    """Short 'what is on screen' list for an error message after a failed
    match — the agent needs the real labels, not just 'not found'.

    Visible text and descriptions come first: a screen's few real labels are
    what the next call will name, and leading with a dozen layout-container ids
    (action_bar_root, contentPanel, …) buries them.
    """
    out = []
    for key in ("text", "desc", "id"):
        for n in nodes:
            label = n[key]
            if label and label not in out:
                out.append(label)
            if len(out) >= limit:
                return out
    return out


def match_nodes(nodes, text=None, desc=None, rid=None):
    """Nodes matching one selector. An exact match wins outright; otherwise fall
    back to case-insensitive substring so a caller can target 'download'
    without reproducing the label character for character."""
    def pick(key, want):
        exact = [n for n in nodes if n[key] == want]
        if exact:
            return exact
        low = want.lower()
        return [n for n in nodes if low in (n[key] or "").lower()]

    if text is not None:
        return pick("text", text)
    if desc is not None:
        return pick("desc", desc)
    if rid is not None:
        exact = [n for n in nodes if n["id"] == rid or n["full_id"] == rid]
        if exact:
            return exact
        low = rid.lower()
        return [n for n in nodes if low in (n["id"] or "").lower()]
    return []


def in_bounds(x, y, width, height):
    """True when (x, y) is on the screen — or when the size is unknown, so an
    unreadable `wm size` never blocks a tap that would have worked."""
    if not width or not height:
        return True
    return 0 <= x < width and 0 <= y < height


# Named regions, as fractions of (width, height). A 3x3 split plus the four
# halves — the vocabulary someone actually uses after a first look at a screen
# ("it's bottom-right"), so a follow-up zoom needs no pixel arithmetic.
REGIONS = {
    "top-left":     (0.0, 0.0, 1 / 3, 1 / 3),
    "top":          (1 / 3, 0.0, 2 / 3, 1 / 3),
    "top-right":    (2 / 3, 0.0, 1.0, 1 / 3),
    "left":         (0.0, 1 / 3, 1 / 3, 2 / 3),
    "center":       (1 / 3, 1 / 3, 2 / 3, 2 / 3),
    "right":        (2 / 3, 1 / 3, 1.0, 2 / 3),
    "bottom-left":  (0.0, 2 / 3, 1 / 3, 1.0),
    "bottom":       (1 / 3, 2 / 3, 2 / 3, 1.0),
    "bottom-right": (2 / 3, 2 / 3, 1.0, 1.0),
    "top-half":     (0.0, 0.0, 1.0, 0.5),
    "bottom-half":  (0.0, 0.5, 1.0, 1.0),
    "left-half":    (0.0, 0.0, 0.5, 1.0),
    "right-half":   (0.5, 0.0, 1.0, 1.0),
}


def resolve_region(spec, width, height):
    """A region spec -> (x1, y1, x2, y2) in screen pixels, or (None, error).

    Accepts a name from REGIONS ('bottom-right') or explicit 'x1,y1,x2,y2'.
    """
    if spec in (None, "", False):
        return None, None
    if not width or not height:
        return None, "region needs the screen size, which could not be read from this device."
    if isinstance(spec, (list, tuple)) and len(spec) == 4:
        nums = list(spec)
    else:
        key = str(spec).strip().lower().replace("_", "-").replace(" ", "-")
        if key in REGIONS:
            fx1, fy1, fx2, fy2 = REGIONS[key]
            nums = [fx1 * width, fy1 * height, fx2 * width, fy2 * height]
        else:
            parts = [p for p in re.split(r"[,\s]+", key) if p]
            if len(parts) != 4 or not all(p.lstrip("-").isdigit() for p in parts):
                return None, (f"Unknown region {spec!r}. Use 'x1,y1,x2,y2' or one of: "
                              f"{', '.join(sorted(REGIONS))}.")
            nums = [int(p) for p in parts]
    x1, y1, x2, y2 = (int(round(v)) for v in nums)
    x1, y1 = max(0, min(x1, width - 1)), max(0, min(y1, height - 1))
    x2, y2 = max(0, min(x2, width)), max(0, min(y2, height))
    if x2 - x1 < 20 or y2 - y1 < 20:
        return None, f"Region {spec!r} resolves to an empty/tiny area ({x1},{y1})-({x2},{y2})."
    return (x1, y1, x2, y2), None


def draw_grid(path, step=100, out_path=None, box=None, scale=1):
    """Write a grid-annotated COPY of a screenshot and return its path.

    A copy, not in-place: the clean frame stays available as evidence (and for
    the vision cache), while the annotated one is what gets reasoned over.

    `box` crops to (x1, y1, x2, y2) and `scale` magnifies the crop — but every
    label still carries its FULL-SCREEN coordinate, so a coordinate read off a
    zoomed crop is directly tappable with no arithmetic on the caller's side.
    Zooming is what makes the visual channel usable: measured against a button
    whose true center was known, a vision model missed by 115-226 px on a whole
    1280x800 screen and by 47 px — inside the button — on a magnified ninth of
    it. Localization error scales with how much screen the model must search.

    Labels are yellow-on-black-halo so they read over both a white settings
    page and a dark game frame, sized to stay legible after the downscale the
    vision API applies while occluding as little of the content as possible.
    """
    from PIL import Image, ImageDraw, ImageFont

    out_path = out_path or _grid_path(path)
    with Image.open(path) as src:
        img = src.convert("RGB")
    x0, y0 = 0, 0
    if box:
        x0, y0 = box[0], box[1]
        img = img.crop(box)
    scale = max(1, min(int(scale), 4))
    if scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)

    w, h = img.size
    step = max(10, int(step))
    # Big enough to survive the vision API's downscale, small enough not to
    # bury the buttons it is meant to help locate.
    font_size = max(12, min(20, w // 75))
    try:
        font = ImageFont.load_default(size=font_size)
    except TypeError:                       # Pillow < 10 has no sized default
        font = ImageFont.load_default()

    # Gridlines land on multiples of `step` in SCREEN space, so the same pixel
    # is always labelled the same way whether or not the frame was cropped.
    xs = list(range(x0 - (x0 % step), x0 + (w // scale) + 1, step))
    ys = list(range(y0 - (y0 % step), y0 + (h // scale) + 1, step))

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    minor, major = (255, 0, 255, 60), (255, 0, 255, 130)
    for gx in xs:
        px = (gx - x0) * scale
        if 0 <= px < w:
            d.line([(px, 0), (px, h)], fill=major if gx % (step * 5) == 0 else minor)
    for gy in ys:
        py = (gy - y0) * scale
        if 0 <= py < h:
            d.line([(0, py), (w, py)], fill=major if gy % (step * 5) == 0 else minor)

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    d = ImageDraw.Draw(img)

    def _label(px, py, text):
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            d.text((px + dx, py + dy), text, font=font, fill=(0, 0, 0))
        d.text((px, py), text, font=font, fill=(255, 255, 0))

    # Edge rulers first (a reading aid where the content is least important),
    # then the intersection labels the model actually quotes back.
    for gx in xs:
        px = (gx - x0) * scale
        if 0 <= px < w:
            _label(min(px + 3, w - 4), 1, str(gx))
    for gy in ys:
        py = (gy - y0) * scale
        if 0 < py < h:
            _label(2, py + 2, str(gy))
    for gx in xs:
        px = (gx - x0) * scale
        if not 0 <= px < w:
            continue
        for gy in ys:
            py = (gy - y0) * scale
            if 0 <= py < h:
                _label(px + 4, py + 2, f"{gx},{gy}")
    img.save(out_path)
    return out_path


def _grid_path(path, suffix="grid"):
    base, dot, ext = path.rpartition(".")
    return f"{base}_{suffix}.{ext}" if dot else f"{path}_{suffix}.png"
