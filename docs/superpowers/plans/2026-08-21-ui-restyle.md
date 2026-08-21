# UI Restyle "Instrument" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a deliberate identity — cool machined-graphite surfaces with one warm amber signal, a bundled typeface, and an SVG icon system replacing the 98 glyphs standing in for one.

**Architecture:** Re-value the existing CSS custom properties rather than rebuilding them; all 180 classes inherit. Token NAMES are unchanged (`--term-cyan` holds amber) because that one name has 76 call sites. Panels separate by tone instead of borders. Icons ship as one inline SVG sprite themed by `currentColor`.

**Tech Stack:** Vanilla JS, precompiled Tailwind, CSS custom properties, pywebview. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-ui-restyle-design.md` — read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- **No layout or component-shape changes.** Re-token and icons only.
- **No token renaming.** `--term-cyan` is the accent slot and keeps its historical name; `tailwind.config.js` already documents why. Exactly ONE token is added: `--term-raised`.
- **No new runtime dependencies, no CDN.** The font is fetched once during implementation and committed; the running app fetches nothing.
- **Colour tokens are space-separated RGB triples, not hex** — `--term-bg: 19 21 24;`. `tests/frontend/test_contrast.mjs` parses that exact format with the regex `--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);`. A hex value silently disappears from the contrast check.
- **Component classes live in `index.html`'s `<style>` block**, never `tailwind.input.css` (three `@tailwind` lines). That block is what `test_tailwind_classes.mjs` reads.
- **Rebuild Tailwind after markup or config changes:** from `frontend/`, `npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify`
- **Frontend test files need `git add -f`** (`.gitignore` contains `/tests/`). Verify with `git ls-files --error-unmatch <path>`.
- **Do not commit `__pycache__`/`.pyc`.** `git status --short` clean before every commit.
- **The Python green bar is a FAILURE SET, not a count:** exactly `tests/test_fs_api.py::test_symlink_out_of_the_workspace_is_rejected` and both `tests/test_host_exec.py::test_tool_directory_is_on_path` params fail — pre-existing and environmental. Anything else is a regression.
- **Every existing frontend suite must stay green.** A restyle that breaks the workflow tree or the device picker has failed however it looks.

## The verified palette

These values are **already contrast-checked** against `test_contrast.mjs`'s own maths — do not re-derive them, and do not substitute "similar" colours. Ratios are `bg / panel`, and every value also clears AA on `--term-raised`, which Task 2 adds to the checked surfaces.

**Dark (`:root`)**

| Token | RGB | Hex | Notes |
|---|---|---|---|
| `--term-bg` | `19 21 24` | #131518 | floor |
| `--term-panel` | `23 25 28` | #17191C | default surface |
| `--term-raised` | `31 34 38` | #1F2226 | **NEW** — third step |
| `--term-line` | `42 46 51` | #2A2E33 | real edges only |
| `--term-text` | `232 234 236` | #E8EAEC | **15.16** on bg (needs ≥7 AAA) |
| `--term-muted` | `154 160 166` | #9AA0A6 | 6.93 / 6.67 |
| `--term-cyan` | `230 164 74` | #E6A44A | the accent |
| `--term-green` | `127 159 122` | #7F9F7A | done |
| `--term-red` | `196 115 107` | #C4736B | failed |
| `--term-orange` | `194 154 94` | #C29A5E | warning — duller than the accent on purpose |
| `--term-magenta` | `138 155 176` | #8A9BB0 | informational |
| `--term-gray` | `95 106 114` | #5F6A72 | cached / inactive |

**Dark `-fg` variants.** Five of six equal their base — verified, not assumed:

| Token | RGB | Ratio |
|---|---|---|
| `--term-cyan-fg` | `230 164 74` | 8.51 / 8.20 |
| `--term-green-fg` | `127 159 122` | 6.22 / 5.99 |
| `--term-red-fg` | `196 115 107` | 5.24 / 5.04 |
| `--term-orange-fg` | `194 154 94` | 7.04 / 6.78 |
| `--term-magenta-fg` | `138 155 176` | 6.44 / 6.20 |
| `--term-gray-fg` | `138 147 153` | 5.85 / 5.63 — **the only one that differs**; the base is 3.30 and fails |

**Light (`html.light`)** — overrides the same subset it does today:

| Token | RGB | Hex |
|---|---|---|
| `--term-bg` | `250 250 250` | #FAFAFA |
| `--term-panel` | `255 255 255` | #FFFFFF |
| `--term-raised` | `241 242 244` | #F1F2F4 |
| `--term-line` | `227 229 232` | #E3E5E8 |
| `--term-text` | `26 28 31` | #1A1C1F — 16.36 on bg |
| `--term-muted` | `90 97 103` | #5A6167 — 6.02 / 6.29 |
| `--term-cyan-fg` | `138 98 44` | #8A622C — 5.21 / 5.43 |
| `--term-green-fg` | `90 113 87` | #5A7157 — 5.11 / 5.34 |
| `--term-red-fg` | `153 90 83` | #995A53 — 5.10 / 5.33 |
| `--term-orange-fg` | `128 102 62` | #80663E — 5.17 / 5.40 |
| `--term-magenta-fg` | `97 108 123` | #616C7B — 5.11 / 5.33 |
| `--term-gray-fg` | `95 106 114` | #5F6A72 — 5.31 / 5.54 |

Light's binding surface is `--term-raised` (#F1F2F4), the darkest of its three —
these values are tuned against it, not against white.

Light keeps the dark base accent values for fills (chips, dots); the contrast test only governs `-fg`.

## File Structure

**Created:** `frontend/fonts/ibm-plex-sans-var.woff2`, `frontend/fonts/LICENSE-OFL.txt`, `frontend/icons.svg`, `frontend/icons.js`, `tests/frontend/test_font.mjs`, `tests/frontend/test_icons.mjs`, `tests/frontend/test_no_emoji.mjs`

**Modified:** `frontend/index.html` (tokens, `@font-face`, borders, glyphs), `frontend/tailwind.config.js` (`term.raised`, font stack, `./icons.js`), `frontend/app.js` (84 glyphs), `frontend/workflow_view.js` (1 glyph + the run rail), `tests/frontend/test_element_ids.mjs` + `test_tailwind_classes.mjs` (scan `icons.js`), `AGENTS.md`

---

### Task 1: Bundle the typeface

**Files:**
- Create: `frontend/fonts/ibm-plex-sans-var.woff2`, `frontend/fonts/LICENSE-OFL.txt`
- Modify: `frontend/index.html` (`<style>` block), `frontend/tailwind.config.js`
- Test: `tests/frontend/test_font.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the CSS family name `"IBM Plex Sans Var"`, available to later tasks via `--font-ui`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/test_font.mjs`:

```javascript
// The app is offline: a font that is referenced but not bundled silently falls
// back, and the UI then renders differently on every machine — green tests, wrong
// typography. This asserts the whole chain: file, licence, @font-face, fallback.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');

