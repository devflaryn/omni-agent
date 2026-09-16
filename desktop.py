"""Desktop rendering adapter for the shared agent engine."""
import json
import os


class DesktopWindow:
    def __init__(self, window, webview):
        self.window = window
        self.webview = webview

    def create_file_dialog(self, kind, **kwargs):
        return self.window.create_file_dialog(
            getattr(self.webview, kind), **kwargs)

    def destroy(self):
        self.window.destroy()

    def emit(self, event):
        self.window.evaluate_js(
            "window.__agent.onEvent(" + json.dumps(event, ensure_ascii=False) + ")")


def main():
    import webview  # Desktop-only dependency: never imported by the CLI engine.
    from agent import AgentApi
    api = AgentApi()
    window = webview.create_window(
        "Omni Agent", url=os.path.join(os.path.dirname(__file__), "frontend", "index.html"),
        js_api=api, width=1320, height=840, min_size=(980, 600), text_select=True)
    adapter = DesktopWindow(window, webview)
    api.set_window(adapter)
    api.add_event_listener(adapter.emit)
    if os.environ.get("OMNI_API_SERVER", "1") != "0":
        try:
            import api_server
            api_server.start_in_background(
                host=os.environ.get("OMNI_API_HOST", api_server.DEFAULT_HOST),
                port=int(os.environ.get("OMNI_API_PORT", api_server.DEFAULT_PORT)))
        except Exception as exc:
            print(f"[api-server] not started: {exc}")
    webview.start(debug=os.environ.get("OMNI_DEVTOOLS", "0").lower() in ("1", "true", "yes", "on"))
