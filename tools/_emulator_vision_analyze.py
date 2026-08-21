"""Host-side vision analysis — imported directly by tools/android_emulator.py.

Reads the metadata.json produced by _emulator_frame_capture.py, sends each
keyframe PNG to a vision-capable backend for a plain-language description,
and writes the description back into metadata.json next to each frame.

Backend selection ("auto" by default):
  1. Try the same chat-completions API/model that powers the main agent (the
     Cline-proxied GLM backend), formatted as an OpenAI-vision-style message
     with an inline base64 image. If that request errors, times out, or the
     model's reply looks like a refusal/doesn't actually describe an image,
     fall back to local Ollama.
  2. Local Ollama at http://localhost:11434 (the agent, the emulator and Ollama
     all run on the same host, so plain localhost reaches it) — works with any vision model the user has pulled (llava,
     moondream, qwen2.5vl, bakllava, ...).
If both fail, each frame is left with vision_description=None and an error
note, so generate_test_report can still produce a report from brightness/diff
data and logcat alone.
"""
import base64
import json
import os

import requests

from tools.vision_cache import cached_vision

_REFUSAL_MARKERS = (
    "cannot see images", "can't see images", "unable to view images",
    "i cannot view", "no image was provided", "i don't have the ability to view",
)


def _looks_like_refusal(text):
    low = (text or "").lower()
    return (not text) or any(m in low for m in _REFUSAL_MARKERS)


def _analyze_with_api(image_b64, prompt, cfg):
    payload = {
        "model": cfg["cline_model"],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
            ],
        }],
        "temperature": 0.2,
    }
    try:
        resp = requests.post(
            cfg["cline_api_url"],
            json=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg['cline_api_key']}"},
            timeout=60,
        )
    except requests.exceptions.RequestException as e:
        return None, f"API request failed: {e}"
    if not resp.ok:
        return None, f"API HTTP {resp.status_code}: {resp.text[:300]}"
    try:
        data = resp.json()
    except ValueError:
        return None, f"API returned non-JSON: {resp.text[:300]}"
    if isinstance(data, dict) and "data" in data and "choices" not in data:
        data = data["data"]
    choices = data.get("choices") if isinstance(data, dict) else None
    if not choices:
        return None, f"API response had no choices: {json.dumps(data)[:300]}"
    text = choices[0].get("message", {}).get("content")
    if _looks_like_refusal(text):
        return None, "Model reply looked like it did not actually see the image"
    return text, None


def _analyze_with_ollama(image_b64, prompt, cfg):
    payload = {
        "model": cfg["ollama_model"],
        "prompt": prompt,
        "images": [image_b64],
        "stream": False,
    }
    try:
        resp = requests.post(f"{cfg['ollama_url']}/api/generate", json=payload, timeout=120)
    except requests.exceptions.RequestException as e:
        return None, f"Ollama request failed (is Ollama running on the host? '{cfg['ollama_url']}'): {e}"
    if not resp.ok:
        return None, f"Ollama HTTP {resp.status_code}: {resp.text[:300]}"
    try:
        data = resp.json()
    except ValueError:
        return None, f"Ollama returned non-JSON: {resp.text[:300]}"
    text = data.get("response")
    if _looks_like_refusal(text):
        return None, "Ollama reply was empty"
    return text, None


def _analyze_one_frame(frame_path, prompt, cfg):
    """Analyze one keyframe image, trying the auto/api/ollama backend(s)
    selected by cfg.get("backend", "auto") — same selection logic
    analyze_session used to run inline. Byte-identical (image bytes, prompt)
    pairs are served from tools/vision_cache.py's content-addressed cache
    instead of hitting the vision backend again, so a long run with many
    repeated black-screen keyframes analyzes that frame only once.

    Returns (description, error, backend_used): description is None and
    error is set if every attempted backend failed. backend_used is "cache"
    on a cache hit (the backend that originally produced the cached text
    isn't recorded — same convention as tools/vision_tools.py's cached
    analyze_image, which reports "cached" in that case)."""
    backend = cfg.get("backend", "auto")
    state = {"error": None, "backend_used": None}

    def _compute():
        try:
            with open(frame_path, "rb") as fh:
                image_b64 = base64.b64encode(fh.read()).decode("ascii")
        except OSError as e:
            state["error"] = f"Could not read frame file: {e}"
            return None

        description, error, backend_used = None, None, None
        if backend in ("auto", "api"):
            description, error = _analyze_with_api(image_b64, prompt, cfg)
            if description:
                backend_used = "api"

        if description is None and backend in ("auto", "ollama"):
            description, err2 = _analyze_with_ollama(image_b64, prompt, cfg)
            if description:
                backend_used = "ollama"
            else:
                error = (error + " | " if error else "") + (err2 or "")

        state["error"] = error
        state["backend_used"] = backend_used
        return description

    text, was_cached = cached_vision(frame_path, prompt, _compute)
    if text is not None:
        return text, None, ("cache" if was_cached else state["backend_used"])
    return None, state["error"], None


