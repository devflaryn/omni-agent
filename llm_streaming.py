"""Request-local answer and provider-supplied reasoning streams."""
import contextvars
import contextlib
import json
import re
import threading
import uuid
import time

_sink = contextvars.ContextVar('omni_stream_sink', default=None)


@contextlib.contextmanager
def stream_events(callback):
    """Bind a sink to this request; late events after cancellation are discarded."""
    active = threading.Event()
    active.set()
    def send(event):
        if active.is_set():
            try:
                callback(event)
            except Exception:
                pass  # a disconnected visual client must not break execution
    token = _sink.set(send if callback else None)
    try:
        yield
    finally:
        active.clear()
        _sink.reset(token)


def streaming_enabled():
    return _sink.get() is not None


def _public_fields(raw):
    # Ignore reasoning blocks, including an unfinished opening/closing block.
    raw = re.sub(r'<(?:think|analysis|reasoning)\b[^>]*>.*?(?:</(?:think|analysis|reasoning)>|$)', '', raw, flags=re.S | re.I)
    start = raw.find('{')
    if start < 0:
        return {}
    raw = raw[start:]
    fields = {}
    depth = 0
    i = 0
    while i < len(raw):
        c = raw[i]
        if c in '{[':
            depth += 1
        elif c in '}]':
            depth -= 1
        elif c == '"':
            begin = i
            i += 1
            while i < len(raw):
                if raw[i] == '\\':
                    i += 2
                    continue
                if raw[i] == '"':
                    break
                i += 1
            if i >= len(raw):
                break
            if depth == 1:
                key = json.loads(raw[begin:i + 1])
                match = re.match(r'\s*:\s*"', raw[i + 1:])
                if match:
                    pos = i + 1 + match.end()
                    end = pos
                    while end < len(raw):
                        if raw[end] == '\\':
                            end += 2
                            continue
                        if raw[end] == '"':
                            break
                        end += 1
                    value = raw[pos:min(end, len(raw))]
                    # Wait for complete escape sequences (including unicode).
                    while value:
                        try:
                            fields[key] = json.loads('"' + value + '"')
                            break
                        except ValueError:
                            value = value[:-1]
                    i = end
        i += 1
    return fields


class VisibleStream:
    def __init__(self):
        self.sink = _sink.get()
        self.id = uuid.uuid4().hex
        self.last = ''
        self.kind = 'explanation'

    def update(self, raw, function=None):
        fields = _public_fields(raw)
        final = function == 'final_answer' or fields.get('type') == 'final_answer'
        value = fields.get('content' if final else 'explanation', '')
        if value and value != self.last:
            self.kind = 'final_answer' if final else 'explanation'
            self.last = value
            self.send('delta')

    def send(self, phase):
        if self.sink:
            self.sink({'type': 'assistant_stream', 'stream_id': self.id,
                       'content': self.last, 'kind': self.kind, 'phase': phase})


class ReasoningStream:
    """Keep model reasoning separate from answers and agent protocol messages."""
    def __init__(self, stream_id):
        self.id = stream_id
        self.sink = _sink.get()
        self.reasoning = ''
        self.chars = 0
        self.started = None
        self.truncated = False

    def update(self, output='', reasoning='', inline=None):
        output = output if isinstance(output, str) else ''
        reasoning = reasoning if isinstance(reasoning, str) else ''
        if output or reasoning:
            if self.started is None:
                self.started = time.monotonic()
            self.chars += len(output) + len(reasoning)
        if inline is not None:
            self.reasoning = inline
        else:
            self.reasoning += reasoning
        if len(self.reasoning) > 256000:
            self.truncated = True
            self.reasoning = self.reasoning[-256000:]

    def send(self, usage, phase='delta'):
        if not self.sink:
            return
        exact = usage.get('completion_tokens', usage.get('output_tokens'))
        # Input/prompt tokens and SSE frame counts are not generated tokens.
        tokens = exact if exact is not None else (self.chars + 3) // 4
        elapsed = max(0, time.monotonic() - self.started) if self.started is not None else 0
        self.sink({'type': 'reasoning_stream', 'stream_id': self.id,
                   'content': self.reasoning, 'phase': phase,
                   'tokens': tokens, 'estimated': exact is None,
                   'tokens_per_second': tokens / elapsed if elapsed >= 1 else None,
                   'truncated': self.truncated})


