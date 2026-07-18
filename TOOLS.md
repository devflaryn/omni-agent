# Agent Tools Reference

The agent exposes **112 tools**, registered via `@registry.register` across the
modules in `tools/`. The tool list the LLM sees is generated dynamically from
this registry (see `tool_registry.get_tool_prompt`), so this file is a
human-readable index — the source of truth is the `@registry.register` blocks.

> Regenerate this list from the live registry:
> ```python
> import tools; from tool_registry import registry
> for n in registry._tools: print(n)
> ```

## Progressive tool disclosure (context optimization)

The full tool list is ~35k tokens. To keep the prompt small, tools are split into
a small always-on **core** and on-demand **domain toolsets** (`apk`, `smali`,
`native`, `emulator`, `frida`, `graph`, `web`; see `_GROUP_BY_MODULE` /
`_GROUP_BY_TOOL` in `tool_registry.py`). The base prompt shows core tools in full
plus a **one-line catalog** of every domain tool. A domain tool still executes
if called; doing so **auto-activates** its toolset (full schemas fold into the
prompt on later turns), and `expand_tools("<group>")` loads a toolset's full
params proactively. A malformed first call to a domain tool gets that tool's full
schema back inline for one-shot self-correction. This cut the first-message
system prompt from ~39k to ~17k tokens.

- **expand_tools** — reveal the full parameter schemas of an on-demand toolset
  (apk|smali|native|emulator|frida|graph|web) or a single tool, before using it.

## Filesystem & file editing — `tools/filesystem.py`
- **list_directory** — list files/folders in a workspace directory (`ls -la`).
- **find_files** — recursively find files/folders by name glob.
- **read_file_chunk** — read a specific line range of a text file.
- **write_file** — create a file or fully overwrite its contents.
- **replace_in_file** — surgical find-and-replace edit of a text file without rewriting the whole file.
- **delete_path** — recursively delete a file or directory.
- **move_file** — move or rename a file/directory.
- **duplicate_file** — copy a file/directory to a new location (keeps the original).

## General-purpose shell — `tools/shell.py`
- **run_command** — run an arbitrary shell command in the Docker sandbox (cwd `/workspace`, timeout-bounded).

