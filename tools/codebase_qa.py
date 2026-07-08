"""Codebase Q&A tool — `ask_codebase`.

Lets the main agent ask a natural-language question about the project in
`/workspace` and get back a synthesized answer, WITHOUT flooding its own
conversation with the dozens of file reads / graph queries the answer took to
find.

How it works
------------
`ask_codebase` spins up a SEPARATE, throwaway LLM conversation (its own system
prompt + message history) that has access to a *read-only* subset of the same
exploration tools the main agent uses (code graph, grep, find, read, disassembly,
decompilation, etc.). That sub-agent investigates the workspace on its own, then
returns a single concise answer. Only that answer crosses back into the main
conversation — all the intermediate tool output stays in the sub-conversation and
is discarded.

Key properties (these are the whole point):
  * No extra API key / provider. It reuses `llm.ask_llm` — the exact same key,
    endpoint and model the main agent already runs on.
  * Isolated context. The exploration happens in a fresh conversation, so the
    main agent's context isn't polluted with the raw file/graph dumps.
  * Read-only. The sub-agent is restricted to a hard-coded allowlist of
    non-mutating tools (see ASK_CODEBASE_TOOLS) — it can never write, delete,
    repack, sign, patch, or drive the emulator.

This mirrors the `/ask`-style "ask a question about the repo" feature other agent
frameworks expose, but implemented entirely on top of this project's own tool
registry.
"""
import json

from llm import ask_llm, extract_json_action, strip_reasoning
from tool_registry import registry

# --- The sub-agent's toolbox -------------------------------------------------
# A deliberately conservative, READ-ONLY subset of the registered tools. These
# only inspect the workspace; none of them mutate files, rebuild/sign APKs, run
# the emulator, or execute arbitrary radare2 write commands. build_code_graph is
# included because it only writes a private cache under /workspace/.codegraph and
# is what makes navigating a big decompiled tree cheap.
ASK_CODEBASE_TOOLS = {
    "list_directory",
    "find_files",
    "read_file_chunk",
    "grep_file",
    "tail_file",
    "grep_directory",
    "search_smali",
    "build_code_graph",
    "query_code_graph",
    "inspect_apk",
    "extract_strings",
    "rabin2_info",
    "nm_symbols",
    "analyze_so_symbols",
    "readelf_info",
    "disassemble_range",
    "ghidra_decompile",
    "get_apk_signature_hash",
    "compare_files_sha256",
    "compare_directories",
}

# --- Bounds ------------------------------------------------------------------
DEFAULT_MAX_STEPS = 12      # exploration tool calls the sub-agent may make
MAX_STEPS_CAP = 30          # hard ceiling regardless of what the caller asks for
SUBAGENT_TEMPERATURE = 0.3  # lower than the main loop — we want steady tool use
PER_RESULT_CHAR_CAP = 6000  # truncate each tool result fed back to the sub-agent
CONTEXT_CHAR_LIMIT = 180_000  # force an answer if the sub-conversation grows past this
REPEAT_LIMIT = 3            # identical tool call this many times in a row -> nudge


_SUBAGENT_SYSTEM_PROMPT = """You are a codebase question-answering assistant working inside an isolated \
investigation session. Another AI agent has handed you ONE question about the project currently mounted at \
`/workspace` (a codebase, or a decompiled/unpacked app). Your job is to investigate that workspace using the \
read-only tools below and return a single, accurate, well-grounded answer.

You operate in the same Linux Docker sandbox as the calling agent; every tool path is relative to `/workspace`.

HOW TO WORK:
- Investigate before you answer. Locate the relevant code with the tools instead of guessing.
- For a large or decompiled/obfuscated tree, do NOT read files one by one to orient yourself. Call \
build_code_graph ONCE, then query_code_graph (string_refs / callers / callees / class / hierarchy) to jump to \
the exact file:line, and only then read_file_chunk that slice. Use grep_directory / search_smali / find_files to \
search by content or name.
- Read only the slices you actually need. You have a limited number of tool calls, so spend them well.
- You are READ-ONLY: you cannot modify, create, delete, repack, sign, or run anything. Only inspect.

RESPONSE FORMAT — you MUST always return a single raw JSON object, no markdown, no prose outside the JSON.

To call a tool:
{"type": "tool_call", "tool": "tool_name", "args": {}}

To give your final answer (do this as soon as you can actually answer):
{"type": "final_answer", "content": "your answer"}

Call only one tool at a time. Never wrap the JSON in code fences. Never output anything outside the JSON object.

YOUR FINAL ANSWER must directly answer the question and cite concrete evidence — file paths with line numbers, \
class/method names, string/symbol names — so the calling agent can trust and act on it without re-checking. Be \
concise and specific; if the workspace genuinely doesn't contain enough to answer, say exactly what's missing."""


