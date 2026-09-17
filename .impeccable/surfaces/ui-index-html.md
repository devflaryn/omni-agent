---
version: 1
slug: "ui-index-html"
primary_target: "ui/index.html"
related_targets: ["ui/styles.css","ui/app.js","ui/composer.js","ui/transcript.js","ui/panel.js","ui/sidebar.js","ui/explorer.js","ui/settings.js"]
---

# Surface: the whole Omni Agent window (ui/index.html, ui/styles.css and the ui/*.js modules that render into it)

Scope: full visual redesign of the incumbent app shell: Home, Chat (explorer, preview, transcript, composer), history drawer (Chats, Memory, Graph, Tokens), Providers dialog, menus, toasts. Visitor mode: Operate.

Audience and job: the owner, on a Mac by day and on a phone over LAN at any hour, watching long pi runs on omnidroid/Roblox work and doing coding chats. Task: start a run, watch its state, read what it did, steer it. Important states: pi off / ready / working; a tool running, done, failed; a chat live in the drawer; a Claude Code chat (view only); goal hook re-engagement; context near its limit.

Constraints: every existing feature, behavior, id, class hook and copy stays; vanilla CSS and ES modules, no build step, no web fonts (must work offline on the LAN); WKWebView and Mobile Safari; keyboard focus visible; reduced motion honored.

Chosen direction: Monochrome Scale (competitive challenger, chosen by the owner over the assigned Signal Panel). Memorable moment: a page with almost no color where the one accent means exactly one thing, "act or alive": the send button, the focus ring, and the pulsing live dot.

## Direction contract

THESIS: The window is one fine neutral scale and nothing else; state and hierarchy come from weight, size and hairlines, and a single accent is spent only on the primary action and the live signal. It refuses the category arrangement of dark glass, glowing pill composer and amber halo.

OWN-WORLD: A neutral ramp from ground #fbfbfa through fields #f3f3f1 / #ebebe8 to hairline #dcdcd8 and ink #141414, with muted #6b6b66 and dim #9a9a94; the same ramp inverted under the system dark scheme for the phone at night. One accent, cobalt #2450e6 (light) / #7aa2ff (dark), on: send, focus ring, live dot, links. Red #c92a2a only on errors. Type: the platform UI sans (SF Pro on Apple, Segoe on Windows) at two weights, 400 and 600, 14/1.5 body, 15px transcript prose; SF Mono/Menlo for code, paths and figures, tabular numerals everywhere numbers align. Controls: ghost buttons with a 1px hairline, radius 6px; primary solid accent; inputs white with hairline, focus turns the hairline to ink. Panels are fields (a step darker), separated by hairlines, never shadows; menus and dialogs float with an offset, soft shadow. No glow, no gradient, no pill radii above 6px except the round send/attach controls, no unicode glyph icons: all icons are 16px stroked SVG at 1.5px.

STORY: The owner opens the window and reads state before words: the top bar says pi · working with a live dot, the transcript's last line is the sticky status meter with elapsed and tokens in tabular figures. They scan tool groups folded to one verb line each, open one, and see arguments and output in a plain code field. On the phone the same page fits: explorer and drawer become full-height sheets, the composer sits above the safe area. Nothing invites; everything is legible.

FIRST VIEWPORT: Desktop 1440: a 44px top bar with a wordmark left, the chat title in the middle, and at the right pi · working + model id in mono + three 32px icon buttons. Below it, the explorer as a 260px field on the left with a filter input and a tree in 13px rows; the transcript centered at 760px measure on the ground; the composer at the bottom, a white hairline rectangle with the textarea, the attach control, the model button as a ghost chip, and the send button as the only solid accent on screen. Home: heading 30px/600 centered above the composer, working directory as a mono line, recent folders as hairline chips. Phone 390: the same bar with the model hidden, transcript full width with 16px gutters, composer full width.

FORM: Monochrome Scale, the dealt challenger digital-design-canon-monochrome-product-marketing fused into an operator tool (my own list ranked Logcat Ledger first, Signal Panel sixth and assigned); seed key d43b70d0; code-led.

Signature interaction and motion: the drawer and explorer slide in on an exponential ease-out over 180ms; the live dot breathes by opacity only; streamed tokens fade up 2px. Nothing else moves. Reduced motion stops all three.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Unresolved: whether the owner wants a manual light/dark switch in the UI (the build follows the system setting).
