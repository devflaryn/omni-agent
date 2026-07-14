"""Compatibility boundary for OmniDroid observation metadata.

The frozen v1 OmniDroid contract did not have continuous screen observation.
Newer engines add ``capture`` and may grow its JSON over time.  Keep all field
aliases and forward-compatibility handling here so the rest of omni-agent sees
one stable metadata shape and old engines can continue to use the adb fallback.
"""

import json
import os


METADATA_VERSION = 2


def capture_capability(version_payload):
    """Return a normalized capture capability advertised by ``version``.

    Accepted shapes are intentionally liberal.  During rollout some builds used
    ``capabilities.capture``, while a simple command list is enough to advertise
    the core command.  An absent advertisement means "unknown/legacy", not that
    the whole engine is unusable.
    """
    if not isinstance(version_payload, dict):
        return {"supported": False, "command": "capture", "options": set()}

    raw_caps = version_payload.get("capabilities") or version_payload.get("features") or {}
    raw = raw_caps.get("capture") if isinstance(raw_caps, dict) else None
    commands = version_payload.get("commands") or []
    if isinstance(commands, dict):
        commands = list(commands)

    if raw is True or "capture" in commands:
        return {"supported": True, "command": "capture", "options": set()}
    if not isinstance(raw, dict):
        return {"supported": False, "command": "capture", "options": set()}

    options = raw.get("options") or raw.get("flags") or []
    if isinstance(options, dict):
        options = [name for name, enabled in options.items() if enabled]
    options = {str(v).lstrip("-").replace("-", "_") for v in options}
    if raw.get("launch_package") or raw.get("atomic_launch"):
        options.add("launch_package")
    return {
        "supported": raw.get("supported", True) is not False,
        "command": str(raw.get("command") or "capture"),
        "metadata_version": raw.get("metadata_version"),
        "options": options,
    }


def _number(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _integer(value, default=0):
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _safe_file_name(value):
    """Metadata image references are always reduced to an output-dir basename."""
    if not value:
        return None
    return os.path.basename(str(value).replace("\\", "/"))


def normalize_capture_metadata(raw, provider="omnidroid", engine_path=None):
    """Normalize engine/legacy metadata without dropping unknown fields.

    Canonical time is integer monotonic elapsed milliseconds (``t_ms``).  The
    old ``t_seconds`` and new engine ``elapsed_ms`` aliases remain readable.
    ``changed_percent`` is the percentage of sampled pixels whose channel delta
    crossed the configured per-pixel threshold; ``diff_score`` remains the
    legacy mean absolute delta for compatibility and diagnostics.
    """
    meta = dict(raw) if isinstance(raw, dict) else {}
    duration_ms = meta.get("duration_ms")
    if duration_ms is None:
        duration_ms = _integer(_number(meta.get("duration_seconds")) * 1000)
    meta["metadata_version"] = max(_integer(meta.get("metadata_version"), 1), METADATA_VERSION)
    meta["duration_ms"] = _integer(duration_ms)
    meta["duration_seconds"] = round(meta["duration_ms"] / 1000.0, 3)
    meta["capture_provider"] = meta.get("capture_provider") or provider
    if engine_path:
        meta["capture_engine"] = os.path.abspath(engine_path)
    meta.setdefault("clock", "monotonic")
    meta.setdefault("timestamp_precision", "milliseconds")
    meta.setdefault("events", [])
    meta.setdefault("crashes", [])
    meta.setdefault("crash_detected", bool(meta.get("crashes")))
    meta.setdefault("exit_detected", False)
    meta.setdefault("app_state", "unknown")

    frames = []
    previous_t = None
    for fallback_index, source in enumerate(meta.get("keyframes") or []):
        if not isinstance(source, dict):
            continue
        frame = dict(source)
        t_ms = frame.get("t_ms")
        if t_ms is None:
            t_ms = frame.get("elapsed_ms")
        if t_ms is None:
            t_ms = _number(frame.get("t_seconds")) * 1000
        t_ms = max(0, _integer(t_ms))
        delta_ms = frame.get("delta_ms")
        if delta_ms is None:
            delta_ms = 0 if previous_t is None else max(0, t_ms - previous_t)
        changed = frame.get("changed_percent")
        if changed is None:
            changed = frame.get("change_percent")
        file_name = _safe_file_name(frame.get("file") or frame.get("path"))

        frame.update({
            "index": _integer(frame.get("index"), fallback_index),
            "file": file_name,
            "t_ms": t_ms,
            "elapsed_ms": t_ms,
            "t_seconds": round(t_ms / 1000.0, 3),
            "delta_ms": max(0, _integer(delta_ms)),
            "changed_percent": round(_number(changed), 3),
            "diff_score": round(_number(frame.get("diff_score")), 3),
            "mean_brightness": round(_number(frame.get("mean_brightness")), 2),
            "black_screen": bool(frame.get("black_screen")),
            "reason": str(frame.get("reason") or ("baseline" if not frames else "scene_change")),
            "app_state": str(frame.get("app_state") or "unknown"),
            "pid": frame.get("pid"),
            "crash": bool(frame.get("crash")),
        })
        frames.append(frame)
        previous_t = t_ms

    frames.sort(key=lambda item: (item["t_ms"], item["index"]))
    for index, frame in enumerate(frames):
        frame["index"] = index
        if index == 0:
            frame["delta_ms"] = 0
        elif not frame.get("delta_ms"):
            frame["delta_ms"] = max(0, frame["t_ms"] - frames[index - 1]["t_ms"])
    meta["keyframes"] = frames
    meta["keyframe_count"] = _integer(meta.get("keyframe_count"), len(frames))
    meta["samples_taken"] = _integer(
        meta.get("samples_taken", meta.get("updates_seen", len(frames))), len(frames)
    )
    return meta


def _inside(path, directory):
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(directory)]) == os.path.abspath(directory)
    except (ValueError, OSError):
        return False


