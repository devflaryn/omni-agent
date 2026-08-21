// The action-group title must categorize what happened ("Read 3 files · Ran 2
// commands") instead of the old undifferentiated "Ran 6 tools".
import assert from 'node:assert';
import { loadApp } from './_harness.mjs';

const { sandbox } = loadApp();
const { newGroupCounts, countToolCall, groupTitleText, dispatchedAgentCount } = sandbox;

assert.equal(typeof groupTitleText, 'function', 'app.js must expose groupTitleText');

// Build a fake group the way pushAction does, then read its title.
function titleFor(calls) {
  const g = { counts: newGroupCounts(), n: 0 };
  for (const ev of calls) { g.n += 1; countToolCall(g.counts, ev, g.n); }
  return groupTitleText(g);
}
const call = (tool, args = {}) => ({ tool, args });

// --- the headline case from the request -------------------------------------
assert.equal(
  titleFor([
    call('read_file_chunk', { filepath: 'a.py' }),
    call('write_file', { filepath: 'b.py' }),
    call('write_file', { filepath: 'c.py' }),
    call('run_command', { command: 'ls' }),
    call('run_command', { command: 'pwd' }),
    call('run_command', { command: 'make' }),
  ]),
  'Read 1 file · Changed 2 files · Ran 3 commands');

// --- singular / plural ------------------------------------------------------
assert.equal(titleFor([call('read_file_chunk', { filepath: 'a.py' })]), 'Read 1 file');
assert.equal(titleFor([call('run_command', {})]), 'Ran 1 command');
assert.equal(titleFor([call('list_directory', {})]), 'Searched once');
assert.equal(titleFor([call('list_directory', {}), call('find_files', {})]), 'Searched 2 times');
assert.equal(titleFor([call('plan_add_task', {})]), 'Planned 1 step');

// --- files dedupe by path, commands do not ----------------------------------
assert.equal(
  titleFor([
    call('read_file_chunk', { filepath: 'same.py' }),
    call('read_file_chunk', { filepath: 'same.py' }),
    call('tail_file', { filepath: 'same.py' }),
  ]),
  'Read 1 file', 'touching one file three times is still one file');

assert.equal(
  titleFor([call('run_command', { command: 'ls' }), call('run_command', { command: 'ls' })]),
  'Ran 2 commands', 'identical commands are two runs, not one');

// Pathless reads must not collapse into each other.
assert.equal(titleFor([call('read_file_chunk', {}), call('read_file_chunk', {})]),
  'Read 2 files');

// --- fixed segment order regardless of call order ---------------------------
assert.equal(
  titleFor([
    call('plan_add_task', {}),
    call('run_command', {}),
    call('write_file', { filepath: 'x' }),
    call('read_file_chunk', { filepath: 'y' }),
  ]),
  'Read 1 file · Changed 1 file · Ran 1 command · Planned 1 step');

// --- delegation counts agents, not calls ------------------------------------
assert.equal(dispatchedAgentCount({ agents: [1, 2, 3] }), 3);
assert.equal(dispatchedAgentCount({}), 1, 'an unreadable spec still counts as one');
assert.equal(
  titleFor([
    call('dispatch_agents', { agents: [{}, {}, {}] }),
    call('read_file_chunk', { filepath: 'a' }),
    call('read_file_chunk', { filepath: 'b' }),
  ]),
  'Read 2 files · Delegated to 3 subagents');

// --- unmapped tools still appear, via the trailing bucket -------------------
assert.equal(titleFor([call('brand_new_tool', {})]), 'Ran 1 tool');
assert.equal(
  titleFor([call('read_file_chunk', { filepath: 'a' }), call('brand_new_tool', {})]),
  'Read 1 file · Ran 1 tool');

// --- zero segments are omitted, never rendered as "0 files" -----------------
assert.ok(!titleFor([call('run_command', {})]).includes('0 '),
  'empty buckets must not appear in the title');

console.log('group summary: OK');
