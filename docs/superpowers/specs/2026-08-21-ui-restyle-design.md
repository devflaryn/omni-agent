# Omni-Agent: UI restyle — "Instrument"

**Date:** 2026-08-21
**Status:** DESIGN — approved in brainstorming, not yet implemented.
**Branch:** `ui-restyle` (off `main`)

## Goal

Give the app a deliberate visual identity: a cool machined-graphite dark theme
with a single warm signal accent, a bundled typeface, and a real icon system
replacing the 98 glyphs currently standing in for one.

This is sub-project 4 of 4, and the last. Sub-projects 1 (workflow engine),
2 (SSH devices) and 3 (workflow library UI) are merged.

## Confirmed design decisions (user)

1. **Re-token plus an icon system.** No layout changes, no component
   restructuring. All 180 existing classes inherit from the tokens.
2. **Dark-first, refined** — not light-first.
3. **Direction A, "Instrument"** — cool graphite surfaces, one warm amber
   signal, desaturated status colours.
4. **Icons adapted from a permissive open set** (Lucide, ISC), shipped as one
   inline SVG sprite.
5. **Bundle one variable font** — IBM Plex Sans Variable (SIL OFL).
6. **Google-INSPIRED, never Google-copied.** This is the binding constraint on
   every judgment call below.

## What "inspired, not copied" means concretely

Taken: hierarchy carried by type and space rather than borders and boxes; one
confident accent used sparingly; surfaces separated by tone; generous, engineered
spacing; colour that means something.

Rejected on purpose: Material's palette and elevation shadows, the FAB, ripples,
Roboto and Product Sans, the 8dp grid dogma, and Material Symbols — using
Google's actual icon set would be the literal copying the brief rules out. A
build that reads "Material app" has failed regardless of how clean it is.

**The inverse test.** Material is a cool surface with a cool blue accent.
Direction A is a cool surface with a WARM accent. That inversion is what makes
this hard to mistake for a copy, and it is why the accent is amber rather than
any blue.

## What already exists (verified, not assumed)

- **The token system is sound and is not being rebuilt.** 48 CSS custom
  properties in `index.html`'s `<style>` block: a 4px spacing scale, a 7-step
  type ramp, three control heights, four radii, and separate `-fg` colour
  variants tuned so small text clears WCAG AA.
- **`tests/frontend/test_contrast.mjs` RE-DERIVES its ratios from the CSS** — it
  parses the token values and computes contrast rather than asserting frozen
  numbers. New values are therefore validated automatically; they simply have to
  pass. This is the single most valuable existing guard for this work.
- **A light theme already exists** at `index.html:95` (`html.light`), and the
  contrast test covers both themes.
- **98 glyphs** stand in for icons: 84 in `app.js`, 13 in `index.html`, 1 in
  `workflow_view.js`. The newest files (`workflow_library.js`, `device_view.js`)
  have **zero** — they were written with SVG discipline, so the target pattern
  already exists in the codebase.
- Most are not pictographs. `✕ → ✓ ⚙ ⠿ ← ▶ ○` are symbols used AS icons; only
  about eight are true emoji (`📁 📂 🧩 🖼 🐍 📄 🗑 📦`).
- **`--term-cyan` is referenced 76 times** across `index.html` and `app.js`, and
  `tailwind.config.js` maps every `--term-*` into a Tailwind colour.

## Non-goals

- **No layout or component-shape changes.** Decision #1.
- **No token renaming.** See the ruling below.
- **No new theme.** Light stays derived, not redesigned.
- **No animation system.** A single spinner replacing the braille frames is in;
  a motion language is not.
- **No icon set of our own drawing.** Decision #4.

---

## The ruling that shapes the whole implementation

**Token NAMES stay; only their VALUES change.**

`--term-cyan` will hold amber. `--term-*` will describe a palette that is no
longer terminal-themed. Both are already true today — that variable currently
holds Claude terracotta, and `tailwind.config.js` documents the compromise:
*"`cyan` is the primary accent slot … it keeps its historical name so existing
class usage keeps working."*

The alternative — renaming to `--accent`, `--surface`, etc. — means touching 76
call sites plus every Tailwind class name that derives from them, across
`index.html`, `app.js` and three view files, for zero visual gain and a large
regression surface in exactly the guards (`test_element_ids`,
`test_tailwind_classes`) that protect this app.

One token is ADDED: `--term-raised`, the third surface step, which the tonal
separation needs and which has no equivalent today. It gets a matching
`tailwind.config.js` entry.

---

## The palette

Dark is authoritative; light is derived from it.

### Surfaces — three tonal steps, no borders between them

