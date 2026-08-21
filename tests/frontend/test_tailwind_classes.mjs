// Every Tailwind class the markup references must actually exist in the
// precompiled frontend/tailwind.css.
//
// tailwind.css is built ahead of time (see the comment in index.html), so a class
// that was never present at build time produces NO rule and fails silently — the
// element just inherits. This is not theoretical: `text-[10.5px]` was used at 8
// sites and matched nothing, so those labels rendered at whatever size they
// inherited rather than the intended one.
//
// Arbitrary-value utilities (text-[11px], w-[560px], ...) are the most dangerous,
// since they only exist if some source file already used that exact value.
//
// This file used to claim it checked named utilities too. It did not — the loop
// skipped everything that was not an arbitrary value, and 17 plain utilities
// were sitting dead in the markup as a result: `mt-auto` (the start rail's
// footer never pinned to the bottom), `max-h-full` / `max-w-full` /
// `object-contain` (the file viewer's image rendered unconstrained), plus a
// dozen spacing utilities. Named utilities are now genuinely checked, against a
// list of prefixes that are unambiguously Tailwind so component and JS-hook
// class names are not swept in.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

const tw = fs.readFileSync(path.join(FRONTEND, 'tailwind.css'), 'utf8');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
// workflow_view.js, workflow_library.js and device_view.js are separate UI
// files (kept out of app.js on purpose) and get the same class protection as
// everything else.
const workflowViewJs = fs.readFileSync(path.join(FRONTEND, 'workflow_view.js'), 'utf8');
const workflowLibraryJs = fs.readFileSync(path.join(FRONTEND, 'workflow_library.js'), 'utf8');
const deviceViewJs = fs.readFileSync(path.join(FRONTEND, 'device_view.js'), 'utf8');
const iconsJs = fs.readFileSync(path.join(FRONTEND, 'icons.js'), 'utf8');
const jsSources = appJs + '\n' + workflowViewJs + '\n' + workflowLibraryJs + '\n' + deviceViewJs + '\n' + iconsJs;

// Classes defined by the project itself, in index.html's <style> block.
const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
// Un-escape first: the block now defines selectors like .p-1\.5 and
// .text-term-text\/90, whose names only match once the backslashes are gone.
const localClasses = new Set(
  [...styleBlock.replace(/\\/g, '').matchAll(/\.([a-zA-Z][\w./-]*)/g)].map(m => m[1]));

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
  for (const m of jsSources.matchAll(/classList\.(?:add|remove|toggle|contains)\('([^']+)'/g)) {
    out.add(m[1]);
  }
  return out;
}

const used = new Set([...classesIn(html), ...classesIn(jsSources)]);

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

// Named utilities whose prefix is unambiguously Tailwind. Anything matching one
// of these must resolve to a rule; a component class like `tree-row` or a JS
// hook like `llm-model-row` does not match, so it is never judged here.
const NAMED_UTILITY = new RegExp('^(?:' + [
  'm[trblxy]?-', 'p[trblxy]?-', 'gap-', 'space-[xy]-',
  'w-', 'h-', 'min-[wh]-', 'max-[wh]-', 'inset-', 'top-', 'left-', 'right-', 'bottom-',
  'flex-', 'grid-', 'col-', 'row-', 'justify-', 'items-', 'self-', 'place-', 'order-',
  'text-', 'font-', 'leading-', 'tracking-', 'align-', 'whitespace-', 'break-',
  'bg-', 'border-', 'rounded-', 'ring-', 'shadow-', 'opacity-', 'object-',
  'overflow-', 'z-', 'cursor-', 'select-', 'pointer-events-', 'truncate$',
].join('|') + ')');

for (const cls of used) {
  if (localClasses.has(cls)) continue;
  if (ARBITRARY.test(cls) || VARIANT_ARBITRARY.test(cls)) continue; // handled above
  if (cls.includes('${')) continue;                                 // template fragment
  const bare = cls.includes(':') ? cls.slice(cls.lastIndexOf(':') + 1) : cls;
  if (!NAMED_UTILITY.test(bare)) continue;
  // The base class of an escaped selector (p-1.5 -> .p-1\.5) survives unescaping.
  if (!new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '[{,:> ]')
    .test(unescaped) && !localClasses.has(bare)) missing.push(cls);
}

