# Omni Agent — UI Revision, Round 2

Date: 2026-07-26
Status: designed
Predecessor: `2026-07-26-ui-revision-design.md` (three milestones, marked implemented)

## Why there is a round 2

Round 1 built a real design system — a 4px spacing grid, a six-step type ramp,
AA-remediated accent colors, and `.btn` / `.field` / `.chip` / `.modal-*`
component classes. That work was sound. It was also **never finished**, and it
shipped without a feedback layer.

A fresh audit of the shipped branch, measured rather than estimated:

| Finding | Measured |
|---|---|
| Type set ad-hoc rather than by a class | **56 sites** — 30 raw `text-[Npx]` + 26 inline `style="font-size:var(--text-*)"` |
| Regions the component migration never reached | Graph tab sidebar (18 ad-hoc sizes), `#fileViewer` (5) |
| Buttons bypassing `.btn` entirely | 11, including four different treatments inside one ~50-line panel |
| `:focus-visible` rules | **3** (`.btn`, `.icon-btn`, `.ws-row`) |
| `:active` press states | **0** |
| Skeleton / loading states | **0**, and **0** `aria-busy` |
| `prefers-reduced-motion` | **0**, against 5 `@keyframes` including a 2.4s infinite shimmer |
| `role="dialog"` / `aria-modal` | **0** on both modals; no focus trap, no focus restore |

### The type finding is the sharp one

Round 1's own problem statement named inline `style=` escapes as **defect #1**.
Its implementation then fixed the type ramp by introducing **26 inline
`font-size:var(--text-*)` escapes**. Type never reached classes — it moved from
Tailwind arbitrary values to inline styles, which is the same defect wearing a
different coat.

The consequence is not cosmetic. Type set inline is not greppable as a system,
cannot be overridden by a theme or a media query, and — critically — **cannot be
asserted by a test**, which is why the ramp drifted back within a single
milestone.

## Constraints inherited from the brief

- pywebview stays; no Electron, no framework, no build step in the edit loop.
- The Python backend and the `pywebview.api.*` bridge keep working unchanged.
- All existing functionality preserved.
- `tailwind.css` is precompiled — **no new Tailwind utilities**, so everything
  lands in the `<style>` block. This is the same constraint round 1 worked under.
- **Visual identity is frozen.** Warm charcoal / terracotta stays. This round
  changes precision, not appearance.

## Decisions locked

| # | Decision | Choice |
|---|---|---|
| 1 | Sequencing | Three streams, in order: finish the system → feedback → motion/a11y |
| 2 | Type delivery | Utility **classes** in the `<style>` block, not inline styles |
| 3 | Focus strategy | One zero-specificity `:where()` rule, not per-component rules |
| 4 | Modal a11y | In scope — `role`/`aria-modal`/focus trap/Esc/focus restore |
| 5 | `marked` + `DOMPurify` CDN | **Out of scope.** `renderMarkdown` is try/caught and degrades to escaped text |
| 6 | Visual identity | Unchanged |

---

# Stream 1 — Finish the system

## 1.1 Type becomes classes

Six utilities beside the existing component classes:

```css
.t-2xs { font-size: var(--text-2xs); }
.t-xs  { font-size: var(--text-xs); }
.t-sm  { font-size: var(--text-sm); }
.t-base{ font-size: var(--text-base); }
.t-lg  { font-size: var(--text-lg); }
.t-xl  { font-size: var(--text-xl); }
```

All 56 sites convert. The mapping is mechanical and total:

| Was | Becomes |
|---|---|
| `text-[10px]` (7) | `t-2xs` |
| `text-[11px]` (12) | `t-xs` |
| `text-[12px]` (10) | `t-sm` |
| `text-[13px]` (1) | `t-base` |
| `style="font-size:var(--text-2xs)"` (8) | `t-2xs` |
| `style="font-size:var(--text-xs)"` (8) | `t-xs` |
| `style="font-size:var(--text-sm)"` (2) | `t-sm` |
| `style="font-size:var(--text-base)"` (2) | `t-base` |
| `style="font-size:var(--text-lg)"` (3) | `t-lg` |
| `style="font-size:var(--text-xl)"` (1) | `t-xl` |

Afterwards zero arbitrary sizes and zero inline font-size remain in the markup.
`test_type_ramp.mjs` asserts exactly that, which is what stops the drift from
recurring a third time.

Non-type inline styles (`width:`, `flex:`, `display:none`) stay. They are
one-off layout values, not a scale, and inventing a class per width would be
worse than the disease.

## 1.2 Regions the migration skipped

**`#fileViewer`** moves onto the shared modal chrome — `.modal-backdrop`,
`.modal-shell`, `.modal-head`, `.modal-body` — replacing its hand-rolled
`rounded-3xl` / `px-5 py-3`. Round 1 claimed to unify three modals; it unified
`#llmModal`, deleted `#exportModal`, and skipped this one.

