# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the developer who owns this machine. The app runs on their Mac and is opened in the pywebview desktop window or a browser; a large share of use is remote control from a phone or laptop on the same LAN (`--lan`). There is no login and no second audience. Labels can assume the owner's vocabulary (pi, Claude Code, omnidroid, frida, APK, vault) but the phone view is a first-class layout target, not a fallback.

## Product Purpose

Omni Agent is a local control room for agent runs. It starts a pi child in a chosen project folder, streams the transcript live, shows every pi and Claude Code chat on the machine, and keeps an Obsidian-vault memory, repo knowledge graphs and token accounting beside the chat. Success is: the owner can start a task, walk away, glance at a phone, and know at once whether the agent is still working, what it last did, and whether it finished.

## Positioning

A single window over the agents that already run on this machine, rather than a hosted chat product. Chats started in a terminal appear here whole; chats started here continue or fork correctly; the model can hand work to Claude Code, read the vault, or build a repo graph mid-turn. Nothing leaves the machine unless a provider key is configured.

## Operating Context

- The dominant job is watching long agent runs on omnidroid / Roblox work: pi driving Android VMs, APK rebuilds, frida hooks, custom APK boots. Tool activity, run status and the elapsed/token line matter more than prose polish. Runs last minutes to hours and are often observed from a phone.
- Secondary job: general coding chats in project folders, with the file explorer and preview beside the transcript.
- Surfaces: Home (prompt + working directory), Chat (explorer, preview, transcript, composer), history drawer (Chats, Memory, Graph, Tokens), Providers dialog, toasts.
- Runtime: Node 22 server on port 4400, static `ui/` (vanilla HTML/CSS/ES modules, no framework, no build step), SSE for live events. Desktop window is WKWebView via pywebview; phone use is Mobile Safari / Chrome over LAN.
- Models are user-configured providers in pi's `~/.pi/agent/models.json` (OpenRouter + DeepSeek today). DeepSeek is text-only, so some skills carry text-only verification loops.

## Capabilities and Constraints

- Everything in the current UI stays: home composer with directory chips, explorer with archive browsing and preview (text, rendered markdown with Raw toggle, images, zip/apk entries), `@path` references, transcript with folded tool-call groups, tool-result images with overlay, thinking status line with tok/sec, goal hook line, history drawer with day grouping and live-dot, trash-based delete, Memory/Graph/Tokens tabs, Providers dialog with presets, resizable columns with remembered widths, toasts.
- Two agent sources are distinguished throughout: pi (interactive, drives from here) and Claude Code (read-only in the UI, never launched from it). Keep them visually tellable apart.
- No build step, no framework, no bundler: plain CSS and ES modules served as-is. Fonts must be system or self-hosted-free; the app must work offline on the LAN.
- Must work in WKWebView (macOS) and mobile Safari; keyboard-driven on desktop, touch on phone.
- Terminology to keep: "Working directory", "History", "Chats / Memory / Graph / Tokens", "Providers", "Goal hook", "Thinking".
- Theme: the UI follows the system color scheme (light by day on the Mac, dark on a phone at night); a manual in-app switch is not requested. Decided 2026-09-16.

## Brand Commitments

Name: **Omni Agent**. No logo, wordmark or icon assets exist yet. The owner's binding request for this redesign: it must read as a clean, deliberate tool UI and not as generic AI-generated chat-app styling (no glows, gradient halos, oversized pill radii, or decorative flourishes without purpose). The incumbent dark/amber look is discarded, not refined.

## Evidence on Hand

- Real transcripts and chats: everything under `~/.pi/agent/sessions` and `~/.claude/projects` on this machine; the vault at `vault/` with real memory notes and graphs.
- Design history: `docs/superpowers/specs/2026-09-09-chat-continue-ui-revamp-desktop-design.md` and `docs/superpowers/specs/2026-09-15-images-tps-goal-hook-design.md` describe the current behavior.
- No screenshots, marketing copy, testimonials or usage metrics exist; none are to be invented.

## Product Principles

1. Status at a glance: from across the room or on a phone, the state of the run (working, waiting on a tool, done, failed) must be readable before any text is.
2. The transcript is the product; chrome recedes. Panels, drawers and controls earn their pixels or collapse.
3. Dense but calm: an operator's tool, not a landing page. Consistent spacing, one type scale, restrained color used only for meaning (source, state, error).
4. Same app on every screen: phone over LAN gets the full feature set with a layout that fits, never a stripped "mobile version".
5. Nothing fake: no invented models, providers, metrics or placeholder content in the UI.

## Accessibility & Inclusion

Keyboard focus must stay visible on controls (existing `:focus-visible` rings), motion respects `prefers-reduced-motion`, touch targets on phone at least 40px. No formal standard has been mandated.