const font = path.join(FRONTEND, 'fonts', 'ibm-plex-sans-var.woff2');
assert.ok(fs.existsSync(font), 'the variable font is not bundled at frontend/fonts/');
const bytes = fs.statSync(font).size;
assert.ok(bytes > 10000, `font file is only ${bytes} bytes — truncated download?`);
assert.ok(bytes < 400000, `font file is ${bytes} bytes — expected a latin subset`);

assert.ok(fs.existsSync(path.join(FRONTEND, 'fonts', 'LICENSE-OFL.txt')),
  'the SIL OFL licence must ship beside the font');

assert.ok(/@font-face\s*{[^}]*IBM Plex Sans Var[^}]*}/s.test(html),
  'no @font-face declaring "IBM Plex Sans Var"');
assert.ok(/url\(["']?fonts\/ibm-plex-sans-var\.woff2/.test(html),
  '@font-face does not point at the bundled file by relative path');
assert.ok(/font-display:\s*swap/.test(html),
  'font-display: swap keeps text visible while the face loads');

// A bundled font can fail to load from file:// inside a webview. The fallback is
// what keeps the app usable when it does.
const uiVar = html.match(/--font-ui:\s*([^;]+);/);
assert.ok(uiVar, 'no --font-ui token');
assert.ok(/IBM Plex Sans Var/.test(uiVar[1]), '--font-ui must name the bundled face first');
assert.ok(/(system-ui|ui-sans-serif|Segoe UI)/.test(uiVar[1]),
  '--font-ui must carry a system fallback stack');

console.log('font: OK (bundled, licensed, declared, with fallback)');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_font.mjs`
Expected: FAIL — `the variable font is not bundled at frontend/fonts/`

- [ ] **Step 3: Fetch and wire the font**

```bash
mkdir -p frontend/fonts
curl -L -o frontend/fonts/ibm-plex-sans-var.woff2 \
  "https://cdn.jsdelivr.net/npm/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2"
curl -L -o frontend/fonts/LICENSE-OFL.txt \
  "https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt"
```

Verify the download is a real font, not an error page: `ls -l frontend/fonts/` should show roughly 45 KB, and `head -c 4 frontend/fonts/ibm-plex-sans-var.woff2` should print `wOF2`.

In `index.html`'s `<style>` block, at the very top (before `:root`):

```css
    /* Bundled so the UI renders identically everywhere and needs no network.
       The fallback stack matters: a webview that cannot load a file:// font
       must still be usable. */
    @font-face {
      font-family: 'IBM Plex Sans Var';
      src: url('fonts/ibm-plex-sans-var.woff2') format('woff2-variations');
      font-weight: 100 700;
      font-style: normal;
      font-display: swap;
    }
```

Add to `:root`:

```css
      --font-ui: 'IBM Plex Sans Var', ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
```

In `tailwind.config.js`, change the `sans` entry so every Tailwind `font-sans` picks it up:

```js
        sans: ['IBM Plex Sans Var', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/frontend/test_font.mjs`
Expected: `font: OK (bundled, licensed, declared, with fallback)`

Run: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify && cd ..`
Then: `node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_boot.mjs`
Expected: `OK` from each.

- [ ] **Step 5: Commit**

```bash
git add -f frontend/fonts frontend/index.html frontend/tailwind.config.js frontend/tailwind.css tests/frontend/test_font.mjs
git commit -m "feat(ui): bundle IBM Plex Sans Variable with a system fallback"
```

---

### Task 2: The palette

**Files:**
- Modify: `frontend/index.html` (`:root` and `html.light` token blocks), `frontend/tailwind.config.js`
- Test: `tests/frontend/test_contrast.mjs` (existing — it validates automatically)

**Interfaces:**
- Consumes: nothing.
- Produces: `--term-raised` and the re-valued palette, consumed by every later task.

- [ ] **Step 1: Run the contrast test to see the current baseline**

Run: `node tests/frontend/test_contrast.mjs`
Expected: `contrast: OK (28 ratios checked)` — the CURRENT palette passing. Note the count; it rises when `--term-raised` is added to the checked surfaces.

- [ ] **Step 2: Replace the dark token values**

In `index.html`'s `:root`, set exactly these — **space-separated RGB, not hex**, because `test_contrast.mjs` parses that format and a hex value silently drops out of the check:

```css
      /* "Instrument": cool machined graphite, one warm signal.
         Surfaces separate by TONE — bg / panel / raised — and --term-line is
         reserved for real edges (inputs, focus, the run rail), never for
         outlining a panel. Every value below is contrast-verified; see
         docs/superpowers/specs/2026-08-21-ui-restyle-design.md. */
      --term-bg: 19 21 24;         /* #131518 */
      --term-panel: 23 25 28;      /* #17191C */
      --term-raised: 31 34 38;     /* #1F2226 — selected tab, hovered row, chip */
      --term-line: 42 46 51;       /* #2A2E33 */
      --term-muted: 154 160 166;   /* #9AA0A6 — 6.93 bg / 6.67 panel */
      --term-text: 232 234 236;    /* #E8EAEC — 15.16 on bg */
      --term-cyan: 230 164 74;     /* #E6A44A — the accent */
      --term-green: 127 159 122;   /* #7F9F7A */
      --term-magenta: 138 155 176; /* #8A9BB0 */
      --term-orange: 194 154 94;   /* #C29A5E — duller than the accent on purpose */
      --term-red: 196 115 107;     /* #C4736B */
      --term-gray: 95 106 114;     /* #5F6A72 */

      /* Five of six -fg variants equal their base: the desaturated status
         palette already clears AA. Only gray needed lifting (base is 3.30). */
      --term-cyan-fg: 230 164 74;     /* 8.51 / 8.20 */
      --term-green-fg: 127 159 122;   /* 6.22 / 5.99 */
      --term-red-fg: 196 115 107;     /* 5.24 / 5.04 */
      --term-magenta-fg: 138 155 176; /* 6.44 / 6.20 */
      --term-orange-fg: 194 154 94;   /* 7.04 / 6.78 */
      --term-gray-fg: 138 147 153;    /* #8A9399 — 5.85 bg / 5.63 panel / 5.11 raised */
```

Keep the shimmer tokens, but re-tune them to the cool family:

```css
      --shimmer-base: 122 130 137;
      --shimmer-hi: 232 234 236;
      --shimmer-glow: rgba(255, 255, 255, .12);
```

- [ ] **Step 3: Replace the light token values**

In `html.light`, override the same subset it overrides today:

```css
      --term-bg: 250 250 250;      /* #FAFAFA */
      --term-panel: 255 255 255;   /* #FFFFFF */
      --term-raised: 241 242 244;  /* #F1F2F4 */
      --term-line: 227 229 232;    /* #E3E5E8 */
      --term-muted: 90 97 103;     /* #5A6167 — 6.02 / 6.29 */
      --term-text: 26 28 31;       /* #1A1C1F — 16.36 on bg */
      --term-cyan-fg: 138 98 44;      /* #8A622C — 5.21 / 5.43 / 4.85 raised */
      --term-green-fg: 90 113 87;     /* #5A7157 — 5.11 / 5.34 / 4.76 */
      --term-red-fg: 153 90 83;       /* #995A53 — 5.10 / 5.33 / 4.76 */
      --term-magenta-fg: 97 108 123;  /* #616C7B — 5.11 / 5.33 / 4.76 */
      --term-orange-fg: 128 102 62;   /* #80663E — 5.17 / 5.40 / 4.82 */
      --term-gray-fg: 95 106 114;     /* #5F6A72 — 5.31 / 5.54 */
      --shimmer-base: 150 155 160;
      --shimmer-hi: 26 28 31;
      --shimmer-glow: rgba(0, 0, 0, .08);
```

Keep the light theme's base accent values as they are — the contrast test governs only `-fg`, and the base values are used for fills.

- [ ] **Step 4: Add `--term-raised` to Tailwind**

In `tailwind.config.js`, inside `colors.term`, beside `panel`:

```js
          raised: 'rgb(var(--term-raised) / <alpha-value>)',
```

- [ ] **Step 5: Extend the contrast test to cover the new surface**

`--term-raised` carries text (chips, selected rows), so it belongs in the check. In `tests/frontend/test_contrast.mjs`, change the surface loop:

```javascript
  for (const surface of ['term-bg', 'term-panel', 'term-raised']) {
```

- [ ] **Step 6: Run the tests**

Run: `node tests/frontend/test_contrast.mjs`
Expected: `contrast: OK (42 ratios checked)` — 14 per surface × 3 surfaces. If any assertion fails it names the token, the surface and the measured ratio; fix by adjusting that `-fg` value upward (dark) or downward (light) until it clears 4.5, and **never** by lowering the threshold.

Run: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify && cd ..`
Then: `node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_boot.mjs && node tests/frontend/test_element_ids.mjs`
Expected: `OK` from each.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html frontend/tailwind.config.js frontend/tailwind.css
git add -f tests/frontend/test_contrast.mjs
git commit -m "feat(ui): Instrument palette — cool graphite surfaces, warm signal accent"
```

---

### Task 3: Tone instead of borders

**Files:**
- Modify: `frontend/index.html` (`<style>` block and markup)

**Interfaces:**
- Consumes: `--term-raised` from Task 2.
- Produces: nothing new.

This is the change that most makes the app read cleaner, and it is the one structurally Google-inspired idea in the design: panels stop being outlined and start being distinguished by tone.

- [ ] **Step 1: Find every panel border**

Run: `grep -n "border-term-line\|border: 1px solid rgb(var(--term-line))" frontend/index.html | head -40`

Classify each hit into one of two groups. **Keep** the border where there is a real edge the user interacts with or needs to locate precisely:
- inputs, textareas, selects (`.field`)
- focus rings
- the composer's outer edge
- table/row separators inside a scrolling list where rows would otherwise merge

**Remove** it where it is merely outlining a container, and give that container `background: rgb(var(--term-panel))` or `--term-raised` instead:
- panel and card wrappers
- the tab strip
- chips and pills
- the sidebar's outer edge
- modal bodies (keep the modal's own edge)

- [ ] **Step 2: Apply the change**

For each container in the "remove" group, delete the `border` declaration (or the `border-term-line` utility from its class list) and ensure it sits on a different tone from its parent — `--term-panel` on `--term-bg`, or `--term-raised` on `--term-panel`. A container that ends up the same tone as its parent has lost its separation: give it the next step up, not a border back.

Selected/active states move from "border + tint" to `--term-raised`, which is what that token exists for.

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify && cd ..`
Then run all seven frontend suites:
`for t in test_workflow_library test_workflow_view test_device_picker test_boot test_element_ids test_tailwind_classes test_contrast; do node tests/frontend/$t.mjs; done`
Expected: `OK` from each. `test_tailwind_classes` is the one most likely to catch a mistake here — a removed utility that is still referenced, or a new one that was never compiled.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/tailwind.css
git commit -m "feat(ui): separate surfaces by tone, reserving borders for real edges"
```

---

### Task 4: The icon sprite

**Files:**
- Create: `frontend/icons.svg`, `frontend/icons.js`
- Modify: `frontend/index.html` (script tag), `frontend/tailwind.config.js` (content glob)
- Test: `tests/frontend/test_icons.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: global `icon(name, cls)` returning an SVG string, and the sprite injected on load. No other export.

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/test_icons.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_icons.mjs`
Expected: FAIL — `ENOENT … frontend/icons.svg`

- [ ] **Step 3: Create the sprite**

Create `frontend/icons.svg`. Geometry is uniform: 24×24, `stroke-width` 1.75, round caps and joins, no fills. Paths follow Lucide's geometry (ISC licence — the notice below is what it asks for).

```svg
<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
<!-- Icon geometry adapted from Lucide (https://lucide.dev), ISC License.
     Copyright (c) for portions from Feather (c) 2013-2023 Cole Bemis.
     One sprite, one geometry: 24x24, 1.75 stroke, round caps/joins, no fill.
     Icons inherit colour through currentColor, so themes need no variants. -->
<symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
<symbol id="i-x-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></symbol>
<symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></symbol>
<symbol id="i-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></symbol>
<symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
<symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5M11 18l-6-6 6-6"/></symbol>
<symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
<symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M18 13l-6 6-6-6"/></symbol>
<symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></symbol>
<symbol id="i-chevron-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></symbol>
<symbol id="i-square" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M4 20h16a1 1 0 0 0 1-1V9a2 2 0 0 0-2-2h-7l-2-2H6a2 2 0 0 0-2 2v11a1 1 0 0 0 0 0z"/></symbol>
<symbol id="i-folder-open" viewBox="0 0 24 24"><path d="M4 20V7a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v1"/><path d="M3.5 20l2.2-7.3a1 1 0 0 1 1-.7h14a1 1 0 0 1 .95 1.3L19.5 20z"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></symbol>
<symbol id="i-file-code" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M10 12l-2 2 2 2M14 12l2 2-2 2"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6"/></symbol>
<symbol id="i-package" viewBox="0 0 24 24"><path d="M21 8.5v7a2 2 0 0 1-1 1.7l-7 3.9a2 2 0 0 1-2 0l-7-3.9a2 2 0 0 1-1-1.7v-7a2 2 0 0 1 1-1.7l7-3.9a2 2 0 0 1 2 0l7 3.9a2 2 0 0 1 1 1.7z"/><path d="M3.3 7.4 12 12l8.7-4.6M12 12v9"/></symbol>
<symbol id="i-puzzle" viewBox="0 0 24 24"><path d="M9 3a2 2 0 0 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 0 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 0 1-4 0v-1H6a1 1 0 0 1-1-1v-3H4a2 2 0 0 1 0-4h1V5a1 1 0 0 1 1-1h3z"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/></symbol>
<symbol id="i-monitor" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>
<symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></symbol>
<symbol id="i-alert-triangle" viewBox="0 0 24 24"><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></symbol>
<symbol id="i-ban" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></symbol>
<symbol id="i-more-horizontal" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
<symbol id="i-grip-vertical" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></symbol>
<symbol id="i-corner-down-right" viewBox="0 0 24 24"><path d="M4 5v6a2 2 0 0 0 2 2h12"/><path d="M15 10l5 3-5 3"/></symbol>
<symbol id="i-loader" viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></symbol>
</svg>
```

- [ ] **Step 4: Create the helper**

Create `frontend/icons.js`:

```javascript
// One sprite, injected once; icon() returns an <svg><use> that inherits colour
// through currentColor. Kept out of app.js, which is already 4,400+ lines.
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // The sprite is fetched from the same directory as the page. In a webview this
  // is a file:// read, so a failure is silent — log it rather than leaving the UI
  // mysteriously iconless.
  function injectSprite() {
    fetch('icons.svg')
      .then((r) => r.text())
      .then((svg) => {
        const host = document.createElement('div');
        host.style.display = 'none';
        host.setAttribute('aria-hidden', 'true');
        host.innerHTML = svg;
        document.body.appendChild(host);
      })
      .catch((e) => console.error('[icons] sprite failed to load:', e));
  }

  function icon(name, cls) {
    const c = cls ? ` ${cls}` : '';
    return `<svg class="ico${c}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
         + `<use href="#i-${name}"></use></svg>`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSprite);
  } else {
    injectSprite();
  }

  Object.assign(typeof window !== 'undefined' ? window : globalThis, { icon });
})();
```

Add the base class to `index.html`'s `<style>` block:

```css
    .ico { width: 16px; height: 16px; display: inline-block; vertical-align: -3px;
           fill: none; stroke: currentColor; stroke-width: 1.75;
           stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
    .ico-lg { width: 20px; height: 20px; vertical-align: -4px; }
    .ico-spin { animation: ico-spin 900ms linear infinite; }
    @keyframes ico-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .ico-spin { animation: none; } }
