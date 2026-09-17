---
name: Omni Agent
description: One neutral scale, one accent that means "act or alive", red only for errors.
colors:
  ground: "#fbfbfa"
  field: "#f3f3f1"
  field-2: "#ebebe8"
  field-3: "#e2e2de"
  line: "#dcdcd8"
  line-2: "#c9c9c4"
  ink: "#141414"
  muted: "#6b6b66"
  dim: "#9a9a94"
  accent: "#2450e6"
  accent-ink: "#ffffff"
  accent-soft: "rgba(36, 80, 230, 0.10)"
  err: "#c92a2a"
  inverse: "#141414"
  inverse-ink: "#fbfbfa"
  scrim: "rgba(20, 20, 20, 0.28)"
  ground-dark: "#141414"
  field-dark: "#1b1b1a"
  field-2-dark: "#222221"
  field-3-dark: "#2a2a29"
  line-dark: "#2b2b2a"
  line-2-dark: "#3a3a38"
  ink-dark: "#ececea"
  muted-dark: "#a09f9a"
  dim-dark: "#6e6e69"
  accent-dark: "#7aa2ff"
  accent-ink-dark: "#0d1a3d"
  err-dark: "#ff7070"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "clamp(24px, 3vw, 30px)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  prose:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.3
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.35
  group-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable', 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.02em"
  mono:
    fontFamily: "'SF Mono', ui-monospace, Menlo, 'Cascadia Code', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tabular-nums"
  mono-block:
    fontFamily: "'SF Mono', ui-monospace, Menlo, 'Cascadia Code', Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  inline: "4px"
  r: "6px"
  round: "50%"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "14px"
  3xl: "16px"
  4xl: "20px"
  5xl: "24px"
  6xl: "28px"
components:
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "5px 11px"
  button-ghost-hover:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "5px 11px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "5px 11px"
  button-quiet-hover:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.r}"
    size: "32px"
  icon-button-hover:
    backgroundColor: "{colors.field-2}"
    textColor: "{colors.ink}"
  send-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.round}"
    size: "30px"
  send-button-stop:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.inverse-ink}"
    rounded: "{rounded.round}"
    size: "30px"
  send-button-disabled:
    backgroundColor: "{colors.field-2}"
    textColor: "{colors.dim}"
    rounded: "{rounded.round}"
    size: "30px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "6px 10px"
  composer:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.prose}"
    rounded: "{rounded.r}"
    padding: "10px 10px 8px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.mono}"
    rounded: "{rounded.r}"
    padding: "3px 10px"
  chip-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
  segment-active:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.inverse-ink}"
    rounded: "{rounded.r}"
    padding: "2px 9px"
  menu:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "4px"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "7px 10px"
  menu-item-hover:
    backgroundColor: "{colors.field}"
  user-message:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    padding: "9px 14px"
  code-block:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.mono-block}"
    rounded: "{rounded.r}"
    padding: "10px 12px"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.r}"
    padding: "3px 8px"
  list-row-hover:
    backgroundColor: "{colors.field-2}"
  list-row-active:
    backgroundColor: "{colors.field-3}"
    textColor: "{colors.ink}"
  pane:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
  dialog:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    width: "min(900px, 100%)"
  toast:
    backgroundColor: "{colors.inverse}"
    textColor: "{colors.inverse-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.r}"
    padding: "8px 12px"
  toast-error:
    backgroundColor: "{colors.err}"
    textColor: "#ffffff"
    rounded: "{rounded.r}"
    padding: "8px 12px"
  top-bar:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    height: "44px"
    padding: "0 8px 0 16px"
---

# Design System: Omni Agent

## Overview

**Creative North Star: "The Monochrome Scale"**

Omni Agent is a control room over agent runs already happening on this machine, and its window is built to be read before it is read: one fine neutral scale from near-white ground to near-black ink, with state and hierarchy carried by weight, size and hairlines rather than by color. A single cobalt accent is spent on exactly one meaning, "act or alive": the send button, the keyboard focus ring, the breathing live dot, links, and the icon of a tool that is running right now. Red appears only when something failed. Everything else is grey, and the greys are graded precisely enough that a pane, a hover, a selection and a border each occupy their own step.