def _parse_subagent_response(response_text):
    """Parse the sub-agent's JSON reply into a (type, payload) tuple.

    Mirrors agent.parse_response's tolerance (llm.extract_json_action digs the
    action out of think-blocks/fences/prose, a stray {tool/args} object counts
    as a tool_call) but is kept local so this module depends only on llm +
    tool_registry, never on agent.py (which pulls in the whole webview app and
    would be a circular import at load time)."""
    data = extract_json_action(response_text or "")
    if data is None:
        return ("error", f"non-JSON content: {(response_text or '')[:300]}")

    response_type = data.get("type")
    if response_type not in ("tool_call", "final_answer") and ("args" in data or "tool" in data):
        data["tool"] = data.get("tool", response_type)
        response_type = "tool_call"

    if response_type == "tool_call":
        return ("tool_call", data)
    if response_type == "final_answer":
        return ("final_answer", data.get("content", ""))
    return ("error", f"unknown response type '{response_type}': {(response_text or '')[:300]}")


def _execute_readonly_tool(tool_name, tool_args):
    """Run one sub-agent tool call through the registry, but only if it's on the
    read-only allowlist, and return a compact feedback string. Defense in depth:
    the sub-agent's prompt only advertises allowlisted tools, and this refuses
    anything off-list even if the model hallucinates one."""
    if tool_name not in ASK_CODEBASE_TOOLS:
        return (
            f"Tool '{tool_name}' is not available in this read-only investigation session. "
            f"Use one of the listed tools, or give your final_answer."
        )
    if not isinstance(tool_args, dict):
        tool_args = {}

    result = registry.execute(tool_name, tool_args)
    output = result.get("stdout", "")
    err = result.get("stderr", "")
    err_dict = result.get("error", "")

    feedback = f"Tool '{tool_name}' executed.\n"
    if output:
        trimmed = output[:PER_RESULT_CHAR_CAP]
        feedback += f"Output:\n{trimmed}\n"
        if len(output) > PER_RESULT_CHAR_CAP:
            feedback += (
                f"[Output truncated at {PER_RESULT_CHAR_CAP} chars of {len(output)}. "
                "Narrow the query or read a specific slice for more.]\n"
            )
    if err:
        feedback += f"Stderr:\n{err[:1500]}\n"
    if err_dict:
        feedback += f"System Error:\n{err_dict}\n"
    if not output and not err and not err_dict:
        feedback += "(no output)\n"
    return feedback


def _estimate_chars(messages):
    return sum(len(m.get("content", "")) for m in messages)


def _format_answer(answer, tools_used, steps, note=None):
    answer = (answer or "").strip() or "(the codebase Q&A sub-agent returned an empty answer)"
    seen, uniq = set(), []
    for t in tools_used:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    footer = f"\n\n[ask_codebase: {steps} exploration step(s)"
    if uniq:
        footer += f"; tools used: {', '.join(uniq)}"
    footer += "]"
    if note:
        footer += f"\n[note: {note}]"
    return {"stdout": answer + footer}


def _force_final_answer(messages, tools_used, steps, note):
    """Ask the sub-agent one last time to commit to an answer with what it has."""
    messages.append({"role": "user", "content": (
        "[SYSTEM] You have reached the investigation limit for this session. Do NOT call any more tools. "
        "Respond now with your best final_answer based on what you have found so far, as "
        '{"type": "final_answer", "content": "..."}. If you could not fully determine the answer, say what '
        "you did find and what remained unresolved."
    )})
    raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
    rtype, payload = _parse_subagent_response(raw)
    if rtype == "final_answer":
        return _format_answer(payload, tools_used, steps, note)
    # Last resort: hand back whatever text came out rather than nothing.
    return _format_answer(raw, tools_used, steps, note)


