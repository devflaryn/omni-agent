// A typo'd icon name renders as empty space with no error — the same silent
// failure the element-id and Tailwind-class guards exist to catch.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

const sprite = fs.readFileSync(path.join(FRONTEND, 'icons.svg'), 'utf8');
const symbols = new Set([...sprite.matchAll(/<symbol[^>]*id="i-([\w-]+)"/g)].map(m => m[1]));
assert.ok(symbols.size >= 20, `sprite has only ${symbols.size} symbols`);

// Every symbol shares one geometry, or icons will not sit together optically.
for (const [, id, vb] of sprite.matchAll(/<symbol[^>]*id="i-([\w-]+)"[^>]*viewBox="([^"]+)"/g)) {
  assert.equal(vb, '0 0 24 24', `i-${id} has viewBox "${vb}", expected "0 0 24 24"`);
}

const SOURCES = ['app.js', 'workflow_view.js', 'workflow_library.js', 'device_view.js', 'icons.js'];
const used = new Set();
for (const f of SOURCES) {
  const p = path.join(FRONTEND, f);
  if (!fs.existsSync(p)) continue;
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bicon\(\s*['"]([\w-]+)['"]/g)) used.add(m[1]);
}
const missing = [...used].filter(n => !symbols.has(n)).sort();
assert.deepEqual(missing, [],
  'icon() is called with names that have no symbol in icons.svg:\n  ' + missing.join('\n  '));

// Stroke and colour live on the .ico class, not on each symbol — that is what
// lets one sprite serve both themes.
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
assert.ok(/\.ico\s*{[^}]*stroke:\s*currentColor/s.test(html),
  '.ico must set stroke: currentColor so icons inherit colour in both themes');

console.log(`icons: OK (${symbols.size} symbols, ${used.size} referenced)`);