_DEFAULT_PROMPT = (
    "You are looking at a screenshot from an Android app under test. Describe, in 2-3 "
    "sentences, exactly what is on screen: what screen/page this looks like, whether it's a "
    "blank/black screen, and anything that looks broken (misaligned layout, missing images, "
    "garbled text). IMPORTANT: explicitly call out any system CRASH/ANR dialog — e.g. "
    "'<app> keeps stopping', '<app> isn't responding', 'Unfortunately, <app> has stopped', or "
    "a Close app/Wait dialog — since that is direct visual evidence the app died, distinct from "
    "a merely black screen."
)

# Frames worth spending a vision call on even under the cap: state changes and
# failure states carry the most signal; a long tail of near-duplicate scene
# changes does not.
_PRIORITY_REASONS = {"baseline", "black_transition", "black_exit"}
_DEFAULT_MAX_FRAMES = 40


def _select_frames_for_vision(keyframes, max_frames):
    """Pick which keyframes to describe when there are many, so vision cost stays
    bounded without dropping the informative ones. Always keeps the FIRST and
    LAST frame, every black-screen / crash / state-transition frame, then fills
    the remaining budget with the rest in order. Returns (selected_set_of_ids,
    skipped_count) where ids are (index) of chosen frames."""
    if max_frames is None or max_frames <= 0 or len(keyframes) <= max_frames:
        return {kf["index"] for kf in keyframes}, 0
    chosen = set()
    n = len(keyframes)
    for pos, kf in enumerate(keyframes):
        if (pos == 0 or pos == n - 1 or kf.get("black_screen") or kf.get("crash")
                or kf.get("app_state") in ("crashed", "exited")
                or kf.get("reason") in _PRIORITY_REASONS):
            chosen.add(kf["index"])
    # Fill remaining budget with the earliest not-yet-chosen frames.
    for kf in keyframes:
        if len(chosen) >= max_frames:
            break
        chosen.add(kf["index"])
    return chosen, max(0, n - len(chosen))


def analyze_session(session_dir, cfg):
    """Analyzes every keyframe in session_dir/metadata.json per cfg, writing
    descriptions back into that file. Returns a plain-text summary string."""
    prompt = cfg.get("prompt") or _DEFAULT_PROMPT
    try:
        max_frames = int(cfg.get("max_frames", _DEFAULT_MAX_FRAMES))
    except (TypeError, ValueError):
        max_frames = _DEFAULT_MAX_FRAMES

    meta_path = os.path.join(session_dir, "metadata.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)

    keyframes = meta.get("keyframes", [])
    selected_ids, skipped = _select_frames_for_vision(keyframes, max_frames)

    backend_used_overall = None
    summary_lines = []
    for kf in keyframes:
        # Under the cap, describe only the high-signal frames; the rest keep
        # their metadata (timing, black/crash flags) but get no vision call.
        if kf["index"] not in selected_ids:
            kf["vision_description"] = None
            kf["vision_error"] = "skipped (frame-budget cap; not a state/failure frame)"
            continue
        fpath = os.path.join(session_dir, kf["file"])
        description, error, backend_used = _analyze_one_frame(fpath, prompt, cfg)

        kf["vision_description"] = description
        kf["vision_error"] = None if description else error
        kf["vision_backend"] = backend_used
        if backend_used:
            backend_used_overall = backend_used

        if description:
            summary_lines.append(f"  frame {kf['index']} ({backend_used}): {description[:200]}")
        else:
            summary_lines.append(f"  frame {kf['index']}: FAILED — {error}")

    meta["vision_backend_used"] = backend_used_overall
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    analyzed = sum(1 for kf in meta["keyframes"] if kf.get("vision_description"))
    header = (f"Analyzed {analyzed}/{len(meta['keyframes'])} keyframe(s). "
              f"Backend used: {backend_used_overall or 'NONE (all attempts failed)'}")
    if skipped:
        header += (f" ({skipped} low-signal frame(s) skipped under the {max_frames}-frame "
                   "budget — first/last/black/crash/transition frames are always analyzed).")
    return "\n".join([header] + summary_lines)
