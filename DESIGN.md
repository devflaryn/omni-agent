---
name: Omni Agent
description: ChatGPT's dark UI, made consistent. Greys that separate by tone, ink as the one accent, blue only for links, red only for failures. Dark by default; a matching light theme on request.
colors:
  side: "#181818"
  side-2: "#262626"
  side-3: "#2f2f2f"
  ground: "#212121"
  raised: "#2f2f2f"
  composer: "#303030"
  bubble: "#303030"
  field: "#2f2f2f"
  field-2: "#383838"
  field-3: "#424242"
  line: "#333333"
  line-2: "#464646"
  line-float: "rgba(255, 255, 255, 0.06)"
  ink: "#ececec"
  muted: "#b4b4b4"
  dim: "#9b9b9b"
  accent: "#ececec"
  accent-ink: "#0d0d0d"
  accent-soft: "rgba(255, 255, 255, 0.07)"
  inverse: "#ececec"
  inverse-ink: "#0d0d0d"
  link: "#7ab7ff"
  select: "rgba(122, 183, 255, 0.32)"
  err: "#fa7470"
  on-err: "#1a0505"
  warn: "#e8a33d"
  send-off: "#676767"
  scrim: "rgba(0, 0, 0, 0.6)"
  side-light: "#f9f9f9"
  side-2-light: "#ececec"
  side-3-light: "#e3e3e3"
  ground-light: "#ffffff"
  raised-light: "#ffffff"
  composer-light: "#ffffff"
  bubble-light: "#f4f4f4"
  field-light: "#f4f4f4"
  field-2-light: "#ececec"
  field-3-light: "#e3e3e3"
  line-light: "#e5e5e5"
  line-2-light: "#d4d4d4"
  line-float-light: "rgba(0, 0, 0, 0.08)"
  ink-light: "#0d0d0d"
  muted-light: "#5d5d5d"
  dim-light: "#6e6e6e"
  accent-light: "#0d0d0d"
  accent-ink-light: "#ffffff"
  link-light: "#0b66d0"
  err-light: "#c9302c"
  on-err-light: "#ffffff"
  warn-light: "#b7791f"
  send-off-light: "#d7d7d7"
  scrim-light: "rgba(0, 0, 0, 0.3)"
typography:
  hero:
    fontFamily: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  prose:
    fontFamily: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  body:
    fontFamily: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.3
  caption:
    fontFamily: "ui-sans-serif, -apple-system, system-ui, 'Segoe UI Variable', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "'SF Mono', ui-monospace, Menlo, 'Cascadia Mono', 'Cascadia Code', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  code-inline:
    fontFamily: "'SF Mono', ui-monospace, Menlo, 'Cascadia Mono', 'Cascadia Code', Consolas, monospace"
    fontSize: "0.875em"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "28px"
  pill: "999px"
  round: "50%"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
motion:
  dur-1: "120ms"
  dur-2: "180ms"
  dur-3: "240ms"
  ease: "cubic-bezier(0.2, 0.7, 0.2, 1)"
  ease-std: "cubic-bezier(0.2, 0, 0, 1)"
  ease-in: "cubic-bezier(0.4, 0, 1, 1)"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.pill}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "36px (44px under a coarse pointer)"
  send-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.round}"
    size: "36px (44px under a coarse pointer)"
  composer:
    backgroundColor: "{colors.composer}"
    rounded: "{rounded.2xl}"
    padding: "12px 12px 10px 16px"
  user-message:
    backgroundColor: "{colors.bubble}"
    rounded: "{rounded.xl}"
    padding: "10px 18px"
  menu:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "6px"
  menu-item:
    rounded: "{rounded.sm}"
    padding: "7px 10px"
  card:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
  box:
    backgroundColor: "{colors.side}"
    rounded: "{rounded.md}"
  dialog:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
  toast:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.inverse-ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  input:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.sm}"
    padding: "7px 12px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# Design system: Omni Agent

This file is the single source of truth for how Omni Agent looks. The tokens at the top of `ui/styles.css` are the same
values; when the two disagree, fix whichever is wrong, and never add a raw value to a rule where a token exists.

## The look

