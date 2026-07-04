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
  2. Local Ollama at http://localhost:11434 (both the agent and the emulator
     run on the same Windows host now, so no host.docker.internal indirection
     is needed) — works with any vision model the user has pulled (llava,
     moondream, qwen2.5vl, bakllava, ...).
If both fail, each frame is left with vision_description=None and an error
note, so generate_test_report can still produce a report from brightness/diff
data and logcat alone.
"""
import base64
import json
import os

import requests

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


_DEFAULT_PROMPT = (
    "You are looking at a screenshot from an Android app under test. Describe, in 2-3 "
    "sentences, exactly what is on screen: what screen/page this looks like, any visible "
    "error dialogs or crash messages, whether it's a blank/black screen, and anything that "
    "looks broken (misaligned layout, missing images, garbled text)."
)


def analyze_session(session_dir, cfg):
    """Analyzes every keyframe in session_dir/metadata.json per cfg, writing
    descriptions back into that file. Returns a plain-text summary string."""
    backend = cfg.get("backend", "auto")
    prompt = cfg.get("prompt") or _DEFAULT_PROMPT

    meta_path = os.path.join(session_dir, "metadata.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)

    backend_used_overall = None
    summary_lines = []
    for kf in meta.get("keyframes", []):
        fpath = os.path.join(session_dir, kf["file"])
        try:
            with open(fpath, "rb") as f:
                image_b64 = base64.b64encode(f.read()).decode("ascii")
        except OSError as e:
            kf["vision_description"] = None
            kf["vision_error"] = f"Could not read frame file: {e}"
            summary_lines.append(f"  frame {kf['index']}: FAILED — {kf['vision_error']}")
            continue

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
    header = f"Analyzed {analyzed}/{len(meta['keyframes'])} keyframe(s). Backend used: {backend_used_overall or 'NONE (all attempts failed)'}"
    return "\n".join([header] + summary_lines)
