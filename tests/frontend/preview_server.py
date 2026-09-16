"""Serve an offline rendering fixture, without exposing a real engine bridge."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONTEND = HERE.parents[1] / 'frontend'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND), **kwargs)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            body = (FRONTEND / 'index.html').read_text(encoding='utf-8').replace(
                '<script src="app.js"></script>',
                '<script src="/__preview.js"></script><script src="app.js"></script>').encode()
            kind = 'text/html; charset=utf-8'
        elif self.path == '/__preview.js':
            body = (HERE / 'preview_bridge.js').read_bytes()
            kind = 'application/javascript'
        else:
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8766), Handler).serve_forever()