```

Add the script tag in `index.html` beside the other view scripts, **before** `app.js`:

```html
  <script defer src="icons.js"></script>
```

Add `'./icons.js'` to `tailwind.config.js`'s `content` array.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/frontend/test_icons.mjs`
Expected: `icons: OK (33 symbols, 0 referenced)` — zero references is correct here; Tasks 5 and 6 add them.

Run: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify && cd ..`
Then: `node tests/frontend/test_boot.mjs && node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_element_ids.mjs`
Expected: `OK` from each.

- [ ] **Step 6: Commit**

```bash
git add frontend/icons.svg frontend/icons.js frontend/index.html frontend/tailwind.config.js frontend/tailwind.css
git add -f tests/frontend/test_icons.mjs
git commit -m "feat(ui): SVG icon sprite with a currentColor-themed icon() helper"
```

---

### Task 5: Migrate the glyphs in `index.html` and `workflow_view.js`

**Files:**
- Modify: `frontend/index.html` (13 glyphs), `frontend/workflow_view.js` (1 glyph)

**Interfaces:**
- Consumes: `icon(name, cls)` and the sprite from Task 4.
- Produces: nothing new.

- [ ] **Step 1: List what needs replacing**

Run: `node -e "const fs=require('fs');for(const f of ['index.html','workflow_view.js']){const t=fs.readFileSync('frontend/'+f,'utf8');const m=[...t.matchAll(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{2600}-\u{27BF}]/gu)];console.log(f, m.length, [...new Set(m.map(x=>x[0]))].join(' '));}"`

- [ ] **Step 2: Replace each, using this mapping**

| Glyph | Icon |
|---|---|
| `✕` | `x` |
| `✓` | `check` |
| `✗` | `x-circle` |
| `→` | `arrow-right` |
| `←` | `arrow-left` |
| `↑` `⇡` | `arrow-up` |
| `↓` | `arrow-down` |
| `▶` | `play` |
| `○` | `circle` |
| `⚙` | `settings` |
| `⠿` | `grip-vertical` |
| `⤵` | `corner-down-right` |
| `⚠` | `alert-triangle` |
| `🚫` | `ban` |
| `⋯` | `more-horizontal` |
| `⚡` | `zap` |
| `📁` | `folder` |
| `📂` | `folder-open` |
| `📄` | `file` |
| `🐍` | `file-code` |
| `🗑` | `trash` |
| `📦` | `package` |
| `🧩` | `puzzle` |
| `🖼` | `image` |
| `⠧` (spinner) | `loader` + `ico-spin` |

In static markup use `<svg class="ico"><use href="#i-NAME"></use></svg>` directly; in JS-built strings use `icon('NAME')`.

An element that was a bare glyph and carried meaning needs an accessible name, since an SVG has none: give the element `aria-label` (or `title`) matching what the glyph meant. A decorative glyph beside a text label needs nothing — the sprite already sets `aria-hidden`.

- [ ] **Step 3: Verify**

Run: `node tests/frontend/test_icons.mjs && node tests/frontend/test_element_ids.mjs && node tests/frontend/test_workflow_view.mjs && node tests/frontend/test_boot.mjs`
Expected: `OK` from each. `test_icons` now reports a non-zero reference count.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/workflow_view.js
git commit -m "feat(ui): replace glyphs with sprite icons in index.html and the workflow view"
```

