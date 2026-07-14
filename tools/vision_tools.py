"""Image reasoning (image-to-text) tools.

These let the agent hand a screenshot / image to the configured VISION model
(image-to-text) — a separate model from the main text-to-text LLM (see
llm.ask_vision / the provider's "vision models" ladder) — get back a plain-language
description or answer, and carry that back into the main reasoning loop. This is
how the agent "sees" what a debugging screenshot actually shows.

Images are downscaled/compressed to fit the provider's inline-image size limit
before sending, so a full-resolution emulator screenshot doesn't blow the request.
"""
import base64
import io
import os

from PIL import Image

from tool_registry import registry
from tools.common import resolve_workspace_path
import llm

# Keep the base64 payload comfortably under NVIDIA NIM's inline-image limit
# (~180 KB); shrinking dimensions + JPEG quality until it fits.
_MAX_B64_BYTES = 170_000
_START_MAX_DIM = 1280


def _encode_image_capped(path):
    """Read an image and return (data_uri, note). Downscales the longest side and
    lowers JPEG quality until the base64 payload fits the inline limit, so even a
    1080p screenshot is sendable. `note` records what shrinking happened."""
    with Image.open(path) as im:
        im = im.convert("RGB")
        orig_w, orig_h = im.size
        max_dim = _START_MAX_DIM
        quality = 85
        note = ""
        for _ in range(8):
            work = im
            longest = max(work.size)
            if longest > max_dim:
                scale = max_dim / float(longest)
                work = im.resize((max(1, int(work.size[0] * scale)),
                                  max(1, int(work.size[1] * scale))))
            buf = io.BytesIO()
            work.save(buf, "JPEG", quality=quality)
            raw = buf.getvalue()
            b64 = base64.b64encode(raw).decode("ascii")
            if len(b64) <= _MAX_B64_BYTES:
                if work.size != (orig_w, orig_h) or quality < 85:
                    note = f"(downscaled to {work.size[0]}x{work.size[1]} q{quality} to fit the vision API)"
                return f"data:image/jpeg;base64,{b64}", note
            # Too big — shrink more aggressively for the next attempt.
            if quality > 55:
                quality -= 15
            else:
                max_dim = int(max_dim * 0.8)
        # Last resort: return whatever we produced (still base64), even if large.
        return f"data:image/jpeg;base64,{b64}", "(image is large; sent at reduced quality)"


def _resolve_image(path):
    """Resolve a workspace-relative (or absolute) image path to a real host file."""
    p = (path or "").strip()
    if not p:
        return None, "No image path provided."
    if os.path.isabs(p) and os.path.isfile(p):
        return p, None
    host = resolve_workspace_path(p)
    if not os.path.isfile(host):
        return None, f"Image not found: {p} (looked at {host})"
    return host, None


_DEFAULT_QUESTION = (
    "Describe exactly what is on this screen in 2-4 sentences: which screen/page it is, the key "
    "UI elements and any text, and anything that looks broken or noteworthy (an error/crash dialog, "
    "a blank/black screen, misaligned or missing content). Be concrete and specific."
)


@registry.register(
    name="analyze_image",
    description=(
        "Look at an image (a screenshot, exported frame, diagram, photo — any PNG/JPG in the workspace) "
        "with the configured VISION model (image-to-text) and return a plain-language description or an "
        "answer to your question about it. Use this to actually SEE what a debugging screenshot shows — "
        "an emulator screen, a crash/ANR dialog, a rendered layout, a chart — before deciding the next "
        "step. The vision model is separate from the main text model but shares the same API-key pool; it "
        "runs through the same key-rotation/model-fallback engine. Pass image_path for one image, or "
        "image_paths to reason over several at once (e.g. to compare before/after frames). The returned "
        "description is yours to reason over and act on."
    ),
    params_schema={
        "image_path": "string (workspace-relative path to ONE image, e.g. 'screenshots/manual/foo.png')",
        "image_paths": "array of strings (optional — several image paths to analyze together instead of image_path)",
        "question": "string (optional — what you want to know about the image(s); defaults to a full screen description)",
    },
    output="The vision model's description/answer as text (plus which vision model answered), or an error if no vision model is configured or all vision models failed.",
    when_to_use="Call this whenever you need to understand what's actually on a screenshot/image — after taking an emulator screenshot or capturing keyframes, when a test result depends on what rendered, or any time visual evidence would settle an uncertainty. Then reason over the description and continue."
)
def analyze_image(image_path=None, image_paths=None, question=None):
    paths = []
    if isinstance(image_paths, (list, tuple)):
        paths.extend(str(p) for p in image_paths if str(p).strip())
    if image_path and str(image_path).strip():
        paths.append(str(image_path).strip())
    if not paths:
        return {"error": "Provide image_path (or image_paths)."}
    if not llm.has_vision_model():
        return {"error": ("No vision (image-to-text) model is configured. Open LLM Settings and add one to "
                          "the provider's 'vision models' list — it reuses the same API-key pool as the text models.")}

    content = [{"type": "text", "text": (question or "").strip() or _DEFAULT_QUESTION}]
    notes = []
    for p in paths[:6]:   # bound how many images ride in one request
        host, err = _resolve_image(p)
        if err:
            return {"error": err}
        try:
            data_uri, note = _encode_image_capped(host)
        except Exception as e:
            return {"error": f"Could not read/encode image '{p}': {e}"}
        content.append({"type": "image_url", "image_url": {"url": data_uri}})
        if note:
            notes.append(f"{os.path.basename(p)} {note}")

    res = llm.ask_vision([{"role": "user", "content": content}])
    if not res.get("ok"):
        return {"error": res.get("error", "vision request failed")}
    out = res["content"].strip()
    prefix = f"[vision: {res.get('model', '?')}"
    prefix += (" · " + "; ".join(notes) + "]") if notes else "]"
    return {"stdout": f"{prefix}\n{out}"}
