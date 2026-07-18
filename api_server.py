"""OpenAI-compatible passthrough API server for omni-agent.

Exposes a SINGLE, KEYLESS OpenAI-compatible endpoint on the local network that any
"bring-your-own-key" tool (opencode, Cursor, Continue, plain curl, …) can point at.
Every request is served through the agent's existing multi-provider fallback stack
(llm.passthrough_chat): a shared pool of API keys, a capability-ordered model ladder,
and per-key / per-model cooldowns. The caller sends any dummy key it likes — this
server never checks it; the REAL keys live in the agent's LLM Settings and never
leave this machine.

Endpoints:
    GET  /v1/models              -> the configured model ids (OpenAI list shape)
    POST /v1/chat/completions    -> proxied completion, streaming or not
    GET  /healthz                -> {"ok": true}

Run standalone:      python api_server.py            (binds 0.0.0.0:8787)
    or embedded:     from api_server import start_in_background; start_in_background()

Point your tool at   http://<this-machine-LAN-IP>:8787/v1   with any API key.
"""

import json
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import llm

DEFAULT_HOST = "0.0.0.0"     # reachable from other machines on the LAN
DEFAULT_PORT = 1234


def _lan_ip():
    """Best-effort primary LAN IP of this machine, for the "point your tool here"
    hint. Falls back to 127.0.0.1 when offline."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))     # no packets sent; just picks the outbound iface
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _now():
    return int(time.time())


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OmniAgentProxy/1.0"

    # --- helpers ----------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message, status=400, err_type="invalid_request_error"):
        # OpenAI-shaped error envelope so clients surface it cleanly.
        self._send_json({"error": {"message": message, "type": err_type,
                                   "param": None, "code": None}}, status=status)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def log_message(self, fmt, *args):
        # Quieter than the default stderr spam; one tidy line per request.
        print(f"[api-server] {self.address_string()} {fmt % args}")

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # --- routes -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._send_json({"ok": True})
        if path in ("/v1/models", "/models"):
            models = llm.list_passthrough_models() or []
            data = [{"id": m, "object": "model", "created": _now(),
                     "owned_by": "omni-agent"} for m in models]
            return self._send_json({"object": "list", "data": data})
        return self._error(f"Unknown path {path}", status=404, err_type="not_found")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/v1/chat/completions", "/chat/completions"):
            return self._error(f"Unknown path {path}", status=404, err_type="not_found")
        try:
            payload = self._read_body()
        except (ValueError, json.JSONDecodeError) as e:
            return self._error(f"Invalid JSON body: {e}")
        if not isinstance(payload, dict) or not payload.get("messages"):
            return self._error("Request must include a non-empty 'messages' array.")

        stream = bool(payload.get("stream"))
        result = llm.passthrough_chat(payload)

        if not result.get("ok"):
            return self._error(result.get("error", "upstream failure"),
                               status=result.get("status", 502),
                               err_type="upstream_error")
        data = result["data"]
        if stream:
            return self._send_stream(data, result.get("served", {}))
        return self._send_json(data)

    # --- streaming --------------------------------------------------------
    def _send_stream(self, data, served):
        """Re-emit a completed upstream response as OpenAI SSE chunks. The upstream
        call itself ran non-streaming (so the fallback engine can transparently
        rotate keys/models before the first byte), then we replay the finished
        message as a delta stream — which is what stream-mode clients expect."""
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self._cors()
            self.end_headers()
        except Exception:
            return

        cid = "chatcmpl-" + uuid.uuid4().hex
        created = _now()
        model = data.get("model") or served.get("model") or "omni-agent"
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        finish = choice.get("finish_reason") or "stop"

        def chunk(delta, finish_reason=None):
            obj = {"id": cid, "object": "chat.completion.chunk", "created": created,
                   "model": model,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
            return "data: " + json.dumps(obj) + "\n\n"

        try:
            # 1) role preamble, 2) the payload (content and/or tool_calls), 3) finish.
            self._write_sse(chunk({"role": "assistant"}))
            delta = {}
            if message.get("content"):
                delta["content"] = message["content"]
            if message.get("tool_calls"):
                delta["tool_calls"] = message["tool_calls"]
            if message.get("reasoning_content"):
                delta["reasoning_content"] = message["reasoning_content"]
            if delta:
                self._write_sse(chunk(delta))
            self._write_sse(chunk({}, finish_reason=finish))
            self._write_sse("data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            return

    def _write_sse(self, text):
        self.wfile.write(text.encode("utf-8"))
        self.wfile.flush()


def serve(host=DEFAULT_HOST, port=DEFAULT_PORT):
    """Run the proxy (blocking). Returns the ThreadingHTTPServer if you want to
    shut it down; normally called for its side effect."""
    httpd = ThreadingHTTPServer((host, port), _Handler)
    ip = _lan_ip()
    print("=" * 68)
    print(" Omni-Agent OpenAI-compatible proxy is up (no API key required).")
    print(f"   Local:   http://127.0.0.1:{port}/v1")
    print(f"   Network: http://{ip}:{port}/v1     <- use this from other machines")
    print("   Set any dummy API key in your client; this server ignores it.")
    print(f"   Models:  GET http://{ip}:{port}/v1/models")
    print("=" * 68)
    httpd.serve_forever()
    return httpd


def start_in_background(host=DEFAULT_HOST, port=DEFAULT_PORT):
    """Start the proxy in a daemon thread and return the ThreadingHTTPServer so
    the embedding app (agent.py) can expose it alongside the desktop UI without
    blocking. Safe to call once at startup."""
    httpd = ThreadingHTTPServer((host, port), _Handler)
    ip = _lan_ip()
    print(f"[api-server] OpenAI-compatible proxy on http://{ip}:{port}/v1 "
          f"(and http://127.0.0.1:{port}/v1) — no key required.")
    t = threading.Thread(target=httpd.serve_forever, name="omni-api-server", daemon=True)
    t.start()
    return httpd


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Omni-Agent OpenAI-compatible passthrough proxy.")
    ap.add_argument("--host", default=DEFAULT_HOST, help="bind address (default 0.0.0.0 = all interfaces)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default {DEFAULT_PORT})")
    args = ap.parse_args()
    try:
        serve(args.host, args.port)
    except KeyboardInterrupt:
        print("\n[api-server] shutting down.")
