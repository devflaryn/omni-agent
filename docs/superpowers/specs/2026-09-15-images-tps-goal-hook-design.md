# Image previews, live token rate, goal hook — design

Date: 2026-09-15. Three independent changes to Omni Agent, requested together.

## 1. Images the model reads show up in the chat

**Today.** pi's `read` tool returns `[{type:"text"}, {type:"image", data, mimeType}]` for a PNG/JPEG.
`normalize.mjs` flattens tool results to text, so the image becomes the literal string `[image]` and
the chat shows nothing.

**Design.**

- `normalize.mjs` gains `contentImages(content)` and every `tool_result` block (pi session file,
  pi RPC `tool_execution_end`, Claude session file) carries `images: [{ mimeType, data }]` next to
  `text`. Images larger than 8 MB of base64 are dropped (the text note still says an image was read).
- `transcript.js`: when a tool result has images, a thumbnail strip is appended **under the work
  group** the tool belongs to (visible even when the group is collapsed). One strip per work group,
  a small box per image (multiple reads → several boxes). Click a box → a lightbox overlay with the
  image at natural size (bounded by the viewport); click anywhere, `×`, or Escape closes it. The chat
  itself never enlarges.
- History replay works the same way because the session file keeps the image blocks.

## 2. Token rate on the status line is a rolling 5-second figure

**Today.** `Thinking… 1m 20s · 3.2k tokens · 40 tok/sec` divides all output tokens by the whole turn
time, including seconds spent waiting for tool results.

**Design.**

- Each streamed delta records a sample `{ ts, chars }` on the turn. `lib.js` gets a pure
  `rollingRate(samples, now, { windowMs: 5000, staleMs: 1500 })`: tokens (chars ÷ 4) received in the
  last 5 s divided by the span of those samples, or `0` when the newest sample is older than
  `staleMs` (the model is waiting on a tool, or has not started).
- `renderMeter` shows ` · N tok/sec` only when `rollingRate` is non-zero. The finished-turn line is
  unchanged (duration and total tokens).

## 3. Goal hook: a second model keeps the chat alive

Same mechanics as Claude Code's goal loop: when the agent stops, a judge decides whether the user's
request is actually done. If not, the agent is re-engaged. Omni shows only a one-line notice, never
the hook's message.

**Components.**

- `server/hook.mjs`
  - `GoalKeeper({ getPi, bus, judge, config })`. Listens to bus events for Omni's own pi session:
    - live user message without the hook marker → new goal (text, `nudges = 0`, `seq++`);
    - assistant / tool messages → appended to a bounded transcript tail;
    - `status { streaming: false }` → after `graceMs` (default 2 s; cancelled by a new user prompt or
      an abort) run the judge.
  - The judge gets the goal, the last ~6 k chars of the tail (assistant text, tool names + args,
    result heads, the last stop reason) and returns JSON `{ done, reason, nudge }`. `done: true` also
    covers "the agent is waiting on the user for something only the user can answer".
  - Not done and `nudges < maxNudges` (default 5): `pi.prompt(hookMessage(...), { echo: false })`
    and a bus event `{ kind: "hook", name: "goal", text: "Goal hook re-engaged the agent (2/5): <reason>" }`.
    Judge failures (bad JSON, spawn error, timeout) never nudge; they log.
  - `hookMessage(name, body)` wraps the message as `<omni-hook name="goal">…</omni-hook>` so the
    session file, when replayed, is recognisable.
  - `runJudge()` spawns `node <pi cli> -p --no-tools --no-extensions --no-skills --no-session
    --no-context-files --no-prompt-templates --thinking off --provider P --model M --system-prompt …`
    with the input on stdin, and reads stdout. This reuses every provider the user configured.
- `pi-rpc.mjs`: `prompt(message, { images, echo = true })`; hooks pass `echo: false` so no user
  bubble is broadcast.
- `config.mjs`: `hook: { enabled, provider, model, maxNudges, graceMs }` read from
  `omni.config.json`; empty provider/model = "use the chat's current model".
- `index.mjs`: `GET/PUT /api/hook` (PUT persists to `omni.config.json`); `/api/pi/abort` cancels the
  keeper for the current goal.
- UI
  - `transcript.js`: `hook` events and replayed user messages that start with `<omni-hook` render as
    an event line (icon + text), never as a user bubble.
  - Composer model menu gets a **Goal hook** section: `off / on`, and the judge model
    (`same as chat` or any configured model). Persisted through `/api/hook`.

**Out of scope.** Claude Code sessions (view-only in Omni), a per-chat toggle (the hook is global),
editing the judge prompt from the UI.

## Testing

- `normalize.test.mjs`: image blocks survive on pi entries, pi RPC tool end, Claude tool results.
- `ui.test.mjs`: `rollingRate` (window, staleness, empty), `hookInfo` parsing.
- `hook.test.mjs`: keeper with a fake pi and fake judge — nudges when not done, stays quiet when done,
  respects the cap, a new prompt cancels the grace timer, abort cancels, judge errors do not nudge,
  the hook prompt is not echoed and a `hook` event is emitted.
- `server.test.mjs`: `/api/hook` round-trips config.