The system is dense but calm: an operator's ledger, not a landing page. Panes are fields one step darker than the ground and are separated by hairlines, never by shadows; only things that float (menus, the dialog, toasts, phone sheets) carry an offset shadow. Type is the platform UI sans at 400 and 600 (500 for a selected row), with SF Mono for anything a machine wrote: paths, ids, model names, figures. Numbers align with tabular numerals so the token ledger and elapsed counters read like a column of figures. The same ramp inverts under the system dark scheme for the phone at night; roles stay identical, only the values flip.

It refuses the category arrangement it replaced: dark glass, a glowing pill composer, an amber halo, decorative gradients. Motion is limited to three things (a sliding sheet, a breathing dot, a fading token) and all three stop under reduced motion.

**Key Characteristics:**
- One nine-step neutral ramp (ground, field, field-2, field-3, line, line-2, ink, muted, dim) inverted in dark with identical roles.
- One accent, cobalt, spent only on the primary action and the live signal; red only on errors.
- Hairline separation between panes; shadows reserved for floating surfaces.
- Platform sans at two working weights; mono with tabular numerals for machine text and figures.
- A single 6px radius; the send and attach controls are the only circles.
- Stroked 16px SVG icons at 1.5px; no glyph characters, no rasters.

## Colors

A monochrome scale with a single cobalt voice; every grey has one job and the jobs are the same in both schemes.

### Primary
- **Cobalt** (`{colors.accent}` light, `{colors.accent-dark}` dark): the send button fill, the 2px keyboard focus ring, the breathing live dot in the top bar, the status meter and the history row, links and the "Manage providers" / "Add provider" affordances, the streaming caret, and the icon and status of a tool while it runs. Text on the accent fill is `{colors.accent-ink}` (white in light, deep navy in dark).
- **Cobalt Wash** (`{colors.accent-soft}`): text selection only.

### Neutral
- **Ground** (`{colors.ground}` / `{colors.ground-dark}`): the page, the transcript, the composer, inputs, menus, the dialog, the graph canvas. The lightest step in light mode, the darkest in dark mode.
- **Field** (`{colors.field}` / `{colors.field-dark}`): panes one step off the ground: explorer, history drawer, provider list; also the user message bubble, code blocks, table headers and menu-item hover.
- **Field 2** (`{colors.field-2}` / `{colors.field-2-dark}`): hover on rows and icon buttons; the fill of a disabled send button.
- **Field 3** (`{colors.field-3}` / `{colors.field-3-dark}`): the selected row in the tree or history; the context bar track.
- **Line** (`{colors.line}` / `{colors.line-dark}`): the hairline between panes, the top bar's bottom edge, code block and table borders, ledger row rules, the fold line beside tool rows.
- **Line 2** (`{colors.line-2}` / `{colors.line-2-dark}`): the stronger hairline on controls: ghost buttons, inputs, chips, the composer frame, floating menus, blockquote and reasoning rails, the scrollbar thumb.
- **Ink** (`{colors.ink}` / `{colors.ink-dark}`): text, the brand mark, the focused input border, the active tab underline, the context bar fill, the resizer on hover, the "ready" status dot.
- **Muted** (`{colors.muted}` / `{colors.muted-dark}`): secondary text, control labels at rest, the model id, the status line, tool row labels, ledger keys, the context bar when it warns.
- **Dim** (`{colors.dim}` / `{colors.dim-dark}`): placeholders, captions, timestamps and sizes, icon rests, the group labels in history, the idle status dot.
- **Inverse** (`{colors.inverse}` on `{colors.inverse-ink}`): the stop button, the active segment button and toasts, i.e. the few solid surfaces that are not the accent.
- **Scrim** (`{colors.scrim}`): behind the providers dialog and the image lightbox, with a 4-6px backdrop blur.

### Error
- **Signal Red** (`{colors.err}` / `{colors.err-dark}`): a failed tool's icon and status, a failed run line, an error note, the context bar when hot, and the error toast fill.

### Named Rules
**The Act-or-Alive Rule.** The accent may fill or stroke only what the user is about to do (send, focus) or what is alive right now (live dot, running tool, streaming caret) plus links. It is never a decoration, a heading color or a hover.

