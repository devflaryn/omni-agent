"""Noisy-tool output distillation registry.

A curated set of tools (NOISY_TOOLS) produce large, mostly-irrelevant output
(logcat's flagship case). Their raw output is kept OUT of the main conversation:
the model sees a distilled summary plus a path to the full raw text on disk.

A tool listed in DETERMINISTIC_DISTILLERS is distilled without any LLM call
(logcat reuses the battle-tested crash-extraction helpers). Anything else in
NOISY_TOOLS falls back to a read-only summarizer subagent (see distill()).
"""
from tools._emulator_diagnostics import extract_crash_traces, analyze_logcat

NOISY_TOOLS = {"get_logcat"}


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
