# Omni Agent: pi-only UI rewrite, provider config, file explorer with previews (2026-09-14)

## Goals

- One harness in the UI: **pi**. The composer never asks which harness to use. Claude Code stays on the
  server only because pi's `claude_task` extension calls it; nothing in the UI targets it.
- Home is a **single container**: brand, composer, working directory. No left sidebar.
- Chat history moves to a **right drawer** opened by a toggle button in the top bar. Next to that
  button sits a **Providers** (config) button.
- **Providers**: pick a provider from a preset list (OpenRouter, OpenAI, Anthropic, Google, DeepSeek,
  Groq, xAI, Mistral, Together, Fireworks, Ollama, LM Studio, or any OpenAI/Anthropic-compatible URL),
  paste the API key, and type the model ids by hand. The model picker lists **only** those models.
  pi's own list (hundreds of OpenRouter models) is never shown.
- Sending from Home opens the **chat view**: a **file explorer** sidebar on the left rooted at the
  chat's working directory, the transcript in the middle. Clicking a file opens a **preview column**
  between the explorer and the transcript:
  - `.zip` / `.apk` / `.jar` / `.aar` / `.xapk`: the entries inside (path, size), and a text entry can
    be opened in place.
  - images (`png jpg jpeg gif webp svg bmp ico`): the image.
  - `.md`: rendered markdown (the same `md()` the transcript uses), with a raw toggle.
  - any text file: monospace text.
  - everything else: size and a "no preview" note.

## Non-goals

- No change to the pi RPC protocol, the session watchers, the vault, the graph tools or the desktop
  launcher. Memory, Graph and Tokens keep their existing code and move into the right drawer as tabs.
- No secret manager: keys go where pi already reads them, `~/.pi/agent/models.json` (plaintext,
  mode 0600, gitignored by living outside the repo). That is how pi's docs describe custom providers.

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● Omni Agent   <title>                       [model] [☰ Chats] [⚙]   │  top bar
├──────────────────────────────────────────────────────────────────────┤
│ HOME (single container, centered):                                   │
│   "What should we work on?"                                          │
│   [ composer: textarea, +, model/thinking pill, send ]               │
│   working directory: /path   · recent dir chips                      │
├──────────────────────────────────────────────────────────────────────┤
│ CHAT:                                                                │
│ ┌ explorer ┐┌ preview (when a file is open) ┐┌ transcript ────────┐  │
│ │ tree     ││ path · [Reference] [×]        ││ turns…             │  │
│ │          ││ image / md / text / zip list  ││                    │  │
│ │          ││                               ││ [ composer ]       │  │
│ └──────────┘└───────────────────────────────┘└────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
 Right drawer (over the content, toggled by ☰): tabs Chats | Memory | Graph | Tokens.
 Providers dialog (modal, opened by ⚙).
