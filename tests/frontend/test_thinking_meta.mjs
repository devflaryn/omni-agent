// The live Thinking… line must read "Thinking… (1h 55m 4s · 56k tokens)" —
// parenthesized, elapsed first, joined by a small middot — and must degrade
// cleanly when only one figure (or neither) is available.
import assert from 'node:assert';
import { loadApp } from './_harness.mjs';

const DOT = '<span class="think-dot">·</span>';

// The Thinking… row is created inside app.js and not addressable by id, so reach
// it through the chat container the shim does hold.
function probe(sandbox) {
  const chat = sandbox.document.getElementById('chat');
  const row = chat.children[chat.children.length - 1];
  return row.querySelector('.think-meta').innerHTML;
}

// Drive the real event path and return the rendered .think-meta markup.
// tokens === null means no status event was ever received; started === false
// means no user turn began, so there is no run clock.
function render({ tokens, elapsedMs, started = true }) {
  const { sandbox, clock } = loadApp();
  const onEvent = sandbox.window.__agent.onEvent;
  clock.now = 0;
  if (started) onEvent({ type: 'user_message', content: 'go' });
  if (tokens !== null) onEvent({ type: 'status', convo_tokens: tokens });
  clock.now = elapsedMs;
  onEvent({ type: 'thinking_start' });
  return probe(sandbox);
}

// --- both figures: the format from the request ------------------------------
// 1h 55m 4s = 6904s
assert.equal(
  render({ tokens: 56000, elapsedMs: 6904 * 1000 }),
  ` (1h 55m 4s${DOT}56k tokens)`);

// --- elapsed only (no status event yet) -------------------------------------
assert.equal(render({ tokens: null, elapsedMs: 5000 }), ' (5s)',
  'a single value must not be wrapped around an orphan dot');

// --- tokens only (no user turn, so no run clock) ----------------------------
assert.equal(render({ tokens: 56000, elapsedMs: 0, started: false }), ' (56k tokens)');

// --- neither: render nothing rather than empty parens -----------------------
assert.equal(render({ tokens: null, elapsedMs: 0, started: false }), '');
assert.equal(render({ tokens: 0, elapsedMs: 0, started: false }), '',
  'a zero token count is "not known yet", not a value worth showing');

// --- the dot is its own element so CSS can shrink it ------------------------
const both = render({ tokens: 9400, elapsedMs: 65 * 1000 });
assert.ok(both.includes('class="think-dot"'), 'the separator must be styleable');
assert.equal(both, ` (1m 5s${DOT}9.4k tokens)`);

// --- elapsed leads; tokens follow (the order was reversed before) -----------
assert.ok(both.indexOf('1m 5s') < both.indexOf('9.4k'),
  'elapsed must come before the token count');

// --- the token figure tracks convo_tokens, not the old ctx_tokens estimate --
{
  const { sandbox, clock } = loadApp();
  const onEvent = sandbox.window.__agent.onEvent;
  clock.now = 0;
  onEvent({ type: 'user_message', content: 'go' });
  onEvent({ type: 'status', convo_tokens: 640000, ctx_tokens: 71000 });
  onEvent({ type: 'thinking_start' });
  assert.equal(probe(sandbox), ` (0s${DOT}640k tokens)`,
    'convo_tokens must win over the ctx_tokens estimate');
}

// --- an old transcript without convo_tokens still replays -------------------
{
  const { sandbox, clock } = loadApp();
  const onEvent = sandbox.window.__agent.onEvent;
  clock.now = 0;
  onEvent({ type: 'user_message', content: 'go' });
  onEvent({ type: 'status', ctx_tokens: 71000 });
  onEvent({ type: 'thinking_start' });
  assert.equal(probe(sandbox), ` (0s${DOT}71k tokens)`,
    'pre-existing transcripts fall back to ctx_tokens rather than showing zero');
}

// --- the count survives a new user turn (it is the whole conversation) ------
{
  const { sandbox, clock } = loadApp();
  const onEvent = sandbox.window.__agent.onEvent;
  clock.now = 0;
  onEvent({ type: 'user_message', content: 'first' });
  onEvent({ type: 'status', convo_tokens: 120000 });
  onEvent({ type: 'thinking_start' });
  onEvent({ type: 'thought', text: 'done thinking' });
  onEvent({ type: 'user_message', content: 'second' });
  onEvent({ type: 'thinking_start' });
  assert.ok(probe(sandbox).includes('120k tokens'),
    'a new user turn must not reset the conversation token total');
}

console.log('thinking meta: OK');