Omni Agent wears **ChatGPT's dark UI**, on purpose: the owner chose it. Near-black greys that separate surfaces by tone,
ink white as the only accent, a pill-shaped send button, a rounded composer, a lightning mark. The job of this system is to
make that look **faithful and consistent**: one radius scale, one type scale, one spacing grid, one set of motion timings,
and the same roles in both themes.

- **Dark is the default.** Settings → Appearance offers Dark, Light and System. Light is ChatGPT's light theme with the same
  roles. System follows the device and changes with it. The choice is the browser's own (`localStorage`), applied by
  `ui/theme.js` in `<head>` before the first paint, so nothing flashes.
- **Tone, not lines.** The sidebar (`side`) is darker than the page (`ground`); controls and floating surfaces (`raised`,
  `composer`, `field`) are lighter. Hairlines (`line`, `line-2`) separate panes; shadows appear only on what floats.
- **One accent.** `accent` is ink: the send button, a primary button, a live dot, a running tool. It is never decoration.
  `link` is blue and means a link or a keyboard focus ring. `err` is red and means failed. `warn` is amber and appears only
  on a file that changed on disk under an open editor.

## Colour

| Role | Dark | Light | Used for |
|---|---|---|---|
| `side`, `side-2`, `side-3` | #181818, #262626, #2f2f2f | #f9f9f9, #ececec, #e3e3e3 | The explorer and the drawer, and their hover and selected rows |
| `ground` | #212121 | #ffffff | The page, the transcript, inputs |
| `raised` | #2f2f2f | #ffffff | Menus, dialogs, cards |
| `composer`, `bubble` | #303030 | #ffffff, #f4f4f4 | The composer, the user's message |
| `field`, `field-2`, `field-3` | #2f2f2f, #383838, #424242 | #f4f4f4, #ececec, #e3e3e3 | Hover, pressed, selected; inline code |
| `line`, `line-2` | #333333, #464646 | #e5e5e5, #d4d4d4 | Hairlines between panes; control borders |
| `line-float` | white 6% | black 8% | The edge of a floating surface |
| `ink`, `muted`, `dim` | #ececec, #b4b4b4, #9b9b9b | #0d0d0d, #5d5d5d, #6e6e6e | Text: primary, secondary, faintest |
| `accent`, `accent-ink` | #ececec on #0d0d0d | #0d0d0d on #ffffff | Send, primary, live |
| `link`, `select` | #7ab7ff | #0b66d0 | Links, focus rings, selection |
| `err`, `on-err` | #fa7470, #1a0505 | #c9302c, #ffffff | Failures, and text on a red fill |

**Contrast.** `dim` is the faintest text allowed. It reads at 4.7:1 on the dark composer and 5.1:1 on white (4.6:1 on
`field`). Text on a red fill uses `on-err`, never plain white on light red.

The composer in light gets a hairline (`composer-edge`) and a faint two-layer shadow (`composer-shadow`), as ChatGPT's does;
in dark both are none. File-type tints and syntax colours (VS Code's) and diff colours (GitHub's) are content colours, kept
inside the explorer, the editor and diffs.

## Type

The platform sans for everything a person reads. Mono only for what a machine wrote: paths, ids, model ids, code. Mono is
always **weight 400**; it is never used as decoration, for labels or for figures.

| Token | Size | Used for |
|---|---|---|
| `fs-2xs` | 11px | Badges, attach pills, sizes |
| `fs-xs` | 12px | Captions, hints, meta, mono paths |
| `fs-sm` | 13px | Controls, menus, labels, notes |
| `fs-base` | 14px | Body, list rows, the chat title |
| `fs-md` | 15px | Dialog and section titles |
| `fs-lg` | 16px | Prose, the composer, inputs on a phone (iOS does not zoom at 16) |
| `fs-xl` | 18px | The wordmark, the recovery code |
| `fs-2xl` | 24px | Sign-in titles, the hero on a phone |
| `fs-3xl` | 28px | The hero, the six-digit code |

Weights: 400 to read, 500 for a selected row or a live row, 600 for titles. Figures that change use `tabular-nums`. Inline
code is mono at `0.875em`, 400, on `field-2`. Labels are sentence case everywhere; no tracked ALL-CAPS.

## Radius