assert.deepEqual(missing.sort(), [],
  'these Tailwind classes are used in the markup but produce NO rule in '
  + 'the precompiled tailwind.css, so they silently do nothing. Either use a value '
  + 'that is already compiled, move the style into the <style> block, or rebuild '
  + 'tailwind.css:\n  ' + missing.join('\n  '));

// Sanity: the audit must actually be looking at something. If the extractor
// regex ever stops matching, `missing` would be trivially empty and this file
// would pass while checking nothing.
const arbitraryCount = [...used].filter(c => ARBITRARY.test(c)).length;
assert.ok(used.size > 200,
  `only extracted ${used.size} classes from the markup — the extractor is broken`);

// This used to assert a MINIMUM number of arbitrary classes found in the app
// (>= 12), as a proxy for "the ARBITRARY regex still matches things". That is
// the wrong instrument: the count legitimately falls as ad-hoc values are
// replaced by the .t-* ramp and the component classes, so a healthier codebase
// kept failing the guard. It went 30+ -> 9 -> 3 over two migrations.
//
// Test the regex against fixtures instead. That proves the matcher works
// deterministically, and stays true whether the app has three arbitrary
// classes or three hundred.
for (const good of ['text-[11px]', 'w-[560px]', 'min-h-[120px]']) {
  assert.ok(ARBITRARY.test(good), `ARBITRARY regex no longer matches ${good}`);
}
for (const bad of ['t-xs', 'flex', 'text-term-cyan']) {
  assert.ok(!ARBITRARY.test(bad), `ARBITRARY regex wrongly matches ${bad}`);
}
assert.ok(VARIANT_ARBITRARY.test('md:w-[10px]'),
  'VARIANT_ARBITRARY regex no longer matches md:w-[10px]');

// The escaping this test relies on must keep working: these two exercise the
// heaviest escapes in the sheet (comma -> \2c, parens, %, / and the decimal
// point). `text-[10.5px]` used to be the decimal-point fixture here, but it
// is no longer referenced anywhere in index.html or app.js (the .t-* type
// ramp replaced it) — a freshly rebuilt tailwind.css correctly no longer
// contains it, so pinning to it was asserting stale build output rather than
// the escaping behavior. `gap-1.5` is a live, currently-used class that hits
// the same dot-escape path (`.gap-1\.5`).
for (const cls of ['mx-[max(20px,calc((100%-64rem)/2))]', 'gap-1.5']) {
  assert.ok(unescaped.includes('.' + cls),
    `un-escaping is broken: could not find .${cls} after normalising tailwind.css`);
}

// A `hidden` that does not hide.
//
// Component classes in the <style> block set `display`, and Tailwind's .hidden
// has the same specificity — but this block is served AFTER tailwind.css, so
// the component wins and the element stays visible. #viewerBack shipped this
// way for one build: "← archive" rendered on every plain text file because
// `.btn { display: inline-flex }` beat `.hidden`.
//
// Any element combining `hidden` with a display-setting component class must
// therefore have an explicit `.component.hidden { display: none }` guard.
const displayComponents = new Set(
  [...styleBlock.matchAll(/\.([\w-]+)[^{]*\{[^}]*\bdisplay\s*:/g)].map(m => m[1]));
const guarded = new Set(
  [...styleBlock.matchAll(/\.([\w-]+)\.hidden\b/g)].map(m => m[1]));

const unguarded = [];
for (const m of html.slice(html.indexOf('</style>')).matchAll(/class="([^"]*\bhidden\b[^"]*)"/g)) {
  for (const c of m[1].split(/\s+/)) {
    if (c === 'hidden' || !displayComponents.has(c) || guarded.has(c)) continue;
    unguarded.push(`${c}  (on class="${m[1].slice(0, 60)}")`);
  }
}
assert.deepEqual([...new Set(unguarded)].sort(), [],
  'these elements combine Tailwind\'s .hidden with a component class that sets '
  + 'display. The component wins on source order, so the element stays VISIBLE. '
  + 'Add a `.<component>.hidden { display: none; }` rule:\n  '
  + [...new Set(unguarded)].join('\n  '));

console.log(`tailwind classes: OK (${used.size} classes, ${arbitraryCount} arbitrary verified, `
  + `${guarded.size} hidden-guards)`);
