"""The Thinking… line's token figure must be the real size of the MAIN
conversation: provider-reported, monotonic, and free of subagent spend.

Before this, agent.py emitted ctx_tokens — a chars/4 estimate of the *current*
message list, which collapsed every time _maybe_summarize_context replaced the
history. These tests pin the replacement's arithmetic.
"""
import agent as agent_mod


class _Stub:
    """Minimal stand-in exposing only the counter under test."""
    _count_conversation_usage = agent_mod.AgentApi._count_conversation_usage


def _sess():
    return {"convo_tokens": 0, "usage_prev_prompt": 0, "usage_prev_completion": 0}


def _feed(monkeypatch, api, s, usages):
    """Replay a sequence of provider usage dicts through the counter."""
    for u in usages:
        monkeypatch.setattr(agent_mod, "take_last_usage", lambda u=u: u)
        api._count_conversation_usage(s)
    return s["convo_tokens"]


def test_first_call_counts_the_whole_prompt_and_reply(monkeypatch):
    s, api = _sess(), _Stub()
    total = _feed(monkeypatch, api, s, [{"prompt": 5000, "completion": 300}])
    assert total == 5300


def test_later_turns_count_only_new_content(monkeypatch):
    """Turn 2 re-sends turn 1's messages. Only the genuinely new input (the tool
    result) plus the new reply may be added, or the history is counted twice."""
    s, api = _sess(), _Stub()
    total = _feed(monkeypatch, api, s, [
        {"prompt": 5000, "completion": 300},   # 5300
        # prompt grew to 5000+300 (echoed reply) + 700 of tool output
        {"prompt": 6000, "completion": 200},   # +700 new input +200 reply
    ])
    assert total == 5300 + 700 + 200


def test_naive_cumulative_would_double_count(monkeypatch):
    """Guards the reason the delta exists: summing raw total_tokens per call
    inflates the number badly on a long conversation."""
    usages = [{"prompt": 5000, "completion": 300}, {"prompt": 6000, "completion": 200}]
    s, api = _sess(), _Stub()
    delta_total = _feed(monkeypatch, api, s, usages)
    naive_total = sum(u["prompt"] + u["completion"] for u in usages)
    assert delta_total == 6200
    assert naive_total == 11500
    assert delta_total < naive_total


def test_counter_never_decreases_across_summarization(monkeypatch):
    """_maybe_summarize_context discards messages, so the next prompt is far
    smaller. The count must keep climbing — that is the whole point."""
    s, api = _sess(), _Stub()
    seen = []
    for u in [
        {"prompt": 600_000, "completion": 400},
        {"prompt": 610_000, "completion": 400},
        {"prompt": 71_000, "completion": 500},    # summarization fired
        {"prompt": 74_000, "completion": 300},
    ]:
        monkeypatch.setattr(agent_mod, "take_last_usage", lambda u=u: u)
        api._count_conversation_usage(s)
        seen.append(s["convo_tokens"])

    assert seen == sorted(seen), f"counter went backwards: {seen}"
    assert all(b >= a for a, b in zip(seen, seen[1:]))
    # The summarizing turn contributes only its reply (its input delta clamps to
    # zero) — the accepted, documented undercount.
    assert seen[2] - seen[1] == 500


def test_missing_usage_leaves_the_counter_untouched(monkeypatch):
    """A provider that reports no usage must not zero the running total or
    corrupt the baseline for the next call."""
    s, api = _sess(), _Stub()
    _feed(monkeypatch, api, s, [{"prompt": 5000, "completion": 300}])
    before = dict(s)

    for empty in ({}, None, {"prompt": 0, "completion": 0}):
        monkeypatch.setattr(agent_mod, "take_last_usage", lambda e=empty: e)
        api._count_conversation_usage(s)
        assert s == before

    # The next real call still measures its delta against the last real one.
    _feed(monkeypatch, api, s, [{"prompt": 6000, "completion": 200}])
    assert s["convo_tokens"] == 5300 + 700 + 200


def test_baseline_survives_a_reopen(monkeypatch):
    """start_session restores convo_tokens AND the prompt baseline together. With
    only the total restored, the first post-reopen call would re-count the whole
    replayed history as new input."""
    s, api = _sess(), _Stub()
    _feed(monkeypatch, api, s, [
        {"prompt": 5000, "completion": 300},
        {"prompt": 6000, "completion": 200},
    ])
    saved = {
        "convo_tokens": s["convo_tokens"],
        "usage_prev_prompt": s["usage_prev_prompt"],
        "usage_prev_completion": s["usage_prev_completion"],
    }

    reopened = dict(saved)
    _feed(monkeypatch, api, reopened, [{"prompt": 6500, "completion": 100}])
    # 6500 - (6000+200) = 300 new input, + 100 reply
    assert reopened["convo_tokens"] == saved["convo_tokens"] + 300 + 100

    # The bug this guards: dropping the baseline re-counts the entire history.
    without_baseline = {"convo_tokens": saved["convo_tokens"],
                        "usage_prev_prompt": 0, "usage_prev_completion": 0}
    _feed(monkeypatch, api, without_baseline, [{"prompt": 6500, "completion": 100}])
    assert without_baseline["convo_tokens"] > reopened["convo_tokens"] + 6000


def test_status_event_carries_the_count_and_its_baseline():
    """_emit_status must ship convo_tokens (for the UI) plus the baseline fields,
    because that snapshot is what _persist_session stores as "stats"."""
    import inspect
    src = inspect.getsource(agent_mod.AgentApi._emit_status)
    for field in ("convo_tokens", "usage_prev_prompt", "usage_prev_completion"):
        assert f'"{field}"' in src, f"_emit_status must emit {field}"