| Token | Value | Role |
|---|---|---|
| `--term-bg` | `#131518` | The floor. Inputs and wells recess to this. |
| `--term-panel` | `#17191C` | Default surface. Chat, panels, the tab strip. |
| `--term-raised` | `#1F2226` | Raised: selected tab, hovered row, chips. **New.** |
| `--term-line` | `#2A2E33` | Reserved for real edges only — input borders, focus rings, the run rail hairline. NOT for separating panels. |

The current build outlines nearly every panel with `--term-line`. Removing those
outlines and letting tone do the separating is the single change that most makes
this read cleaner, and it is the one structurally Google-inspired move in the
design.

### Text

| Token | Value | Role |
|---|---|---|
| `--term-text` | `#E8EAEC` | Primary. Cool near-white, not cream. |
| `--term-muted` | `#9AA0A6` | Secondary; must clear AA on `bg`, `panel` and `raised`. |

### The accent, and why status colours change with it

| Token | Value | Role |
|---|---|---|
| `--term-cyan` (accent) | `#E6A44A` | Signal amber. The only saturated warm thing on screen. |

Amber sits near "warning", so the semantic colours are **desaturated** to give
the accent exclusive claim to saturated warmth. This is a real trade — status
colours become quieter — and it is deliberate: it is what makes a single warm
accent legible on a cool console instead of competing with three other warm
badges.

| Token | Value | Meaning |
|---|---|---|
| `--term-green` | `#7F9F7A` | done / ok |
| `--term-red` | `#C4736B` | failed |
| `--term-orange` | `#C29A5E` | warning (deliberately duller than the accent) |
| `--term-magenta` | `#8A9BB0` | informational |
| `--term-gray` | `#5F6A72` | cached / inactive |

`-fg` variants exist for every accent used as small text and are tuned upward
until they clear 4.5:1 against **both** `--term-panel` and `--term-bg`. Exact
values are produced during implementation by the contrast test itself — it
computes ratios from the CSS, so the loop is: set a value, run the test, adjust.
**No `-fg` value is chosen by eye.**

### Light theme

Re-derived, not redesigned: the same hues, inverted lightness, with the accent
darkened until it clears AA on white. The contrast test covers both themes and
governs the result.

---

## Typography

**IBM Plex Sans Variable**, SIL OFL, bundled at `frontend/fonts/`, referenced by
a local `@font-face` with `font-display: swap` and the existing system stack as
fallback.

**Verified obtainable and cheaper than assumed.** The latin-subset weight-axis
build is **45 KB** (`@fontsource-variable/ibm-plex-sans`, fetched once at
implementation time from unpkg or jsDelivr — both confirmed reachable, HTTP 200).
That is a third of the ~150 KB a full variable font would cost, and it covers one
file with the entire weight range.

**The download happens once, during implementation; the file is committed.** The
running app never fetches anything — the no-CDN offline constraint is preserved,
which is the whole reason for bundling rather than linking.

Why not Inter: Inter is the default choice, and this brief explicitly rejects
defaults. Plex is engineered rather than neutral — it reads as industrial
software, which is what this app is — and it is decidedly not a Google face.

Two things it buys beyond character:
- **Tabular figures** (`font-variant-numeric: tabular-nums`) on every count,
  token total, elapsed time and id. This app is full of numbers in columns that
  currently jitter.
- **Identical rendering on every machine**, instead of Segoe UI here and
  something else there.

The licence file ships beside the font. Monospace stays on the system stack —
it is used only for code and paths, and bundling a second face doubles the
weight for little gain.

The type ramp keeps its seven steps and its values; only weights and
letter-spacing are retuned, since the ramp was already deliberate.

---

## The icon system

### Mechanism

One inline SVG sprite, `frontend/icons.svg`, injected once into the document, and
a helper `icon(name, className)` returning `<svg class="…"><use href="#i-name"/></svg>`.

- Themed by `currentColor`, so icons inherit text colour automatically and no
  icon needs a per-theme variant.
- 24×24 viewBox, 1.75 stroke, round caps and joins — one geometry for all.
- Offline by construction; no network, no icon font, no dependency.
- **The paths are written directly into the sprite, not pulled from a package.**
  Lucide's geometry is the reference; there is no npm install, no build step and
  nothing to keep in sync. The ISC notice ships in the sprite's header comment,
  which is what the licence asks for.
- Rendered at 16px in dense UI, 20px in headers.

### Inventory

About 30 icons, adapted from Lucide, replacing this mapping:

| Glyph | Count | Icon |
|---|---|---|
| `✕` | 12 | `x` |
| `→` | 12 | `arrow-right` |
| `✓` | 8 | `check` |
| `⚙` | 7 | `settings` |
| `⠿` | 6 | `grip-vertical` |
| `📁` `📂` | 6 | `folder`, `folder-open` |
| `✗` | 4 | `x-circle` |
| `←` | 4 | `arrow-left` |
| `▶` | 3 | `play` |
| `⚡` | 3 | `zap` |
| `○` | 3 | `circle` |
| `⇡` `↑` `↓` | 4 | `arrow-up`, `arrow-down` |
| `⚠` | 1 | `alert-triangle` |
| `🗑` | 1 | `trash` |
| `📄` `🐍` | 2 | `file`, `file-code` |
| `📦` `🧩` `🖼` | 3 | `package`, `puzzle`, `image` |
| `⋯` | 1 | `more-horizontal` |
| `⤵` | 1 | `corner-down-right` |
| `🚫` | 1 | `ban` |
| `⠧` (spinner) | 1 | `loader` + CSS rotation |

The 18 existing inline SVGs move into the sprite too, so there is exactly one
place icons live.

**The braille spinners are a special case.** `⠿`/`⠧` animate by cycling glyph
frames in JS. They become one `loader` icon rotated by CSS, which is smoother,
themeable, and deletes the frame-cycling code.

### Guard

A test asserting **every `icon('name')` referenced in any frontend JS exists as a
symbol in the sprite**, in the same spirit as the existing element-id and
Tailwind-class guards. A typo'd icon name otherwise renders as empty space with
no error — exactly the silent-failure mode this project's frontend tests exist to
catch.

A second test asserts **no emoji or pictographic glyph remains** in the frontend
sources, so the debt cannot quietly return.

---

## The signature: the run rail

The one element this design is remembered by, and the only place boldness is
spent.

Agent rows in a workflow hang off a single continuous hairline per phase, with a
mark per agent:

- **filled** — done
- **hollow ring, accent-coloured** — running
- **dimmed filled** — a cached replay

A live workflow then reads as a chart being drawn rather than a list growing.

It is unique to this app, it costs one border and one dot, and everything around
it stays quiet. It changes no markup structure — the rows already exist; the rail
is a `::before` hairline on the mark column.

---

## Testing

The existing frontend guards do most of the work, which is why this restyle is
lower-risk than its blast radius suggests.

| File | Covers |
|---|---|
| `tests/frontend/test_contrast.mjs` (existing) | Re-derives every ratio from the CSS. The new palette must clear AA in BOTH themes. The `-fg` values are tuned against this, not by eye. |
| `tests/frontend/test_tailwind_classes.mjs` (existing) | Every class used still resolves after the rebuild. |
| `tests/frontend/test_element_ids.mjs` (existing) | No id lost while editing markup. |
| `tests/frontend/test_icons.mjs` (new) | Every `icon('name')` used in any frontend JS exists in the sprite, and every symbol has a 24×24 viewBox. It does NOT reject unused symbols: the sprite carries a few (chevrons, search, plus, refresh) that the folded-in inline SVGs and near-term UI need. |
| `tests/frontend/test_no_emoji.mjs` (new) | No emoji or pictographic glyph remains in `index.html`, `app.js`, `workflow_view.js`, `workflow_library.js`, `device_view.js`, `wave_stats.js`. |
| `tests/frontend/test_font.mjs` (new) | The bundled font file exists, `@font-face` points at it, the licence ships beside it, and a fallback stack is declared. |
| `tests/frontend/test_boot.mjs` (existing) | The app still boots with the sprite injected. |

Every existing suite must stay green: a restyle that breaks the workflow tree or
the device picker has failed regardless of how it looks.

## Risks, stated plainly

- **Contrast regressions are the likeliest failure**, and the test is the answer:
  values get tuned against it rather than chosen by eye.
- **Amber against "warning"** is a real tension. The desaturated status palette is
  the mitigation, and it is a genuine trade, not a free win.
- **`app.js` holds 84 glyph replacements** — mechanical, high-volume, and exactly
  the kind of change where a wrong icon name fails silently. Hence the sprite
  guard.
- **A bundled font is a binary in git** (45 KB, verified) and must load from
  `file://` in a pywebview window — a `@font-face` that resolves in a browser can
  still fail there. If it does, the fallback stack keeps the app usable and the
  font test catches the wiring.

## Build order

1. `frontend/fonts/` — fetch and commit IBM Plex Sans Variable (45 KB latin subset) + licence, `@font-face`, fallback stack, `test_font.mjs`
2. Palette re-token: surfaces, text, accent, status, `--term-raised` + Tailwind entry, both themes, tuned against `test_contrast.mjs`
3. Remove panel borders; let tone separate surfaces
4. `frontend/icons.svg` + the `icon()` helper + `test_icons.mjs`
5. Migrate glyphs: `index.html`, then `workflow_view.js`, then `app.js` (the bulk), then `test_no_emoji.mjs`
6. The run rail treatment in `workflow_view.js`
7. Type retune: weights, letter-spacing, tabular figures
8. `AGENTS.md` — the design language, the token-name ruling, and where icons live

Steps 1-3 change how the app feels; 4-5 remove the debt; 6-7 are the polish that
makes it look designed rather than recoloured.