---

### Task 6: Migrate the 84 glyphs in `app.js`

**Files:**
- Modify: `frontend/app.js`
- Test: `tests/frontend/test_no_emoji.mjs`

**Interfaces:**
- Consumes: `icon(name, cls)` from Task 4.
- Produces: nothing new.

This is the bulk of the debt and the highest-volume mechanical change in the plan. The sprite guard from Task 4 is what makes it safe: a wrong icon name fails the test rather than rendering blank.

- [ ] **Step 1: Write the failing test**

Create `tests/frontend/test_no_emoji.mjs`:

```javascript
// Glyphs stood in for an icon system for a long time. This is the guard that
// stops them creeping back once the sprite exists.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');
const FILES = ['index.html', 'app.js', 'workflow_view.js', 'workflow_library.js',
               'device_view.js', 'wave_stats.js', 'icons.js'];

// Pictographs, dingbats, arrows and box/braille glyphs used as icons. Typographic
// punctuation an interface legitimately needs — — – … · × ° — is NOT matched.
const GLYPH = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2800}-\u{28FF}\u{25A0}-\u{25FF}\u{FE0F}]/gu;

const offenders = [];
for (const f of FILES) {
  const p = path.join(FRONTEND, f);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(GLYPH)) {
      offenders.push(`${f}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 70)}`);
    }
  });
}

assert.deepEqual(offenders, [],
  'glyphs are being used where a sprite icon belongs:\n  ' + offenders.join('\n  '));

console.log(`no-emoji: OK (${FILES.length} files clean)`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/frontend/test_no_emoji.mjs`
Expected: FAIL, listing the remaining `app.js` glyphs with file, line and context.