## APK lifecycle: unpack / build / sign / inspect — `tools/apk_tools.py`
- **unzip_apk** — extract raw APK contents (ONLY for whole-file swaps: `.so`, assets, arch folders). Not the decompile path — use `decode_apk`/`jadx_decompile` for code.
- **decode_apk** — apktool decode (apktool's `d`) to smali + AndroidManifest.xml + resources (auto-builds a code graph). Primary tool for reading/editing an app.
- **jadx_decompile** — decompile to readable Java/Kotlin source (for understanding, not rebuilding).
- **recompile_apk** — rebuild an APK from EITHER a `decode_apk` directory (apktool build) OR a raw `unzip_apk` directory (zip repack); auto-detects which. Compression-safe (keeps `resources.arsc`/`.so` stored). Unsigned output. Replaces the old `build_apk` + `repack_apk`.
- **sign_apk** — zipalign + sign with a debug keystore (v1+v2+v3).
- **verify_apk** — verify signature, alignment, and required files.
- **inspect_apk** — list APK contents with sizes/compression (`unzip -l`).
- **replace_file_in_apk** — replace/add a single entry inside an APK in place (patched `.dex`, `.so`, asset). Unsigned output.
- **search_smali** — regex-search all `.smali` files, returning only matching `file:line` snippets.
- **search_java** — regex-search decompiled Java/Kotlin, returning only matching `file:line` snippets.
- **get_apk_signature_hash** — extract the original signing certificate fingerprint (SHA1/SHA256).
- **extract_manifest_info** — summarize a manifest: package, application class, launcher activity, SDK, permissions.

## DEX / smali bytecode editing — `tools/dex_editing.py`
- **disassemble_dex** — baksmali a standalone `.dex` into `.smali` files.
- **assemble_dex** — assemble `.smali` files back into a `.dex`.
- **list_dex_classes** — list class descriptors in a `.dex` without disassembling.
- **patch_smali_method** — replace an entire named method body in a `.smali` file.
- **insert_smali_code** — insert a new method/field/block into a `.smali` class (without touching existing methods).

## Native binary analysis (ELF / .so) — `tools/binary_analysis.py`
- **extract_strings** — printable strings from a binary, with optional regex filter + pagination.
- **rabin2_info** — fast metadata (symbols/strings/sections/imports) via rabin2.
- **nm_symbols** — list symbols via `nm` (best on non-stripped binaries).
- **readelf_info** — ELF structure: sections, dynamic section, symbol table.
- **radare2_cmd** — run targeted radare2 commands (never full `aaa` on large binaries).
- **disassemble_range** — disassemble a known address range via objdump (safe on huge binaries).
- **ghidra_decompile** — decompile native function(s) to C-like pseudocode via Ghidra headless.
- **read_binary_range** — read a byte range and return it as a hex string + annotated xxd dump.
- **diff_binary_files** — byte-for-byte diff of two files; lists each differing offset with both bytes in hex.
- **llvm_objdump_disasm** — clean AArch64 disassembly via llvm-objdump (resolves `<sym@plt>` calls, no radare2 noise), optional range/filter/pagination.
- **analyze_function_calls** — list the imported/external functions a named function calls (with PLT addresses), flagging kill-switch/anti-tamper imports (exit/abort/kill/dlopen/…).
- **find_byte_sequence_in_so** — scan a binary for a hex byte pattern (optional offset range); returns every file offset with surrounding hex context.

## Low-level byte patching — `tools/hex_patching.py`
- **patch_bytes_at_offset** — write raw hex bytes at a known file offset and verify by reading back.

## Higher-level native patching — `tools/binary_editing.py`
- **patch_binary_string** — replace a string literal in a `.so` (same length or shorter).
- **binary_patch** — locate a byte sequence and overwrite it (with occurrence/offset disambiguation + verify).
- **nop_function** — NOP out a function's first N instructions by symbol name (auto-arch).
- **patch_function_return** — force a function to immediately return true/false/zero/null by symbol name (auto-arch).
- **patch_at_offset_with_bytes** — robust offset-based byte patch (direct file I/O, no vaddr/segment math); returns previous bytes for rollback and adds PF_W (mprotect-style) to the containing ELF segment.

## Native code generation & injection — `tools/native_codegen.py`
- **assemble_and_patch** — assemble raw assembly to machine code and optionally patch it into a `.so`.
- **compile_c_and_patch** — compile a self-contained freestanding C function and optionally patch it in.
- **find_code_cave** — find a run of filler bytes big enough to hold new code.

## Hashing / integrity — `tools/hash_tools.py`
- **compute_sha256** — SHA256 hex digest of a single file (record a fingerprint).
- **compare_files_sha256** — SHA256 two files and report identical/different.

## Text & log analysis — `tools/text_analysis.py`
- **grep_file** — regex-search a single file, paginated.
- **tail_file** — last N lines of a file (crash logs, build output).
- **grep_directory** — recursive regex search across any file type, with include/exclude globs.
- **compare_directories** — report which files differ between two directory trees.

## Code knowledge graph — `tools/code_graph.py`
- **build_code_graph** — build/refresh a queryable graph of a codebase (smali or ordinary source).
- **query_code_graph** — query the graph (classes/methods/callers/callees/string_refs/hierarchy/so_symbols); auto-builds if none exists.
- **list_code_graphs** — list built graphs (id, root, counts).
- **diff_code_graphs** — compare two graphs (e.g. two app versions).

## Codebase Q&A — `tools/codebase_qa.py`
- **ask_codebase** — ask a natural-language question about `/workspace`; an isolated read-only sub-agent investigates and returns one answer.

## Android emulator / device — `tools/android_emulator.py`
- **ensure_emulator_running** — boot the project's Android VM (omnidroid backend). Pass `dev=true` (or set `OMNI_USE_DEV_BASE=1`) to boot the **dev base** (`base_arm` + the extra **vdc devkit disk** `base_arm_devkit.qcow2`: android-arm64 frida-server + Magisk + `omni-*` tools) instead of a shipped production base.
- **adb_shell** — run an arbitrary `adb shell` command against the emulator.
- **install_apk_on_emulator** — install an APK (ABI-safe on the omnidroid/qemu path).
- **launch_app_on_emulator** — launch an installed app.
- **get_logcat** — dump the current logcat buffer, optionally filtered.
- **monitor_logcat** — capture a logcat window and return only crash/ANR stack traces.
- **take_emulator_screenshot** — one on-demand screenshot via `screencap` (works even if minimized).
- **record_and_capture_keyframes** — sample the screen over a FIXED window and keep only meaningful keyframes.
- **read_auto_screenshots** — *(dev base only)* read the **ALWAYS-ON** auto-screenshot feed. There is nothing to start or stop: whenever a dev emulator is up (`ensure_emulator_running(dev=True)`), omnidroid auto-captures a full-res PNG on every big on-screen change (a spinner stays below threshold; a black↔loading flip is always caught) into `/workspace/screenshots/auto/`, flushing `metadata.json` live. This returns the running flag + per-keyframe elapsed/gap/black/reason/filename; filenames encode elapsed + gap-since-previous + wall-clock so an instant transition is distinguishable from one that took time. Call with no args for the default `auto` feed; `since_index` polls just the new frames. (The recorder is engine-owned — started on the dev boot, stopped on `stop_emulator`. For a package-scoped crash/exit VERDICT over a bounded window, use `record_and_capture_keyframes`.)
- **analyze_keyframes** — describe each keyframe with a vision model.
- **generate_test_report** — assemble a Markdown test report (keyframes + logcat).
- **run_apk_test_session** — one-shot pipeline: boot → install → launch → capture → analyze → report. Always runs on a FRESH instance: reset is forced true and the harness verifies no third-party packages exist (uninstalling leftovers) before installing the APK under test. Pass `dev=true` to run the whole session on the frida/root-hiding dev base. **Not for Roblox** — it has no concept of accounts/cookies/the session bootstrap and just does a plain install + launcher-intent open; given a Roblox cookie it silently lands on Roblox's own login screen while still reporting success. Use `launch_roblox_build` (or `login_roblox_account` + `play_roblox`) for any Roblox cookie/login/join scenario.
- **stop_emulator** — stop the running emulator/account.
- **ensure_frida_server** — *(dev base only)* start the devkit frida-server hidden (custom port + randomized process name) via Magisk `su` and `adb forward` a host port onto it; returns the `frida -H 127.0.0.1:<port>` endpoint to attach with. Needs a Magisk-rooted dev boot (`omni build-dev-base --patch-boot`).
- **hide_root_from_app** — *(dev base only)* best-effort hide root+Magisk+frida from a target package via the devkit `omni-hide` (Magisk DenyList/Shamiko + `resetprop` prop-spoofs). Run after `ensure_frida_server`, before launching the target.

## Roblox login/join (product session path) — `tools/roblox_session.py`
Wraps the engine's `omni play` / `omni session` / `omni login` / `omni accounts`
rather than reimplementing them (see `contracts/omni-session.md`), so these
exercise the exact zero-click path a customer gets: login is a `.ROBLOSECURITY`
cookie (the Roblox Android client has no deep-link auth parameter), planted into
Roblox's own WebView cookie jar by the injected bootstrap after a cold-start +
`roblox://experiences/start` deep link fired by the kiosk. Identical on dev and
production bases.

**Account model:** a saved account is just its cookie in ONE `accounts.json`,
keyed by Roblox **username** (the login name, never the display name) — either
added by a human via an interactive `omni login` browser sign-in, OR by the agent
via `login_roblox_account` from a cookie it was already handed (headless, no
browser). An instance is a THIN (~0.4 MB) overlay auto-created and named for the
account, so two accounts run at once. The engine refuses to create ANY instance
for a name with no saved cookie and no explicit override (`no_token` error) —
"the only way to get a profile is to log in" is enforced, not just documented.
- **login_roblox_account** — register/refresh an account from a cookie (file or
  raw string) you already have. The cookie is verified against Roblox exactly
  like an interactive sign-in, then saved under its real username. The SAME
  cookie always resolves to the SAME username, so this is safe to call
  repeatedly — it refreshes one account in place, never duplicates it. This is
  the ONLY way the agent can add a new playable account.
- **list_roblox_accounts** — the saved usernames available to play as (cookies
  never returned; `verify=true` also checks each is still valid). Call this
  first to pick an `account`.
- **play_roblox** — boot (or reuse) a thin instance and land INSIDE a Roblox
  place, logged in, no menu, no taps. MODERN path: `account="<username>"` and the
  engine resolves the cookie automatically (no token to handle). `token=` is an
  override for an unsaved cookie. Prefer this over `launch_app_on_emulator`.
- **set_roblox_account** — switch which account a running instance is logged in
  as (cold-starts Roblox first — a token swap on a live process would silently
  keep playing as the old account), change the place, or just read back the
  stored session (token always redacted).
- **launch_roblox_build** — the single call for "here's a cookie (+ optionally a
  new Roblox APK to test) and a place id, get me into that game": composes
  login_roblox_account -> (if apk_path given) decode_apk -> inject_session_
  bootstrap -> recompile_apk -> sign_apk -> install -> play_roblox. Exists
  because a STOCK Roblox APK has no code path that reads a session cookie at
  all — installing one as-is and expecting cookie login to work just silently
  lands on Roblox's own login screen. Prefer this over composing the steps by
  hand, and NEVER use run_apk_test_session for this — it has no concept of
  accounts, cookies, or the bootstrap.

