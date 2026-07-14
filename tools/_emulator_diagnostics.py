"""Compact Android process/log diagnostics for emulator observations.

Visual state and application state are deliberately independent: a black frame
is only a visual fact.  A crash requires process-lifecycle or logcat evidence.
This module turns noisy ``logcat -b all -v epoch`` output plus pid polling into
small, timestamp-correlated events that a text-only agent can reason about.
"""

import re


_EPOCH_RE = re.compile(r"^\s*(\d{9,}(?:\.\d{1,9})?)\s+")
_PID_RE = re.compile(r"\b(?:pid[=: ]+|PID:\s*)(\d+)\b", re.IGNORECASE)
_JAVA_CRASH_RE = re.compile(r"FATAL EXCEPTION|AndroidRuntime.*FATAL", re.IGNORECASE)
_NATIVE_CRASH_RE = re.compile(
    r"Fatal signal|signal\s+\d+\s+\(SIG|beginning of crash|Abort message:|FORTIFY|CheckJNI",
    re.IGNORECASE,
)
_ANR_RE = re.compile(r"\bANR in\b|\bam_anr\b|Application Not Responding", re.IGNORECASE)
_LMK_RE = re.compile(r"lowmemorykiller|\blmkd\b.*\bkill|Killing\s+\S+.*\badj\b.*to free", re.IGNORECASE)
_EXIT_RE = re.compile(
    r"\bam_proc_died\b|Process\s+\S+\s+\(pid\s+\d+\)\s+has died|"
    r"ProcessRecord\{.*\}\s+has died|process.*gone",
    re.IGNORECASE,
)
_TRACE_LINE_RE = re.compile(
    r"FATAL EXCEPTION|Fatal signal|signal\s+\d+\s+\(SIG|ANR in|am_anr|"
    r"\bat\s+\S+\.|Caused by:|Suppressed:|\.\.\.\s+\d+\s+more|"
    r"#\d{2}\s+pc|backtrace:|Abort message:|Cmdline:|Process:|"
    r"AndroidRuntime|\bDEBUG\b|\blibc\b|tombstoned|crash_dump|"
    r"am_proc_died|has died|lowmemorykiller|\blmkd\b",
    re.IGNORECASE,
)
_PACKAGE_PATTERNS = (
    re.compile(r"\bProcess:\s*([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)"),
    re.compile(r"\bCmdline:\s*([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)"),
    re.compile(r"\bANR in\s+([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)"),
    re.compile(r"\bProcess\s+([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)\s+\(pid"),
    re.compile(r"\bKilling\s+([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)\b"),
    # Native tombstone markers: ">>> com.example <<<" and "name: com.example",
    # plus the libc abort line "... in tid 2000 (com.example)". Without these a
    # native SIGSEGV in the app's own .so could not be attributed to the package
    # and would be dropped by package-scoped analysis.
    re.compile(r">>>\s*([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)\s*<<<"),
    re.compile(r"\bname:\s*([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)\s*>>>"),
    re.compile(r"\bin tid\s+\d+\s+\(([A-Za-z0-9_.]+(?::[A-Za-z0-9_.-]+)?)\)"),
    re.compile(r"\b([A-Za-z0-9_.]+)/(?:[A-Za-z0-9_.$]+)"),
)


def _epoch_ms(line):
    match = _EPOCH_RE.match(line or "")
    if not match:
        return None
    try:
        return int(round(float(match.group(1)) * 1000.0))
    except (TypeError, ValueError):
        return None


def _packages(text):
    found = []
    for pattern in _PACKAGE_PATTERNS:
        for package in pattern.findall(text or ""):
            if package not in found:
                found.append(package)
    return found


def _package_matches(process_name, package_name):
    if not package_name:
        return True
    return process_name == package_name or process_name.startswith(package_name + ":")


def _event_kind(line):
    if _JAVA_CRASH_RE.search(line):
        return "java_crash"
    if _NATIVE_CRASH_RE.search(line):
        return "native_crash"
    if _ANR_RE.search(line):
        return "anr"
    if _LMK_RE.search(line):
        return "low_memory_kill"
    if _EXIT_RE.search(line):
        return "process_exit"
    return None


