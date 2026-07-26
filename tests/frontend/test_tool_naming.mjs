// The transcript must never show a raw internal identifier. Verifies the curated
// TOOL_META names, the acronym handling, and the mechanical fallback that catches
// any tool added after the table was last regenerated.
import assert from 'node:assert';
import { loadApp } from './_harness.mjs';

const { sandbox, evalInApp } = loadApp();
const { toolDisplayName, toolCategory } = sandbox;
const TOOL_META = evalInApp('TOOL_META');

assert.equal(typeof toolDisplayName, 'function', 'app.js must expose toolDisplayName');

// --- curated names ----------------------------------------------------------
assert.equal(toolDisplayName('list_directory'), 'List Directory');
assert.equal(toolDisplayName('read_file_chunk'), 'Read File');
assert.equal(toolDisplayName('run_command'), 'Run Command');
assert.equal(toolDisplayName('replace_in_file'), 'Edit File');
assert.equal(toolDisplayName('dispatch_agents'), 'Dispatch Subagents');

// --- mechanical fallback for an unmapped tool -------------------------------
assert.equal(toolDisplayName('some_new_tool'), 'Some New Tool',
  'an unmapped tool must still Title-Case rather than leak snake_case');
assert.equal(toolDisplayName('inspect_apk_manifest'), 'Inspect APK Manifest',
  'acronyms stay upper-case in the fallback');
assert.equal(toolDisplayName('read_elf_header'), 'Read ELF Header');
assert.equal(toolDisplayName('single'), 'Single');

// --- degenerate input must not throw or render "undefined" ------------------
assert.equal(toolDisplayName(''), '');
assert.equal(toolDisplayName(undefined), '');
assert.equal(toolDisplayName(null), '');

// --- no curated name may look like an identifier ----------------------------
for (const [tool, meta] of Object.entries(TOOL_META)) {
  assert.ok(!meta.name.includes('_'),
    `TOOL_META['${tool}'].name still contains an underscore: ${meta.name}`);
  assert.ok(/^[A-Z0-9]/.test(meta.name),
    `TOOL_META['${tool}'].name must start capitalised: ${meta.name}`);
}

// --- every entry carries one of the six known categories --------------------
const CATS = new Set(['read', 'change', 'run', 'search', 'delegate', 'plan']);
for (const [tool, meta] of Object.entries(TOOL_META)) {
  assert.ok(CATS.has(meta.cat), `TOOL_META['${tool}'] has unknown cat '${meta.cat}'`);
}
assert.equal(toolCategory('some_new_tool'), 'other',
  'an unmapped tool must fall into the other bucket, not vanish');

console.log('tool naming: OK');