**The One Step Rule.** A pane sits one step off its parent: ground to field, field to field-2 on hover, field-3 when selected. Nothing skips a step and nothing is tinted.

**The Red Means Failed Rule.** Red is an error state, never a warning, a delete affordance at rest or an emphasis.

## Typography

**Display Font:** the platform UI sans (SF Pro Text on Apple, Segoe UI Variable on Windows, system-ui elsewhere)
**Body Font:** the same platform sans
**Label/Mono Font:** SF Mono, then ui-monospace, Menlo, Cascadia Code, Consolas

**Character:** No web fonts ship; the type is whatever the platform draws best, which keeps the window native in WKWebView and Mobile Safari and offline on the LAN. Hierarchy comes from a tight 11-15px scale and two working weights; mono marks everything a machine produced.

### Hierarchy
- **Display** (600, `clamp(24px, 3vw, 30px)`, 1.2, -0.02em, balanced wrap): the Home heading only. Fixed at 24px on the phone.
- **Headline** (600, 15px, 1.3): the dialog title and the provider form title (the latter in mono).
- **Title** (600, 13px, 1.3): pane titles (Files, ledger block titles), the active drawer tab; the wordmark at 13.5px with -0.01em.
- **Prose** (400, 15px, 1.6): assistant text and the composer textarea. The transcript is capped at a 760px measure.
- **Body** (400, 14px, 1.5): the document default, the Home subline, markdown preview. User messages sit at 14.5px.
- **Control** (400, 13px, 1.3): ghost buttons, menu items, history rows, tabs, the status meter, tool labels (13.5px on the group summary).
- **Label** (400, 12.5px, 1.4): chips, composer chips, tree rows, secondary notes, system messages, ledger keys, toasts, dialog sublines.
- **Caption** (400, 11.5px): the composer caption, file meta, timestamps, menu headers (500), provider hints; 11px for the history group label (600, 0.02em, uppercase), attach pills and file sizes.
- **Mono** (400, 12px, 1.5, tabular numerals): paths, ids, model names, the top bar model id at 11.5px, tool status and diff counts, ledger values (500, 13px), chips on Home; code blocks and the memory editor at 12.5px; inline code at 0.88em.

### Named Rules
**The Machine Text Rule.** Anything produced or consumed by a machine, i.e. a path, an id, a model name, a count, a size, an elapsed time, is set in mono with tabular numerals. Prose never is.

**The Two Weights Rule.** 400 for reading, 600 for a title or the selected tab; 500 is reserved for the selected row and ledger figures. No 700, no light weights.

## Layout

The window is a fixed-height flex shell: a 44px top bar, then a main row with the explorer (260px, a field with a right hairline), an optional preview (440px, ground with a right hairline), and the content column. The transcript and the composer share a centered 760px measure with 24px gutters; Home is a centered 720px column padded 10vh from the top. The history drawer is a fixed 360px field on the right that slides over the content and, from 1200px up, pushes the main row aside by its own width. Explorer, preview and drawer widths are user-resizable via 7px hit-area resizers that draw a 1px ink line on hover; widths are remembered.

Rhythm is an even 2/4/6/8/10/12/14/16/20/24/28px set: 2px between icon actions, 4px inside menus and composer bars, 6px between chips and toasts, 8px as the default gap, 10px for row and code padding, 12-16px for pane padding, 20-24px for dialog and transcript gutters, 28px between turns. Rows in lists are 3px vertical padding on desktop and 7px on the phone.

Breakpoints: at 1200px and above the open drawer pushes content; at 1100px and below the preview narrows to 380px; at 760px and below the phone layout applies: the top bar grows to 48px and hides the model id, the explorer becomes a fixed sheet of `min(88vw, 320px)` with the large shadow, the preview and the drawer become full-width sheets, the transcript keeps 16px gutters, icon buttons, the round controls and composer chips grow to 40px and rows, tabs, buttons and inputs reach a 40px touch height, the composer caption moves above the controls on its own line, the composer and toasts respect the bottom safe-area inset, the providers dialog collapses to a single column with the provider list as a wrapping row, and top-bar menus become fixed full-width sheets 8px from each edge.

## Elevation & Depth

