---
name: tool-usage
description: How to wield this agent's own toolset efficiently — navigate with the code graph instead of reading files one-by-one, use progressive tool disclosure (expand_tools), delegate heavy work to fresh subagent contexts, and reach for the right skill/command — so actions stay clever and context stays small.
when_to_use: At the start of any non-trivial task, when you're unsure which tool fits, when you catch yourself reading many files or grepping blindly, or any time you want to work faster and cheaper. Especially on a long run.
allowed-tools: query_code_graph, build_code_graph, grep_directory, find_files, expand_tools, list_skills, use_skill, list_commands, use_command, dispatch_agents, ask_codebase, record_finding
---

# Using your tools well

Your effectiveness on a long run is decided less by the model than by HOW you use the
tools. Two habits dominate: **navigate, don't read blindly**, and **keep heavy work off
your own context**. This skill is the operating manual for the toolset the runtime
gives you.

## 1. Find things by NAVIGATING, not scanning
On a decompiled app, reading files one-by-one to "get oriented" burns context fast and
finds little. Instead:
- `query_code_graph(name="<anything>")` — a bare name searches strings + methods +
  classes + native symbols at once and lands you on the exact `file:line`. It
  auto-builds the graph. Use it for `query_code_graph(name="isRooted")`,
  `query_code_graph(name="/system/xbin/su")`, `query_code_graph(name="CertificatePinner")`.
  This is your primary locator — reach for it FIRST.
- `grep_directory` / `search_smali` / `search_java` / `find_files` to sweep a tree for a
  pattern the graph doesn't index (raw XML, assets, a byte-ish string).
- Only then `read_file_chunk` the specific slice those point you to — never a directory's
  worth of files to browse.

If you notice you've read several files without a single graph/search call, STOP — that's
context rot setting in. Navigate.

## 2. Progressive tool disclosure — load a toolset before domain work
The base prompt shows core tools in full and everything else as a one-line catalog to
keep the prompt small. Two ways to get full parameter schemas:
- Just call the tool — calling any catalog tool auto-activates its whole toolset for the
  rest of the session.
- `expand_tools("native")` (or `apk`/`smali`/`emulator`/`frida`) BEFORE a chunk of domain
  work, so you see every tool's exact params up front and pick the best one instead of
  guessing. Do this at the start of a native/emulator/frida phase.

The toolset map (what lives where):
| Toolset | Use it for |
|---|---|
| `apk` | decode / rebuild / sign / verify / inspect / manifest / jadx / search smali+java |
| `smali` | standalone DEX & smali disassembly and method/field patching |
| `native` | `.so` analysis + byte/assembly/C patching (ghidra, objdump, nm, radare2, patch_*) |
| `emulator` | install / launch / logcat / screenshots / vision / test session |
| `frida` | runtime hooking / tracing / unpinning on the dev base |
| `graph` | build/diff/list code knowledge-graphs (query_code_graph auto-builds) |
| `web` | search / fetch a page / download |

## 3. Delegate heavy, self-contained work to a FRESH context
The single biggest anti-rot lever. Anything that would cost many tool calls and whose
result you can summarize should run in a SUBAGENT, not inline:
- `dispatch_agents([...])` — fan out 2+ INDEPENDENT read-only investigations in parallel
  (e.g. "locate the root check", "locate the signature check", "map the license flow");
  you get back only their distilled reports. See AVAILABLE SUBAGENTS for the personas.
- A plan step tagged `delegate="<agent>"` — the harness runs it in its own context when
  you mark it in_progress and folds back just the report (use the `implementer` for a
  well-specified change, a read agent for research).
- `ask_codebase("<one focused question>")` — a single isolated Q&A when you don't need a
  whole persona.
The dozens of reads/queries stay in the sub-context and never touch yours.

## 4. Reach for a skill or command before improvising
- `list_skills` / `use_skill` — battle-tested workflows for the actual techniques
  (apk-modding, ssl-pinning-bypass, native-patching, frida-dynamic-instrumentation,
  root-detection-bypass, …). Loading a skill also brings its toolsets online. Consult the
  matching one instead of reinventing the procedure.
- `list_commands` / `use_command` — broader end-to-end WORKFLOWS that orchestrate skills,
  subagents, and the plan (e.g. `plan-feature`, `verify-work`). Use one when the whole
  task matches it.

## 5. Keep durable state OUTSIDE the chat
`record_finding` / `record_decision` / `record_open_question` and the `plan_*` tools
persist across summarization and context resets — raw chat messages do not. Write what
matters there the moment you learn it, then trust it instead of scrolling history.
(See the `context-hygiene` and `deep-planning` skills for the full long-run discipline.)

## Anti-patterns (each one is wasting context or making worse choices)
- Reading files one-by-one instead of `query_code_graph` / a search.
- Guessing a domain tool's args from the one-line catalog instead of `expand_tools` first.
- Doing a big self-contained investigation inline instead of delegating it.
- Improvising a whole APK/RE procedure a skill already encodes.
- Keeping findings only in the chat where the next summary loses them.
