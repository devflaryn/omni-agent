# Omni-Agent: SSH Devices — running the whole toolset on another machine

**Date:** 2026-08-21
**Status:** DESIGN — approved in brainstorming, not yet implemented.
**Branch:** `ssh-devices` (off `main`)

## Goal

Let the agent drive **another computer**. A registered SSH device becomes the
session's execution target, and every tool — files, shell, search, code graph,
APK work, even adb and Frida if that box has them — runs there instead of here.

This is sub-project 2 of 4 from the original request. Sub-project 1 (the
workflow engine) is merged. Sub-projects 3 (workflow authoring & library UI) and
4 (the Google-style UI restyle) get their own specs.

## Why this is cheap: two properties of the existing code

Both were verified by reading the code, not assumed. They are the reason this is
a transport swap rather than a rewrite, and anyone changing them later should
know what depends on them.

1. **`ssh` is a subprocess, so `_run_polling` works unchanged.** `run_cmd`
   builds `[shell, "-c", command]` and hands it to `host_exec._run_polling`,
   which owns the process group, drains both pipes on a background thread, polls
   the Stop predicate every 200 ms, and consults the timeout decider. Substituting
   `ssh host …` as the argv keeps every one of those behaviours verbatim. An
   in-process SSH library (paramiko) would mean reimplementing all of it — the
   exact machinery whose bugs are expensive and already fixed here.

2. **Paths are already project-relative, so no translation is needed.**
   `tools/common.normalize_path` strips a leading `/` (and the legacy
   `/workspace` prefix) and returns a project-relative path; `wpath` shlex-quotes
   it; commands run with cwd set to the project folder. The command STRING is
   therefore valid on the remote host unchanged, provided the remote cwd is the
   remote project folder. The container era left this codebase in the one shape
   that makes remote execution nearly free.

**Consequence:** the large majority of the 105 registered tools go remote without
being touched. `host_exec.run_cmd` is the single choke point — 14 tool modules
shell through it, and `write_file` deliberately routes writes through it rather
than opening files directly (`tools/filesystem.py:109`). Nothing in this work may
introduce a second execution path that bypasses it.

## What does NOT go remote

An earlier framing of this work claimed "all ~106 tools for free". That is too
strong, and the exceptions are worth knowing before the first line is written.
A defined set bypasses `run_cmd` and does in-process local I/O via
`tools/common.resolve_workspace_path()` (which joins `workspace_root()` with a
relative path and returns a HOST path) or via `find_android_sdk_tools()` (which
locates the LOCAL Android SDK).

**Goes remote (the bulk).** filesystem, shell, text search/analysis, hashing,
binary analysis and editing, hex patching, dex/smali editing, native codegen,
plan/investigation/ledger/strategy/skills bookkeeping, delegation and workflows.
Crucially this includes **APK work** — `tools/apk_tools.py` calls `run_cmd` 27
times against 3 uses of `resolve_workspace_path`, and those 3 are the post-build
constraint check, which already degrades with a clear "Constraint check could not
run" message rather than failing the build.

**Local-only, and must say so plainly when a device is active:**

| Area | Why | Behaviour when remote |
|---|---|---|
| Emulator, screen capture, vision, Frida, Roblox session, hook verification | They drive the **local** Android SDK (`find_android_sdk_tools`) and read screenshots from local disk | Refuse with: "runs on this computer only — switch to This computer, or register the emulator's host as the device" |
| `build_code_graph` / `query_code_graph` (auto-builds) | Indexes source through a **local** subprocess pinned to `CODEGRAPH_WORKSPACE`; a local graph of a remote project is meaningless | Refuse with the same shape of message |
| `download_file` | Fetches with in-process `requests` and writes to a local path | **Made remote**: route through `run_cmd` using `curl -fL --max-filesize`, so the file lands on the machine that needs it. `curl` joins the probe's tool list |