Flat by default. Depth is tonal: a pane is a field one step off the ground and is separated by a 1px hairline; no pane, card, message or input carries a shadow. Shadows exist only for surfaces that float above the layout: the providers dialog and the lightbox image take the large shadow, toasts take the small shadow, and on the phone the explorer sheet takes the large shadow because it floats over the transcript. Floating menus float with a hairline only, no shadow. The dialog and lightbox sit on a scrim with a blur.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 8px 24px rgba(20, 20, 20, 0.10), 0 1px 2px rgba(20, 20, 20, 0.06)`; dark: `0 8px 24px rgba(0, 0, 0, 0.45), 0 1px 2px rgba(0, 0, 0, 0.4)`): toasts.
- **Float Large** (`box-shadow: 0 24px 60px rgba(20, 20, 20, 0.16), 0 2px 6px rgba(20, 20, 20, 0.06)`; dark: `0 24px 60px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.4)`): the providers dialog, the lightbox image, the phone explorer sheet.

### Named Rules
**The Hairline Not Shadow Rule.** Panes that belong to the layout are separated by a 1px line. A shadow means the surface is floating and will go away.

## Shapes

One radius: 6px on every control, input, row, menu, message, code block, dialog and toast (`--r` and `--r-lg` are both 6px). Inline code and attach pills take 4px because they are set inside a text line. The only circles are the 30px send and attach controls (40px on the phone) and the 6-7px status dots. Small squares are the brand mark (10px, 2px radius) and the stop glyph inside the send button (10px, 2px). Borders are 1px hairlines in line or line-2; a focused input turns its hairline to ink rather than glowing. Nothing is clipped into a pill or a card stack; there are no gradients and no rasters.

## Components

Every control is a ghost by default: transparent fill, hairline stroke, muted or ink text, filling one step on hover. Solid fills are the accent (act), the inverse (stop, active segment, toast) and the error red.

### Buttons
- **Shape:** softly squared (6px); icon buttons are 32px squares, 26px in the small variant and inside turn actions, 40px on the phone (36px small).
- **Ghost (default):** transparent on a 1px line-2 hairline, ink text at 13px, 5px 11px padding; hover fills with field and strengthens the border to dim. Small variant 3px 8px at 12px.
- **Primary:** accent fill, accent-ink text, 600 weight; hover brightens 6%.
- **Quiet:** no border, muted text; hover ink on field.
- **Icon:** borderless, muted, 16px SVG at 1.5px stroke; hover or `.on` ink on field-2.
- **Focus:** a 2px accent outline offset 2px on every focusable element. Disabled: 45% opacity.
- **Segment / chip:** hairline chips at 12.5px; chips on Home are mono and turn their border to ink when active; a segment button inverts (ink fill, ground text) when active.

### Send and Stop (signature control)
A 30px circle (40px on the phone). Idle: accent fill with a 15px arrow at 1.8px stroke. Running: inverse fill with a 10px square stop glyph. Disabled (a view-only Claude Code chat, or an empty composer): field-2 fill and dim glyph, while the surrounding composer frame drops to line and its placeholder to line-2. It is the only solid accent in the first viewport.

### Cards / Containers
- **Panes** (explorer, drawer, provider list): field fill, one hairline on the edge that touches the ground, no radius, no shadow.
- **Composer:** ground fill, line-2 hairline, 6px radius, 10px 10px 8px padding; the whole frame turns its hairline to ink on focus-within. Contains a borderless 15px textarea (40-260px tall) and a bar of chips, the caption in dim 11.5px, and the send control.
- **User message:** field fill, 6px radius, 9px 14px padding, 14.5px, at most 85% of the measure (92% on the phone), right-aligned.
- **Code block / tool output:** field fill, line hairline, 6px radius, 10px 12px (8px 10px for tool I/O, capped at 320px tall), mono 12-12.5px.
- **Ledger** (Tokens tab): no tiles; single-column rows with a muted 12.5px key left and a mono 500 13px value right, each ruled by a line hairline; a 4px context bar in field-3 with an ink fill that goes muted when warning and red when hot.
- **Dialog:** ground, 6px radius, large shadow, up to 900px wide and 90vh tall, on a blurred scrim; a 240px field provider list left and the form right.
- **Toast:** inverse fill, inverse-ink text, 12.5px, 8px 12px, small shadow, stacked bottom-right with 6px gaps (edge-to-edge on the phone). Error toasts are red with white text.

### Inputs / Fields
- **Style:** ground fill, 1px line-2 hairline, 6px radius, 6px 10px padding, 100% width; placeholder in dim; selects draw a 14px stroked chevron; search fields draw a stroked clear glyph.
- **Focus:** the hairline becomes ink; no outline, no glow. The Home working-directory input is borderless and muted at rest and only shows its hairline on hover and focus.
- **Error / Disabled:** errors are reported in a red note beneath, not on the field.

### Navigation
- **Top bar:** 44px (48px phone), ground with a bottom hairline. Left: a 10px ink square mark and the 13.5px 600 wordmark; the chat title in muted 13px behind a left hairline; an overflow icon button. Right: the pi status (a 7px dot: dim outline when off, ink when ready, accent and breathing when working) with "pi · working" copy, the model id in mono 11.5px muted (hidden on the phone), and three 32px icon buttons for files, history and providers. The history button reads `.on` (ink on field-2) while the drawer is open.
- **Drawer tabs:** 40px row with a bottom hairline; tabs are muted 13px text with a 1px transparent underline that turns ink and 600 when active.
- **Menus:** ground, line-2 hairline, 6px radius, 4px inner padding, items 7px 10px at 13px with field hover; the chosen item is 600 with a 14px stroked check; group headers dim 11.5px 500; a "Manage" footer in accent above a line hairline. Minimum 240px (280px for the model menu), full-width sheet on the phone.
- **Lists** (tree, history): 12.5-13px rows, 6px radius, field-2 hover, field-3 and 500 when active. History rows carry a 6px ink dot (pi) or a 5px dim outlined dot (Claude Code, view only) that turns accent and breathes when the chat is live; a delete icon appears on hover (always on the phone). Group labels are dim 11px 600 uppercase.

### Status Meter and Tool Groups (signature)
The last line of every turn is the meter: a 7px dot, muted 13px text with elapsed and tokens in tabular figures, and a chevron that opens a reasoning drawer beneath a line-2 rail. While live the text is ink and the dot is accent and breathing. Tool activity folds to one 13.5px summary line per run of tools (a 16px stroked icon, a verb label, a chevron revealed on hover); rows inside sit behind a 1px line rail with a mono status at the right that turns accent while running and red on failure. Tool result images are 96x72 thumbnails on a checkerboard with a hairline that turns ink on hover, opening a scrim lightbox.

### Motion
Three movements only: the drawer and explorer slide in over 180ms on `cubic-bezier(0.2, 0.7, 0.2, 1)`; the live dots breathe by opacity only (1 to 0.35, 1.4-1.6s); streamed tokens fade up 2px over 160ms. New turns and floating surfaces appear with a 150-220ms fade-up using the same ease; hover transitions are 120ms. Reduced motion removes all of it.

## Do's and Don'ts

### Do:
- **Do** separate panes with a 1px line hairline and step the fill one notch (ground to field); use shadows only on surfaces that float.
- **Do** spend the accent only on send, focus, live dots, running tools, the streaming caret and links; leave every other state to weight and grey.
- **Do** set paths, ids, model names and every figure in mono with tabular numerals; keep prose in the platform sans at 400 and 600.
- **Do** keep 6px as the only radius on rectangles; circles are the send and attach controls and status dots alone.
- **Do** draw icons as 16px inline SVG at 1.5px stroke, round caps and joins, in currentColor.
- **Do** mark a focused input by turning its hairline to ink, and every other focusable element with the 2px accent outline.
- **Do** keep both schemes role-identical: the same token names, inverted values, no per-scheme layout.

### Don't:
- **Don't** add gradients, glows, blurred halos, glass or tinted greys; the ramp is neutral and flat.
- **Don't** use red for anything but a failed state, and never as a delete color at rest.
- **Don't** use pill radii on rectangles or shadows on panes, messages, inputs or menus.
- **Don't** ship web fonts, icon fonts, unicode glyph icons or raster icons; the app must draw itself offline on the LAN.
- **Don't** animate anything beyond the sheet slide, the breathing dot and the token fade.
- **Don't** introduce a second accent or tint headings; hierarchy comes from size and weight only.