- [ ] **Step 3: Replace them**

Work through the failures using the same mapping table as Task 5. Every replacement in `app.js` is inside a JS string, so the form is `${icon('x')}` in a template literal or `icon('x')` in a concatenation.

Three cases need judgment rather than substitution:

1. **The braille spinner.** Frames are cycled by JS (`⠿ ⠧ …`). Replace the whole mechanism with `icon('loader', 'ico-spin')` and delete the frame-cycling code and its timer — CSS does the animation now, and the `prefers-reduced-motion` rule added in Task 4 handles accessibility for free.
2. **Glyphs inside `TOOL_META` display names**, if any. Those strings are asserted by `tests/test_tool_meta_coverage.py::test_display_names_are_human_readable` — keep them plain text with no icon markup.
3. **Glyphs that carry meaning alone** (a bare `✓` in a status cell). Add `aria-label` to the containing element so the meaning survives the swap.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/frontend/test_no_emoji.mjs`
Expected: `no-emoji: OK (7 files clean)`

Run: `node tests/frontend/test_icons.mjs`
Expected: `OK` — this is the check that every name used actually exists in the sprite.

Run the whole frontend suite plus the Python guard that parses `app.js`:
`for t in test_workflow_library test_workflow_view test_device_picker test_boot test_element_ids test_tailwind_classes test_contrast test_wave_stats; do node tests/frontend/$t.mjs; done`
`.venv/Scripts/python.exe -m pytest tests/test_tool_meta_coverage.py -q`
Expected: `OK` from each, and the pytest file green.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js
git add -f tests/frontend/test_no_emoji.mjs
git commit -m "feat(ui): replace the remaining 84 glyphs in app.js with sprite icons"
```

