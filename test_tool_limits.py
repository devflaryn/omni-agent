"""Tests the fix for the 'tool limit reached' problem that killed hard/long jobs.

Before the fix, agent.py hard-aborted after 20 consecutive tool calls, fired a
'SYSTEM GUARD' warning every loop iteration past 15 (context pollution), and
blocked a single identical tool retry as a loop. The fix: one-time soft nudge
at SOFT_TOOL_NUDGE, summarization+reset instead of abort at MAX_CONSECUTIVE_TOOLS,
and LOOP_REPEAT_THRESHOLD identical calls in a row before flagging a loop.

Run: python test_tool_limits.py
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import agent
from agent import (execute_tool, LOOP_REPEAT_THRESHOLD, SOFT_TOOL_NUDGE,
                   MAX_CONSECUTIVE_TOOLS, MAX_SUMMARY_RESETS)
from tool_registry import registry


def _dummy_echo(value="x"):
    return {"stdout": f"echo:{value}"}


registry.register("dummy_echo", "Test-only echo tool (no Docker).",
                  {"value": {"type": "string"}})(_dummy_echo)


def maintain_last_call(prev, tool_name, args, is_loop_warning):
    """Replica of the last_tool_call maintenance in AgentApp.run_agent_loop."""
    same = (isinstance(prev, dict) and prev.get("tool") == tool_name
            and prev.get("args", {}) == args)
    if is_loop_warning:
        if isinstance(prev, dict):
            nd = dict(prev); nd["repeats"] = prev.get("repeats", 1) + 1; return nd
        return {"tool": tool_name, "args": args, "repeats": 2}
    if same:
        return {"tool": tool_name, "args": args, "repeats": prev.get("repeats", 1) + 1}
    return {"tool": tool_name, "args": args, "repeats": 1}


def call_once(prev, tool_name, args, threshold=LOOP_REPEAT_THRESHOLD):
    payload = {"tool": tool_name, "args": args}
    feedback = execute_tool(payload, prev, threshold)
    warned = feedback.startswith("[SYSTEM WARNING]")
    return feedback, maintain_last_call(prev, tool_name, args, warned), warned


def test_constants():
    assert LOOP_REPEAT_THRESHOLD == 3
    assert SOFT_TOOL_NUDGE == 30
    assert MAX_CONSECUTIVE_TOOLS == 60
    assert MAX_SUMMARY_RESETS == 8
    src = open(agent.__file__, "r", encoding="utf-8").read()
    assert "Agent ignored warning. Aborting." not in src
    assert "consecutive_tools >= 15" not in src
    assert "consecutive_tools >= 20" not in src
    print("OK: new budget constants present; old kill-switches removed.")
    return True


def test_single_retry_is_allowed():
    args = {"value": "a"}
    fb1, prev1, w1 = call_once(None, "dummy_echo", args)
    assert not w1 and "echo:a" in fb1
    fb2, prev2, w2 = call_once(prev1, "dummy_echo", args)
    assert not w2 and "echo:a" in fb2, "a single retry must still execute"
    assert prev2["repeats"] == 2
    print("OK: a single identical retry executes (legitimate retry allowed).")
    return True


def test_loop_guard_trips_at_threshold():
    args = {"value": "a"}
    _, p1, _ = call_once(None, "dummy_echo", args)
    _, p2, _ = call_once(p1, "dummy_echo", args)
    fb3, p3, w3 = call_once(p2, "dummy_echo", args)
    assert w3 and fb3.startswith("[SYSTEM WARNING]")
    assert "echo:a" not in fb3, "guarded call must NOT execute"
    assert "3 times in a row" in fb3
    assert p3["repeats"] == 3
    _, p4, w4 = call_once(p3, "dummy_echo", args)
    assert w4 and p4["repeats"] == 4
    print("OK: loop guard trips on the 3rd identical call and blocks execution.")
    return True


def test_counter_resets_on_different_call():
    a, b = {"value": "a"}, {"value": "b"}
    _, p1, _ = call_once(None, "dummy_echo", a)
    _, p2, _ = call_once(p1, "dummy_echo", a)
    _, p3, _ = call_once(p2, "dummy_echo", a)  # trips at 3
    fb_b, pb, wb = call_once(p3, "dummy_echo", b)
    assert not wb and "echo:b" in fb_b
    assert pb["repeats"] == 1, "different call resets counter"
    fb_b2, pb2, wb2 = call_once(pb, "dummy_echo", b)
    assert not wb2 and "echo:b" in fb_b2
    _, _, wb3 = call_once(pb2, "dummy_echo", b)
    assert wb3, "3rd identical of new call trips the guard"
    print("OK: switching tools resets the repeat counter.")
    return True


def test_threshold_is_configurable():
    args = {"value": "z"}
    fb1, p1, w1 = call_once(None, "dummy_echo", args, threshold=2)
    assert not w1
    fb2, _, w2 = call_once(p1, "dummy_echo", args, threshold=2)
    assert w2 and "2 times in a row" in fb2
    print("OK: loop threshold is configurable (per-profile override works).")
    return True


def test_full_import():
    import importlib
    importlib.reload(agent)
    print("OK: agent.py imports cleanly after the fix.")
    return True


def main():
    tests = [test_constants, test_single_retry_is_allowed,
             test_loop_guard_trips_at_threshold, test_counter_resets_on_different_call,
             test_threshold_is_configurable, test_full_import]
    ok = True
    for t in tests:
        print(f"\n=== {t.__name__} ===")
        try:
            ok &= bool(t())
        except AssertionError as e:
            print(f"FAIL: {e}"); ok = False
        except Exception as e:
            print(f"ERROR: {type(e).__name__}: {e}"); ok = False
    print("\n" + ("ALL PASSED" if ok else "FAILED"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
