"""Terminal presentation of Omni's shared engine; no desktop dependencies."""
import argparse
from contextlib import redirect_stdout
import json
import shlex
import sys
import threading


class TerminalEvents:
    def __init__(self, output, json_events=False):
        self.output = output
        self.json_events = json_events
        self.lock = threading.RLock()
        self.streams = {}
        self.completed = {}
        self.failed = False

    def write(self, text):
        with self.lock:
            print(text, file=self.output, flush=True)

    def __call__(self, event):
        with self.lock:
            kind = event.get("type")
            if kind == "error":
                self.failed = True
            if self.json_events:
                self.write(json.dumps(event, ensure_ascii=False, default=str))
                return
            if kind == "assistant_stream":
                key = event.get("stream_id", "main")
                content = event.get("content", "")
                previous = self.streams.get(key, "")
                if event.get("phase") == "reset":
                    if previous:
                        self.write("\n[Response retry]")
                    self.streams.pop(key, None)
                elif event.get("phase") == "end":
                    if previous:
                        self.write("")
                    if previous:
                        self.completed[event.get("kind", "explanation")] = previous.strip()
                    self.streams.pop(key, None)
                elif content:
                    print(content[len(previous):] if content.startswith(previous) else content,
                          end="", file=self.output, flush=True)
                    self.streams[key] = content
            elif kind in ("final_answer", "assistant", "system", "error", "thought"):
                content = event.get("content") or event.get("text") or ""
                streamed_kind = "final_answer" if kind == "final_answer" else "explanation" if kind == "thought" else None
                if not streamed_kind or self.completed.pop(streamed_kind, None) != content.strip():
                    self.write(content)
            elif kind in ("tool_call", "tool_running"):
                self.write(f"\n[tool] {event.get('tool', '')} {json.dumps(event.get('args', {}), ensure_ascii=False)}")
            elif kind == "tool_result":
                self.write(str(event.get("result", "")))
            elif kind == "subagent_stream":
                pass  # JSON mode carries deltas; plain terminals print complete worker messages below.
            elif kind.startswith("subagent_"):
                who = event.get("agent") or event.get("sub_id", "worker")
                text = event.get("content") or event.get("task") or event.get("last_tool") or event.get("report")
                if text:
                    self.write(f"\n[{who}] {text}")


HELP = """/help                 Show commands
/changes              List changed files in the temporary copy
/apply PATH [PATH...]  Apply selected files (quote paths containing spaces)
/apply --all          Apply all listed changes; conflicts still refuse
/status               Show workspace and temporary directory
/agents               Show subagent activity
/quit                 Save and exit
Ctrl+C                Stop the current run (or exit at the prompt)
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description="Omni Agent — the desktop engine in your terminal")
    parser.add_argument("workspace", nargs="?", default=".")
    parser.add_argument("-p", "--prompt", help="Run one prompt and exit; '-' reads stdin")
    parser.add_argument("--json", action="store_true", help="Emit newline-delimited engine events")
    parser.add_argument("--in-place", action="store_true", help="Edit the original workspace instead of a temporary copy")
    parser.add_argument("--list-models", action="store_true", help="List configured models and exit")
    args = parser.parse_args(argv)
    if args.json and args.prompt is None and not args.list_models:
        parser.error("--json requires --prompt (use -p - to read stdin)")
    output = sys.stdout
    events = TerminalEvents(output, args.json)
    # Library diagnostics belong on stderr, leaving --json stdout machine-readable.
    with redirect_stdout(sys.stderr):
        from agent import AgentEngine
        api = AgentEngine(event_sink=events)
        if args.list_models:
            events.write(json.dumps(api.get_model_options(), ensure_ascii=False))
            return 0
        result = api.start_session(args.workspace, temporary=not args.in_place)
        if not result.get("ok"):
            events({"type": "error", "content": result.get("error", "Could not start session")})
            return 1
        if not args.json:
            info = api.working_copy_status()
            events.write(f"Omni Agent\nWorkspace: {info['workspace']}\nWorking directory: {info['root']}\n/help for commands")

        def run(text):
            events.failed = False
            result = api.send_message(text)
            if not result.get("ok"):
                events({"type": "error", "content": result.get("error", "Could not send message")})
                return 1
            try:
                while not api.wait(0.2):
                    pass
            except KeyboardInterrupt:
                api.stop()
                api.wait(10)
                return 130
            return 1 if events.failed else 0

        try:
            if args.prompt is not None:
                prompt = sys.stdin.read() if args.prompt == "-" else args.prompt
                return run(prompt)
            if not sys.stdin.isatty():
                parser.error("Use -p TEXT or -p - when stdin is not interactive")
            while True:
                try:
                    print("\nomni> ", end="", file=output, flush=True)
                    line = input().strip()
                except (EOFError, KeyboardInterrupt):
                    return 0
                if not line:
                    continue
                if line in ("/quit", "/exit"):
                    return 0
                if line == "/help":
                    events.write(HELP)
                elif line in ("/status", "/changes"):
                    info = api.working_copy_status()
                    events.write(json.dumps(info if line == "/status" else info.get("changes", info), indent=2))
                elif line == "/agents":
                    events.write(json.dumps(api.session.get("dock", {}), indent=2))
                elif line.startswith("/apply "):
                    try:
                        paths = shlex.split(line)[1:]
                        if paths == ["--all"]:
                            info = api.working_copy_status()
                            paths = [c["path"] for c in info.get("changes", [])]
                        events.write(json.dumps(api.promote_changes(paths), indent=2))
                    except ValueError as exc:
                        events.write(str(exc))
                elif line.startswith("/"):
                    events.write("Unknown command. Use /help.")
                else:
                    run(line)
        finally:
            api._persist_session()


if __name__ == "__main__":
    sys.exit(main())