Making the emulator and code-graph paths genuinely remote is real work (a remote
SDK, shipping the indexer to the device) and is explicitly out of scope. What is
IN scope is that they fail with an accurate, actionable message instead of
silently operating on the wrong machine — which is the same safety rule as
never falling back to local.

## Confirmed design decisions (user)

1. **Shell out to the `ssh` binary.** No new dependency; inherits `~/.ssh/config`,
   ssh-agent, keys, jump hosts and `ProxyCommand` for free.
2. **Whole toolset, one active device at a time.** Switched explicitly.
3. **Keys and `~/.ssh/config` only.** The app stores NO secrets. A host that
   needs a password gets a key set up the normal way, once.
4. **The user switches devices; the model cannot.** The agent is told which
   machine it is on, in the system prompt and in the UI, but has no
   device-switching tool.
5. **The UI file tree and viewer follow the device.**
6. **Tag-and-reap** for killing remote work on Stop/timeout.

## Verified environment facts

Measured on the target machine (Windows 11), not assumed:

- Two ssh clients exist: Git/MSYS `/usr/bin/ssh` (**OpenSSH 10.2p1**) and
  `C:\Windows\System32\OpenSSH\ssh.exe` (**OpenSSH_for_Windows 9.5p2**).
- **Windows OpenSSH cannot multiplex**: with `ControlMaster=auto` it fails
  `getsockname failed: Not a socket`. Git/MSYS ssh multiplexes correctly.
- **`ControlPath` is bound to 108 bytes** (the Unix-socket limit). MSYS ssh
  rejects a longer one outright with `ControlPath too long`.
  `~/.omni-agent/ssh/%C` measures **95 bytes** and passes.

Multiplexing is not a nicety: without it every one of a workflow's hundreds of
tool calls pays a fresh TCP + auth handshake.

## Non-goals

- **File transfer tools** (scp/sftp push/pull between machines).
- **Per-subagent device targeting** (fanning a workflow across a fleet).
  `ScopedWorkspaceLock` currently assumes one filesystem; this would multiply the
  concurrency questions.
- **Password authentication** and any secret storage.
- **Remote toolchain installation.** Missing tools are reported; the user runs
  `scripts/install_tools.py` on that machine.
- **A model-facing device-switching tool.** Decision #4.

---

## Architecture

### Module layout

```
devices.py                  registry (load/save/list), Device, ssh argv construction,
                            binary selection, multiplexing, remote probe, remote reap
host_exec.py                run_cmd dispatches local vs remote; _run_polling untouched
agent.py                    device picker bridge, prompt line, transcript notice,
                            remote-aware build_file_tree / read_project_file
frontend/index.html+app.js  the device chip + picker (the only frontend additions)
```

`devices.py` is a new module rather than more code in `host_exec.py`: that file
is 482 lines of carefully-tuned process mechanics, and it is the part most worth
leaving alone.

### Command construction

Local today: `[shell, "-c", command]` with `cwd=_workspace_root`.

Remote — one argv substitution, then the same `_run_polling`:

```
<ssh> -o ControlMaster=auto
      -o ControlPath=~/.omni-agent/ssh/%C
      -o ControlPersist=600
      -o BatchMode=yes
      -o ConnectTimeout=10
      <target>
      bash -c '<wrapper>'
```

The wrapper, in order:

1. records its process-group id to `${TMPDIR:-/tmp}/.omni-<tag>.pgid`,
2. sets an `EXIT` trap removing that file,
3. prepends `$HOME/.omni-agent/bin` to `PATH` (the remote equivalent of
   `build_env()`),
4. runs the device's optional `env_prelude`,
5. `cd`s to the remote root and runs the command.

The command string itself is unchanged from the local case. Quoting is
`shlex.quote` throughout — POSIX quoting is correct for the remote shell too.

### Choosing the ssh binary

Prefer Git/MSYS `ssh`, mirroring `host_exec._find_posix_shell()`'s existing
preference for the MSYS toolchain on Windows. Fall back to Windows OpenSSH
**with multiplexing disabled** rather than failing — a slower connection beats no
connection. The chosen binary and whether multiplexing is active are reported at
connect time, so a user seeing slow tool calls can tell why.