---

### Task 7: The run rail

**Files:**
- Modify: `frontend/workflow_view.js`, `frontend/index.html` (`<style>` block)

**Interfaces:**
- Consumes: the palette from Task 2.
- Produces: nothing new.

The signature element — the one place boldness is spent. Agent rows hang off a continuous hairline per phase so a live workflow reads as a chart being drawn rather than a list growing.

- [ ] **Step 1: Add the styles**

In `index.html`'s `<style>` block, beside the other `wf-*` classes:

```css
    /* The run rail: one hairline per phase, one mark per agent. Filled = done,
       hollow ring = running, dimmed = a cached replay. */
    .wf-mark { width: 15px; flex-shrink: 0; display: flex; justify-content: center;
               position: relative; }
    .wf-mark::before { content: ''; position: absolute; left: 7px; top: -11px; bottom: -11px;
                       width: 1px; background: rgb(var(--term-line)); }
    .wf-agent:first-of-type .wf-mark::before { top: 50%; }
    .wf-agent:last-of-type  .wf-mark::before { bottom: 50%; }
    .wf-dot { width: 7px; height: 7px; border-radius: 50%; position: relative; z-index: 1;
              background: rgb(var(--term-gray)); }
    .wf-dot-ok   { background: rgb(var(--term-green)); }
    .wf-dot-fail { background: rgb(var(--term-red)); }
    .wf-dot-warn { background: rgb(var(--term-orange)); }
    .wf-dot-run  { background: transparent; border: 1.5px solid rgb(var(--term-cyan)); }
    .wf-dot-cached { background: rgb(var(--term-gray)); opacity: .55; }
```