**Graph tab sidebar** routes its 11 hand-rolled buttons through `.btn`. One
variant is missing from the system and gets added rather than hand-rolled again:

```css
.btn-accent { border-color: rgb(var(--term-cyan)); color: rgb(var(--term-cyan-fg)); }
```

Used by `#graphBuildBtn`, `#graphBuildRun`, `#graphModeToggle` — the three
controls currently sharing a copy-pasted `border-term-cyan … text-term-cyan`
string.

**Tab bar** (`#tabChat` / `#tabPlan` / `#tabGraph`) lands on the control-height
scale instead of `px-3.5 py-1`.

---

# Stream 2 — Feedback layer

## 2.1 Focus, in one rule

```css
:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid rgb(var(--term-cyan));
  outline-offset: 2px;
}
```

`:where()` contributes **zero specificity**, so the three existing rules keep
winning where they need a different offset (`.ws-row` uses `-2px` inset so the
ring does not clip against the list edge). One rule replaces what would
otherwise be twelve, and it covers controls added later for free.

`.composer-input` opts out — the composer already signals focus by lighting its
border via `:focus-within`, and a second ring inside the rounded box reads as a
rendering bug.

## 2.2 Press states

`:active` on `.btn`, `.icon-btn`, `.composer-btn`, `.ctx-item`, `.llm-tab`,
`.tree-row`, `.ws-row`, `.composer-model-item`: a 0.5px downward nudge plus one
background step darker than hover. The transform is gated by reduced motion; the
background change is not, so the affordance survives for users who disable
animation.

## 2.3 Loading states

A `.skeleton` class reusing the existing `--shimmer-base` / `--shimmer-hi`
variables, and an `.is-busy` button state. Applied at the six points that
currently jump from empty to populated with nothing in between:

| Surface | Today | With this |
|---|---|---|
| File tree | blank until `list_files` returns | skeleton rows |
| Recents list (start screen) | blank | skeleton rows |
| Model menu | empty popup | skeleton rows |
| File viewer | empty `<pre>` | skeleton block |
| Graph build | text status only | `.is-busy` on the button |
| LLM connection test | text status only | `.is-busy` on the button |

Each container carries `aria-busy` while loading, so the state is announced
rather than merely drawn.

---

# Stream 3 — Motion and semantics

## 3.1 Motion tokens

```css
--dur-fast: 120ms; --dur-base: 200ms; --dur-slow: 280ms;
--ease-out:   cubic-bezier(.21, 1.02, .47, 1);
--ease-inout: cubic-bezier(.4, 0, .2, 1);
```

Replaces the 12 hardcoded duration/easing pairs. The two easing curves already
exist in the file, used inconsistently; naming them is what makes the
inconsistency visible.

## 3.2 Reduced motion

A blanket reduce block, **plus an explicit `.shimmer` override**:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
  .shimmer, .group-title-wave {
    background: none; color: rgb(var(--term-muted)); animation: none;
  }
}
```

The override is not optional. `.shimmer` sets `color: transparent` and paints
the text through `background-clip: text` — stopping its animation alone would
freeze the gradient mid-sweep, and the blanket rule cannot undo the transparent
color. The same applies to `.group-title-wave`. Getting this wrong makes text
unreadable for exactly the users the media query exists to protect.

## 3.3 Modal accessibility

`role="dialog"`, `aria-modal="true"` and `aria-labelledby` on `#fileViewer` and
`#llmModal`. A shared pair in `app.js`:

- `openModal(el, opener)` — unhides, records the opener, moves focus to the
  first focusable child, installs a keydown handler.
- `closeModal(el)` — hides, removes the handler, returns focus to the opener.

The handler traps Tab within the dialog and closes on Esc. Both modals currently
close only by mouse.

The tab bar gains `role="tablist"` / `role="tab"` / `aria-selected`, so the
active tab is exposed rather than conveyed by color alone.

---

# Testing

Four new suites under `tests/frontend/`, each locking one stream:

| Suite | Asserts |
|---|---|
| `test_type_ramp.mjs` | zero `text-[Npx]` and zero inline `font-size` in `index.html` |
| `test_focus_ring.mjs` | a `:focus-visible` rule resolves for every interactive selector |
| `test_reduced_motion.mjs` | a reduce block exists and every `@keyframes` is covered, including the `.shimmer` color override |
| `test_modal_a11y.mjs` | both modals carry `role`/`aria-modal`; the trap helper cycles focus and restores it |

Existing guards stay green: `test_tailwind_classes.mjs` (no arbitrary utility
absent from the precompiled sheet), `test_contrast.mjs` (AA), `test_boot.mjs`
(`init()` finds every id it looks up).