### Tag-and-reap

Killing the local `ssh` closes the channel but does not reliably kill the remote
command. A TTY (`ssh -tt`) would deliver SIGHUP, but it merges stderr into stdout
and injects carriage returns — and this project's tools parse the two streams
separately, so that would corrupt tool results across the board. Hence:

- every command carries a unique `tag`;
- the wrapper records its **process-group id** (so children die too, which a bare
  `pkill -f` on the tag would miss);
- on Stop or timeout, `host_exec` fires a second, multiplexed `ssh` sending
  `TERM`, then `KILL`, to that group.

Reaping is **best-effort and never blocks the Stop path.** If the reap connection
fails, `run_cmd` still returns `stopped` promptly, and the result says the remote
command may still be running. An honest message beats a hung UI.

### Connecting: one round trip

Selecting a device runs a single probe that does everything local
`set_workspace` does: `mkdir -p` the remote root, resolve it, report `uname -a`,
and `command -v` every entry in `REQUIRED_TOOLS`. Missing tools are **reported,
not fatal** — identical to today's local behaviour — with a note that
`scripts/install_tools.py` must run on that machine.

### Registry

`~/.omni-agent/devices.json`, global rather than per-project (a machine is not
project-specific). One entry:

```json
{"id": "...", "name": "build-box", "target": "berat@10.0.0.5",
 "remote_root": "/home/berat/projects/thing", "env_prelude": "", "notes": ""}
```

`target` is anything ssh accepts, including a `~/.ssh/config` alias — which is
how jump hosts and `ProxyCommand` come along for free. No secrets, ever.

### Resolved details, so an implementer does not have to guess

- **The active device is per-session, persisted per project.** The registry is
  global (a machine is not project-specific), but which device a project is
  working against is session state, restored on reopen alongside the other
  session flags. Default is local.
- **Selecting a device replaces the workspace.** While a device is active, its
  `remote_root` IS the project folder; `set_workspace` and device selection are
  two entry points to the same "where does work happen" state, never two
  competing ones.
- **`workspace_root()` keeps returning a LOCAL path, and returns `None` when a
  device is active.** It is the honest signal that there is no host-side folder.
  Its four callers (`tools/common.resolve_workspace_path`, `tools/code_graph`,
  `tools/web_tools` ×2) already handle a missing root by erroring; making it
  `None` turns "operates on a path that does not exist locally" into a clean
  refusal. A separate `devices.active_root()` gives the remote path for command
  construction.
- **Local-only tools guard with one shared helper**, not ad-hoc checks:
  `devices.require_local(feature_name)` returns `None` when local and an error
  dict when remote, so every refusal reads identically and no tool invents its
  own wording.
- **The probe's tool list gains `curl`** (for remote `download_file`) alongside
  the existing `REQUIRED_TOOLS` entries.

---

## The UI follows the device

Two functions reroute while keeping their **exact payload shape**, so `app.js`'s
tree and viewer are unchanged:

- **`build_file_tree`** — currently `os.listdir` ("host side"). When remote: one
  `find`-based command through `run_cmd`, parsed into the same nested dict,
  honouring the same ignore rules and depth cap.
- **`read_project_file`** — currently direct file I/O ("host side"). When remote:
  text through the same read path tools already use; images and archive listings
  via base64, behind a **size cap** (a 50 MB APK does not cross the wire for a
  preview — it returns "too large to preview remotely").

`_resolve_project_file`'s symlink-escape guard needs a remote equivalent via
`realpath`, or the remote viewer can be walked out of the project root. Note the
local version of this guard is one of the three currently-failing tests on this
machine (`test_fs_api.py::test_symlink_out_of_the_workspace_is_rejected`), so the
remote one must be genuinely covered rather than assumed by analogy.