## Roblox session bootstrap injection — `tools/session_bootstrap.py`
- **inject_session_bootstrap** — inject the Omni session bootstrap
  (`omnidroid/bootstrap/`) into a **decoded** Roblox APK: adds
  `com/omni/bootstrap/OmniBootstrap.smali`, one `invoke-static` at the top of
  `Application.onCreate()`, and a `<queries>` entry making the kiosk visible to
  Roblox (Android 11+ package-visibility filtering — without it the provider
  query silently returns null). Run between `decode_apk` and `recompile_apk` on
  every Roblox build omnidroid will ship or test; without it, `play_roblox`
  still joins the right place but lands on Roblox's own login screen.

## Frida runtime hooking / instrumentation (dev base) — `tools/frida_tools.py`
Run natively on the host via the `frida` Python binding against the dev base's devkit frida-server (android-arm64, hidden custom port, auto-forwarded). Dev base only (`ensure_emulator_running(dev=true)`, Magisk-rooted). The base is **arm64 native** (no libndk translation), so BOTH Java/Kotlin hooks AND native `Interceptor`/`Stalker` hooks of the app's own arm64 `.so` code work.
- **frida_list_processes** — enumerate processes/apps the frida-server sees (confirms connectivity; finds exact process names/pids).
- **frida_run_script** — inject an arbitrary Frida JS agent (inline or from a `/workspace` `.js`) into an app (attach or spawn-gated), run it for a window, and return every `send()`/`console.log`/error plus whether the app stayed alive (a crash right after injection ⇒ likely detection).
- **frida_trace** — auto-generate + run a tracer for named Java methods (`com.pkg.Class.method`, all overloads) and/or native functions (`lib.so!symbol`), logging args + return values.
- **frida_bypass_ssl_pinning** — inject a ready-made Java-layer TLS-unpinning agent (X509TrustManager / OkHttp CertificatePinner / Conscrypt TrustManagerImpl / HostnameVerifier) so an intercepting proxy can read the app's HTTPS.

