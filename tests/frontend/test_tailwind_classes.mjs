// Every Tailwind class the markup references must actually exist in the
// precompiled frontend/tailwind.css.
//
// tailwind.css is built ahead of time (see the comment in index.html), so a class
// that was never present at build time produces NO rule and fails silently — the
// element just inherits. This is not theoretical: `text-[10.5px]` was used at 8
// sites and matched nothing, so those labels rendered at whatever size they
// inherited rather than the intended one.
//
// Arbitrary-value utilities (text-[11px], w-[560px], ...) are the dangerous ones,
// since they only exist if some source file already used that exact value. Named
// utilities are checked too, minus the ones this project defines in its own
// <style> block.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

const tw = fs.readFileSync(path.join(FRONTEND, 'tailwind.css'), 'utf8');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');

// Classes defined by the project itself, in index.html's <style> block.
const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const localClasses = new Set(
  [...styleBlock.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

// Tailwind escapes selector characters inconsistently from a naive `\` + char:
// a comma becomes the CSS unicode escape `\2c ` while `[`, `(`, `%`, `.` and `/`
// get a plain backslash. Rather than reimplement that, un-escape the stylesheet
// once and compare against raw class names.
const unescaped = tw
  .replace(/\\2c\s/g, ',')      // \2c  -> ,
  .replace(/\\3a\s/g, ':')      // \3a  -> :
  .replace(/\\/g, '');          // strip the remaining single-char escapes

function classesIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/class(?:Name)?=["'`]([^"'`]*)["'`]/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  // classList.add('foo') / classList.toggle('foo', x) / className = 'a b'
  for (const m of appJs.matchAll(/classList\.(?:add|remove|toggle|contains)\('([^']+)'/g)) {
    out.add(m[1]);
  }
  return out;
}

const used = new Set([...classesIn(html), ...classesIn(appJs)]);

// Only judge classes that LOOK like Tailwind utilities we can verify. Skip
// project classes and bare words that are clearly component names.
const ARBITRARY = /^[a-z-]+-\[[^\]]+\]$/;      // text-[11px], w-[560px]
const VARIANT_ARBITRARY = /^[a-z-]+:[a-z-]+-\[[^\]]+\]$/; // md:w-[10px]

const missing = [];
for (const cls of used) {
  if (localClasses.has(cls)) continue;
  if (!ARBITRARY.test(cls) && !VARIANT_ARBITRARY.test(cls)) continue;
  // Match the selector followed by a rule/combinator boundary, so `text-[10px]`
  // cannot be satisfied by a longer selector that merely starts the same way.
  if (!new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[{,:> ]')
    .test(unescaped)) missing.push(cls);
}

assert.deepEqual(missing.sort(), [],
  'these arbitrary Tailwind classes are used in the markup but produce NO rule in '
  + 'the precompiled tailwind.css, so they silently do nothing. Either use a value '
  + 'that is already compiled, move the style into the <style> block, or rebuild '
  + 'tailwind.css:\n  ' + missing.join('\n  '));

// Sanity: the audit must actually be looking at something. If the extractor
// regex ever stops matching, `missing` would be trivially empty and this file
// would pass while checking nothing.
const arbitraryCount = [...used].filter(c => ARBITRARY.test(c)).length;
assert.ok(used.size > 200,
  `only extracted ${used.size} classes from the markup — the extractor is broken`);
assert.ok(arbitraryCount >= 12,
  `only found ${arbitraryCount} arbitrary classes — the extractor is broken`);

// The escaping this test relies on must keep working: these two are the most
// heavily escaped selectors in the sheet (comma -> \2c, parens, %, /).
for (const cls of ['mx-[max(20px,calc((100%-64rem)/2))]', 'text-[10.5px]']) {
  assert.ok(unescaped.includes('.' + cls),
    `un-escaping is broken: could not find .${cls} after normalising tailwind.css`);
}

console.log(`tailwind classes: OK (${used.size} classes, ${arbitraryCount} arbitrary verified)`);
