"""Noisy-tool output distillation registry.

A curated set of tools (NOISY_TOOLS) produce large, mostly-irrelevant output
(logcat's flagship case). Their raw output is kept OUT of the main conversation:
the model sees a distilled summary plus a path to the full raw text on disk.

A tool listed in DETERMINISTIC_DISTILLERS is distilled without any LLM call
(logcat reuses the battle-tested crash-extraction helpers). Anything else in
NOISY_TOOLS falls back to a read-only summarizer subagent (see distill()).
"""
import os
import time

from subagents import run_subagent, AgentDef
from tools._emulator_diagnostics import extract_crash_traces, analyze_logcat

NOISY_TOOLS = {"get_logcat"}

# Below this size, distillation isn't worth a file or a subagent — pass through.
_SMALL_OUTPUT_CHARS = 8000
_HEAD_CHARS = 4000  # how much raw head to show when we can only degrade
# Hard cap on the FINAL summary (deterministic or LLM). A distilled summary
# should be a fraction of the small-output threshold above — otherwise a
# misbehaving distiller (or an unbounded LLM report) defeats the whole point
# of keeping noisy output out of context.
_MAX_SUMMARY_CHARS = 6000


def _logcat_distiller(raw_text, tool_args):
    """Distill a raw logcat dump into crash traces + a short event digest, with
    NO LLM call. Returns a summary string, or None to defer to the LLM fallback.

    Real return shapes (verified against tools/_emulator_diagnostics.py):
    - extract_crash_traces(...) -> (blocks: list[str], total_block_count: int).
      Each element of `blocks` is already a raw multi-line trace block string,
      so str(t) works fine per-block, but the top-level return is a 2-tuple,
      NOT a bare list -- must unpack, not iterate directly.
    - analyze_logcat(...) -> dict with keys: events (list[dict]), crashes
      (list[dict]), crash_detected/anr_detected/exit_detected (bool),
      unrelated_event_count (int). str() of this dict technically contains
      the crash text (each event dict has "trace"/"summary" substrings) but
      is a sprawling Python-repr with duplicated full trace blocks, so we
      format the fields explicitly into a compact digest instead.
    """
    if not (raw_text or "").strip():
        return None

    package_name = None
    if isinstance(tool_args, dict):
        package_name = tool_args.get("package_name") or tool_args.get("package")

    parts = []

    try:
        traces, total_blocks = extract_crash_traces(raw_text, package_name=package_name)
    except Exception:
        traces, total_blocks = [], 0
    if traces:
        parts.append(f"CRASHES/ANRs ({len(traces)} shown of {total_blocks} detected):")
        for trace in traces:
            parts.append(str(trace).strip())

    try:
        analysis = analyze_logcat(raw_text, package_name=package_name)
    except Exception:
        analysis = None
    if analysis:
        digest = [
            "EVENT DIGEST: "
            f"crash_detected={analysis.get('crash_detected')} "
            f"anr_detected={analysis.get('anr_detected')} "
            f"exit_detected={analysis.get('exit_detected')} "
            f"unrelated_event_count={analysis.get('unrelated_event_count')}"
        ]
        for event in analysis.get("events") or []:
            digest.append(
                f"  [{event.get('type')}] t_ms={event.get('t_ms')} "
                f"pid={event.get('pid')} pkg={event.get('package')}: "
                f"{event.get('summary')}"
            )
        parts.append("\n".join(digest))

    if not parts:
        # Nothing notable extracted — let the caller decide (fall back / pass through).
        return None
    return "\n".join(parts)


DETERMINISTIC_DISTILLERS = {
    "get_logcat": _logcat_distiller,
}


def _summarizer_agent():
    return AgentDef(
        name="output_summarizer",
        system_prompt=(
            "You are an OUTPUT SUMMARIZER. You are given the raw output of a tool plus the "
            "orchestrator's current goal. Distill the output down to what matters FOR THAT GOAL: "
            "errors, failures, key state, and anything the orchestrator must act on. Drop routine "
            "noise. Be concrete (quote the exact lines that matter). Return just the summary."),
        mode="read", allowed_tools=set(), max_steps=1,
    )


def _extract_raw(result):
    if isinstance(result, dict):
        out = result.get("stdout")
        if out:
            return out if isinstance(out, str) else str(out)
        # stdout-less dict: mirror the main loop's JSON rendering.
        import json
        return json.dumps(result, indent=2, default=str)
    return str(result or "")


def _save_raw(run_dir, tool_name, raw_text):
    """Write raw output to <run_dir>/raw/<tool>-<ts>.txt. Returns the path, or None."""
    try:
        raw_dir = os.path.join(run_dir, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        fname = f"{tool_name}-{int(time.time() * 1000)}.txt"
        path = os.path.join(raw_dir, fname)
        with open(path, "w") as f:
            f.write(raw_text)
        return path
    except Exception:
        return None


def _path_note(path):
    return f"\n\n[full raw output saved to {path} — read it if you need a detail this summary dropped]"


def _cap_summary(summary):
    """Hard-cap a distilled summary so a misbehaving distiller (deterministic or
    LLM) can never flood the conversation the way the raw output would have."""
    if len(summary) <= _MAX_SUMMARY_CHARS:
        return summary
    truncated = len(summary) - _MAX_SUMMARY_CHARS
    return (
        summary[:_MAX_SUMMARY_CHARS]
        + f"\n… [+{truncated} chars of summary truncated — full raw at the path below]"
    )


def distill(tool_name, result, run_dir, task_context):
    """Distill a noisy tool's output: summary into chat, full raw to a file.
    Fail-open — never raises; on any problem returns a usable (head + path) body."""
    raw = _extract_raw(result)
    # Small / empty output: not worth distilling.
    if len(raw) <= _SMALL_OUTPUT_CHARS or not raw.strip():
        return {"stdout": raw}

    path = _save_raw(run_dir, tool_name, raw) if run_dir else None

    summary = None
    distiller = DETERMINISTIC_DISTILLERS.get(tool_name)
    if distiller is not None:
        try:
            summary = distiller(raw, (result.get("args") if isinstance(result, dict) else {}) or {})
        except Exception:
            summary = None
    if summary is None:
        try:
            res = run_subagent(_summarizer_agent(),
                               task="Summarize the tool output below for the current goal.",
                               context=f"GOAL: {task_context}\n\nRAW OUTPUT:\n{raw}",
                               run_dir=run_dir)
            if res.get("ok"):
                summary = (res.get("report") or "").strip() or None
        except Exception:
            summary = None

    if summary is None:
        # Degrade: show the head so nothing critical is silently lost.
        head = raw[:_HEAD_CHARS]
        body = f"(could not distill; showing first {len(head)} of {len(raw)} chars)\n{head}"
        return {"stdout": body + (_path_note(path) if path else "")}

    return {"stdout": _cap_summary(summary) + (_path_note(path) if path else "")}
