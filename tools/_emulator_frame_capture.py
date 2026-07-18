"""Host-side (Windows) frame-capture algorithm — imported directly by
tools/android_emulator.py, NOT shipped into any sandbox. The emulator runs
natively on Windows, so this samples it via the host's adb.exe directly.

Screenshots come from `adb exec-out screencap -p`, which reads the emulated
device's own framebuffer over the ADB protocol (the same mechanism used to
screenshot a real phone). This is deliberately NOT a desktop/window capture
API (no BitBlt/PrintWindow/mss on the emulator's Qt window) — screencap works
identically whether the emulator's window is focused, occluded, or MINIMIZED,
because it never looks at the host window at all.

Fallback algorithm: each sampled frame is downscaled, then compared against
the LAST KEPT keyframe (not the immediately preceding raw sample).
Comparing to the last kept frame is what makes a small looping animation
invisible here (it never drifts far from the frame that was last saved) while
a real transition (which changes a configurable percentage of pixels) crosses
the threshold immediately.  RGB changed-area catches equal-luminance colour
changes and localized dialogs better than one global grayscale average.  A
black frame is a visual observation only; process/logcat diagnostics decide
whether the app actually crashed.

New OmniDroid engines capture every VNC/display update directly.  This module
remains the compatibility path for a v1 engine and cannot promise display-rate
coverage because one adb screencap is a round trip.  It still timestamps every
sample using monotonic nanoseconds and stores integer millisecond timing.
"""
import io
import json
import os
import subprocess
import time

from PIL import Image, ImageChops, ImageStat

from tools._emulator_capture_contract import normalize_capture_metadata, write_metadata_atomic


def _screencap_png_bytes(adb_path, serial=None):
    cmd = [adb_path]
    if serial:
        cmd += ["-s", serial]
    cmd += ["exec-out", "screencap", "-p"]
    proc = subprocess.run(cmd, capture_output=True, timeout=20)
    return proc.stdout


def _downsample(png_bytes, scale_w):
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = img.size
    if w == 0:
        raise ValueError("Captured frame has zero width")
    scale_h = max(1, int(h * (scale_w / w)))
    return img.resize((scale_w, scale_h))


def _frame_metrics(img_a, img_b, pixel_threshold=24):
    """Return (mean channel delta, changed-pixel percentage).

    A pixel counts as changed when ANY RGB channel crosses ``pixel_threshold``.
    This keeps a tiny spinner below the scene threshold while detecting menus,
    error dialogs, and colour-only transitions that grayscale can miss.
    """
    diff = ImageChops.difference(img_a, img_b)
    means = ImageStat.Stat(diff).mean
    mean_abs = sum(means) / max(1, len(means))
    pixels = list(diff.getdata())
    changed = sum(1 for pixel in pixels if max(pixel) >= pixel_threshold)
    changed_percent = (changed * 100.0 / len(pixels)) if pixels else 0.0
    return mean_abs, changed_percent


def _mean_brightness(img):
    # ITU-R BT.601 luma conversion, used only to label visually black frames.
    return ImageStat.Stat(img.convert("L")).mean[0]


