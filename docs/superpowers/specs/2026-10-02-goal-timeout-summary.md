# omni-agent: /goal, tool-timeout keep-alive, and a live summary box — Design

Date: 2026-10-02
Status: draft (awaiting owner review)

## Goal

Three improvements to omni-agent, all building on systems that already exist:

1. **`/goal` + goal hooks** — an explicit goal the agent can't quietly abandon.
2. **Tool-call timeout that keeps the call alive and asks the agent** instead of killing the
   MCP server (which today drops the lab and "ruins all progress").
3. **A toggleable TLDR/progress box in the chat**, written by a separate summarizer LLM, refreshed
   at goal-check milestones.

## What already exists (we extend, not rebuild)

- `server/hook.mjs` `GoalKeeper`: tracks a per-chat goal (today = last user prompt), runs a **judge
  model** on settle (`onSettled`, `hook.mjs:156-172`), and **re-engages pi** until done
  (`pi.prompt(..., {echo:false})`, `hook.mjs:198`), toggleable via `PUT /api/hook` with a UI switch.
- `runJudge()` (`hook.mjs:86-104`): a separate one-off LLM call via `pi -p --no-tools --no-session`.
  The summarizer reuses this exact pattern.
- The chat UI is a web app over **SSE** (`server/bus.mjs` → `/events`); `bus.emit(ev)` fans out
  `{kind, sid, seq, ...}` events; `ui/transcript.js applyEvent` switches on `ev.kind`; toggleable
  panel + `localStorage` patterns exist (`ui/panel.js:20`).
- pi has **no native stop-veto**; the keeper's server-side re-engage IS the stop hook. pi has a
  `tool_call` hook and an `AbortSignal` into tool `execute`, but **no declarative timeout** — the
  timeout lives in `integrations/pi/omni-mcp.ts` (`McpStdioClient.request`), which currently
  `this.close(0)` (kills the server) on timeout.

## Decisions (owner)

- Timeout: keep the call alive, don't kill the server, surface it to the agent to decide.
- Summarizer cadence: on goal-check (piggyback the keeper's judge trigger).
- Summarizer model: the chat's model by default, configurable later.

## Design

### F1. `/goal` + goal hooks

- A pi command extension `integrations/pi/omni-goal.ts` registering `/goal <text>` (and `/goal`
  with no args = show current goal + progress). It POSTs the explicit goal to a new server endpoint
  `PUT /api/goal {sid, goal}`.
- `GoalKeeper` gains an **explicit goal** per sid that overrides the implicit last-prompt when set
  (`goalFor(sid)` prefers `explicit[sid]`). The existing re-engage-until-judge-says-done loop is the
  "never stop until achieved" behavior; `/goal` just makes the target explicit and arms the keeper.
- Progress state (`{goal, done, lastReason, nudges}`) is exposed for the summary box.

### F2. Tool-timeout keep-alive + ask-the-agent

- In `omni-mcp.ts McpStdioClient.request`: on timeout, **do not** `this.close(0)`. Instead keep the
  server running and the pending entry registered, and reject the *awaiting tool call* with a typed
  `SlowCallError(method, elapsedMs)`.
- In the tool `execute` wrapper (where `callTool` is awaited), catch `SlowCallError` and return a
  normal tool result (not isError) whose text tells the agent: the call ran N s without returning,
  the server + lab are intact, it may be stuck or slow, and it should decide (wait and re-call, or
  move on). Emit a `{kind:"hook", sid, text:"⏱ <tool> slow (Ns)…"}` bus event so the status is
  tracked/visible (the UI already renders `hook` lines).
- If the server later answers the slow call, deliver the late result as a `pi.sendMessage(...,
  {deliverAs:"followUp"})` note so nothing is lost.
- **Honest constraint:** omni-mcp is single-threaded, so a *truly* stuck call still occupies the
  server until cancelled. Mitigation now: the lab CPU is interruptible and has a 200M-instruction
  budget, so most runaway calls self-terminate. **Fast follow (separate, Rust):** handle MCP
  `notifications/cancelled` by interrupting the guest CPU, so a stuck call can be abandoned without
  losing the lab. F2 here is the JS keep-alive; the Rust cancel is tracked as a follow-up.

### F3. Toggleable TLDR / progress summary box

- `hook.mjs`: alongside the judge on `onSettled`, call a `runSummarizer()` (runJudge-style, chat
  model by default, configurable) that returns a 2–4 sentence TLDR + what's done + goal progress.
  Emit `bus.emit({kind:"summary", sid, text, goal, done})`.
- `ui/transcript.js` (or a small `ui/summary.js`): render a **pinned, collapsible box** at the top
  of the transcript showing the latest summary + goal/progress, toggled by a header button with the
  state in `localStorage "omni.summary"` (mirrors `panel.js:20`). The box updates in place on each
  new `summary` event (keyed by sid), not appended as a transcript line.
- Cadence: once per goal-check (so it refreshes exactly when the keeper evaluates progress). Cheap:
  one extra `pi -p` call per settle.

## Testing

- omni-agent uses `node --test`. 
- F1: unit-test `GoalKeeper` prefers the explicit goal over the implicit one; `/goal` command posts
  and the endpoint stores it; keeper re-engages while not done (extend existing hook tests if any).
- F2: unit-test `McpStdioClient` — a timeout rejects with `SlowCallError` and the child is **still
  running** (not closed); a late answer still resolves/deliverable. (Mirror the existing
  `test/pi-mcp-extension.test.mjs` timeout test, which currently asserts the server is restarted —
  update it to assert keep-alive.)
- F3: unit-test `runSummarizer` shape and that a `summary` bus event is emitted on settle; a UI
  smoke check that a `summary` event updates the box.

## Risks / open

- The single-thread timeout constraint (above) — JS keep-alive now, Rust cancel as a fast follow.
- Summarizer cost: one extra model call per settle; cadence is already the cheapest trigger, and the
  model is configurable to a cheap one later.
- pi command registration (`registerCommand`) availability confirmed in the type surface; the
  command talks to the server over HTTP like `omni-claude.ts` does.
