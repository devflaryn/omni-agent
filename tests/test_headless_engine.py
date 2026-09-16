"""Shared engine/terminal integration without a display or a live provider."""
import io
import json
from pathlib import Path
import subprocess
import sys

import pytest

import agent
import cli
import devices
import host_exec


@pytest.fixture
def engine(tmp_path, monkeypatch):
    workspace = tmp_path / "project with spaces"
    workspace.mkdir()
    (workspace / "hello.txt").write_text("original", encoding="utf-8")
    monkeypatch.setattr(agent, "MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setattr(agent, "_WS_SETTINGS_PATH", str(tmp_path / "recent.json"))
    monkeypatch.setattr(agent, "_active_workspace", None)
    monkeypatch.setattr(agent, "_working_root", None)
    monkeypatch.setattr(host_exec, "_workspace_root", None)
    monkeypatch.setattr(devices, "_active", None)
    monkeypatch.setattr(agent, "set_workspace", lambda root: setattr(host_exec, "_workspace_root", root))
    monkeypatch.setattr(agent, "get_static_system_prompt", lambda **kwargs: "Test engine")
    monkeypatch.setattr(agent, "active_supports_native_tools", lambda: False)
    events = []
    api = agent.AgentEngine(events.append)
    yield api, workspace, events
    api.end_session()


def test_import_and_cli_help_do_not_import_webview():
    code = """
import importlib.abc, sys
class NoDesktop(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'webview' or fullname.startswith('webview.'):
            raise AssertionError('headless engine imported webview')
sys.meta_path.insert(0, NoDesktop())
import agent
sys.argv = ['agent.py', '--cli', '--help']
agent.main()
"""
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                            cwd=Path(__file__).resolve().parents[1], timeout=30)
    assert result.returncode == 0, result.stderr
    assert "--in-place" in result.stdout


def test_copy_promote_resume_and_in_place_share_engine(engine):
    api, workspace, events = engine
    assert api.start_session(str(workspace))["ok"]
    root = Path(api.session["root"])
    assert root != workspace
    assert host_exec.workspace_root() == str(root)
    assert agent._project_root() == str(root)
    (root / "hello.txt").write_text("edited", encoding="utf-8")
    assert (workspace / "hello.txt").read_text() == "original"
    assert api.working_copy_status()["changes"] == [{"path": "hello.txt", "status": "modified"}]
    assert api.promote_changes(["hello.txt"])["ok"]
    assert (workspace / "hello.txt").read_text() == "edited"
    assert api.end_session()["ok"]
    assert api.start_session(str(workspace))["ok"]
    assert api.session["root"] == str(root)
    assert api.start_session(str(workspace), temporary=False)["ok"]
    assert api.session["root"] == str(workspace)
    assert not api.working_copy_status()["temporary"]
    assert any(e["type"] == "session_started" for e in events)


def test_invalid_or_failed_start_preserves_current_route(engine, monkeypatch):
    api, workspace, events = engine
    assert api.start_session(str(workspace))["ok"]
    old_session = api.session
    old_root = host_exec.workspace_root()
    assert not api.start_session(str(workspace / "missing"))["ok"]
    assert api.session is old_session
    from working_copy import WorkingCopy
    monkeypatch.setattr(WorkingCopy, "open", lambda *a: (_ for _ in ()).throw(ValueError("missing copy")))
    assert not api.start_session(str(workspace))["ok"]
    assert api.session is old_session
    assert host_exec.workspace_root() == old_root
    assert agent._project_root() == old_root


def test_busy_promotion_and_external_conflict_refuse(engine):
    api, workspace, _ = engine
    api.start_session(str(workspace))
    root = Path(api.session["root"])
    (root / "hello.txt").write_text("agent edit")
    api._busy = True
    assert not api.promote_changes(["hello.txt"])["ok"]
    api._busy = False
    (workspace / "hello.txt").write_text("external edit")
    assert not api.promote_changes(["hello.txt"])["ok"]
    assert (workspace / "hello.txt").read_text() == "external edit"


def test_subagent_chat_is_bounded_and_drafts_not_persisted(engine):
    api, workspace, _ = engine
    api.start_session(str(workspace))
    api._emit({"type": "subagent_started", "sub_id": "a", "agent": "worker", "task": "inspect"})
    for index in range(90):
        api._emit({"type": "subagent_chat", "sub_id": "a", "role": "assistant", "content": str(index)})
        api._emit({"type": "subagent_stream", "sub_id": "a", "content": "draft"})
    chat = api.session["dock"]["rows"][0]["chat"]
    assert len(chat) == 80 and chat[-1]["content"] == "89"
    api._emit({"type": "wave_started", "wave_id": "next"})
    assert api.session["dock"]["rows"][0]["chat"] == chat
    assert not any(e["type"].endswith("stream") for e in api.session["transcript"])


def test_disconnected_renderer_does_not_drop_other_events():
    received = []
    api = agent.AgentEngine(lambda event: (_ for _ in ()).throw(RuntimeError("disconnected")))
    api.add_event_listener(received.append)
    api._emit({"type": "system", "content": "hello"})
    assert received == [{"type": "system", "content": "hello"}]


def test_cli_one_shot_uses_shared_engine_and_json_stdout(engine, monkeypatch, capsys):
    api, workspace, _ = engine
    # Only the provider loop is replaced. CLI still constructs/starts the real engine.
    def fake_loop(self):
        self._emit({"type": "final_answer", "content": "offline reply"})
        self._busy = False
        self._emit({"type": "done"})
    monkeypatch.setattr(agent.AgentEngine, "_run_agent_loop", fake_loop)
    assert cli.main([str(workspace), "--json", "-p", "hello"]) == 0
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert any(row.get("content") == "offline reply" for row in rows)
    assert rows[-1]["type"] == "done"


def test_terminal_reconciles_stream_without_duplicate_final():
    output = io.StringIO()
    sink = cli.TerminalEvents(output)
    sink({"type": "assistant_stream", "stream_id": "a", "kind": "final_answer", "phase": "delta", "content": "Hello"})
    sink({"type": "assistant_stream", "stream_id": "a", "kind": "final_answer", "phase": "delta", "content": "Hello world"})
    sink({"type": "assistant_stream", "stream_id": "a", "kind": "final_answer", "phase": "end", "content": "Hello world"})
    sink({"type": "final_answer", "content": "Hello world"})
    assert output.getvalue() == "Hello world\n"


def test_worker_has_cross_domain_tools_and_actual_working_root(engine):
    import subagents
    api, workspace, _ = engine
    api.start_session(str(workspace))
    worker = subagents.AgentDef("worker", "Test", mode="write", toolsets=["native"])
    allowed = subagents.resolve_allowed_tools(worker)
    assert {"run_command", "write_file", "grep_directory", "decode_apk"} <= allowed
    assert not {"dispatch_agents", "run_workflow", "strategy_set"} & allowed
    messages = subagents._build_messages(worker, allowed, "Inspect", "", None)
    assert api.session["root"] in messages[0]["content"]


def test_cleanup_error_still_releases_shell_and_emits_done(engine, monkeypatch):
    api, workspace, events = engine
    api.start_session(str(workspace))
    api._busy = True
    api._stop = True
    monkeypatch.setattr(api, "_refresh_tree", lambda **kwargs: (_ for _ in ()).throw(OSError("unavailable")))
    api._run_agent_loop()
    assert not api._busy
    assert events[-1]["type"] == "done"
    assert any(e["type"] == "error" for e in events)