def capture_keyframes(adb_path, output_dir, duration_seconds, interval_seconds,
                       change_threshold, black_threshold, sample_scale_w, serial=None,
                       change_percent=2.0, pixel_threshold=24, max_keyframes=120,
                       start_monotonic_ns=None, start_epoch_ms=None):
    """Runs the sample/diff/keep loop for duration_seconds and writes keyframe
    PNGs + metadata.json into output_dir (a real host directory).

    Returns a plain-text summary string (what the tool call should return).
    """
    os.makedirs(output_dir, exist_ok=True)

    keyframes = []
    last_kept_small = None
    last_was_black = False
    start = start_monotonic_ns if start_monotonic_ns is not None else time.monotonic_ns()
    start_epoch_ms = start_epoch_ms if start_epoch_ms is not None else time.time_ns() // 1_000_000
    duration_ns = max(0, int(float(duration_seconds) * 1_000_000_000))
    interval_ns = max(1_000_000, int(float(interval_seconds) * 1_000_000_000))
    next_sample_ns = start
    index = 0
    sample_count = 0
    warnings = []

    last_kept_t_ms = None
    last_observed = None
    while time.monotonic_ns() - start < duration_ns:
        capture_started = time.monotonic_ns()
        try:
            raw = _screencap_png_bytes(adb_path, serial)
            if not raw:
                warnings.append("screencap returned no bytes")
                next_sample_ns += interval_ns
                time.sleep(max(0, next_sample_ns - time.monotonic_ns()) / 1_000_000_000)
                continue
            small = _downsample(raw, sample_scale_w)
        except Exception as e:
            t_ms = max(0, (time.monotonic_ns() - start) // 1_000_000)
            warnings.append(f"capture failed at t={t_ms}ms: {e}")
            next_sample_ns += interval_ns
            time.sleep(max(0, next_sample_ns - time.monotonic_ns()) / 1_000_000_000)
            continue

        capture_finished = time.monotonic_ns()
        # adb cannot tell us the exact guest scanout instant.  The midpoint of
        # the bounded call is a less biased estimate than completion time.
        observed_ns = capture_started + (capture_finished - capture_started) // 2
        t_ms = max(0, int(round((observed_ns - start) / 1_000_000)))
        capture_latency_ms = round((capture_finished - capture_started) / 1_000_000, 3)

        sample_count += 1
        last_observed = small
        brightness = _mean_brightness(small)
        is_black = brightness < black_threshold

        keep = False
        reason = None
        diff_score = 0.0
        changed_percent = 0.0
        if last_kept_small is None:
            keep = True  # always keep the first frame as the baseline
            reason = "baseline"
        else:
            diff_score, changed_percent = _frame_metrics(
                small, last_kept_small, pixel_threshold=pixel_threshold
            )
            if changed_percent >= change_percent:
                keep = True
                reason = "scene_change"
            elif diff_score >= change_threshold:
                # Keep the original threshold as a compatibility/sensitivity
                # backstop for callers that explicitly tuned it.
                keep = True
                reason = "mean_diff"
            elif is_black and not last_was_black:
                keep = True
                reason = "black_transition"
            elif not is_black and last_was_black:
                keep = True
                reason = "black_exit"

        if keep and len(keyframes) < max_keyframes:
            fname = f"frame_{index}_{t_ms}ms.png"
            with open(os.path.join(output_dir, fname), "wb") as f:
                f.write(raw)
            keyframes.append({
                "index": index,
                "t_ms": t_ms,
                "elapsed_ms": t_ms,
                "t_seconds": round(t_ms / 1000.0, 3),
                "delta_ms": 0 if last_kept_t_ms is None else max(0, t_ms - last_kept_t_ms),
                "file": fname,
                "diff_score": round(diff_score, 3),
                "changed_percent": round(changed_percent, 3),
                "mean_brightness": round(brightness, 2),
                "black_screen": is_black,
                "reason": reason or "scene_change",
                "capture_latency_ms": capture_latency_ms,
                "app_state": "unknown",
                "pid": None,
                "crash": False,
            })
            last_kept_small = small
            last_was_black = is_black
            last_kept_t_ms = t_ms
            index += 1
        elif keep and len(keyframes) >= max_keyframes:
            if not any("max_keyframes" in warning for warning in warnings):
                warnings.append(
                    f"max_keyframes={max_keyframes} reached; later scene changes were counted but not saved"
                )

        next_sample_ns += interval_ns
        time.sleep(max(0, next_sample_ns - time.monotonic_ns()) / 1_000_000_000)

    meta_path = os.path.join(output_dir, "metadata.json")
    metadata = normalize_capture_metadata({
        "metadata_version": 2,
        "duration_ms": int(round(float(duration_seconds) * 1000)),
        "interval_ms": int(round(float(interval_seconds) * 1000)),
        "interval_seconds": interval_seconds,
        "change_threshold": change_threshold,
        "change_percent": change_percent,
        "pixel_threshold": pixel_threshold,
        "black_threshold": black_threshold,
        "samples_taken": sample_count,
        "keyframe_count": len(keyframes),
        "keyframes": keyframes,
        "capture_provider": "adb_fallback",
        "capture_engine": None,
        "clock": "monotonic",
        "timestamp_precision": "milliseconds",
        "coverage": "adb_polling",
        "start_epoch_ms": int(start_epoch_ms),
        "warnings": warnings,
    }, provider="adb_fallback")
    write_metadata_atomic(meta_path, metadata)

    lines = [
        f"ADB fallback captured {sample_count} sample(s), kept {len(keyframes)} keyframe(s) "
        f"over {int(round(float(duration_seconds) * 1000))}ms.",
        "Timing uses monotonic milliseconds; coverage is adb polling, not every display update.",
    ]
    for kf in keyframes:
        flag = " [BLACK SCREEN]" if kf["black_screen"] else ""
        lines.append(
            f"  frame {kf['index']}: t={kf['t_ms']}ms (+{kf['delta_ms']}ms) "
            f"changed={kf['changed_percent']:.2f}% diff={kf['diff_score']:.2f} "
            f"reason={kf['reason']}{flag} -> {kf['file']}"
        )
    for w in warnings:
        lines.append(f"  WARNING: {w}")
    lines.append(f"Metadata written to {meta_path}")
    return "\n".join(lines)
