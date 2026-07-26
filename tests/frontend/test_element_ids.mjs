// Every element id app.js looks up with $() must exist in index.html.
//
// app.js's init() wires listeners with `$('someId').addEventListener(...)`. If
// the markup no longer has that id, $() returns null and init() throws — which
// aborts the REST of init, leaving a half-wired app with no console visible to
// the user in a packaged desktop build. Restructuring the markup (as the
// workspace picker and LLM settings rewrites do) is exactly when this breaks.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');

const declared = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));

// Ids app.js creates at runtime rather than finding in the markup.
const CREATED_AT_RUNTIME = new Set(['concurrency-dock', 'subagents-fab']);

const looked_up = new Set(
  [...app.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));

const missing = [...looked_up].filter(id => !declared.has(id) && !CREATED_AT_RUNTIME.has(id));

assert.deepEqual(missing.sort(), [],
  'app.js calls $() on ids that do not exist in index.html. $() returns null and '
  + 'init() throws, aborting the rest of the wiring:\n  ' + missing.join('\n  '));

// getElementById used directly (outside the $ helper) counts too.
const direct = [...app.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]);
const missingDirect = direct.filter(id => !declared.has(id) && !CREATED_AT_RUNTIME.has(id));
assert.deepEqual([...new Set(missingDirect)].sort(), [],
  'getElementById on ids missing from index.html:\n  ' + missingDirect.join('\n  '));

// Sanity: the extractors must actually be finding things.
assert.ok(declared.size > 50, `only found ${declared.size} ids in index.html`);
assert.ok(looked_up.size > 50, `only found ${looked_up.size} $() lookups in app.js`);

console.log(`element ids: OK (${looked_up.size} lookups against ${declared.size} declared ids)`);
