"""Byte-identical image vision cache.

Screenshots (especially byte-for-byte black frames) get re-analyzed by the
vision model every time they recur. cached_vision serves an identical image
with the same prompt from the content-addressed cache instead — one vision
call per unique (image bytes, prompt). Fail-open: any cache problem just runs
the real vision call.
"""
from tools import cache as _cache

_CACHE_TOOL = "vision_analyze"


def cached_vision(image_path, prompt, compute_fn):
    """Return (analysis_text, was_cached). Keys on sha256(image_path) + prompt.

    compute_fn() runs the real vision call and returns the analysis text. It is
    called at most once per unique (image bytes, prompt) while caching is on."""
    prompt = prompt or ""
    if _cache.enabled():
        try:
            hit = _cache.lookup(_CACHE_TOOL, image_path, extra=prompt)
        except Exception:
            hit = None
        if hit and isinstance(hit, dict) and hit.get("analysis") is not None:
            return hit["analysis"], True

    text = compute_fn()

    if _cache.enabled() and text is not None:
        try:
            _cache.store(_CACHE_TOOL, image_path, {"analysis": text}, extra=prompt)
        except Exception:
            pass
    return text, False