def load_capture_result(output_dir, payload, provider="omnidroid", engine_path=None):
    """Load capture metadata from the known output dir and merge command JSON.

    Engine-returned paths are only followed when they stay inside ``output_dir``;
    the local engine is trusted, but report generation should never become an
    arbitrary-file reader because a malformed payload named another path.
    """
    payload = dict(payload) if isinstance(payload, dict) else {}
    expected = os.path.join(output_dir, "metadata.json")
    candidates = [expected]
    returned = payload.get("metadata_path")
    if returned:
        returned = str(returned)
        if not os.path.isabs(returned):
            returned = os.path.join(output_dir, returned)
        if _inside(returned, output_dir) and returned not in candidates:
            candidates.append(returned)

    raw = {}
    for candidate in candidates:
        if os.path.isfile(candidate):
            with open(candidate, encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                raw = loaded
                break

    # Command JSON is a useful summary and may be the only metadata on a
    # partially rolled-out engine.  Disk metadata wins for detailed arrays.
    for key, value in payload.items():
        if key not in raw or raw.get(key) in (None, [], ""):
            raw[key] = value
    return normalize_capture_metadata(raw, provider=provider, engine_path=engine_path)


def write_metadata_atomic(path, metadata):
    """Write JSON atomically so a stopped capture never leaves half a document."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp, path)


def summarize_capture(metadata):
    frames = metadata.get("keyframes") or []
    provider = metadata.get("capture_provider", "unknown")
    lines = [
        f"Capture provider: {provider}",
        f"Observed {metadata.get('samples_taken', 0)} display update/sample(s); "
        f"kept {len(frames)} keyframe(s) over {metadata.get('duration_ms', 0)} ms.",
        f"App state: {metadata.get('app_state', 'unknown')}; "
        f"crash_detected={bool(metadata.get('crash_detected'))}; "
        f"exit_detected={bool(metadata.get('exit_detected'))}.",
    ]
    if metadata.get("capture_engine"):
        lines.append(f"Capture engine: {metadata['capture_engine']}")
    for frame in frames:
        flags = []
        if frame.get("black_screen"):
            flags.append("BLACK")
        if frame.get("crash"):
            flags.append("CRASH")
        flag_text = f" [{'|'.join(flags)}]" if flags else ""
        lines.append(
            f"  frame {frame['index']}: t={frame['t_ms']}ms (+{frame['delta_ms']}ms) "
            f"changed={frame['changed_percent']:.2f}% diff={frame['diff_score']:.2f} "
            f"reason={frame['reason']} app={frame.get('app_state', 'unknown')}{flag_text} "
            f"-> {frame.get('file') or '(no file)'}"
        )
    return "\n".join(lines)
