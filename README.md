# Omni Agent

The desktop and terminal run the same Python agent engine. `agent.py` owns sessions,
tools, planning, delegation, persistence, and execution. `desktop.py` adapts engine
events and native dialogs to the visual frontend; `cli.py` adapts the same events
to a terminal. Neither frontend runs a separate agent loop.

## Run

Desktop:

```sh
python -m pip install -r requirements.txt
python agent.py
```

Headless computer or SSH terminal:

```sh
python -m pip install -r requirements-headless.txt
python agent.py --cli /absolute/path/to/project
```

No display server or pywebview is required for the CLI. Use the same
`llm_config.json` next to `agent.py` as the desktop. Configure providers with the
desktop's LLM Settings, or provision that configuration on the headless machine.
Keep API keys private. `--list-models` lists configured choices.

The existing host toolchain still applies: a POSIX shell and the tools needed by
your task must be installed. On Windows, use Git for Windows. Check tools with
`python scripts/install_tools.py --check`; install them with
`python scripts/install_tools.py`.

One-shot and machine-readable runs:

```sh
python agent.py --cli /path/to/project -p "Inspect the project and fix the failing tests"
python agent.py --cli /path/to/project --json -p "Summarize the project"
printf 'Inspect this project' | python agent.py --headless /path/to/project --json -p -
```

`--json` emits newline-delimited engine events, including streaming responses and
subagent events. Diagnostics go to stderr. It requires `--prompt`. Exit codes:
0 for a completed run, 1 for an engine error, 2 for invalid CLI arguments, and 130
when a one-shot run is interrupted. Run commands from the installation directory,
or invoke `agent.py` by its absolute path; the project argument sets the tool cwd.

## Temporary working copies

New sessions default to a real temporary working copy outside the project.
Tools use that directory as their cwd; there is no virtual path translation.
The source workspace receives files only when you explicitly apply selected
changes through **Working copy → Apply selected**, or the CLI's `/apply` command.
Deleted files are listed and require selection too.

```text
/changes
/apply "src/file with spaces.py" README.md
/apply --all
/status
/agents
/quit
```

Publication checks original-file hashes and refuses conflicting upstream edits.
The copy is retained after publication and closing the app, and reopening the same
project resumes it. Staged conversations are stored separately from in-place
conversations. The copy's manifest is under the project's `memory/.../staged/`
directory; its absolute location is shown in `/status` and the desktop dialog.

For direct edits, uncheck **Use a temporary working copy** before opening the
desktop session, or pass `--in-place` to the CLI. Existing SSH device routing
requires in-place mode. To use temporary copies on a headless machine, run the
CLI on that machine directly, including through an SSH terminal.

Copies omit `.git`, dependency/environment directories (`node_modules`, `.venv`,
`venv`), and caches. Reinstall project dependencies in the copy as needed. This
is not a Git worktree or a security sandbox: arbitrary tools still have the host
user's permissions. Symlinks and Windows junctions are not copied or promoted.
An OS cleanup of the temporary directory causes reopening to refuse rather than
treating the missing copy as deleted project files. Preserve/rename that project's
`staged` memory directory to start a new copy and conversation if recovery is needed.

Selected files are prevalidated together and replaced atomically one file at a
time. An I/O failure during publication can leave a partially applied batch; inspect
the reported error and refresh the list before retrying.

## Responses and subagents

OpenAI-compatible and Anthropic SSE responses stream public answer/narration text
as it arrives. The desktop reconciles drafts with completed messages. Providers
that return ordinary JSON still work but display completed responses. Hidden model
reasoning is not displayed.

Open **Subagents** to inspect each worker's task, assistant messages, tool calls,
and results live. Recent completed chat messages persist across reopening. The
terminal prints worker messages as they complete; JSON mode also exposes each
worker's token stream, identified by subagent and stream IDs.

Automatic brainstorm/architect dispatch and automatic assignment of plan steps
are off by default. The main agent is instructed to inspect a new request before
delegating bounded work. Explicit delegation and Ultra workflows remain available.
To restore the earlier automatic behavior, set `OMNI_SUPERPOWERS=1` and
`OMNI_AUTO_DELEGATE=1` before starting.

Normal workers, including researcher and native analyst, have access to all domain
tools. Their task determines what to change; toolset labels do not block tools.
Explicit read-only reviewers retain that contract. Recursive dispatch/workflow
launch and the orchestrator's strategic-state writes remain orchestrator-owned.
Dispatch accepts `scope: ["src/package/**"]`; disjoint writers run concurrently,
while overlapping or unscoped writers serialize.

## Verification

Offline tests cover GUI-free startup, shared-engine sessions, copy/resume/promotion,
conflicts and path confinement, streaming and concurrent request routing, and
frontend rendering. No live LLM credentials are needed for these checks.

```sh
python -m pytest tests/test_headless_engine.py tests/test_working_copy.py tests/test_llm_streaming.py
node tests/frontend/test_live_streaming.mjs
node tests/frontend/test_contrast.mjs
```

The desktop theme uses near-black neutral surfaces, rounded controls, white primary
buttons, and subdued borders. Its colors remain RGB token triples so the existing
contrast tests can check both dark and light themes.