## Web — `tools/web_tools.py`
- **web_search** — search the internet (title/URL/snippet).
- **read_webpage** — fetch a page and return readable text.
- **download_file** — download a URL into the workspace.

## Planning — `tools/plan_tools.py`
- **plan_create** — create a fresh execution plan (summary + ordered todo list).
- **plan_add_task** — add a task discovered mid-execution.
- **plan_update_task** — update a task's status/text.
- **plan_reorder** — reorder plan tasks.
- **plan_view** — view the current plan and progress.

## Investigation memory (evidence-first) — `tools/investigation_tools.py`
Structured, deduplicated, evidence-backed record of what's been established; survives context-window resets (folded into the system prompt like the plan). See `investigation.py`.
- **record_finding** — record a CONFIRMED fact; **evidence is required** (file:line / symbol / search hit / command/test/log output).
- **record_hypothesis** — record an UNPROVEN idea with a confidence level + partial evidence.
- **update_hypothesis** — mark a hypothesis confirmed (promotes it to a finding), refuted, or open.
- **record_failed_attempt** — record a dead end (approach + why it failed); the loop's repeat-failure guard reads these.
- **record_decision** — record a choice + rationale.
- **record_open_question** — record an unresolved question.
- **record_test_result** — record a validation outcome (pass/fail/unknown) — how "it works" becomes evidence-backed.
- **set_next_steps** — replace the rolling "immediate next actions" list.
- **investigation_view** — show the full bucketed investigation memory.

## Independent review — `tools/reviewer.py`
- **review_conclusion** — run an INDEPENDENT, skeptical review of a claimed conclusion in a separate isolated context (same model/key, read-only tools): verifies cited evidence, runs a contradiction pass, checks completeness, and returns APPROVE / REVISE with specific gaps. The main loop also invokes this automatically as a gate on every final answer.

## Skills — `tools/skill_tools.py`
- **list_skills** — list available skills (name/description/when-to-use/resources).
- **use_skill** — load a skill's full instructions; also activates the skill's toolsets.
- **read_skill_resource** — load one bundled resource file of a skill.

## Commands (plugin workflows) — `tools/command_tools.py`
- **list_commands** — list plugin-contributed workflow commands (name/description/source plugin).
- **use_command** — load one command's full step-by-step body to follow. A command is broader than a skill (it orchestrates skills, subagents, and the plan). NOTE: this only loads instructions — it is NOT `run_command` (the shell tool). Shipped commands: `/plan-feature`, `/verify-work`, `/re-triage`.

## Delegation & meta — `tools/delegation_tools.py`, `tools/meta_tools.py`
- **dispatch_agents** — run a wave of read-only subagents in parallel (each in its own isolated context) and get back only their distilled reports; keeps heavy exploration off the main context. Name agents from AVAILABLE SUBAGENTS. For a tracked/self-contained step (research OR a change) prefer a plan step tagged `delegate=<agent>` instead.
- **expand_tools** — reveal the full parameter schemas of an on-demand toolset (`apk`/`smali`/`native`/`emulator`/`frida`) or a single tool, before a chunk of domain work.