def _events(response):
    # SSE is UTF-8 even when a server omits charset; requests otherwise uses
    # ISO-8859-1 for text/* and corrupts non-ASCII tokens.
    response.encoding = 'utf-8'
    parts = []
    for line in response.iter_lines(decode_unicode=True):
        if isinstance(line, bytes):
            line = line.decode('utf-8')
        if not line:
            if parts:
                body = '\n'.join(parts)
                parts = []
                if body == '[DONE]':
                    return
                yield json.loads(body)
        elif line.startswith('data:'):
            parts.append(line[5:].lstrip())
    if parts and '\n'.join(parts) != '[DONE]':
        yield json.loads('\n'.join(parts))


def collect_stream(response, protocol):
    """Reassemble a standard response, preserving existing protocol validation."""
    visible = VisibleStream()
    reasoning = ReasoningStream(visible.id)
    text = ''
    calls = {}
    usage = {}
    finish = None
    complete = False
    try:
        for event in _events(response):
            if event.get('error') or event.get('type') == 'error':
                raise ValueError('Provider stream failed: ' + str(event.get('error', 'unknown error')))
            if protocol == 'anthropic':
                et = event.get('type')
                if et == 'message_start':
                    usage.update(event.get('message', {}).get('usage', {}))
                elif et == 'content_block_delta':
                    delta = event.get('delta', {})
                    if delta.get('type') == 'text_delta':
                        text += delta.get('text', '')
                        reasoning.update(output=delta.get('text', ''))
                        visible.update(text)
                    elif delta.get('type') == 'thinking_delta':
                        reasoning.update(reasoning=delta.get('thinking', ''))
                elif et == 'message_delta':
                    finish = event.get('delta', {}).get('stop_reason')
                    usage.update(event.get('usage', {}))
                elif et == 'message_stop':
                    complete = True
            else:
                usage.update(event.get('usage') or {})
                for choice in event.get('choices', []):
                    if choice.get('index', 0) != 0:
                        continue
                    delta = choice.get('delta', {})
                    text += delta.get('content') or ''
                    reasoning.update(output=delta.get('content') or '',
                                     reasoning=delta.get('reasoning_content') or delta.get('reasoning') or '')
                    if re.search(r'<(?:think|analysis|reasoning)\b', text, re.I):
                        blocks = re.findall(r'<(?:think|analysis|reasoning)\b[^>]*>(.*?)(?:</(?:think|analysis|reasoning)>|$)', text, re.S | re.I)
                        inline = '\n\n'.join(blocks)
                        # A closing tag can itself arrive across several frames.
                        inline = re.sub(r'<[^>]*$', '', inline)
                        reasoning.update(inline=inline)
                    visible.update(text)
                    for call in delta.get('tool_calls') or []:
                        index = call.get('index', 0)
                        fn = calls.setdefault(index, {'name': '', 'arguments': ''})
                        part = call.get('function', {})
                        fn['name'] += part.get('name') or ''
                        fn['arguments'] += part.get('arguments') or ''
                        reasoning.update(output=part.get('arguments') or '')
                        if index == 0:
                            visible.update(fn['arguments'], fn['name'])
                    if choice.get('finish_reason') is not None:
                        finish = choice['finish_reason']
                        complete = True
            # Anthropic's message_start output count is a starting snapshot,
            # not a live total; use estimates until its final usage update.
            reasoning.send(usage if protocol != 'anthropic' or et in ('message_delta', 'message_stop') else {})
        if not complete:
            raise ValueError('Provider stream ended before its completion marker')
        if protocol == 'anthropic':
            return {'content': [{'type': 'text', 'text': text}], 'usage': usage, 'stop_reason': finish}
        message = {'content': text or None}
        if calls:
            message['tool_calls'] = [{'function': calls[i]} for i in sorted(calls)]
        return {'choices': [{'message': message, 'finish_reason': finish}], 'usage': usage}
    finally:
        reasoning.send(usage, 'end' if complete else 'reset')
        visible.send('end' if complete else 'reset')
        response.close()