# Tombstone header lines that identify the crashing process. In a native crash
# these sit ABOVE the `signal` anchor line, so a forward-only block misses them.
_TOMBSTONE_ID_RE = re.compile(
    r">>>|(?:^|\s)name:\s|(?:^|\s)pid:\s|Cmdline:|ABI:|Build fingerprint|\*\*\* \*\*\*",
    re.IGNORECASE)


def _lookback_identity(lines, index, back=12):
    """Preceding tombstone-header lines (>>> pkg <<<, name:, Cmdline:, ...) so a
    native crash can be attributed to its package. Empty for non-tombstones."""
    start = max(0, index - back)
    return [l for l in lines[start:index] if _TOMBSTONE_ID_RE.search(l)]


def _collect_block(lines, index, limit=80):
    """Collect a bounded crash block without swallowing the rest of logcat."""
    block = [lines[index]]
    misses = 0
    for line in lines[index + 1:index + limit]:
        # A new anchor starts a new event; don't merge two crashes together.
        if _event_kind(line) and len(block) > 1:
            break
        if _TRACE_LINE_RE.search(line):
            misses = 0
            block.append(line)
            continue
        misses += 1
        if misses > 2:
            break
        block.append(line)
    return "\n".join(block).rstrip()


def analyze_logcat(text, package_name=None, start_epoch_ms=None, known_pids=None, max_events=20):
    """Extract target-app crashes, ANRs, exits, and memory kills from logcat.

    ``related`` is conservative when a package was supplied: an event must name
    that package (or a pid observed for it).  This prevents a system/other-app
    crash from turning a visually black target screen into a false crash claim.
    """
    lines = (text or "").splitlines()
    known_pids = {str(pid) for pid in (known_pids or []) if pid not in (None, "")}
    events = []
    for index, line in enumerate(lines):
        kind = _event_kind(line)
        if not kind:
            continue
        block = _collect_block(lines, index)
        # A native tombstone names its process ABOVE the signal anchor; fold that
        # identity in so the crash can be attributed to (or excluded from) a package.
        ident_block = block
        if kind == "native_crash":
            ident = _lookback_identity(lines, index)
            if ident:
                ident_block = "\n".join(ident) + "\n" + block
        packages = _packages(ident_block)
        pid_match = _PID_RE.search(block)
        pid = pid_match.group(1) if pid_match else None
        if package_name:
            explicitly_related = any(_package_matches(pkg, package_name) for pkg in packages)
            pid_related = bool(pid and pid in known_pids)
            related = explicitly_related or pid_related
        else:
            related = True
        epoch_ms = _epoch_ms(line)
        t_ms = None
        if epoch_ms is not None and start_epoch_ms is not None:
            t_ms = max(0, epoch_ms - int(start_epoch_ms))
        summary_line = re.sub(r"\s+", " ", line).strip()
        events.append({
            "type": kind,
            "t_ms": t_ms,
            "epoch_ms": epoch_ms,
            "package": next((p for p in packages if _package_matches(p, package_name)),
                            packages[0] if packages else package_name),
            "pid": int(pid) if pid and pid.isdigit() else None,
            "related": related,
            "summary": summary_line[-500:],
            "trace": block[-12000:],
        })

    # Repeated logcat tags can describe the same crash.  Deduplicate on kind,
    # timestamp, pid, and first summary while retaining chronological order.
    unique = []
    seen = set()
    for event in events:
        key = (event["type"], event.get("epoch_ms"), event.get("pid"), event["summary"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(event)
    related = [event for event in unique if event.get("related")][-max_events:]
    crash_types = {"java_crash", "native_crash"}
    return {
        "events": related,
        "crashes": [event for event in related if event["type"] in crash_types],
        "crash_detected": any(event["type"] in crash_types for event in related),
        "anr_detected": any(event["type"] == "anr" for event in related),
        "exit_detected": any(event["type"] in {"process_exit", "low_memory_kill"} for event in related),
        "unrelated_event_count": len(unique) - len(related),
    }


def extract_crash_traces(text, max_traces=5, package_name=None):
    """Compatibility wrapper used by ``monitor_logcat``."""
    analysis = analyze_logcat(text, package_name=package_name, max_events=max(1, max_traces * 3))
    blocks = [event["trace"] for event in analysis["events"]
              if event["type"] in {"java_crash", "native_crash", "anr"}]
    return blocks[-max_traces:], len(blocks)


def parse_pid_output(text):
    """Return the first numeric pid from Android's ``pidof`` output."""
    for token in re.findall(r"\b\d+\b", text or ""):
        try:
            return int(token)
        except ValueError:
            pass
    return None


def merge_diagnostics(metadata, process_events, log_analysis, package_name=None):
    """Merge lifecycle/log evidence and annotate every keyframe's app state."""
    meta = dict(metadata or {})
    timeline = [dict(event) for event in (process_events or []) if isinstance(event, dict)]
    for event in log_analysis.get("events", []):
        kind = event.get("type")
        if kind in {"java_crash", "native_crash"}:
            event_type = "app_crashed"
        elif kind == "anr":
            event_type = "anr"
        elif kind == "low_memory_kill":
            event_type = "app_killed"
        else:
            event_type = "app_exit_log"
        item = {
            "type": event_type,
            "t_ms": event.get("t_ms"),
            "pid": event.get("pid"),
            "summary": event.get("summary"),
            "log_type": kind,
        }
        timeline.append(item)

    # Unknown log times sort last, preserving their evidence without pretending
    # to know when they happened relative to millisecond display updates.
    timeline.sort(key=lambda event: (
        event.get("t_ms") is None,
        event.get("t_ms") if event.get("t_ms") is not None else 10**18,
    ))

    state = "not_started" if package_name else "unknown"
    pid = None
    first_pid = None
    saw_started = False
    crash_seen = False

    def apply(event, current_state, current_pid):
        nonlocal first_pid, saw_started, crash_seen
        kind = event.get("type")
        event_pid = event.get("pid")
        if kind in {"app_started", "app_restarted"}:
            saw_started = True
            if first_pid is None and event_pid:
                first_pid = event_pid
            return "running", event_pid or current_pid
        if kind == "app_crashed":
            crash_seen = True
            return "crashed", None
        if kind in {"app_exited", "app_killed"}:
            return ("exited" if saw_started else current_state), None
        return current_state, current_pid

    cursor = 0
    frames = sorted((meta.get("keyframes") or []), key=lambda frame: frame.get("t_ms", 0))
    for frame in frames:
        frame_t = frame.get("t_ms", 0)
        while cursor < len(timeline):
            event_t = timeline[cursor].get("t_ms")
            if event_t is None or event_t > frame_t:
                break
            state, pid = apply(timeline[cursor], state, pid)
            cursor += 1
        frame.setdefault("app_state", state)
        if frame.get("app_state") == "unknown" or frame.get("app_state") is None:
            frame["app_state"] = state
        frame.setdefault("pid", pid)
        if frame.get("pid") is None:
            frame["pid"] = pid
        frame["crash"] = bool(frame.get("crash") or state == "crashed")

    while cursor < len(timeline):
        state, pid = apply(timeline[cursor], state, pid)
        cursor += 1

    # A process may restart after a crash.  Keep final state truthful while the
    # independent crash_detected flag preserves the failure evidence.
    last_pid = pid
    meta["events"] = timeline
    meta["crashes"] = log_analysis.get("crashes", [])
    meta["crash_detected"] = bool(meta.get("crash_detected") or crash_seen
                                  or log_analysis.get("crash_detected"))
    meta["anr_detected"] = bool(meta.get("anr_detected") or log_analysis.get("anr_detected"))
    meta["exit_detected"] = bool(meta.get("exit_detected")
                                 or log_analysis.get("exit_detected")
                                 or any(e.get("type") in {"app_exited", "app_killed"} for e in timeline))
    meta["app_state"] = state
    meta["first_pid"] = meta.get("first_pid") or first_pid
    meta["last_pid"] = meta.get("last_pid") or last_pid
    meta["package"] = meta.get("package") or package_name
    meta["unrelated_log_event_count"] = log_analysis.get("unrelated_event_count", 0)
    return meta