```

- `body` is a CSS grid with one column; the drawer is `position: fixed` on the right so it never
  reflows the chat. Open state persists in `localStorage("omni.drawer")`.
- The explorer column is 260px, the preview column 420px (both collapse on screens under 900px:
  the explorer becomes an overlay, the preview fills the width until closed).
- The explorer's root is the chat's `cwd`; on Home it is the working directory input, so "Reference a
  file…" from the Home composer opens the same explorer as an overlay.

## 2. Providers

### Storage
`~/.pi/agent/models.json` is the single source of truth (pi reads it). Shape, per pi's docs:

```json
{ "providers": { "<name>": { "baseUrl": "...", "api": "openai-completions", "apiKey": "sk-…",
    "models": [{ "id": "deepseek/deepseek-v4-flash-0731", "name": "…", "reasoning": true,
                 "input": ["text"], "contextWindow": 1310720, "maxTokens": 65536,
                 "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }] } } }
```

Omni reads and writes only `providers.<name>`; unknown fields on a provider (`compat`, `headers`)
and unknown top-level keys are preserved on every write. The path is `CONFIG.piModelsFile`
(default `~/.pi/agent/models.json`, overridable for tests).

### Presets (`server/providers.mjs`, `PRESETS`)
| key | baseUrl | api |
|---|---|---|
| openrouter | https://openrouter.ai/api/v1 | openai-completions |
| openai | https://api.openai.com/v1 | openai-completions |
| anthropic | https://api.anthropic.com | anthropic-messages |
| google | https://generativelanguage.googleapis.com/v1beta | google-generative-ai |
| deepseek | https://api.deepseek.com/v1 | openai-completions |
| groq | https://api.groq.com/openai/v1 | openai-completions |
| xai | https://api.x.ai/v1 | openai-completions |
| mistral | https://api.mistral.ai/v1 | openai-completions |
| together | https://api.together.xyz/v1 | openai-completions |
| fireworks | https://api.fireworks.ai/inference/v1 | openai-completions |
| ollama | http://localhost:11434/v1 | openai-completions |
| lmstudio | http://localhost:1234/v1 | openai-completions |
| custom-openai | (user types) | openai-completions |
| custom-anthropic | (user types) | anthropic-messages |

A preset only prefills `baseUrl`/`api`; the user can rename the provider key and edit the URL.

### API
- `GET /api/providers` → `{ providers: [{ name, baseUrl, api, hasKey, keyHint, models: [{id, name, reasoning, contextWindow, maxTokens}] }], presets: PRESETS, active: { provider, model } }`.
  The key is never returned, only `hasKey` and the last 4 characters.
- `PUT /api/providers/:name` body `{ baseUrl, api, apiKey?, models: [{ id, name?, reasoning?, contextWindow?, maxTokens? }] }`.
  Omitting `apiKey` keeps the stored key. Models are typed one id per line in the UI; each becomes
  `{ id, name: id, reasoning: true, input: ["text"], contextWindow, maxTokens, cost: zeros }` with
  defaults `contextWindow 128000`, `maxTokens 16384` unless given. Validation: name matches
  `^[a-z0-9][a-z0-9_-]*$`, baseUrl parses as a URL, api is one of pi's known apis, at least one
  model id. 400 with a message otherwise.
- `DELETE /api/providers/:name` removes the provider.
- Both writes then **restart pi** (if it was running) so the child re-reads `models.json`, then
  `switch_session` back to the file it had open, so the current chat is not lost. The response carries
  `{ ok: true, restarted: boolean }`.
- `GET /api/pi/models` now returns the flat list from `models.json`
  (`{ provider, id, name, contextWindow }`), ignoring pi's own catalogue. If `models.json` has no
  providers it falls back to pi's list filtered by `cfg.piModels` (unchanged behaviour for anyone
  without the new config).
- `POST /api/pi/model` is unchanged (`set_model` with provider + modelId).

### Dialog
A modal with a provider list on the left (name, model count, key status) and a form on the right:
preset select, provider name, base URL, API type (read-only, from the preset unless custom), API key
(password input, placeholder shows `••••1234` when a key exists), models textarea (one id per line),
optional context window / max tokens, Save, Delete. Saving shows a toast, refreshes the model
picker and closes nothing (so several providers can be edited in a row).

## 3. File explorer and previews

### Server
`readFileSafe` gains a `kind` and a raw route:
- `GET /api/fs/read?root&path` → `{ kind: "text"|"markdown", content, ext, size }` for text,
  `{ kind: "image", ext, size, url: "/api/fs/raw?…" }` for images, `{ kind: "archive", ext, size,
  entries: [{ path, size, compressed, dir }] }` for zip-like files, `{ kind: "binary", ext, size }`
  otherwise. Text files over 2 MB stay `tooBig`. Archives are parsed from the central directory
  only (`server/zip.mjs`, Node built-ins: `fs`, `zlib`), capped at 5000 entries listed.
- `GET /api/fs/raw?root&path` streams the bytes with the right image MIME (images only, 20 MB cap).
- `GET /api/fs/archive-entry?root&path&entry` → `{ content }` for a text entry inside a zip
  (stored or deflated, ≤ 2 MB uncompressed), `{ binary: true }` otherwise. The same `fsRootAllowed`
  guard applies to all three.

`server/zip.mjs`: `listZipEntries(buf)` reads the End Of Central Directory record (scanning back
through a possible comment), walks the central directory (`PK\x01\x02`), and returns entries with
name, uncompressed size, compressed size, method, local header offset. `readZipEntry(buf, entry)`
follows the local header (`PK\x03\x04`), skips its variable fields, and returns the data inflated
(`inflateRawSync`) or as-is for method 0. ZIP64 is rejected with a clear error.

### UI (`ui/explorer.js`)
Tree with lazy directory loading (existing `/api/fs/list`), a filter box, and a preview column.
`fileKind(name)` in `ui/lib.js` decides the preview family from the extension (unit tested).
The preview header has the path, **Reference in prompt** (inserts `@path`), and close. Archive
entries render as a list; clicking a text-looking entry loads it via `archive-entry` and shows it
below the list.

## 4. Composer (pi only)

Textarea, `+` menu (Reference a file…, Attach relevant memory, Attach repo graph), a single
model/thinking pill (thinking levels from `/api/pi/thinking-levels`, models from `/api/pi/models`),
caption, send/stop. No harness segment, no access pill, no Claude model list. `CLAUDE_MODELS` and the
`showTarget` option are removed. Sending on Home starts pi in the working directory (or `new_session`
if pi is already there) and prompts; sending in a chat goes through the existing continue/prompt logic,
which already handles pi-owned, non-owned and forked chats.

Chats discovered from Claude Code are still listed in the history drawer (they live on this machine),
open read-only in the transcript, and their composer caption says "Claude Code chat · read only in
Omni"; send is disabled for them.

## 5. Files

New: `server/providers.mjs`, `server/zip.mjs`, `ui/explorer.js`, `ui/settings.js`,
`test/providers.test.mjs`, `test/zip.test.mjs`. Rewritten: `ui/index.html`, `ui/styles.css`,
`ui/app.js`, `ui/composer.js`, `ui/sidebar.js` (history list inside the drawer). Edited:
`server/index.mjs` (routes), `server/config.mjs` (`piAgentDir`, `piModelsFile`), `ui/panel.js`
(drawer tabs; the Files tab is removed), `ui/lib.js` (`fileKind`), `README.md`.

## 6. Testing

- `test/zip.test.mjs`: build a zip in the test with `zlib.deflateRawSync` and hand-written headers
  (stored + deflated entries, a directory entry, a comment on the EOCD), assert listing and entry
  reads; a ZIP64 marker throws.
- `test/providers.test.mjs`: read/write against a temp `models.json`; unknown fields survive;
  omitted key keeps the old key; validation errors; `flatModels()` order.
- `test/server.test.mjs`: `/api/providers` round trip with a fake pi that records `stop`/`start`/
  `switchSession`; `/api/fs/read` on a `.md`, a `.png` and a `.zip` fixture; `/api/fs/raw` MIME;
  `/api/pi/models` prefers `models.json`.
- `test/ui.test.mjs`: `fileKind`.
- Manual: `npm start`, open http://127.0.0.1:4400, add a provider, pick its model, send a prompt,
  open the explorer, preview a `.md`, an image and an `.apk`.