Then a manual pass driving every interaction in the running app — the brief asks
for it, and none of the above catches a bridge call that silently stopped
firing.

## Out of scope

- Visual identity changes.
- A Tailwind rebuild.
- Vendoring `marked` / `DOMPurify`.
- Draggable panel splitters (declined in round 1, still declined).

---

# Implementation notes

All three streams landed. Final suite: **725 passed, 3 skipped** (baseline 721/3;
`tests/test_thought_wrap.py` still needs `--ignore`, a pre-existing stale-GUI
import unrelated to this work).

## Corrections to this document

- **The type surface was 127 sites, not 56.** The design counted only
  `index.html`. `app.js` held 71 more, including `text-[10.5px]` (7) and
  `text-[9px]` (2) — sizes not on the ramp at all. `app.js` renders the whole
  transcript, so it is the *more* visible half. Both files were converted; 9px
  and 10.5px fold to `t-2xs`.
- **`#viewerPath` deliberately does not use `.modal-title`.** That class sets a
  serif family which would override `font-mono`, and a file path must stay
  monospaced. It uses `t-base` and keeps the `aria-labelledby` target.

## Bugs found by running the app

Three of these were invisible to the test suite and only appeared on screen.

1. **`mt-auto` was not in the compiled `tailwind.css` at all** — along with 16
   other utilities in active use (`mb-8`, `pt-6`, `p-3`, `px-8`, `flex-wrap`,
   `justify-start`, `max-h-full`, `max-w-full`, `object-contain`, …). They
   produced no rule and silently did nothing. Visible symptoms: the start
   screen's rail footer never pinned to the bottom, button labels rendered
   centred instead of left-aligned, and the file viewer's image had **no size
   constraint at all**. All 17 are now defined in the `<style>` block.
2. **`test_tailwind_classes.mjs` claimed to check named utilities and did not.**
   Its loop skipped everything that was not an arbitrary bracket value, which is
   why the 17 above went unnoticed. It now checks named utilities against a list
   of unambiguously-Tailwind prefixes.
3. **`.btn` beat Tailwind's `.hidden`.** Equal specificity, and the `<style>`
   block is served after `tailwind.css`, so `#viewerBack` — `class="btn btn-sm
   btn-ghost hidden"` — rendered "← archive" on every plain text file. Caught by
   opening a `.txt`. Guarded now, and a test enumerates every element combining
   `hidden` with a display-setting component class.
4. **`switchTab` toggled styling that could not render.** It added and removed
   `border-term-cyan` / `border-transparent` on buttons carrying no border
   width, so the active tab was signalled by text colour alone. The strip now
   reuses the existing `.llm-tabs` segmented control, and `.tab-btn` — a class
   defined nowhere and queried nowhere — is gone.
5. **The DOM shim lacked `removeAttribute`.** Same class of hole as the missing
   `remove()` that round 1 documented. `test_boot.mjs` caught it the moment
   `aria-busy` was first cleared during init. Added to both shims, along with
   `hasAttribute` and `closest`.

## A guard that was measuring the wrong thing

`test_tailwind_classes.mjs` asserted a **minimum count** of arbitrary classes
(`>= 12`) as a proxy for "the extractor still works". That count legitimately
falls as ad-hoc values are replaced — it went 30+ → 9 → 3 during this work, and
the guard failed twice for the wrong reason. It now tests the regex against
fixtures, which is deterministic and does not punish the codebase for improving.

## Verified by mutation, not just by passing

Each new guard was checked against a planted regression: a reintroduced
`text-[11px]`, a deleted `.shimmer` colour restore, a removed `:where()` focus
rule, a broken Shift+Tab wrap, a deleted `.mt-auto`, and a removed `.btn.hidden`.
All six failed as expected.

## Interactions driven in the running app

Start screen (recents render, filter, row hover/selection, Open) · workspace
open · all three tabs · file tree render and file open · file viewer (content,
Esc to close, focus ring on the close button) · sidebar collapse and expand ·
theme toggle in both directions · LLM providers modal (master list, empty
detail, sticky footer, Esc) · composer (model label, effort chip, fallback
badge) · toast stack auto-dismiss.

## Deliberate tradeoffs

- **Ambient loop durations stay literal.** `shimmer 2.4s`, `group-title-wave
  .85s`, `skeleton-sweep 1.4s`, `spin .7s` are not state transitions and do not
  belong on a fast/base/slow scale; only the 13 transition durations were
  tokenised.
- **Non-type inline styles stay.** `width:`, `flex:`, `display:none` are one-off
  layout values, not a scale; a class per width would be worse than the disease.
- **`marked` / `DOMPurify` stay on the CDN.** `renderMarkdown` is try/caught and
  degrades to escaped plain text offline, so this is a quality issue rather than
  a failure, and vendoring was explicitly declined for this round.