**Frontend additions** are limited to: a persistent device chip in the header
(distinct accent when remote), and a picker listing "This computer" plus
registered devices, with an add/edit form (name, target, remote root,
env_prelude) and a "Test connection" button that runs the probe and shows the
remote OS and any missing tools.

---

## Safety

Three rules, in priority order:

1. **Never silently fall back to local.** If the device is unreachable, commands
   fail loudly. A fallback would run the command on the wrong machine — the one
   catastrophic failure this feature can produce.
2. **The transcript records switches.** Changing device emits a system message
   into the conversation, so reading a transcript later is never ambiguous about
   which machine a command ran on.
3. **The active device is always visible** — the header chip, plus one line in
   `_refresh_system_prompt` naming the execution target and remote root. The
   model is told; it has no tool to change it (decision #4).

## Error handling

- `BatchMode=yes` turns a missing key into a fast, clear failure instead of a
  hung interactive prompt.
- Remote root missing → the same shape as today's `_WORKSPACE_GONE_MSG`.
- **The 255 ambiguity, stated rather than papered over:** `ssh` exits 255 on
  transport errors, but a command can legitimately exit 255 too. Disambiguate on
  stderr matching ssh's own signatures (`ssh: connect to host`,
  `Permission denied`, `Connection closed by`, `kex_exchange_identification`).
  When they match, report a device error; otherwise pass the exit code through.
  The residual case — a command that genuinely exits 255 *and* writes one of
  those strings to stderr — is documented in the code, not pretended away.

## Testing

All offline, no network, matching the existing suite's discipline.

| File | Covers |
|---|---|
| `tests/test_devices.py` | registry load/save; argv construction against a **fake ssh binary** that echoes its argv; multiplexing options present; ControlPath under 108 bytes; MSYS-over-Windows binary preference; fallback disables multiplexing; quoting torture (remote root with spaces, command containing quotes and `$`) |
| `tests/test_host_exec_remote.py` | dispatch: local argv byte-identical when no device is active; remote argv when one is; **an unreachable device never falls back to local**; tag/reap command shape; reap failure still returns `stopped` promptly; the 255 disambiguation |
| `tests/test_remote_fs_api.py` | `find` output → tree dict (from recorded output); text/image/archive read paths; the size cap; the remote symlink-escape guard |
| `tests/test_local_only_guards.py` | `devices.require_local()` returns `None` locally and an error dict remotely; every emulator/vision/Frida/code-graph tool refuses (rather than silently acting) when a device is active; `workspace_root()` returns `None` when remote and its four callers degrade cleanly; `download_file` builds a `curl` command when remote |
| `tests/test_devices_integration.py` | optional `localhost` round trip, **skipped** when no sshd is reachable — not pretending CI has one |

The fake-ssh technique is what makes argv construction testable without a
server: a script on PATH that prints its arguments, so every quoting and option
decision is asserted exactly.

## Build order

1. `devices.py` — registry + Device (pure, no I/O beyond the JSON file)
2. `devices.py` — ssh binary selection + argv construction (fake-ssh tests)
3. `host_exec.py` — dispatch in `run_cmd`, plus the never-fall-back-to-local rule
4. `devices.py` — the connect probe (root, uname, missing tools incl. `curl`)
5. `host_exec.py` — tag-and-reap on Stop/timeout
5a. `devices.require_local()` + the refusal guards on emulator / vision / Frida /
    Roblox / code-graph, and `workspace_root()` returning `None` when remote
5b. `tools/web_tools.download_file` — `curl` path when remote
6. `agent.py` — remote `build_file_tree`
7. `agent.py` — remote `read_project_file` (text, then base64 + cap)
8. `agent.py` — device bridge, prompt line, transcript notice
9. Frontend — the device chip and picker
10. Docs — `AGENTS.md` section and `TOOLS.md` if any tool text changes

Steps 1-5b deliver a working, honest remote toolset on their own — everything
either runs on the right machine or refuses out loud. Steps 6-9 make the UI honest
about which machine you are looking at.
