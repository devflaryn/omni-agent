---
name: subagent-driven-implementation
description: Use when implementing a plan or feature with several tasks in Omni Agent and the work should be handed to subagents — choosing between a Claude Code agent (agent_start kind "claude", claude_task) and a pi agent (agent_start kind "pi", the subagent tool), running tasks in parallel, reviewing each agent's work before the next, or creating a reusable subagent persona (~/.pi/agent/agents/<name>.md, or a Claude Code agent in .claude/agents/). Trigger on "use subagents", "delegate this", "give it to Claude Code", "run these in parallel", "make a reviewer/implementer agent", or any agent_start / claude_task / subagent call for coding work.
---

# Subagent-driven implementation

You are the coordinator. Each task goes to a **fresh agent** with a complete brief; you check its
work yourself and have it reviewed before the next task starts. Your own context holds the plan
and the verdicts, not the file dumps. Agents cannot see this chat and nobody answers their
questions: whatever is not in the brief does not exist for them.

## Pick the worker

| Work | Tool | Why |
|---|---|---|
| Real coding: a module + its tests, a multi-file change, a refactor, a hard bug | `agent_start {kind: "claude"}` | Claude Code is the strongest coder here. Runs in the background; its report arrives as an `[omni-agent-result]` message |
| Coding you cannot continue without (the next step needs its answer now) | `claude_task` | Same Claude Code, but blocks until it answers (default 15 min); `resume` = the returned session id for a follow-up |
| Investigation, search, scan, device loop, a cheap mechanical edit | `agent_start {kind: "pi"}` (+ `agent: "scout"` etc.) | Runs on this chat's model unless `model` is given; cheaper |
| A short read-only look (review a diff, find where X lives) | `subagent {agent, task}` | Blocking, isolated context, persona tools enforced; `tasks: [...]` runs several at once |
| A build, test suite, server, anything that just runs | `job_start` | A shell job, not an agent |
| One command, one file read, a two-line edit | do it yourself | Delegating costs more than it saves |

## The loop

1. **Plan.** `plan` with one step per task, noting which tasks depend on which. A persona the loop itself uses (a reviewer) is made first.
2. **Brief and dispatch** the next task (recipe below). Keep working on something else; never poll `agent_status` in a loop. Use `agent_wait` only when nothing is left to do.
3. **Verify yourself** when the report arrives: `git status`, `git diff --stat`, read the diff, run the tests (`job_start` for slow suites). The report is a claim, not evidence.
4. **Review** any task that changes code (docs-only edits: your own read is enough) with a fresh reviewer (`subagent {agent: "reviewer", task}` or `agent_start` with a reviewer persona): first "does the diff do exactly what the task asked, nothing missing, nothing extra", then code quality.
5. **Fix** through the same agent: `agent_message {id, message}` resumes it on its own session with its context intact. Give the exact finding and the file:line. Re-verify after. Two fix rounds that miss: stop, and either do it yourself or rewrite the brief for a new agent. A stuck agent: `agent_status {id}` for its last activity, `agent_cancel {id}` to stop it.
6. `plan done` the step; next task. A task that depends on this one starts only now; tasks that do not can already be running.
7. **Commit** yourself, once a step is verified and only when the user wants commits; agents are told not to.

## The brief

Every `task` string has these five parts, in this order:

1. **Goal**: one sentence of the outcome.
2. **Context**: repo path, the relevant files, the contracts it must honour (function signatures, routes, data shapes), findings so far, how tests run.
3. **Scope**: the files it may change; what it must not touch; "do not commit" unless you want commits.
4. **Done when**: the command that must pass (e.g. `npm test`) and what must be true.
5. **Report**: files changed, what was verified and how, anything it was unsure of or skipped.

Templates for an implementer brief and a reviewer persona: `reference/templates.md`.

## Parallel work

- Run tasks at once only when they are **independent**: no shared files and no contract still being decided. Fix the contract first (the signature, the URL), then start both.
- All agents share **one working tree** unless you give them their own. For parallel coding that could touch the same files: `git worktree add ../<repo>-<task> -b <task>` per agent, pass that folder as `cwd` (and put "run `npm install` first" or the repo's setup in the brief: a new worktree has no dependencies), merge the branches yourself, re-run the tests on the merge, then `git worktree remove`.
- Limits: 6 agents run at once (more wait as `queued`); agents nest 2 deep, so an agent you start can start one more level, not further.
- Reviews of finished tasks can run in parallel with the next implementation.

## Create a subagent (persona)

A persona is a Markdown file whose body becomes the agent's system prompt:

```markdown
---
name: reviewer
description: Reviews an uncommitted diff against its task and reports real bugs by severity with file:line. Use after an implementer finishes, before the next task.
tools: read, grep, find, ls, bash
---

You review ONE change. ... (rules, what to check, output format)
```

- **Where:** `~/.pi/agent/agents/<name>.md` — `agent_start {agent: "<name>"}` and the `subagent` tool both find it. A project-only `.pi/agents/<name>.md` is seen by the `subagent` tool only. Shipping it with omni-agent: put it in `integrations/pi/agents/` and add it to `AGENTS` in `scripts/install.mjs`.
- **`tools`** (pi): the only tools it gets, by pi tool name — `read, bash, edit, write, grep, find, ls`, MCP tools by their `server_tool` name (e.g. `omnidroid_screenshot`). The plan tool is always added; `agent_start`/`claude_task` only if listed, so a restricted persona cannot escape its limits. Leaving out `edit, write` does not make it read-only while it has `bash`: say "do not modify files" in the body too. A reviewer needs `bash` (for `git diff` and the tests).
- **`model`** (pi): `provider/id`; a `model` passed to `agent_start` wins. Omit it to use the caller's provider default.
- **With `kind: "claude"`** the body is appended to Claude Code's system prompt; `tools` and `model` are ignored (Claude Code keeps all its tools and runs with permissions bypassed).
- No restart needed: the file is read at every start. **Prove it works**: one small `agent_start {agent: "<name>", task: ...}` and read its report before relying on it.

### Subagents inside a Claude Code task

A Claude Code agent can split its own task with Claude Code's subagents. A reusable one is
`.claude/agents/<name>.md` in the repo (or `~/.claude/agents/` for every project), same shape:
frontmatter `name`, `description`, optional `tools` (comma list of Claude Code tool names) and
`model` (`sonnet`, `opus`, `haiku` or `inherit`), body = its system prompt. Name it in the brief:
"use the `reviewer` subagent on your diff before reporting". Use this when the split belongs
inside one coding task; use Omni agents when you want each piece as its own chat you can watch,
steer and verify.

## Common mistakes

| Mistake | Fix |
|---|---|
| Brief says "implement task 2 from the plan" | Paste the task text and the context; the agent cannot read this chat |
| Accepting "all tests pass" from the report | Run them yourself |
| Two parallel agents editing the same file in one tree | Sequential, or one worktree each |
| Starting the dependent task before the first is verified | Verify, review, fix, then dispatch |
| A new agent to fix the last agent's bug | `agent_message` the same agent; it keeps its context |
| Polling `agent_status` every few seconds | Do other work; reports arrive by themselves |
| Persona file written, never tried | One smoke-test start before using it for real |