| Token | Value | Used for |
|---|---|---|
| `r-xs` | 4px | Inline code, attach pills, tiny status chips |
| `r-sm` | 8px | Rows, menu items, inputs, icon buttons |
| `r-md` | 12px | Boxes inside content: tool output, diffs, toasts, the code display |
| `r-lg` | 16px | Floating and framed surfaces: menus, dialogs, cards, code blocks |
| `r-xl` | 24px | The user's message bubble; the composer on a phone |
| `r-2xl` | 28px | The composer |
| `r-pill` | 999px | Buttons, chips, segmented tabs, the machine pill |

Circles (`50%`) are the send button, round composer buttons and status dots. A child's radius never exceeds its parent's.

## Spacing

A 4px grid: `sp-1` 4, `sp-2` 8, `sp-3` 12, `sp-4` 16, `sp-5` 20, `sp-6` 24, `sp-8` 32. Rows pad 8-10px, panes 12-16px,
dialogs and the transcript 20-24px, and turns sit 32px apart.

## Motion

| Token | Value | Used for |
|---|---|---|
| `dur-1` | 120ms | Hover, press, menus in and out, toast out |
| `dur-2` | 180ms | The drawer, dialogs, toasts in, the drawer's push of the content |
| `dur-3` | 240ms | Progress fills |
| `ease` | cubic-bezier(0.2, 0.7, 0.2, 1) | Things arriving |
| `ease-in` | cubic-bezier(0.4, 0, 1, 1) | Things leaving |

- Menus and context menus fade and scale from 98% at their origin, in and out (`@starting-style` and a `display`
  transition, so the global `[hidden]` rule still hides them). Dialogs fade their scrim and scale the panel. Toasts slide
  up 6px and fade in, wait while the pointer is on them or the tab is hidden, and slide down and fade out.
- Buttons press to 96%. Live dots breathe by opacity only.
- Nothing animates between themes (`.theme-switching`). Under reduced motion every animation and transition is cut to
  1ms; state still shows by colour and position.
- Never `transition: all`. Only `opacity`, `transform`, colours and the drawer's margin move.

## Layout

A top bar (52px, 48px on a phone, plus the safe area), then the explorer (260px, closed until asked for), an optional
preview, and the content. The transcript and composer share a 768px column with `scrollbar-gutter: stable both-edges`, so
the column never shifts when a scrollbar appears. The drawer is 360px on the right; from 1200px up it pushes the content,
and the push animates with the drawer.

**Phone (760px and below).** The top bar keeps the mark; in a chat it gives the title the room and moves Missions and
Settings to Home. Every target is at least 44px under a coarse pointer. What hover reveals on a desktop (turn actions,
chevrons, delete) is shown on touch (`hover: none`). Sheets, the composer and toasts respect the safe areas. The app has a
web manifest, so Add to Home Screen opens it standalone.

## Components

- **Buttons** are pills: ghost by default (hairline, ink), primary in `accent`, quiet with no border. One primary per view.
- **Icon buttons** are 36px squares at `r-sm`, muted, `field` on hover.
- **Composer**: `composer` fill, `r-2xl`, a 16px textarea, a bar with the + menu, the model pill, a caption and the round
  send button. The placeholder says what Send will do ("Message OpenCode in omni-stream", "Reply", "Continue this chat");
  a read-only chat shows none, and its caption says why.
- **Menus**: `raised`, `line-float` edge, `r-lg`, 6px padding, items at `r-sm`; the chosen item has a check.
- **Settings**: segmented pill tabs; each tab is a label, its controls and at most one short hint. Anything longer sits
  behind a **How this works** disclosure (`details.how`). The dialog keeps one height across tabs.
- **Toasts**: only for news from elsewhere. A save shows "Saved" beside its button; a load failure shows in the pane that
  failed.
- **Home**: the hero question, the composer, where it runs (machine and folder), then running work and recent chats from
  every machine.
- **Empty states**: one plain sentence and at most one action, which is not repeated elsewhere on the screen.

## Copy

Plain and human. Sentence case. Two short sentences rather than one joined by a colon. No "Omni will…" narration. Security
facts are always kept, but short in the main path, with the full text behind a disclosure.
