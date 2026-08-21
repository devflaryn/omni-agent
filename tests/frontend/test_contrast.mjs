// Every accent used as TEXT must clear the WCAG AA 4.5:1 floor against both
// surfaces it can sit on, in both themes.
//
// This is not hypothetical: before the -fg variants existed, --term-cyan at
// text-[11px] on --term-panel measured 4.24 in dark and 3.77 in light, and
// --term-gray measured 3.69 / 3.39. This test re-derives the ratios from the
// shipped CSS, so retuning a surface color can never silently break contrast.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, '..', '..', 'frontend', 'index.html');
const css = fs.readFileSync(INDEX, 'utf8');

// Pull one custom-property block out of the stylesheet.
function vars(selector) {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `could not find "${selector} {" in index.html`);
  const body = css.slice(at, css.indexOf('\n    }', at));
  const out = {};
  for (const [, name, val] of body.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[name] = null; // placeholder, filled below
  }
  for (const m of body.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

const relLum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const AA = 4.5;
const ACCENTS = ['cyan', 'red', 'green', 'magenta', 'orange', 'gray'];

const dark = vars(':root');
const light = { ...dark, ...vars('html.light') }; // light overrides a subset

let checked = 0;
for (const [themeName, theme] of [['dark', dark], ['light', light]]) {
  for (const surface of ['term-bg', 'term-panel']) {
    assert.ok(theme[surface], `${themeName}: missing --${surface}`);

    // muted is body-adjacent text and must also clear AA.
    const mutedR = ratio(theme['term-muted'], theme[surface]);
    assert.ok(mutedR >= AA,
      `${themeName}: --term-muted on --${surface} is ${mutedR.toFixed(2)}, needs ${AA}`);
    checked++;

    for (const a of ACCENTS) {
      const fg = theme[`term-${a}-fg`];
      assert.ok(fg, `${themeName}: missing --term-${a}-fg`);
      const r = ratio(fg, theme[surface]);
      assert.ok(r >= AA,
        `${themeName}: --term-${a}-fg on --${surface} is ${r.toFixed(2)}, needs ${AA}`);
      checked++;
    }
  }
  // Primary text should be comfortably above the floor, not merely at it.
  assert.ok(ratio(theme['term-text'], theme['term-bg']) >= 7,
    `${themeName}: --term-text should clear AAA (7:1) on --term-bg`);
}

assert.equal(checked, 28, `expected 28 contrast checks, ran ${checked}`);

// The whole point of the -fg split: the plain accents stay vivid for fills, so
// at least one of them is ALLOWED to fail as text. If every -fg equalled its
// base, the split would be pointless and someone has likely reverted it.
const differs = ACCENTS.filter(a =>
  String(dark[`term-${a}-fg`]) !== String(dark[`term-${a}`]) ||
  String(light[`term-${a}-fg`]) !== String(light[`term-${a}`]));
assert.ok(differs.length >= 4,
  `expected the -fg variants to differ from their fill colors; only ${differs.length} do`);

console.log(`contrast: OK (${checked} ratios checked)`);
