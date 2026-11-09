// Contrast worked out from styles.css itself: the theme tokens, and the rules that put a text colour on a surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Every rule as { selectors, body }, in source order (at-rule wrappers are flattened, which is enough for these rules). */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: m[2] }));
const decl = (body, prop) => { const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body); return m ? m[1].trim() : null; };
/** The last value of `prop` among the rules naming exactly one of `selectors` (most specific first: the first that has one wins). */
function valueFor(selectors, prop) {
  for (const sel of selectors) {
    let v = null;
    for (const r of rules) if (r.selectors.includes(sel)) v = decl(r.body, prop) ?? v;
    if (v) return v;
  }
  return null;
}
function tokens(rootSel) {
  const out = {};
  for (const r of rules) if (r.selectors.includes(rootSel)) for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
  return out;
}
const THEMES = { dark: tokens(":root") };
THEMES.light = { ...THEMES.dark, ...tokens(':root[data-theme="light"]') };
function resolve(v, t) {
  for (let i = 0; i < 5 && /var\(/.test(v); i++) v = v.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/, (_, name, fb) => t[name] ?? fb);
  assert.match(v, /^#[0-9a-f]{6}$/i, `a solid colour: ${v}`);
  return v;
}
const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("the palette's secondary text reaches 4.5:1 on the selected row, in both themes", () => {
  const bg = valueFor([".pal-row.on"], "background");
  assert.ok(bg, "the selected row has a background");
  for (const part of ["pal-sub", "pal-kbd"]) {
    const fg = valueFor([`.pal-row.on .${part}`, `.${part}`], "color");
    for (const [name, t] of Object.entries(THEMES)) {
      const r = ratio(resolve(fg, t), resolve(bg, t));
      assert.ok(r >= 4.5, `${name}: .${part} on the selected row is ${r.toFixed(2)}:1`);
    }
  }
  // And on an unselected row (the palette's own surface), as before.
  const pal = valueFor([".pal"], "background");
  for (const part of ["pal-sub", "pal-kbd", "pal-group"]) for (const [name, t] of Object.entries(THEMES)) {
    const r = ratio(resolve(valueFor([`.${part}`], "color"), t), resolve(pal, t));
    assert.ok(r >= 4.5, `${name}: .${part} on the palette is ${r.toFixed(2)}:1`);
  }
});
