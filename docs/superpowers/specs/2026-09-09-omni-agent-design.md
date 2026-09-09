# Omni Agent — design (2026-09-09)

## Purpose
A local "agentic OS" for one user that (1) shows every pi harness and Claude Code
conversation live, with tokens animating in while a model streams and whole messages
appearing instantly otherwise, (2) is the user's own memory manager backed by an
Obsidian vault, and (3) keeps token use low by feeding both harnesses a small,
relevant memory pack instead of large context files.

It continues `Desktop/pi/pi-gui` (Node built-ins only, browser UI over SSE) and
replaces it.

## Non-goals
Multi-user, auth, cloud sync, a bundled LLM, Electron packaging.

## Architecture
```
browser (ui/)  ◀── SSE /events ──  server/index.mjs  ── stdin/stdout JSONL ──▶ pi --mode rpc
               ── REST /api/* ──▶                    ── stdin/stdout JSONL ──▶ claude -p --output-format stream-json
                                                     ── fs.watch + tail ──▶ ~/.pi/agent/sessions/**/*.jsonl
                                                                             ~/.claude/projects/**/*.jsonl
                                                     ── fs ──▶ vault/ (Obsidian)
```
Everything flows through one normalized event stream ("omni events") so the UI has one
renderer for four sources.

### Sources
| Source | Mechanism | Granularity |
|---|---|---|
| pi (owned) | `pi --mode rpc` child, `message_update` deltas | token deltas → animated |
| Claude Code (owned) | `claude -p --output-format stream-json --include-partial-messages` | token deltas → animated |
| pi (observed) | tail session `.jsonl` | whole messages → appear |
| Claude Code (observed) | tail project `.jsonl` | whole content blocks → appear |

Observed tailing skips files owned by a live child so nothing renders twice.

### Normalized event
`{seq, sid, harness, ts, kind, ...}` with kinds: `session`, `msg` (complete message with
blocks), `delta` (streaming chunk), `block` (block start/end), `tool` (execution
start/update/end), `usage`, `status`, `compaction`, `run` (claude run lifecycle).

### Memory (Obsidian vault at `omni-agent/vault`)
- `Memory/*.md` notes with frontmatter (`name, description, type, tags, created, updated`)
  and `[[wikilinks]]`. `MEMORY.md` is the auto-generated index.
- `Sessions/<harness>/<date>_<id>.md` digests written automatically when a session goes idle.
- `Projects/<name>.md` one per working directory, linked from digests.
- Search = term scoring over name/description/tags/body (no deps).
- Memory pack = top notes fitted to a token budget; injected into pi via the
  `omni-memory` extension (`before_agent_start`) and into Claude Code via
  `--append-system-prompt` for runs started from Omni.
- Claude Code auto-memory (`~/.claude/projects/*/memory/*.md`) can be imported.

### Token accounting
Per session: input/output/cacheRead/cacheWrite totals, context estimate (last
message's input + cache tokens), cost (pi: provider-reported; Claude: price table).

## Testing
`node --test`: JSONL splitter, all four normalizers, tally, vault (in a temp dir),
tailer (temp file), HTTP smoke test of the server with the children disabled.
