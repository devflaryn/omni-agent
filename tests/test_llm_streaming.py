"""Offline streaming regression tests: concurrency, protocol and private text."""
import contextvars
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import llm
from llm_streaming import VisibleStream, collect_stream, stream_events


class Response:
    status_code = 200
    ok = True
    headers = {'Content-Type': 'text/event-stream'}

    def __init__(self, events):
        self.events = events
        self.closed = False

    def iter_lines(self, **kwargs):
        for ev in self.events:
            yield 'data: ' + json.dumps(ev)
            yield ''

    def close(self):
        self.closed = True


def chunk(content='', **extra):
    return {'choices': [{'index': 0, 'delta': {'content': content, **extra}, 'finish_reason': None}]}


DONE = {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}


class StreamingTests(unittest.TestCase):
    def test_json_protocol_is_visible_incrementally_without_reasoning_or_arguments(self):
        events = []
        raw = '<think>{"type":"final_answer","content":"SECRET"}</think>' + json.dumps({
            'type': 'tool_call', 'args': {'content': 'HIDDEN'},
            'explanation': 'Read the café\nnow.'}, ensure_ascii=True)
        with stream_events(events.append):
            response = Response([chunk(c, reasoning_content='SECRET') for c in raw] + [DONE])
            result = collect_stream(response, 'openai')
        values = [e['content'] for e in events if e['phase'] == 'delta' and e['type'] == 'assistant_stream']
        self.assertGreater(len(values), 5)
        self.assertEqual(values[-1], 'Read the café\nnow.')
        self.assertNotIn('SECRET', ''.join(values))
        self.assertNotIn('HIDDEN', ''.join(values))
        self.assertEqual(result['choices'][0]['message']['content'], raw)
        self.assertTrue(response.closed)

    def test_native_final_answer_stream_reassembles_arguments(self):
        events = []
        args = json.dumps({'content': 'Hello world'})
        chunks = [chunk(tool_calls=[{'index': 0, 'function': {'name': 'final_answer'}}])]
        chunks += [chunk(tool_calls=[{'index': 0, 'function': {'arguments': c}}]) for c in args]
        with stream_events(events.append):
            result = collect_stream(Response(chunks + [DONE]), 'openai')
        self.assertEqual(events[-1]['content'], 'Hello world')
        self.assertEqual(events[-1]['kind'], 'final_answer')
        self.assertEqual(result['choices'][0]['message']['tool_calls'][0]['function']['arguments'], args)

    def test_anthropic_skips_thinking_blocks_and_collects_usage(self):
        events = []
        frames = [
            {'type': 'message_start', 'message': {'usage': {'input_tokens': 15}}},
            {'type': 'content_block_delta', 'delta': {'type': 'thinking_delta', 'thinking': 'SECRET'}},
            {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': '{"type":"final_answer","content":"Hi'}},
            {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': ' there"}'}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 8}},
            {'type': 'message_stop'},
        ]
        with stream_events(events.append):
            result = collect_stream(Response(frames), 'anthropic')
        self.assertEqual(events[-1]['content'], 'Hi there')
        self.assertNotIn('SECRET', json.dumps([e for e in events if e['type'] == 'assistant_stream']))
        self.assertEqual([e for e in events if e['type'] == 'reasoning_stream'][-1]['content'], 'SECRET')
        self.assertEqual(result['usage'], {'input_tokens': 15, 'output_tokens': 8})

    def test_reasoning_fields_stream_separately_with_generation_usage(self):
        events = []
        with stream_events(events.append), patch('llm_streaming.time.monotonic', return_value=10):
            collect_stream(Response([chunk(reasoning_content='First '), chunk(reasoning_content='second'),
                                    DONE, {'usage': {'prompt_tokens': 10000, 'completion_tokens': 15}}]), 'openai')
        reasoning = [e for e in events if e['type'] == 'reasoning_stream']
        self.assertEqual(reasoning[0]['content'], 'First ')
        self.assertEqual(reasoning[1]['content'], 'First second')
        self.assertEqual(reasoning[-1]['tokens'], 15)
        self.assertFalse(reasoning[-1]['estimated'])
        self.assertEqual(reasoning[-1]['phase'], 'end')

    def test_inline_thinking_handles_split_tags(self):
        events = []
        with stream_events(events.append):
            collect_stream(Response([chunk(c) for c in '<think>Consider café</think>{"type":"final_answer","content":"Hi"}'] + [DONE]), 'openai')
        reasoning = [e for e in events if e['type'] == 'reasoning_stream']
        self.assertEqual(reasoning[-1]['content'], 'Consider café')
        self.assertTrue(any(e['content'] == 'Consider' for e in reasoning))

    def test_speed_uses_generated_text_not_sse_frame_count(self):
        from llm_streaming import ReasoningStream
        events = []
        with stream_events(events.append), patch('llm_streaming.time.monotonic', side_effect=[10, 12]):
            stream = ReasoningStream('s')
            stream.update(reasoning='a' * 80)
            stream.send({})
        self.assertEqual(events[0]['tokens'], 20)
        self.assertEqual(events[0]['tokens_per_second'], 10)
        self.assertTrue(events[0]['estimated'])

    def test_disconnected_stream_is_not_accepted(self):
        events = []
        response = Response([chunk('{"type":"final_answer","content":"partial')])
        with stream_events(events.append), self.assertRaisesRegex(ValueError, 'completion marker'):
            collect_stream(response, 'openai')
        self.assertEqual(events[-1]['phase'], 'reset')
        self.assertTrue(response.closed)

    def test_concurrent_provider_workers_keep_their_own_sinks(self):
        barrier = threading.Barrier(2)
        outputs = [[], []]
        def caller(index):
            with stream_events(outputs[index].append):
                def provider():
                    barrier.wait(timeout=3)
                    s = VisibleStream()
                    s.update(json.dumps({'type': 'final_answer', 'content': str(index)}))
                    return 'ok'
                self.assertEqual(llm._await_or_stop(provider), 'ok')
        threads = [threading.Thread(target=caller, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)
            self.assertFalse(t.is_alive())
        self.assertEqual([e['content'] for e in outputs[0]], ['0'])
        self.assertEqual([e['content'] for e in outputs[1]], ['1'])

    def test_late_callback_after_context_exit_is_discarded(self):
        events = []
        with stream_events(events.append):
            ctx = contextvars.copy_context()
        ctx.run(lambda: VisibleStream().update('{"type":"final_answer","content":"late"}'))
        self.assertEqual(events, [])

    def test_openai_request_enables_http_streaming_and_returns_existing_envelope(self):
        cfg = {'requires_key': False, 'api_key': '', 'base_url': 'http://example.invalid/v1',
               'model': 'test', 'label': 'test', 'protocol': 'openai'}
        response = Response([chunk('{"type":"final_answer","content":"Hello"}'), DONE])
        with patch.object(llm.requests, 'post', return_value=response) as post, stream_events(lambda e: None):
            result = llm._openai_request(cfg, [], 0.3)
        self.assertTrue(post.call_args.kwargs['stream'])
        self.assertTrue(post.call_args.kwargs['json']['stream'])
        self.assertEqual(json.loads(result['content'])['content'], 'Hello')


if __name__ == '__main__':
    unittest.main()
