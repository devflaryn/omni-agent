"""Live worker telemetry must reach the client before tools finish."""
import json

import subagents
from subagents import AgentDef


def test_tool_call_is_emitted_before_execution_and_result_after(monkeypatch):
    events = []
    replies = iter([
        json.dumps({'type': 'tool_call', 'tool': 'read_file_chunk',
                    'args': {'path': 'a.py'}, 'explanation': 'Inspect the entry point.'}),
        json.dumps({'type': 'final_answer', 'content': 'The entry point is a.py.'}),
    ])
    monkeypatch.setattr(subagents, 'ask_llm', lambda *a, **k: next(replies))
    def execute(*args):
        assert events[-1]['role'] == 'tool_call'
        assert events[-1]['tool'] == 'read_file_chunk'
        return 'file contents'
    monkeypatch.setattr(subagents, '_execute', execute)
    agent = AgentDef('worker', '', mode='write')
    result = subagents._run_loop(agent, [{'role': 'user', 'content': 'inspect'}],
                                {'read_file_chunk'}, .3, 3, {}, on_event=events.append,
                                agent_name='worker', sub_id='unique')
    chat = [e for e in events if e['type'] == 'subagent_chat']
    assert [e['role'] for e in chat] == ['assistant', 'tool_call', 'tool_result', 'assistant']
    assert chat[2]['content'] == 'file contents'
    assert all(e['sub_id'] == 'unique' for e in events)
    assert result['ok']


def test_workers_have_domain_tools_without_persona_toolset_ceiling(monkeypatch):
    class Registry:
        _tools = {'read_file_chunk': None, 'write_file': None, 'frida_hook': None,
                  'strategy_set': None, 'dispatch_agents': None}
        def is_registered(self, name):
            return name in self._tools
    monkeypatch.setattr(subagents, 'registry', Registry())
    agent = AgentDef('worker', '', mode='write', toolsets={'smali'})
    assert subagents.resolve_allowed_tools(agent) == {'read_file_chunk', 'write_file', 'frida_hook'}


def test_explicit_readonly_reviewer_does_not_acquire_mutating_tools(monkeypatch):
    class Registry:
        _tools = {'read_file_chunk': None, 'write_file': None}
        def is_registered(self, name):
            return name in self._tools
    monkeypatch.setattr(subagents, 'registry', Registry())
    agent = AgentDef('reviewer', '', mode='read', allowed_tools={'read_file_chunk', 'write_file'})
    assert subagents.resolve_allowed_tools(agent) == {'read_file_chunk'}
