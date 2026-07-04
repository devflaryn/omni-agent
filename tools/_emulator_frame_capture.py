"""Host-side (Windows) frame-capture algorithm — imported directly by
tools/android_emulator.py, NOT shipped into any sandbox. The emulator runs
natively on Windows, so this samples it via the host's adb.exe directly.

Screenshots come from `adb exec-out screencap -p`, which reads the emulated
device's own framebuffer over the ADB protocol (the same mechanism used to
screenshot a real phone). This is deliberately NOT a desktop/window capture
API (no BitBlt/PrintWindow/mss on the emulator's Qt window) — screencap works
identically whether the emulator's window is focused, occluded, or MINIMIZED,
because it never looks at the host window at all.

Algorithm: each sampled frame is downscaled + grayscaled, then compared
against the LAST KEPT keyframe (not the immediately preceding raw sample).
Comparing to the last kept frame is what makes a small looping animation
invisible here (it never drifts far from the frame that was last saved) while
a real transition (which changes most of the screen) crosses the threshold
immediately. A frame whose average brightness drops below black_threshold is
always flagged, since a crash-to-black-screen transition should be visible
even when the raw diff from a moderately dark previous frame is modest.
"""
import io
import json
import os
import subprocess
import time

from PIL import Image, ImageChops, ImageStat


def _screencap_png_bytes(adb_path, serial=None):
    cmd = [adb_path]
    if serial:
        cmd += ["-s", serial]
    cmd += ["exec-out", "screencap", "-p"]
    proc = subprocess.run(cmd, capture_output=True, timeout=20)
    return proc.stdout


def _downsample_gray(png_bytes, scale_w):
    img = Image.open(io.BytesIO(png_bytes)).convert("L")
    w, h = img.size
    if w == 0:
        raise ValueError("Captured frame has zero width")
    scale_h = max(1, int(h * (scale_w / w)))
    return img.resize((scale_w, scale_h))


def _mean_abs_diff(img_a, img_b):
    return ImageStat.Stat(ImageChops.difference(img_a, img_b)).mean[0]


def _mean_brightness(img):
    return ImageStat.Stat(img).mean[0]


def capture_keyframes(adb_path, output_dir, duration_seconds, interval_seconds,
                       change_threshold, black_threshold, sample_scale_w, serial=None):
    """Runs the sample/diff/keep loop for duration_seconds and writes keyframe
    PNGs + metadata.json into output_dir (a real host directory).

    Returns a plain-text summary string (what the tool call should return).
    """
    os.makedirs(output_dir, exist_ok=True)

    keyframes = []
    last_kept_small = None
    last_was_black = False
    start = time.time()
    index = 0
    sample_count = 0
    warnings = []

    while time.time() - start < duration_seconds:
        t = round(time.time() - start, 2)
        try:
            raw = _screencap_png_bytes(adb_path, serial)
            if not raw:
                time.sleep(interval_seconds)
                continue
            small = _downsample_gray(raw, sample_scale_w)
        except Exception as e:
            warnings.append(f"capture failed at t={t}s: {e}")
            time.sleep(interval_seconds)
            continue

        sample_count += 1
        brightness = _mean_brightness(small)
        is_black = brightness < black_threshold

        keep = False
        diff_score = 0.0
        if last_kept_small is None:
            keep = True  # always keep the first frame as the baseline
        else:
            diff_score = _mean_abs_diff(small, last_kept_small)
            if diff_score >= change_threshold:
                keep = True
            elif is_black and not last_was_black:
                keep = True  # transition INTO a black screen, even if the raw diff was modest

        if keep:
            fname = f"frame_{index}_{t}s.png"
            with open(os.path.join(output_dir, fname), "wb") as f:
                f.write(raw)
            keyframes.append({
                "index": index,
                "t_seconds": t,
                "file": fname,
                "diff_score": round(diff_score, 2),
                "mean_brightness": round(brightness, 2),
                "black_screen": is_black,
            })
            last_kept_small = small
            last_was_black = is_black
            index += 1

        time.sleep(interval_seconds)

    meta_path = os.path.join(output_dir, "metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({
            "duration_seconds": duration_seconds,
            "interval_seconds": interval_seconds,
            "change_threshold": change_threshold,
            "black_threshold": black_threshold,
            "samples_taken": sample_count,
            "keyframes": keyframes,
        }, f, indent=2)

    lines = [f"Captured {sample_count} sample(s), kept {len(keyframes)} keyframe(s) over {duration_seconds}s."]
    for kf in keyframes:
        flag = " [BLACK SCREEN]" if kf["black_screen"] else ""
        lines.append(f"  frame {kf['index']}: t={kf['t_seconds']}s diff={kf['diff_score']}{flag} -> {kf['file']}")
    for w in warnings:
        lines.append(f"  WARNING: {w}")
    lines.append(f"Metadata written to {meta_path}")
    return "\n".join(lines)