- [ ] **Step 2: Render the mark column**

In `workflow_view.js`'s agent-row rendering, wrap the existing status dot in a `.wf-mark` container so the hairline has something to attach to, and pick the dot class from status: `done` → `wf-dot-ok`, `failed` → `wf-dot-fail`, `running` → `wf-dot-run`, plus `wf-dot-cached` when the row is a cached replay. Keep every existing class and `data-` attribute on the row itself — `test_workflow_view.mjs` and the click delegation both depend on them.

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify && cd ..`
Then: `node tests/frontend/test_workflow_view.mjs && node tests/frontend/test_workflow_library.mjs && node tests/frontend/test_tailwind_classes.mjs && node tests/frontend/test_contrast.mjs && node tests/frontend/test_boot.mjs`
Expected: `OK` from each.

- [ ] **Step 4: Commit**

```bash
git add frontend/workflow_view.js frontend/index.html frontend/tailwind.css
git commit -m "feat(ui): the run rail — a workflow reads as a chart being drawn"
```

---

### Task 8: Type retune

**Files:**
- Modify: `frontend/index.html` (`<style>` block)

**Interfaces:**
- Consumes: `--font-ui` from Task 1.
- Produces: nothing new.

The seven-step ramp keeps its sizes — it was already deliberate. Only weight, letter-spacing and numerals change.

- [ ] **Step 1: Apply**

In the `<style>` block:

```css
    /* Plex is a touch wider than the system stack it replaces; the small sizes
       need their tracking opened and the large ones tightened. */
    body { font-family: var(--font-ui); font-feature-settings: 'cv05' 1; }

    /* Every count, token total, elapsed time and id sits in a column. Tabular
       figures stop them jittering as values change. */
    .t-2xs, .t-xs, .wf-agent-meta, .wf-run-meta, .row-m, .font-mono,
    [class*="tabular"] { font-variant-numeric: tabular-nums; }

    .t-2xs { letter-spacing: .06em; }
    .t-xs  { letter-spacing: .01em; }
    .t-xl  { letter-spacing: -.015em; font-weight: 600; }
    .t-lg  { letter-spacing: -.01em; font-weight: 600; }
    .eyebrow { letter-spacing: .1em; font-weight: 600; }