@registry.register(
    name="ask_codebase",
    description=(
        "Ask a natural-language question about the project in /workspace and get back a synthesized answer. "
        "This spins up a SEPARATE, isolated LLM conversation (its own context) that investigates the workspace "
        "with read-only tools (code graph, grep, find, read, disassembly, decompilation) and returns ONE concise, "
        "evidence-backed answer. Only that answer comes back to you — all the intermediate file reads and graph "
        "queries stay in the sub-conversation and never touch your context. It uses the same model/key you run on; "
        "no extra credentials are needed. The sub-agent is read-only: it cannot modify, create, delete, repack, "
        "sign, patch, or run anything."
    ),
    params_schema={
        "question": "string (the question to answer about the codebase/workspace, e.g. 'Where is the license check enforced and what function decides it?')",
        "context": "string (optional — hints to focus the search, e.g. a directory to look in, a class name, or what you've already ruled out)",
        "max_steps": f"integer (optional, default {DEFAULT_MAX_STEPS}, max {MAX_STEPS_CAP}) — how many exploration tool calls the sub-agent may make before it must answer"
    },
    output=(
        "The sub-agent's final natural-language answer (with file:line / symbol evidence), followed by a one-line "
        "footer listing how many exploration steps it took and which tools it used. The exploration itself is NOT "
        "included — only the answer."
    ),
    when_to_use=(
        "Use this for higher-level 'how / why / where' questions about the workspace whose answer would otherwise "
        "cost you many read_file_chunk / query_code_graph calls and flood your context — offload that exploration "
        "here to keep your own conversation clean. For a single direct graph fact, call query_code_graph directly "
        "instead; this tool is for questions that need investigation and synthesis."
    )
)
def ask_codebase(question, context="", max_steps=DEFAULT_MAX_STEPS):
    question = (question or "").strip()
    if not question:
        return {"error": "ask_codebase requires a non-empty 'question'."}
    try:
        max_steps = int(max_steps)
    except (TypeError, ValueError):
        max_steps = DEFAULT_MAX_STEPS
    max_steps = max(1, min(max_steps, MAX_STEPS_CAP))

    # Guarantee a code graph exists BEFORE the sub-agent starts. Without this the
    # sub-agent frequently either skips building one and sweeps files, or wastes
    # steps rebuilding it. If nothing is indexed yet, auto-build one over the
    # whole workspace so it can navigate from its very first turn.
    from tools.code_graph import list_code_graphs, _auto_build_workspace_graph, _stdout_says_no_graph
    auto_note = ""
    try:
        graphs_res = list_code_graphs()
        if _stdout_says_no_graph(graphs_res):
            build = _auto_build_workspace_graph()
            auto_note = (
                "\nNOTE: no code graph existed, so a workspace-wide graph was just auto-built "
                "(graph_id='workspace'). Start by querying it with query_code_graph — do NOT rebuild "
                "it; only call build_code_graph if you need to index a specific sub-directory.\n"
                "Build summary: " + (build.get("stdout") or build.get("error") or "").strip()[:600] + "\n"
            )
    except Exception:
        auto_note = ""  # never let graph bootstrap failure block the Q&A

    # Build the sub-agent's system prompt: fixed instructions + a tool list scoped
    # to the read-only allowlist (generated from the live registry, so params stay
    # accurate automatically).
    tool_prompt = registry.get_tool_prompt(allowed_tools=ASK_CODEBASE_TOOLS)
    system_prompt = _SUBAGENT_SYSTEM_PROMPT + "\n\n" + tool_prompt

    user_prompt = f"QUESTION:\n{question}\n"
    if (context or "").strip():
        user_prompt += f"\nEXTRA CONTEXT / HINTS FROM THE CALLING AGENT:\n{context.strip()}\n"
    if auto_note:
        user_prompt += auto_note
    user_prompt += (
        "\nInvestigate the workspace and answer this question. Start by locating the relevant code "
        "(use the code graph / search for anything non-trivial), read only what you need, then give a "
        "final_answer with concrete file:line / symbol evidence."
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    tools_used = []
    steps = 0
    last_sig = None
    repeats = 0
    parse_errors = 0

    while steps < max_steps:
        raw = ask_llm(messages, temperature=SUBAGENT_TEMPERATURE)
        rtype, payload = _parse_subagent_response(raw)
        messages.append({"role": "assistant", "content": raw})

        if rtype == "final_answer":
            return _format_answer(payload, tools_used, steps)

        if rtype == "error":
            # Bounded: a model that never returns valid JSON must not spin
            # here forever (this branch doesn't consume a step). Salvage its
            # prose as the answer instead.
            parse_errors += 1
            if parse_errors >= 3:
                salvage = strip_reasoning(raw)
                return _format_answer(
                    salvage or f"[investigation failed: model kept replying outside the JSON protocol — {payload}]",
                    tools_used, steps,
                )
            messages.append({"role": "user", "content": (
                "Your last reply was not valid JSON. Respond with a single raw JSON object only — either "
                '{"type": "tool_call", "tool": "...", "args": {...}} or {"type": "final_answer", "content": "..."}.'
            )})
            continue
        parse_errors = 0

        # tool_call
        tool_name = payload.get("tool")
        tool_args = payload.get("args", {}) or {}

        # Loop guard: identical call repeated too many times in a row -> stop
        # executing it and steer, so it can't burn the whole step budget on one
        # stuck query.
        sig = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
        if sig == last_sig:
            repeats += 1
        else:
            repeats, last_sig = 1, sig
        if repeats >= REPEAT_LIMIT:
            messages.append({"role": "user", "content": (
                f"[SYSTEM] You've called '{tool_name}' with identical arguments {repeats} times. That's a loop. "
                "Try different arguments or a different tool, or give your final_answer."
            )})
            repeats = 0
            continue

        steps += 1
        tools_used.append(tool_name)
        feedback = _execute_readonly_tool(tool_name, tool_args)
        messages.append({"role": "user", "content": f"TOOL RESULT:\n{feedback}"})

        if _estimate_chars(messages) > CONTEXT_CHAR_LIMIT:
            return _force_final_answer(
                messages, tools_used, steps,
                note="stopped early — investigation context grew large; answer is based on findings so far.",
            )

    # Ran out of steps without a final answer — force one.
    return _force_final_answer(
        messages, tools_used, steps,
        note=f"reached the {max_steps}-step investigation limit.",
    )