```

If a class in that list does not exist in this codebase, drop it from the selector rather than inventing markup for it — `test_tailwind_classes.mjs` will tell you which are real.

- [ ] **Step 2: Verify**

Run: `cd frontend && npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify && cd ..`
Then: `for t in test_workflow_library test_workflow_view test_device_picker test_boot test_element_ids test_tailwind_classes test_contrast; do node tests/frontend/$t.mjs; done`
Expected: `OK` from each.

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/tailwind.css
git commit -m "feat(ui): retune type weights, tracking and tabular figures for Plex"
```

---

### Task 9: Document the design language

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add the section**

Append after the workflow/SSH sections, matching their voice — explain WHY, name the traps, point at the guards:

```markdown
## The UI design language (2026-08)

"Instrument": cool machined-graphite surfaces with one warm signal accent. The
palette lives in `frontend/index.html`'s `<style>` block as CSS custom
properties; all 180 component classes inherit from it, which is why a restyle
is a re-valuing rather than a rewrite.

Four things a future reader needs to know:

- **Token NAMES are historical; only values are current.** `--term-cyan` holds
  the accent (amber today, Claude terracotta before that) and `--term-*` no
  longer describes a terminal palette. Renaming would touch 76 call sites plus
  every Tailwind class derived from them, for no visual gain.
- **Colour tokens are space-separated RGB triples, not hex.**
  `tests/frontend/test_contrast.mjs` parses that exact format and RE-DERIVES
  every ratio from the CSS, so a hex value silently drops out of the check.
  Tune a colour by running that test, never by eye.
- **Surfaces separate by TONE, not borders** — `--term-bg` / `--term-panel` /
  `--term-raised`. `--term-line` is for real edges only: inputs, focus rings,
  the run rail. Outlining a panel is the thing this design moved away from.
- **Icons come from one sprite**, `frontend/icons.svg`, via `icon(name)` in
  `frontend/icons.js`, themed by `currentColor`. `test_icons.mjs` fails on a
  name with no symbol; `test_no_emoji.mjs` fails if a glyph is used where an
  icon belongs. Both exist because either mistake renders as empty space with
  no error.

Status colours are deliberately desaturated so the accent is the only saturated
warm thing on screen. That is a trade, not an oversight: a single warm accent is
only legible on a cool console if nothing else competes with it.

The typeface is IBM Plex Sans Variable (SIL OFL), bundled at `frontend/fonts/`
and loaded from a relative `@font-face` — the app is offline and fetches nothing
at runtime. The fallback stack matters: a webview that cannot load a `file://`
font must still be usable.
```

- [ ] **Step 2: Verify the claims**

Run: `node -e "const c=require('fs').readFileSync('frontend/index.html','utf8');console.log('rgb-triple tokens:',[...c.matchAll(/--term-[\w-]+:\s*\d+\s+\d+\s+\d+;/g)].length);console.log('hex tokens (should be 0):',[...c.matchAll(/--term-[\w-]+:\s*#/g)].length)"`
Expected: a non-zero triple count and **zero** hex tokens.

Run: `node tests/frontend/test_icons.mjs && node tests/frontend/test_no_emoji.mjs && node tests/frontend/test_contrast.mjs`
Expected: `OK` from each — the three guards the section names.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: the Instrument design language, its token rules and its guards"
```

---

## Verification

From a cold shell:

```bash
cd omni-agent
for t in test_font test_icons test_no_emoji test_contrast test_element_ids test_tailwind_classes test_boot test_workflow_view test_workflow_library test_device_picker test_wave_stats; do node tests/frontend/$t.mjs; done
.venv/Scripts/python.exe -m pytest tests/ -q --ignore=tests/frontend
.venv/Scripts/python.exe -c "import agent; print('agent imports ok')"
git status --short
```

Green = every frontend suite `OK`, and exactly the three pre-existing environmental Python failures named in Global Constraints.

**Then look at it.** No test can tell you whether this reads as designed. Render the app's own markup headlessly and inspect the result:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --window-size=1400,900 \
  --screenshot=/tmp/ui.png "file:///C:/Users/berat/Desktop/Omni%20Apps/omni-agent/frontend/index.html"
```

Check specifically: no panel is outlined where tone should separate it; icons sit optically consistent at 16px; numbers in columns do not jitter; the run rail reads as one continuous line per phase; and the accent appears rarely enough to still mean something.
