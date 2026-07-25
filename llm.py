import collections
import json
import os
import re
import threading
import time
import uuid
import requests
from tool_registry import registry
from skills_loader import get_skills_prompt

# --- LLM provider configuration ---------------------------------------------
# The provider, API key, model and endpoint are NO LONGER hardcoded here. They
# live in llm_config.json (next to this file, git-ignored) and are edited from
# the app's "LLM Settings" UI (AgentApi.get_llm_config / save_llm_config /
# test_llm_config -> the functions in this module).
#
# PROVIDERS below defines sensible defaults for each popular option; the saved
# config only needs to store what the user actually changed (provider + key,
# and optionally a model/base_url override).

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "llm_config.json")

REQUEST_TIMEOUT = 300
CONNECT_TIMEOUT = 15          # TCP/TLS connect cap, so a dead host fails fast (not after 300s)
MAX_RETRIES = 3
RETRY_BACKOFF = 2             # seconds to wait before retrying a provider-side error
# NVIDIA NIM (integrate.api.nvidia.com) QUEUES requests under load instead of
# answering: the POST returns HTTP 202 + an NVCF-REQID header and the result must
# be polled from GET {base_url}/status/{id} (202 = still pending, 200 = done).
# Poll only briefly — a short queue still succeeds — then give up so ask_llm
# fails over to the next configured provider instead of waiting out the queue.
QUEUE_POLL_SECONDS = 25
QUEUE_POLL_INTERVAL = 2
DEFAULT_MAX_TOKENS = 8192      # only the Anthropic protocol needs an explicit output cap
# Emitted in place of a response the provider cut off at the output-token cap
# (OpenAI finish_reason "length" / Anthropic stop_reason "max_tokens"). The
# partial text is unusable — often invalid mid-JSON — so returning it would make
# the agent fail to parse and dump the raw fragment to the UI. This small sentinel
# lets the agent recognize truncation and re-prompt for a smaller output instead.
TRUNCATED_ENVELOPE = json.dumps({"type": "truncated"})
# The active model's MAXIMUM context window, in tokens. The agent loop summarizes
# once estimated usage reaches a fraction of this (see agent.CONTEXT_WINDOW_FRACTION)
# so a long overnight run never overflows. Override per model via llm_config.json's
# "context_window" — this default assumes the large-window target model.
DEFAULT_CONTEXT_WINDOW = 1_000_000
DEFAULT_PROVIDER = "cline"

# Off-protocol tool calls repaired this session. GLM emits tag-shaped calls
# instead of the JSON envelope; this makes the rate visible instead of only
# surfacing when a run dies.
SALVAGE_STATS = collections.Counter()


def reset_salvage_stats():
    """Zero the salvage counters. Called once per session start."""
    SALVAGE_STATS.clear()


# Legacy hardcoded defaults. Kept for two reasons only:
#   1. First-run migration seed (see _SEED_CONFIG) so the app keeps working out
#      of the box for existing users instead of starting unconfigured.
#   2. `from llm import CLINE_API_URL, API_KEY, MODEL_NAME` still resolves for the
#      emulator vision tool (which now prefers get_openai_endpoint_config()).
# Everything routes through the live config via get_effective_config().
CLINE_API_URL = "https://api.cline.bot/api/v1/chat/completions"
API_KEY = "REDACTED_API_KEY"
MODEL_NAME = "cline-pass/glm-5.2"

# Two request "protocols" cover every provider:
#   openai    -> POST {base_url}/chat/completions, OpenAI chat-completions shape.
#                Covers OpenAI, Gemini (its OpenAI-compatible endpoint), LM Studio,
#                Ollama, Cline, and any other OpenAI-compatible server.
#   anthropic -> POST {base_url}/messages, Anthropic Messages API shape.
PROVIDERS = {
    "cline": {
        "label": "Cline Pass",
        "protocol": "openai",
        "base_url": "https://api.cline.bot/api/v1",
        "default_model": "cline-pass/glm-5.2",
        "requires_key": True,
        "envelope": True,   # unwrap Cline's {"data": {...}} response envelope
        "key_hint": "sk_...",
        "notes": "Cline Pass subscription (OpenAI-compatible).",
    },
    "openai": {
        "label": "OpenAI",
        "protocol": "openai",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o",
        "requires_key": True,
        "key_hint": "sk-...",
        "notes": "Official OpenAI API. Set your model (e.g. gpt-4o, o4-mini).",
    },
    "gemini": {
        "label": "Google Gemini",
        "protocol": "openai",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "default_model": "gemini-2.0-flash",
        "requires_key": True,
        "key_hint": "AIza...",
        "notes": "Gemini via its OpenAI-compatible endpoint. Use a Google AI Studio API key.",
    },
    "nvidia": {
        "label": "NVIDIA NIM",
        "protocol": "openai",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "default_model": "deepseek-ai/deepseek-v4-pro",
        "requires_key": True,
        "key_hint": "nvapi-...",
        "notes": ("NVIDIA NIM (build.nvidia.com), OpenAI-compatible. Any key serves any model; "
                  "reasoning is configured per model (⚙ on each model)."),
    },
    "claude": {
        "label": "Anthropic Claude",
        "protocol": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "default_model": "claude-opus-4-8",
        "requires_key": True,
        "key_hint": "sk-ant-...",
        "notes": "Anthropic Messages API. Sampling params are omitted (newer Claude models reject them).",
    },
    "lmstudio": {
        "label": "LM Studio (local)",
        "protocol": "openai",
        "base_url": "http://localhost:1234/v1",
        "default_model": "local-model",
        "requires_key": False,
        "key_hint": "(usually not required)",
        "notes": "Local LM Studio server. Start it and load a model; the model id must match the one it serves.",
    },
    "ollama": {
        "label": "Ollama (local)",
        "protocol": "openai",
        "base_url": "http://localhost:11434/v1",
        "default_model": "llama3.1",
        "requires_key": False,
        "key_hint": "(not required)",
        "notes": "Local Ollama server (OpenAI-compatible). Model must already be pulled (e.g. 'ollama pull llama3.1').",
    },
    "other": {
        "label": "Other (OpenAI-compatible)",
        "protocol": "openai",
        "base_url": "",
        "default_model": "",
        "requires_key": False,
        "key_hint": "optional",
        "notes": "Any OpenAI-compatible endpoint. Set the base URL (ending in /v1), the model id, and a key if it needs one.",
    },
}

# First-run seed so the app keeps working out of the box with the credentials
# that used to be hardcoded. Once llm_config.json exists, this is never used
# again — change the provider/key/model from the UI (or delete the file to reset).
_SEED_CONFIG = {
    "provider": "cline",
    "api_key": API_KEY,
    "model": MODEL_NAME,
    "base_url": PROVIDERS["cline"]["base_url"],
}


DEFAULT_SYSTEM_PROMPT = """You are Omni Agent, a general-purpose engineering AI agent. You write and scaffold \
code, debug and fix bugs, reverse-engineer software and Android apps, patch and rebuild APKs, analyze and modify \
native binaries, test apps on an emulator, and whatever else the task needs within your tools. You are not limited \
to one domain — pick the tools and skills that fit the task in front of you.

You run in a Linux Docker sandbox with the active project mounted at `/workspace`; all project files live there and \
`/workspace/notes.md` is your scratchpad for persistent notes. Most tools run in the sandbox; the Android emulator \
tools run on the host machine instead (their descriptions say so)."""


def get_static_system_prompt(native_tools=False):
    """The STATIC half of the system prompt: intro + behavioral contract +
    skills. It deliberately EXCLUDES the tool list — tools are rendered
    separately by render_tools_section() so progressive tool disclosure can vary
    which schemas are shown per turn without rebuilding any of this.

    native_tools=True adapts the RESPONSE FORMAT block for models driven via the
    OpenAI function-calling interface: they must NOT be told to emit the JSON
    envelope (that contradicts tool_choice=required and confuses the model), so
    the block points at the native interface and the final_answer tool instead."""
    base_prompt = DEFAULT_SYSTEM_PROMPT

    if native_tools:
        base_prompt += """

RESPONSE FORMAT: call tools through your native function-calling interface — exactly ONE tool call per turn. \
Pass a one-sentence `explanation` argument when you START a new sub-step (see EXPLAINING YOUR WORK). To FINISH the \
task, call the final_answer tool with your answer as `content`. Do NOT wrap calls in JSON text, markdown, or \
<tool_call>/<function> tags — use the function-calling interface directly.
"""
    else:
        base_prompt += """

RESPONSE FORMAT (always valid JSON, nothing else):
- Tool call:    {"type": "tool_call", "tool": "<name>", "args": { ... }, "explanation": "<optional 1 sentence>"}
- Final answer: {"type": "final_answer", "content": "<text>"}
Exactly ONE JSON object per turn — one tool at a time. No markdown, no code fences, no text outside the JSON.
"""

    # Shared behavioral contract (protocol-agnostic) — appended for BOTH the native
    # and prose RESPONSE FORMAT variants above.
    base_prompt += """

EXPLAINING YOUR WORK — the PLAN narrates the chat:
- Break work into subprocess/subtask STEPS (e.g. "scan the workspace", "patch the license check", "rebuild & verify").
  Marking a step in_progress (plan_update_task) prints its first-person "explanation" (or its description) as a chat
  line and OPENS an action group; every following tool call folds quietly under it until the NEXT step opens the next
  group. YOU control where the splits fall by how you shape the plan. One narration per sub-process — never narrate
  every call (reading three slices of one file is ONE step, not three lines).
- VOICE: casual, first-person, friendly, like a teammate — and VARY your openers (not "Let me…" every time).
- The per-call "explanation" field is the SECONDARY path: an aside, a mid-step pivot, or narration before a plan
  exists (your first action — usually plan_create — should carry one so the run opens with a line). Don't double-
  narrate. final_answer takes no explanation, and NEVER write prose outside the JSON.
- Independent RESEARCH steps tagged delegate=<read-agent> may be marked in_progress TOGETHER — they run as one
  parallel wave. Dependent steps and delegate=<write-agent> steps must be started one at a time.

PLAN & EXECUTE (adaptive, layered — the runtime expects it):
- INSPECT FREELY, THEN PLAN. Analyze the workspace as much as you need FIRST — read, search, decompile, query the
  code graph, load a skill — to build real understanding. There is NO limit on inspection and NO plan is required to
  explore. Once you actually understand the task (tools, constraints, what "done" objectively means, the biggest
  unknowns), call `plan_create` — task summary, `success_criteria`, `constraints`, `phases` (3-6 stable milestones),
  and the first phase's `steps` — BEFORE you change anything (edit/patch/build). Plan when you're ready, not before;
  a trivial one-line answer needs no plan.
- THREE LAYERS, each revised on its own so you never rewrite the whole plan: MISSION (task+criteria+constraints) and
  PHASES are STABLE (re-cut only on a real replan); STEPS are the small current-phase actions that churn; NEXT ACTION
  is the one precise next move (`plan_set_next_action`).
- STEPS ARE SMALL AND VERIFIABLE: give an important step a clear "done when…" check plus action / purpose / expected /
  verification / fallback (fields on plan_add_task/plan_update_task). Mark a step in_progress when you start it,
  completed ONLY once done AND its verification passed, skipped (with a note) if moot.
- PARALLELISM: steps in the SAME phase run CONCURRENTLY by default — starting one delegated step fans out every
  independent delegated step in that phase at once. So GROUP independent research/probes into one phase to run them in
  parallel, and when a step truly needs another's result, either set its `depends_on` to that step's id (same phase) or
  put it in a LATER phase. Writes to the shared workspace are always serialized for you.
  Prefer the smallest action that reduces uncertainty; avoid over-planning and inventing unconfirmed details.
- ADVANCE with `plan_advance_phase` at a real milestone. REPLAN, don't drift: a SCOPED edit (add/update/reorder) for a
  course-correction; `plan_replan` (with reason) after a major failure / invalidated assumption / repeated dead ends —
  it preserves completed work. End with `plan_set_outcome` (completed / partial / blocked / needs_different_approach)
  right before your final answer. The live plan is appended below as "CURRENT PLAN" — it is the source of truth; keep
  it accurate rather than working ahead of it.

EVIDENCE & VALIDATION — prove it, don't assume it:
- EVIDENCE: back every important claim with something objective (file:line, symbol/class/method, search hit, or
  command/build/test/log output). Keep FACTS vs GUESSES separate — record_finding (evidence REQUIRED) for a proven
  fact; record_hypothesis (confidence + partial evidence) for an idea, then update_hypothesis to confirm/refute it.
  Never state a guess as established.
- DURABLE MEMORY: investigation_view survives context resets — consult it instead of re-deriving. Log dead ends with
  record_failed_attempt and do NOT re-run a failed approach without NEW evidence (switch strategy). record_decision at
  real forks.
- VALIDATE: a code/binary edit is NOT done until an objective check passes — build → sign → install → launch → test /
  inspect logs as the task warrants, then record_test_result. "It should work" is unverified.
- REVIEW: your final_answer is auto-checked by an independent reviewer for unsupported claims, contradictions and
  unfinished work; on revise, close the gaps with real tool calls and answer again (don't resend). Before finalizing,
  run your OWN contradiction check — hunt for a second unpatched code path, another .so loading the same check, a test
  that would fail — not just confirmation. review_conclusion pressure-tests an intermediate result.

BIG / OBFUSCATED CODEBASES — map first, then read (HARD RULE):
- Landing in a large tree (decompiled APK or any big project): MAP before reading. The code knowledge graph
  AUTO-BUILDS, so just call query_code_graph with a name — no query_type needed: `query_code_graph(name="isRooted")`
  or `query_code_graph(name="/system/xbin/su")` searches ALL of string literals + methods + classes + native symbols
  at once and lands you on exact file:line hits. Only THEN read_file_chunk that one slice, or drill in with a specific
  query_type (string_refs / callers / callees / class / hierarchy). Search, don't browse — the graph, plus
  find_files / grep_directory / search_smali, locate things; opening files one-by-one to "get oriented" burns context.
- ask_codebase answers a "how/why/where does X work" question in an isolated context when it would otherwise cost many
  reads.

APK MODDING PLAYBOOK (the core mission — decode → map → understand → patch smallest → rebuild → verify):
- READ with jadx_decompile (readable Java/Kotlin; deobf=true on ProGuard/R8). EDIT in smali (decode_apk →
  patch_smali_method / insert_smali_code) or on the native .so — never rebuild from jadx output.
- LOCATE the logic: `query_code_graph(name="<the check/string/method>")` searches everything and lands you on the
  file:line — signature/root/license/anti-tamper checks are usually found by their strings. Then callers/callees trace
  the guard. For a native check, ghidra_decompile gives C pseudocode and analyze_function_calls flags kill-switch/
  anti-tamper imports.
- PATCH THE SMALLEST THING that works: force a boolean check to return the safe value (smali, or native
  patch_function_return / nop_function), rather than unwinding the whole routine. For obfuscated string checks no
  plaintext search finds, load the string-deobfuscation skill — bypassing the check usually beats decrypting it.
- LAYERED PROTECTIONS are the norm: expect the SAME defense in more than one place (Java AND native; a check plus an
  integrity re-check). After patching one, look for the others before declaring success.
- CONFIRM DYNAMICALLY when unsure: on the dev base, use frida (frida_trace / frida_run_script) to prove which check
  fires and what flipping it does BEFORE committing a static patch — then bake the confirmed change into smali/.so.
- SKILLS: the apk-modding / ssl-pinning-bypass / signature-bypass / anti-debug-bypass / string-deobfuscation skills
  are battle-tested workflows — consult the matching one (use_skill) instead of improvising.
"""

    prompt = base_prompt + "\n" + get_skills_prompt()
    # Fold in the delegatable subagents (plugin-provided) so the planner can target
    # them with a plan step's `delegate` field or dispatch_agents. Lazy import keeps
    # llm import-light and avoids a plugins -> subagents -> llm cycle at load time;
    # empty string when no plugins/agents are present, so lightweight setups are
    # unaffected.
    try:
        from plugins import get_registry
    except ImportError:
        get_registry = None  # plugins package absent (lightweight setup) — expected
    if get_registry is not None:
        try:
            reg = get_registry()
            prompt += "\n" + reg.get_agents_prompt()
            # Fold in the plugin-contributed workflow COMMANDS index (name +
            # description). Only the index is shown; full bodies load on demand via
            # use_command, so this stays tiny no matter how many commands plugins ship.
            prompt += "\n" + reg.get_commands_prompt()
        except Exception as e:
            # Plugins ARE installed but building their agents/commands index raised —
            # a real bug, not the expected "no plugins" case. Stay fail-open (never
            # break system-prompt construction) but SURFACE it instead of silently
            # dropping the whole index, which would degrade the agent with no trace.
            print(f"[llm] plugin agents/commands index skipped after error: {e!r}")
    return prompt


def render_tools_section(active_groups=None, native=False, hidden_groups=None):
    """The AVAILABLE TOOLS section of the prompt, honoring progressive
    disclosure. active_groups=None renders EVERY tool in full (legacy behavior,
    used by isolated sub-agents/tests); a set renders core + active domain
    toolsets in full and the rest as a compact one-line catalog.

    native=True renders a COMPACT name+summary index only (no JSON call-format
    header, no full param blocks) — the authoritative schemas ride in the
    request's `tools=` array, so duplicating them as text just wastes context and
    contradicts the function-calling protocol.

    hidden_groups (if given) omits those toolset groups entirely from every
    render path — used to suppress a whole feature's tools (e.g. "strategy")
    when the feature's flag is off."""
    return registry.get_tool_prompt(active_groups=active_groups, native=native,
                                    hidden_groups=hidden_groups)


def get_full_system_prompt(active_groups=None, native=False):
    """Convenience: the whole prompt = static half + tool section. With
    active_groups=None every tool is shown (used where the full surface is
    wanted); pass a set for progressive disclosure. native=True adapts both
    halves for the function-calling interface."""
    return (get_static_system_prompt(native_tools=native) + "\n"
            + render_tools_section(active_groups, native=native))


# --- config load / save ------------------------------------------------------
# The config file now stores an ORDERED LIST of provider entries under "configs":
#   {"version": 2, "configs": [ {id, name, provider, api_key, model, base_url}, ... ]}
# The order IS the fallback priority — ask_llm tries configs[0] first and falls
# through to the next on failure. The legacy single-config shape ({provider, ...})
# is migrated into a one-entry list on first read.
def _as_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value):
    """Parse a float, or None for empty/unparseable input (so an unset
    temperature stays None and the provider default is used)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# Valid reasoning-effort levels for the advanced provider options. "" / "off"
# means no reasoning. For the Anthropic protocol these map to an extended-thinking
# token budget; for OpenAI-compatible providers the level is used by the "openai"
# and "deepseek_v4" reasoning styles (below) and is otherwise just an on/off switch.
# "max" exists for DeepSeek V4's Think-Max mode (and the biggest Claude budget);
# styles whose APIs don't know it treat it as their strongest level.
REASONING_LEVELS = ("minimal", "low", "medium", "high", "max")
_THINKING_BUDGETS = {"minimal": 1024, "low": 4096, "medium": 8192, "high": 16384, "max": 32768}

# HOW an OpenAI-compatible provider is asked to reason differs by model family —
# a single `reasoning_effort` field only works for o-series/GPT-5-style models.
# The effort level says WHETHER (and how hard) to reason; the style says how to
# encode that in the request body:
#   openai        -> reasoning_effort: <level>                     (o-series, GPT-5, many hosted APIs)
#   thinking      -> thinking: {"type": "enabled"|"disabled"}      (GLM / Z.AI, incl. GLM 5.2 via Cline;
#                    on NVIDIA NIM the same toggle is mirrored into chat_template_kwargs)
#   chat_template -> chat_template_kwargs: {thinking, enable_thinking}  (Qwen3, DeepSeek V3.x, Kimi & other vLLM/NIM)
#   deepseek_v4   -> reasoning_effort: none|high|max + the same knobs in
#                    chat_template_kwargs                          (DeepSeek V4 Pro/Flash on NIM/vLLM)
#   nemotron3     -> chat_template_kwargs: {enable_thinking, medium_effort}  (Nemotron 3 family)
#   system        -> prepend a "detailed thinking on/off" system line   (older Llama-Nemotron)
#   none          -> model always reasons (or can't toggle); send nothing special
# "" / "auto" means: infer the style from the model name (_auto_reasoning_style).
REASONING_STYLES = ("openai", "thinking", "chat_template", "deepseek_v4", "nemotron3", "system", "none")


def _norm_reasoning(value):
    """Normalize a reasoning-effort value to one of REASONING_LEVELS, or '' for
    off/unset/unknown."""
    v = (value or "").strip().lower()
    return v if v in REASONING_LEVELS else ""


def _norm_reasoning_style(value):
    """Normalize a reasoning-style value to one of REASONING_STYLES, or '' for
    auto/unset/unknown (auto = infer from the model at request time)."""
    v = (value or "").strip().lower()
    return v if v in REASONING_STYLES else ""


# --- per-model reasoning overrides -------------------------------------------
# A config entry holds a whole MODEL LADDER, and models from different families
# want different reasoning: GLM's `thinking` flag is not DeepSeek V4's none/high/max
# effort, and one model may want reasoning off while another wants Max. `model_settings`
# maps a model id -> its OWN {reasoning_effort, reasoning_style}; anything unset there
# inherits the entry's group-level reasoning (so an all-default ladder stores nothing).
def _norm_model_effort(value):
    """Normalize a PER-MODEL reasoning-effort override. Unlike the group level this
    has THREE states: '' (absent -> inherit the entry's effort), 'off' (explicitly no
    reasoning, overriding an ON group default), or one of REASONING_LEVELS. Returns
    'off', a level, or '' for inherit/unknown."""
    v = (value or "").strip().lower()
    if v == "off":
        return "off"
    return v if v in REASONING_LEVELS else ""


def _norm_tier(value):
    """Normalize a per-model TIER tag to a lowercase slug, or '' when absent.

    Tier names are deliberately OPEN — 'premium'/'standard'/'cheap' are only the
    names the system prompt advertises, so tagging a model 'fast' works with no
    code change. Kept to a slug so it round-trips through JSON and the UI select."""
    # Handle non-string input by silently degrading to empty tier (malformed input).
    # This ensures hand-edited JSON with "tier": 5 degrades gracefully to no tier,
    # rather than raising (which would crash config loading).
    if not isinstance(value, str):
        return ""
    v = re.sub(r"[^a-z0-9_-]+", "-", value.strip().lower())
    v = v[:32].strip("-")
    return v


def _norm_model_settings(value, model_ids=None):
    """Normalize a model_settings map to {model_id: {reasoning_effort?, reasoning_style?, tier?}}.
    Only keeps keys the user actually set, drops empty overrides, and — when
    `model_ids` is given — any model no longer in the ladder (so stale entries don't
    linger after a model is removed/renamed)."""
    if not isinstance(value, dict):
        return {}
    allowed = set(model_ids) if model_ids is not None else None
    out = {}
    for model, s in value.items():
        model = str(model).strip()
        if not model or (allowed is not None and model not in allowed) or not isinstance(s, dict):
            continue
        entry = {}
        eff = _norm_model_effort(s.get("reasoning_effort"))
        if eff:
            entry["reasoning_effort"] = eff
        sty = _norm_reasoning_style(s.get("reasoning_style"))
        if sty:
            entry["reasoning_style"] = sty
        if isinstance(s.get("supports_native_tools"), bool):
            entry["supports_native_tools"] = s["supports_native_tools"]
        tier = _norm_tier(s.get("tier"))
        if tier:
            entry["tier"] = tier
        if entry:
            out[model] = entry
    return out


def _auto_reasoning_style(model):
    """Best-guess reasoning style from a model id, used when the config leaves the
    style on Auto. Deliberately conservative: GLM is the one the app ships with by
    default (Cline's glm-5.2), so that mapping is the important one. Anything not
    recognized falls back to the OpenAI `reasoning_effort` field, which the common
    hosted reasoning models accept."""
    m = (model or "").lower()
    if "glm" in m:
        return "thinking"
    if "nemotron" in m:
        # Nemotron 3 switched from the "detailed thinking on/off" system directive
        # to chat-template kwargs (enable_thinking / medium_effort / reasoning_budget).
        if "nemotron-3" in m or "nemotron3" in m:
            return "nemotron3"
        return "system"
    if "qwen3" in m or "qwen-3" in m or "kimi" in m:
        return "chat_template"
    if "deepseek" in m:
        # R1 always emits reasoning with no switch; V4 (Pro/Flash) has explicit
        # none/high/max effort modes; V3.1+ toggles via the chat template.
        if "r1" in m:
            return "none"
        if "v4" in m:
            return "deepseek_v4"
        return "chat_template"
    return "openai"


def _resolve_reasoning_style(cfg):
    """The explicit reasoning style if set, else the model-inferred one."""
    return _norm_reasoning_style(cfg.get("reasoning_style")) or _auto_reasoning_style(cfg.get("model"))


def _supports_native_tools(cfg):
    """Whether the active model should be sent an OpenAI `tools` array.
    Per-model override (model_settings) wins; else the config-level default;
    else False (the safe prose path)."""
    model = cfg.get("model")
    ms = (cfg.get("model_settings") or {}).get(model) or {}
    if isinstance(ms.get("supports_native_tools"), bool):
        return ms["supports_native_tools"]
    return bool(cfg.get("supports_native_tools"))


def _dsv4_effort(level):
    """Collapse our effort levels onto DeepSeek V4's three modes: off -> "none",
    max -> "max", any other ON level -> "high" (the model's default)."""
    if not level:
        return "none"
    return "max" if level == "max" else "high"


def _apply_openai_reasoning(payload, cfg, messages):
    """Switch reasoning on/off for an OpenAI-compatible request per the config's
    reasoning style, mutating `payload` in place. The effort level doubles as the
    on/off switch ('' = off). Returns (messages, reasoning_on, style):
      * `messages` may be a NEW list — the 'system' style prepends a directive — so
        callers must send the RETURNED list, not the original;
      * `reasoning_on` / `style` let the caller decide whether to drop sampling
        params (only the 'openai' style needs them omitted)."""
    level = _norm_reasoning(cfg.get("reasoning_effort"))
    on = bool(level)
    style = _resolve_reasoning_style(cfg)
    if style == "openai":
        if on:
            # OpenAI's enum tops out at "high" — map our "max" onto it.
            payload["reasoning_effort"] = "high" if level == "max" else level
    elif style == "deepseek_v4":
        # DeepSeek V4 (Pro/Flash) exposes none/high/max. The hosted NIM endpoint
        # takes a top-level reasoning_effort enum that DEFAULTS TO HIGH, so "off"
        # must be sent explicitly as "none". vLLM self-hosts read the same knobs
        # from chat_template_kwargs (templates ignore unknown kwargs), so both
        # encodings are sent together.
        effort = _dsv4_effort(level)
        payload["reasoning_effort"] = effort
        kwargs = {"thinking": on, "enable_thinking": on}
        if on:
            kwargs["reasoning_effort"] = effort
        payload["chat_template_kwargs"] = kwargs
    elif style == "thinking":
        # GLM / Z.AI: an explicit switch. Send it for OFF too, so a model that
        # reasons by default can still be turned off from the UI. NVIDIA NIM hosts
        # GLM behind a Jinja chat template instead, so the same toggle is mirrored
        # into chat_template_kwargs there (Z.AI/Cline never see the extra field).
        payload["thinking"] = {"type": "enabled" if on else "disabled"}
        if cfg.get("provider") == "nvidia" or "nvidia" in (cfg.get("base_url") or ""):
            payload["chat_template_kwargs"] = {"thinking": on, "enable_thinking": on}
    elif style == "nemotron3":
        # Nemotron 3 (Ultra/Super/Nano): reasoning via chat-template kwargs.
        # medium_effort trims the trace; full thinking is the default when on.
        kwargs = {"enable_thinking": on}
        if on and level in ("minimal", "low", "medium"):
            kwargs["medium_effort"] = True
        payload["chat_template_kwargs"] = kwargs
    elif style == "chat_template":
        # vLLM / NIM Jinja templates read these kwargs; an unused key is ignored by
        # the template, so sending both common spellings is safe.
        payload["chat_template_kwargs"] = {"thinking": on, "enable_thinking": on}
    elif style == "system":
        directive = "detailed thinking on" if on else "detailed thinking off"
        messages = [{"role": "system", "content": directive}] + list(messages)
    # style == "none": nothing to add either way.
    return messages, on, style


def _gen_id():
    return uuid.uuid4().hex[:8]


def _dedup(seq):
    """Order-preserving de-duplication of a string list (drops blanks)."""
    out, seen = [], set()
    for x in seq:
        x = str(x).strip()
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _key_list(cfg):
    """The API-KEY POOL for one config entry, decoupled from any model: the
    explicit `api_keys` list plus anything in `api_key` (which itself may hold
    several keys, comma/space/newline separated). Deduped, order preserved."""
    keys = []
    raw_list = cfg.get("api_keys")
    if isinstance(raw_list, (list, tuple)):
        for k in raw_list:
            keys.extend(_split_keys(k))
    keys.extend(_split_keys(cfg.get("api_key")))
    return _dedup(keys)


def _model_list(cfg):
    """The TEXT-to-TEXT MODEL FALLBACK LADDER for one config entry (priority order,
    primary first), decoupled from the keys: the explicit `models` list plus a
    single `model`. Any key in the pool can serve any of these models."""
    models = []
    raw_list = cfg.get("models")
    if isinstance(raw_list, (list, tuple)):
        models.extend(str(m) for m in raw_list)
    if cfg.get("model"):
        models.append(cfg.get("model"))
    return _dedup(models)


def _vision_model_list(cfg):
    """The IMAGE-to-TEXT (vision) model ladder for one config entry — a SEPARATE
    axis from the text models, used to reason over screenshots/images. Shares the
    same key pool. From `vision_models` (list) or a single `vision_model`."""
    models = []
    raw_list = cfg.get("vision_models")
    if isinstance(raw_list, (list, tuple)):
        models.extend(str(m) for m in raw_list)
    if cfg.get("vision_model"):
        models.append(cfg.get("vision_model"))
    return _dedup(models)


def _minimize_entry(cfg):
    """Normalize one config entry for storage. base_url/model are dropped when
    they equal the provider preset's default, so an entry stays minimal and never
    inherits a stale endpoint/model from another provider. id/name are always kept
    (generated/filled if missing)."""
    provider = (cfg.get("provider") or DEFAULT_PROVIDER)
    preset = PROVIDERS.get(provider) or PROVIDERS["other"]
    base_url = (cfg.get("base_url") or "").strip()
    if base_url.rstrip("/") == (preset["base_url"] or "").rstrip("/"):
        base_url = ""
    name = (cfg.get("name") or "").strip() or preset["label"]
    # KEYS and MODELS are DECOUPLED (a shared key pool + a separate model ladder).
    # A key pool comes from api_keys (list) or api_key (which may itself hold several,
    # comma/space/newline separated); a model ladder from models (list) or model.
    keys = _key_list(cfg)
    models = _model_list(cfg)
    entry = {
        "id": (cfg.get("id") or "").strip() or _gen_id(),
        "name": name,
        "provider": provider,
        "base_url": base_url,
    }
    # Store the canonical form: singular when there's exactly one (keeps simple
    # entries tidy and back-compatible), a list when it's a real pool/ladder.
    if len(keys) > 1:
        entry["api_keys"] = keys
    else:
        entry["api_key"] = keys[0] if keys else ""
    # Drop a lone model that just equals the provider default (stays minimal); an
    # explicit multi-model ladder is always kept verbatim, order = priority.
    if len(models) > 1:
        entry["models"] = models
    else:
        entry["model"] = "" if (not models or models[0] == (preset["default_model"] or "")) else models[0]
    # The separate image-to-text (vision) model ladder, if any.
    vision = _vision_model_list(cfg)
    if vision:
        entry["vision_models"] = vision
    # Per-model reasoning overrides, pruned to the models still in the ladder.
    model_settings = _norm_model_settings(cfg.get("model_settings"), models)
    if model_settings:
        entry["model_settings"] = model_settings
    if cfg.get("max_tokens"):
        entry["max_tokens"] = _as_int(cfg.get("max_tokens"), DEFAULT_MAX_TOKENS)
    if cfg.get("context_window"):
        entry["context_window"] = _as_int(cfg.get("context_window"), DEFAULT_CONTEXT_WINDOW)
    reasoning = _norm_reasoning(cfg.get("reasoning_effort"))
    if reasoning:
        entry["reasoning_effort"] = reasoning
    reasoning_style = _norm_reasoning_style(cfg.get("reasoning_style"))
    if reasoning_style:
        entry["reasoning_style"] = reasoning_style
    temperature = _as_float(cfg.get("temperature"))
    if temperature is not None:
        entry["temperature"] = temperature
    return entry


def _settings_sig(c):
    """Everything about an entry EXCEPT its keys/models/id/name — two entries with
    the same signature are the same provider configured identically, so their keys
    and models can be pooled/laddered into one decoupled entry."""
    preset = PROVIDERS.get(c.get("provider")) or PROVIDERS["other"]
    base = (c.get("base_url") or "").strip().rstrip("/")
    if base == (preset["base_url"] or "").rstrip("/"):
        base = ""
    return (c.get("provider"), base,
            _norm_reasoning(c.get("reasoning_effort")), _norm_reasoning_style(c.get("reasoning_style")),
            c.get("max_tokens") or None, c.get("context_window") or None, _as_float(c.get("temperature")))


def _collapse_configs(entries):
    """Fold entries that are the SAME provider configured identically into ONE
    decoupled entry: their API keys pool into `api_keys`, their models ladder into
    `models` (first-appearance order = priority). This turns the old "one entry per
    key+model pair" shape into "a key pool + a model list", which is how keys and
    models are meant to be configured (keys are shared across all models). Distinct
    providers / differently-tuned entries are left as separate fallback entries."""
    merged = []
    index = {}
    for c in entries:
        preset = PROVIDERS.get(c.get("provider")) or PROVIDERS["other"]
        keys = _key_list(c)
        models = [m or (preset["default_model"] or "") for m in _model_list(c)] or [preset["default_model"] or ""]
        vision = _vision_model_list(c)
        sig = _settings_sig(c)
        g = index.get(sig)
        if g is None:
            g = dict(c)
            g["api_keys"] = list(keys)
            g["models"] = _dedup(models)
            if vision:
                g["vision_models"] = list(vision)
            g["model_settings"] = dict(c.get("model_settings") or {})
            g.pop("api_key", None)
            g.pop("model", None)
            index[sig] = g
            merged.append(g)
        else:
            g["api_keys"] = _dedup(g["api_keys"] + keys)
            g["models"] = _dedup(g["models"] + models)
            if vision:
                g["vision_models"] = _dedup(g.get("vision_models", []) + vision)
            ms = c.get("model_settings")
            if isinstance(ms, dict):
                g.setdefault("model_settings", {}).update(ms)
    return merged


def _read_config_file():
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def load_configs():
    """Return the ordered list of raw config entries (fallback priority order).

    Migrates the legacy single-config shape into a one-entry list, seeds a first
    entry from the legacy Cline credentials on first run, but RESPECTS an explicit
    empty list (so deleting every provider in the UI actually leaves zero)."""
    data = _read_config_file()
    if isinstance(data, dict) and isinstance(data.get("configs"), list):
        raw = data["configs"]                       # new shape (may be [] on purpose)
    elif isinstance(data, dict) and data.get("provider"):
        raw = [data]                                # legacy single-config -> migrate
    else:
        seeded = _minimize_entry(dict(_SEED_CONFIG))  # first run / unreadable -> seed
        save_configs([seeded])
        return [seeded]

    out = []
    for c in raw:
        if not isinstance(c, dict) or not (c.get("provider")):
            continue
        c = dict(c)
        c["id"] = (c.get("id") or "").strip() or _gen_id()
        # Adopt entries saved before the NVIDIA preset existed: a generic "other"
        # entry aimed at the NVIDIA NIM host is really an NVIDIA provider, so relabel
        # it (keeping the user's own display name) — it then shows under the NVIDIA
        # tab and resolves identically. In-memory only; it persists on next save.
        if c["provider"] == "other" and "integrate.api.nvidia.com" in (c.get("base_url") or ""):
            c["provider"] = "nvidia"
        preset = PROVIDERS.get(c["provider"]) or PROVIDERS["other"]
        if not (c.get("name") or "").strip():
            c["name"] = preset["label"]
        out.append(c)

    # Decouple keys from models: fold identically-configured same-provider entries
    # into one entry with a shared key POOL + a model LADDER. If this actually
    # collapsed anything (old key+model-pair configs), persist the clean form so it
    # only migrates once and the settings UI shows the pool/ladder directly.
    collapsed = _collapse_configs(out)
    if len(collapsed) != len(out) and save_configs(collapsed):
        return load_configs()   # re-read the now-clean form (collapse is idempotent)
    return collapsed


def _write_config_file(data):
    tmp = _CONFIG_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, _CONFIG_PATH)
        return True
    except OSError:
        return False


def save_configs(configs):
    """Persist the ordered list of config entries to llm_config.json (atomic).
    Top-level extras (e.g. the user's preferred_model) are carried over."""
    if not isinstance(configs, list):
        return False
    entries = [_minimize_entry(c) for c in configs
               if isinstance(c, dict) and c.get("provider")]
    data = {"version": 2, "configs": entries}
    prev = _read_config_file()
    if isinstance(prev, dict) and isinstance(prev.get("preferred_model"), dict):
        data["preferred_model"] = prev["preferred_model"]
    return _write_config_file(data)


# Back-compat single-config helpers — operate on the PRIMARY (first) entry, for
# callers that still think in terms of one active provider.
def load_config():
    configs = load_configs()
    return dict(configs[0]) if configs else dict(_SEED_CONFIG)


def save_config(cfg):
    """Upsert the primary (first) config, preserving the rest of the fallback
    chain. Used by the legacy single-provider save path."""
    configs = load_configs()
    entry = _minimize_entry(cfg)
    if configs:
        entry["id"] = (cfg.get("id") or "").strip() or configs[0].get("id") or entry["id"]
        configs[0] = entry
    else:
        configs = [entry]
    return save_configs(configs)


def _effective(raw, overrides=None):
    """Resolve one raw entry against its provider preset into a fully-usable config."""
    cfg = dict(raw or {})
    if overrides:
        cfg.update({k: v for k, v in overrides.items() if v is not None})
    provider = cfg.get("provider") or DEFAULT_PROVIDER
    preset = PROVIDERS.get(provider) or PROVIDERS["other"]
    base_url = (cfg.get("base_url") or preset["base_url"] or "").strip().rstrip("/")
    # Resolve the DECOUPLED key pool + model ladder. `model`/`api_key` (singular)
    # are kept as the first of each for back-compat callers (settings prefill, the
    # emulator vision endpoint, connection tests).
    keys = _key_list(cfg)
    models = _model_list(cfg) or [preset["default_model"] or ""]
    models = [m or (preset["default_model"] or "") for m in models]
    model = (cfg.get("model") or models[0] or preset["default_model"] or "").strip()
    vision_models = _vision_model_list(cfg)
    return {
        "id": (cfg.get("id") or "").strip(),
        "name": (cfg.get("name") or "").strip() or preset["label"],
        "provider": provider,
        "protocol": preset["protocol"],
        "label": preset["label"],
        "base_url": base_url,
        "model": model,
        "models": models,
        "vision_models": vision_models,
        "api_keys": keys,
        "api_key": (cfg.get("api_key") if isinstance(cfg.get("api_key"), str) else "").strip() or (keys[0] if keys else ""),
        "envelope": preset.get("envelope", False),
        "requires_key": preset.get("requires_key", False),
        "max_tokens": _as_int(cfg.get("max_tokens"), DEFAULT_MAX_TOKENS),
        # Whether the entry EXPLICITLY sets an output cap. The OpenAI protocol only
        # sends max_tokens when it does (some reasoning models reject the field),
        # while Anthropic always needs one and falls back to the default above.
        "max_tokens_set": bool(cfg.get("max_tokens")),
        "context_window": _as_int(cfg.get("context_window") or preset.get("context_window"), DEFAULT_CONTEXT_WINDOW),
        "reasoning_effort": _norm_reasoning(cfg.get("reasoning_effort")),
        "reasoning_style": _norm_reasoning_style(cfg.get("reasoning_style")),
        # Per-model reasoning overrides, keyed by model id (pruned to the ladder).
        "model_settings": _norm_model_settings(cfg.get("model_settings"), models),
        "temperature": _as_float(cfg.get("temperature")),
    }


def get_effective_configs():
    """Every configured provider resolved with its preset, in fallback order."""
    return [_effective(c) for c in load_configs()]


def active_key_pool():
    """Flat list of API keys for the currently preferred (else primary) provider
    group, in config order. Sizes subagent waves and feeds the KeyAllocator."""
    configs = get_effective_configs()
    if not configs:
        return []
    pref = get_preferred_model() or {}
    cid = pref.get("config_id")
    chosen = next((c for c in configs if c.get("id") == cid), None) or configs[0]
    keys = chosen.get("api_keys")
    if isinstance(keys, list):
        return [k for k in keys if k]
    if isinstance(keys, str):
        return [p for p in re.split(r"[,\s]+", keys) if p]
    k = chosen.get("api_key")
    return [k] if k else []


def get_effective_config(overrides=None):
    """The PRIMARY effective config (first in the fallback chain), merged with
    optional unsaved overrides. When overrides name a provider (a connection test),
    resolve purely from those overrides so no stale primary values leak in."""
    if overrides and (overrides.get("provider")):
        base = {}
    else:
        configs = load_configs()
        base = configs[0] if configs else {"provider": DEFAULT_PROVIDER}
    return _effective(base, overrides)


def get_context_window():
    """The active model's maximum context window in tokens. Read live from the
    config (or the provider preset), defaulting to DEFAULT_CONTEXT_WINDOW. The
    agent loop uses this to decide when to auto-summarize so it never overflows."""
    try:
        return get_effective_config().get("context_window") or DEFAULT_CONTEXT_WINDOW
    except Exception:
        return DEFAULT_CONTEXT_WINDOW


def list_providers():
    """Preset metadata for the settings UI to render provider tabs + defaults."""
    return [
        {
            "id": pid,
            "label": p["label"],
            "protocol": p["protocol"],
            "base_url": p["base_url"],
            "default_model": p["default_model"],
            "requires_key": p.get("requires_key", False),
            "key_hint": p.get("key_hint", ""),
            "notes": p.get("notes", ""),
        }
        for pid, p in PROVIDERS.items()
    ]


def get_openai_endpoint_config():
    """{'url','key','model'} for the active provider IF it speaks the OpenAI
    chat-completions protocol. Used by the emulator vision analyzer, which sends
    OpenAI-format vision messages. Falls back to the legacy Cline endpoint when
    the active provider isn't OpenAI-compatible (e.g. Claude), so that path still
    has a reasonable default to try before failing over to local Ollama."""
    cfg = get_effective_config()
    if cfg["protocol"] == "openai" and cfg["base_url"]:
        return {
            "url": cfg["base_url"].rstrip("/") + "/chat/completions",
            "key": cfg["api_key"],
            "model": cfg["model"],
        }
    return {"url": CLINE_API_URL, "key": API_KEY, "model": MODEL_NAME}


# --- robust JSON action extraction -------------------------------------------
# Reasoning models (GLM, DeepSeek-R1, etc.) rarely return the bare JSON object
# the system prompt demands: they prepend <think> blocks, wrap the JSON in
# ```json fences, or write prose that itself contains braces. A naive
# first-"{"-to-last-"}" slice breaks on all of those, so the agent loop and the
# codebase-QA sub-agent both extract actions through here instead.

_THINK_BLOCK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.DOTALL | re.IGNORECASE)
_THINK_TAIL_RE = re.compile(r"^.*?</think(?:ing)?>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")

_TAG_NAMES = r"tool_call|function_call|function"
_TAG_OPEN = r"<(?:" + _TAG_NAMES + r")"
# The closing tag is OPTIONAL: GLM emits `<tool_call>name{json}` with no
# `</tool_call>` in 742 of 808 observed messages. An unclosed body runs to the
# next tag opener or to end of string.
_TAG_RE = re.compile(
    _TAG_OPEN
    + r"(?:\s+name\s*=\s*\"(?P<attr>[\w.]+)\")?"
    + r"(?:\s*=\s*(?P<eqname>[\w.]+))?\s*>"
    + r"(?P<body>.*?)"
    + r"(?:</(?:" + _TAG_NAMES + r")>|(?=" + _TAG_OPEN + r")|\Z)",
    re.DOTALL | re.IGNORECASE,
)
_LEADING_NAME_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*(\{.*\})\s*$", re.DOTALL)
_BARE_NAME_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*$")
# Two more in-tag call shapes GLM emits, name-resolution only (the JSON args
# are already recovered by _coerce_args/_json_candidates regardless of what
# wraps them, since raw_decode scans for the first '{' and tolerates
# trailing text): `name({...})` (call-syntax body, dominant real-world shape)
# and `name args={...}` (bare "args=" prefix instead of touching braces
# directly). Only used inside a tag body, where the tag is already the
# evidence a call is present (no registration check, same as the other
# in-tag name patterns above).
_LEADING_NAME_CALL_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)(?:\s*\(|\s+args\s*=)", re.DOTALL)


def _coerce_args(raw):
    """Pull an args dict out of a fragment: a JSON object if present, else {}."""
    if not raw:
        return {}
    for obj in _json_candidates(raw):
        if isinstance(obj, dict):
            # A wrapper like {"name":..,"arguments":{..}} -> use its arguments.
            if "arguments" in obj and isinstance(obj["arguments"], dict):
                return obj["arguments"]
            if "args" in obj and isinstance(obj["args"], dict):
                return obj["args"]
            return obj
    return {}


def _normalize_nonjson_actions(text):
    """Map every non-JSON tool-call shape in `text` onto canonical actions, in order.

    Recognizes <tool_call>/<function_call>/<function=> tags (name via attribute,
    `=name`, or a leading token inside the body), a bare `name\\n{json}` pair, and
    a lone registered tool name. Inside a tag, the leading token IS the tool name
    — the tag is the evidence, so no registration check (progressive disclosure
    leaves inactive toolsets' tools unregistered). Outside any tag (bare word or
    plain-text `name\\n{json}` pair), only accepts a leading/bare name when it is a
    REGISTERED tool, so ordinary prose starting with a word is not misread."""
    if not text:
        return []
    actions = []
    for m in _TAG_RE.finditer(text):
        body = (m.group("body") or "").strip()
        name = m.group("attr") or m.group("eqname")
        args = _coerce_args(body)
        if not name:
            for obj in _json_candidates(body):
                if isinstance(obj, dict) and isinstance(obj.get("name"), str):
                    name = obj["name"]
                    if (isinstance(args, dict) and args.get("name") == name
                            and "arguments" not in obj and "args" not in obj):
                        args = {k: v for k, v in args.items() if k != "name"}
                    break
        if not name:
            lead = (_LEADING_NAME_RE.match(body) or _BARE_NAME_RE.match(body)
                    or _LEADING_NAME_CALL_RE.match(body))
            if lead:
                name = lead.group(1)
        if name:
            actions.append({"type": "tool_call", "tool": name,
                            "args": args if isinstance(args, dict) else {}})
    if actions:
        return actions

    lead = _LEADING_NAME_RE.match(text)
    if lead and registry.is_registered(lead.group(1)):
        return [{"type": "tool_call", "tool": lead.group(1),
                 "args": _coerce_args(lead.group(2))}]

    bare = _BARE_NAME_RE.match(text)
    if bare and registry.is_registered(bare.group(1)):
        return [{"type": "tool_call", "tool": bare.group(1), "args": {}}]

    return []


def _normalize_nonjson_action(text):
    """First non-JSON action in `text`, or None.

    When the model stacked several calls into one message (43% of observed
    off-protocol messages), the extras are named in `_dropped_calls` so the
    loop can ask for them one per turn instead of losing them silently."""
    actions = _normalize_nonjson_actions(text)
    if not actions:
        return None
    first = actions[0]
    SALVAGE_STATS["salvaged"] += 1
    if len(actions) > 1:
        first["_dropped_calls"] = [a["tool"] for a in actions[1:]]
        SALVAGE_STATS["dropped_calls"] += len(actions) - 1
    return first


def strip_reasoning(text):
    """Remove <think>/<thinking> blocks from a reply. Also handles a reply that
    starts mid-thought and only has the closing tag (some proxies drop the
    opening tag when the block spans a stream boundary)."""
    if not text:
        return ""
    cleaned = _THINK_BLOCK_RE.sub("", text)
    if re.search(r"</think(?:ing)?>", cleaned, re.IGNORECASE):
        cleaned = _THINK_TAIL_RE.sub("", cleaned, count=1)
    return cleaned.strip()


def _json_candidates(text):
    """Yield every parseable JSON value in `text`, scanning from each '{'.
    raw_decode tolerates trailing text, so prose after the object is fine."""
    decoder = json.JSONDecoder()
    idx = 0
    while True:
        start = text.find("{", idx)
        if start == -1:
            return
        try:
            obj, end = decoder.raw_decode(text, start)
        except ValueError:
            idx = start + 1
            continue
        yield obj
        idx = end


def _normalize_action(obj):
    """Map alias keys onto the canonical action schema so the loop parses them
    uniformly. Some models (and the malformed-output correction prompt, which asks
    for keys 'action, tool, arguments') use 'action'->'type' and 'arguments'->'args';
    'name' is also accepted as a fallback for 'tool'. Canonical keys already present
    always win, so this never overwrites a correct field."""
    if not isinstance(obj, dict):
        return obj
    if "type" not in obj and obj.get("action") in ("tool_call", "final_answer"):
        obj["type"] = obj["action"]
    if "args" not in obj and "arguments" in obj:
        obj["args"] = obj.get("arguments")
    if "tool" not in obj and isinstance(obj.get("name"), str) and obj.get("type") != "final_answer":
        obj["tool"] = obj["name"]
    # A dict that only signals "action" via a bare tool/args key (no explicit
    # type/action field) -- e.g. a raw {"name":.., "arguments":{..}} function-call
    # body -- is still a tool call; without this the caller sees a dict with no
    # "type" at all and treats it as unrecognized.
    if "type" not in obj and "tool" in obj:
        obj["type"] = "tool_call"
    return obj


def _looks_like_action(obj):
    """Whether a parsed JSON object is (or aliases) an agent action."""
    return (
        obj.get("type") in ("tool_call", "final_answer")
        or obj.get("action") in ("tool_call", "final_answer")
        or "tool" in obj or "args" in obj or "arguments" in obj
    )


def _is_strong_action(obj):
    """Whether a parsed JSON object is UNAMBIGUOUSLY an agent action -- i.e.
    action-like for a reason other than merely carrying a bare 'args'/
    'arguments' key. A weak match (action-like ONLY via 'args'/'arguments')
    can be an ARGUMENTS object of a tag-shaped call (e.g. a param literally
    named "args") rather than the action envelope itself, so it must not
    preempt the tag parser in extract_json_action."""
    return (
        obj.get("type") in ("tool_call", "final_answer")
        or obj.get("action") in ("tool_call", "final_answer")
        or "tool" in obj
    )


def extract_json_action(text):
    """Find the agent-action JSON object in a raw LLM reply, or None.

    Tolerates reasoning prose before/after the JSON, <think> blocks, markdown
    code fences, stray braces inside the prose, and trailing commas. Prefers an
    object that looks like an action ({"type": ...} / {"tool": ...}) over any
    other JSON the reply happens to contain. Alias keys ('action'/'arguments') are
    normalized onto the canonical schema before returning."""
    if not text:
        return None
    cleaned = strip_reasoning(text)

    # Fenced blocks first — when the model uses a fence, its content is the
    # intended payload even if the surrounding prose also has braces. Then the
    # stripped reply, then (last resort) the raw reply including think blocks.
    sources = [m.group(1) for m in _FENCE_RE.finditer(cleaned)]
    sources.append(cleaned)
    if cleaned != text:
        sources.append(text)

    fallback = None
    weak_fallback = None
    for source in sources:
        attempts = [source]
        defused = _TRAILING_COMMA_RE.sub(r"\1", source)
        if defused != source:
            attempts.append(defused)
        for attempt in attempts:
            for obj in _json_candidates(attempt):
                if not isinstance(obj, dict):
                    continue
                if _is_strong_action(obj):
                    return _normalize_action(obj)
                if weak_fallback is None and _looks_like_action(obj):
                    weak_fallback = obj
                if fallback is None:
                    fallback = obj

    # No STRONG action-shaped JSON found in any source. Try the non-JSON
    # tool-call shapes (harmony/XML tags, name-then-json, bare tool name)
    # first -- a tag-resolved tool call is more reliable than a weak JSON
    # match (one that only looks action-like via a bare 'args'/'arguments'
    # key, which can just be the ARGUMENTS object of a tag-shaped call) --
    # then fall back to that weak match, normalized, before giving up.
    nonjson = _normalize_nonjson_action(cleaned)
    if nonjson is not None:
        return nonjson
    if weak_fallback is not None:
        return _normalize_action(weak_fallback)
    return fallback


# --- request helpers ---------------------------------------------------------
# The fallback engine (ask_llm) routes on the KIND of failure, not just "it
# failed", because the right recovery differs by axis:
#   rate_limit        -> the API KEY is throttled (per-account). Rotate to another
#                        key, keep the same model.
#   model_unavailable -> the MODEL is down/exhausted/not-found (503/404/529).
#                        Switch to another model, keep the key.
#   queue / timeout   -> the MODEL is overloaded / has a long queue. Switch model.
#   auth              -> the KEY is bad/forbidden (401/403). Rotate key.
#   server / connection / other -> a transient/endpoint fault. Switch model (a
#                        different model on the endpoint may still answer), no cooldown.
def _classify_status(status):
    """Map an HTTP status onto a fallback error_kind (see the table above)."""
    if status == 429:
        return "rate_limit"
    if status in (401, 403):
        return "auth"
    if status in (404, 503, 529):
        return "model_unavailable"
    if 500 <= status < 600:
        return "server"
    return "other"


def _error_response(message):
    return json.dumps({
        "type": "final_answer",
        "content": f"[Error] {message}"
    })


def _poll_queued_result(cfg, response):
    """Follow up a QUEUED NVIDIA NIM request. Under load the POST comes back as
    HTTP 202 with an NVCF-REQID header instead of a result; the outcome is then
    polled from GET {base_url}/status/{id}, which itself returns 202 until the
    invocation finishes. Poll only for QUEUE_POLL_SECONDS — a short queue still
    succeeds — and return the final Response (200 result, or a real error to
    surface). Returns None when the request is still queued after the window, the
    poll itself failed, or the user pressed Stop — the caller then reports the
    provider as busy so ask_llm fails over to the next one in the chain."""
    req_id = response.headers.get("NVCF-REQID")
    if not req_id:
        return None
    status_url = cfg["base_url"].rstrip("/") + "/status/" + req_id
    headers = {"Accept": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    deadline = time.time() + QUEUE_POLL_SECONDS
    while time.time() < deadline:
        if _interruptible_sleep(QUEUE_POLL_INTERVAL):
            return None
        try:
            polled = requests.get(status_url, headers=headers,
                                  timeout=(CONNECT_TIMEOUT, REQUEST_TIMEOUT))
        except requests.exceptions.RequestException:
            return None
        if polled.status_code != 202:
            return polled
    return None


def _openai_request(cfg, messages, temperature):
    """One OpenAI chat-completions request. Returns {'ok', 'content'} on success
    or {'ok': False, 'error'} on failure (with retries for transient errors).
    Queue/rate-limit responses (NIM HTTP 202/429) and timeouts fail FAST instead
    of retrying here, so ask_llm's fallback chain takes over immediately."""
    if cfg["requires_key"] and not cfg["api_key"]:
        return {"ok": False, "error": f"No API key set for {cfg['label']}. Open LLM Settings to add one."}
    if not cfg["base_url"]:
        return {"ok": False, "error": f"No base URL set for {cfg['label']}. Open LLM Settings to configure it."}

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {"model": cfg["model"], "messages": messages}
    if cfg.get("max_tokens_set"):
        payload["max_tokens"] = cfg["max_tokens"]
    # Advanced options (set in the provider's Advanced tab). Reasoning is encoded
    # per the config's reasoning STYLE (see _apply_openai_reasoning) — GLM/Z.AI use
    # a `thinking` flag, Nemotron a system directive, Qwen/DeepSeek V3 chat-template
    # kwargs, DeepSeek V4 a none/high/max effort enum, o-series/GPT-5 the
    # `reasoning_effort` field. Only that last style rejects a custom temperature,
    # so temperature is dropped just for it; every other style still takes the
    # per-config override, else the caller's default.
    messages, reasoning_on, style = _apply_openai_reasoning(payload, cfg, messages)
    payload["messages"] = messages
    if not (reasoning_on and style == "openai"):
        cfg_temp = cfg.get("temperature")
        payload["temperature"] = cfg_temp if cfg_temp is not None else temperature
    # Native function-calling: for models flagged supports_native_tools, offer the
    # active-group tool schemas + final_answer and REQUIRE a structured call, so the
    # model cannot emit free-text outside the protocol. Progressive disclosure is
    # honored via active_groups. Providers not flagged keep the prose-JSON path.
    if _supports_native_tools(cfg):
        from tools import tool_schema
        payload["tools"] = tool_schema.openai_tools_for(cfg.get("active_groups"))
        payload["tool_choice"] = "required"
    seed = cfg.get("seed")
    if seed is not None:
        payload["seed"] = seed
    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"

    last_error = None
    last_kind = None
    for _ in range(MAX_RETRIES):
        try:
            response = requests.post(url, json=payload, headers=headers,
                                     timeout=(CONNECT_TIMEOUT, REQUEST_TIMEOUT))
            # NVIDIA NIM queue: HTTP 202 means "too many requests — result pending".
            # Poll briefly; if the queue doesn't clear, report this provider busy so
            # the fallback chain moves on instead of waiting the queue out.
            if response.status_code == 202:
                response = _poll_queued_result(cfg, response)
                if response is None:
                    # A queue means the MODEL is overloaded, not the key — the
                    # engine reacts by switching model (see _classify_error_kind).
                    return {"ok": False, "queued": True, "error_kind": "queue",
                            "error": (f"{cfg['label']} queued the request (HTTP 202 — too many "
                                      f"requests) and it wasn't ready after {QUEUE_POLL_SECONDS}s; "
                                      f"failing over to the next provider")}
            if response.status_code == 429:
                # A rate limit is per-KEY (account level) — the engine rotates to
                # the next API key on the SAME model.
                return {"ok": False, "rate_limited": True, "error_kind": "rate_limit",
                        "error": (f"{cfg['label']} rate-limited this key (HTTP 429): "
                                  f"{response.text[:300]} — failing over to the next provider")}
            if not response.ok:
                return {"ok": False, "error_kind": _classify_status(response.status_code),
                        "error": f"{cfg['label']} HTTP {response.status_code}: {response.text[:800]}"}
            try:
                data = response.json()
            except Exception:
                return {"ok": False, "error": f"Invalid JSON from {cfg['label']}:\n{response.text[:800]}"}

            # Cline wraps the standard OpenAI response inside a top-level "data"
            # envelope, e.g. {"data": {"choices": [...]}}. Unwrap only when the top
            # level lacks "choices" but the nested "data" has it — safe for every
            # other provider and for error payloads.
            if (isinstance(data, dict) and "data" in data and isinstance(data["data"], dict)
                    and "choices" not in data and "choices" in data["data"]):
                data = data["data"]

            choices = data.get("choices")
            if not choices:
                return {"ok": False, "error": f"No choices from {cfg['label']}:\n{json.dumps(data)[:800]}"}

            message = choices[0].get("message", {})
            content = message.get("content")
            # Some OpenAI-compatible servers return content as a list of typed
            # blocks instead of a plain string.
            if isinstance(content, list):
                content = "".join(
                    b.get("text", "") for b in content if isinstance(b, dict)
                ) or None
            finish = choices[0].get("finish_reason") or choices[0].get("native_finish_reason")

            # Native function-calling: content is null, tool call is in tool_calls.
            if not content and message.get("tool_calls"):
                # Cut off at the output cap → the tool arguments JSON is truncated
                # and unreliable. Signal truncation instead of running a half-parsed
                # (often empty-args) call.
                if finish == "length":
                    return {"ok": True, "content": TRUNCATED_ENVELOPE}
                tc = message["tool_calls"][0]
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments", "{}") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                if not isinstance(args, dict):
                    args = {}
                fname = fn.get("name", "")
                # final_answer is offered as a tool so tool_choice can be "required";
                # convert it back to the final-answer envelope the loop expects.
                if fname == "final_answer":
                    return {"ok": True, "content": json.dumps(
                        {"type": "final_answer", "content": args.get("content", "")})}
                # Narration: every native tool carries an optional `explanation` arg.
                # Lift it to the action's top level (where the agent loop reads it to
                # open a chat/action group) and strip it from args so the underlying
                # tool — which has no such parameter — never receives it.
                action = {"type": "tool_call", "tool": fname, "args": args}
                expl = args.pop("explanation", None)
                if isinstance(expl, str) and expl.strip():
                    action["explanation"] = expl.strip()
                return {"ok": True, "content": json.dumps(action)}

            # Reasoning models (OpenRouter routes DeepSeek-R1, Cohere north, etc.)
            # sometimes leave `content` null and put the whole reply in `reasoning`
            # (or `reasoning_content`). Salvage it so the agent can still parse an
            # action/answer out of it — but only on a clean finish, since a
            # truncated or errored reasoning field is just a half-formed thought.
            if content is None and finish in (None, "stop"):
                reasoning = message.get("reasoning") or message.get("reasoning_content")
                if isinstance(reasoning, list):
                    reasoning = "".join(
                        b.get("text", "") for b in reasoning if isinstance(b, dict)
                    )
                if isinstance(reasoning, str) and reasoning.strip():
                    content = reasoning

            # Provider aborted generation mid-stream. OpenRouter free tiers
            # (e.g. Cohere north) return finish_reason 'error' with a null
            # content under load or rate-limiting. It's usually transient, so
            # retry with a short backoff before giving up.
            if content is None and finish == "error":
                last_error = (
                    f"{cfg['label']} aborted generation (finish_reason: error) for "
                    f"model '{cfg['model']}'. The upstream provider errored, was "
                    f"overloaded, or rate-limited. If this persists, switch to "
                    f"another model or provider."
                )
                time.sleep(RETRY_BACKOFF)
                continue

            if content is None:
                if finish == "stop":
                    return {"ok": True, "content": json.dumps({"type": "final_answer", "content": "Done."})}
                return {"ok": False, "error": f"Missing message content from {cfg['label']} (finish_reason: {finish}):\n{json.dumps(data)[:800]}"}

            # Cut off at the output cap → the content is a truncated fragment (often
            # invalid mid-JSON). Signal truncation so the agent re-prompts for a
            # smaller output rather than failing to parse and dumping the raw text.
            if finish == "length":
                return {"ok": True, "content": TRUNCATED_ENVELOPE}

            usage = data.get("usage") or {}
            if usage:
                _record_usage({
                    "prompt": int(usage.get("prompt_tokens") or 0),
                    "completion": int(usage.get("completion_tokens") or 0),
                    "total": int(usage.get("total_tokens")
                                 or (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0)),
                })

            return {"ok": True, "content": content}

        except requests.exceptions.Timeout:
            # Don't retry a timeout against the SAME provider — with a
            # REQUEST_TIMEOUT-second window a stall almost always means it's
            # overloaded or silently queueing, so hand the conversation to the
            # next provider in the chain instead of blocking here for up to
            # MAX_RETRIES * REQUEST_TIMEOUT seconds. A slow/queueing model is a
            # MODEL problem, so the engine switches model (not the key).
            return {"ok": False, "error_kind": "timeout",
                    "error": (f"{cfg['label']} did not respond within {REQUEST_TIMEOUT}s "
                              f"(busy or queueing) — failing over to the next provider")}
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {e}"
            last_kind = "connection"
        except Exception as e:
            last_error = str(e)
            last_kind = "other"

    return {"ok": False, "error_kind": last_kind or "server",
            "error": last_error or "unknown error"}


def _split_anthropic_messages(messages):
    """Split our system/user/assistant message list into Anthropic's shape: a
    single top-level `system` string plus a user/assistant conversation whose
    first entry is a user turn (the Messages API requires that)."""
    system_parts = []
    conv = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "")
        if not isinstance(content, str):
            content = str(content)
        if role == "system":
            if content:
                system_parts.append(content)
            continue
        if role not in ("user", "assistant"):
            role = "user"
        conv.append({"role": role, "content": content})
    if not conv:
        conv = [{"role": "user", "content": "Continue."}]
    elif conv[0]["role"] != "user":
        conv.insert(0, {"role": "user", "content": "Continue."})
    return ("\n\n".join(system_parts), conv)


def _anthropic_adaptive_model(model):
    """Whether this Claude model uses ADAPTIVE thinking + the `effort` parameter
    (Opus/Sonnet/Haiku 4.6+ and every 5-family model) instead of the deprecated
    `budget_tokens`. Name-sniffed, same spirit as _auto_reasoning_style."""
    m = (model or "").lower()
    if "fable" in m or "mythos" in m:
        return True
    mt = re.search(r"(opus|sonnet|haiku)-(\d+)-(\d+)", m)
    if mt:
        return (int(mt.group(2)), int(mt.group(3))) >= (4, 6)
    mt = re.search(r"(opus|sonnet|haiku)-(\d+)", m)
    if mt:
        return int(mt.group(2)) >= 5
    return False


# Our effort levels mapped onto Anthropic's `effort` enum (low/medium/high/max).
_ANTHROPIC_EFFORT = {"minimal": "low", "low": "low", "medium": "medium",
                     "high": "high", "max": "max"}


def _anthropic_request(cfg, messages, temperature):
    """One Anthropic Messages API request. `temperature` is intentionally NOT
    sent — Claude Opus 4.7/4.8, Sonnet 5 and Fable 5 reject sampling params."""
    if not cfg["api_key"]:
        return {"ok": False, "error": "No API key set for Anthropic Claude. Open LLM Settings to add one."}

    base = cfg["base_url"] or "https://api.anthropic.com/v1"
    url = base.rstrip("/") + "/messages"
    system_text, conv = _split_anthropic_messages(messages)
    payload = {"model": cfg["model"], "max_tokens": cfg["max_tokens"], "messages": conv}
    # Reasoning on -> extended thinking. Modern Claude (4.6+/5-family) uses
    # ADAPTIVE thinking with a top-level `effort` level (budget_tokens is
    # deprecated there); older models get the classic token budget, which the
    # API requires max_tokens to exceed. (Sampling params stay omitted.)
    reasoning = cfg.get("reasoning_effort")
    if reasoning:
        if _anthropic_adaptive_model(cfg["model"]):
            payload["thinking"] = {"type": "adaptive"}
            payload["effort"] = _ANTHROPIC_EFFORT.get(reasoning, "high")
        else:
            budget = _THINKING_BUDGETS.get(reasoning, 8192)
            payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
            if payload["max_tokens"] <= budget:
                payload["max_tokens"] = budget + 1024
    if system_text:
        payload["system"] = system_text
    headers = {
        "Content-Type": "application/json",
        "x-api-key": cfg["api_key"],
        "anthropic-version": "2023-06-01",
    }

    last_error = None
    last_kind = None
    for _ in range(MAX_RETRIES):
        try:
            response = requests.post(url, json=payload, headers=headers,
                                     timeout=(CONNECT_TIMEOUT, REQUEST_TIMEOUT))
            if response.status_code == 429:
                return {"ok": False, "rate_limited": True, "error_kind": "rate_limit",
                        "error": (f"Anthropic rate-limited this key (HTTP 429): "
                                  f"{response.text[:300]} — failing over to the next provider")}
            if not response.ok:
                return {"ok": False, "error_kind": _classify_status(response.status_code),
                        "error": f"Anthropic HTTP {response.status_code}: {response.text[:800]}"}
            try:
                data = response.json()
            except Exception:
                return {"ok": False, "error": f"Invalid JSON from Anthropic:\n{response.text[:800]}"}

            if data.get("type") == "error":
                return {"ok": False, "error": f"Anthropic error: {json.dumps(data.get('error', data))[:800]}"}
            if data.get("stop_reason") == "refusal":
                return {"ok": True, "content": json.dumps({
                    "type": "final_answer",
                    "content": "[Anthropic declined this request (stop_reason: refusal).]"
                })}

            blocks = data.get("content") or []
            text = "".join(
                b.get("text", "") for b in blocks
                if isinstance(b, dict) and b.get("type") == "text"
            )
            if not text:
                return {"ok": False, "error": f"No text content from Anthropic:\n{json.dumps(data)[:800]}"}
            # Cut off at the output cap → truncated fragment. Signal truncation so
            # the agent re-prompts for a smaller output instead of dumping the raw
            # partial (see TRUNCATED_ENVELOPE).
            if data.get("stop_reason") == "max_tokens":
                return {"ok": True, "content": TRUNCATED_ENVELOPE}
            usage = data.get("usage") or {}
            if usage:
                pt = int(usage.get("input_tokens") or 0)
                ct = int(usage.get("output_tokens") or 0)
                _record_usage({"prompt": pt, "completion": ct, "total": pt + ct})
            return {"ok": True, "content": text}

        except requests.exceptions.Timeout:
            last_error = "Request timed out"
            last_kind = "timeout"
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {e}"
            last_kind = "connection"
        except Exception as e:
            last_error = str(e)
            last_kind = "other"

    return {"ok": False, "error_kind": last_kind or "server",
            "error": last_error or "unknown error"}


# --- two-axis fallback state -------------------------------------------------
# The configured entries are resolved into PROVIDER GROUPS (see _build_groups),
# each with a shared POOL of interchangeable API keys and a capability-ordered
# MODEL LADDER (primary = most capable first). The engine treats keys and models
# as separate axes and recovers on the RIGHT one for each failure kind:
#   * a rate-limited key (429) is swapped for another key on the SAME model;
#   * an unavailable/queued/slow model (503/404/queue/timeout) makes the engine
#     switch MODEL, keeping the key.
# To "make the most capable model work the most", the ladder is always tried
# primary-first, and a model that just failed with a model-level error is put in
# a short COOLDOWN so the next call skips straight past it instead of re-probing
# a known-down model every time — then, once the cooldown lapses, the primary is
# retried first again. This yields the user's intended pattern over time (keep
# coming back to the primary, widen to weaker models only while it's down) without
# wasting a slow probe on a model that failed milliseconds ago.
_TL = threading.local()

def set_subagent_context(pinned_key=None, models=None):
    """Mark THIS thread as a subagent: pin its API key, optionally pin its own
    MODEL LADDER (ordered model ids — see subagents.resolve_model_ladder),
    suppress the main-thread provider badge, and start fresh usage accounting.
    Thread-local, so the main thread's ask_llm is entirely unaffected."""
    _TL.pinned_key = pinned_key
    _TL.model_ladder = list(models) if models else None
    _TL.is_subagent = True
    _TL.last_usage = None
    _TL.last_model = None

def clear_subagent_context():
    _TL.pinned_key = None
    _TL.model_ladder = None
    _TL.is_subagent = False
    _TL.last_usage = None
    _TL.last_model = None

def _pinned_key():
    return getattr(_TL, "pinned_key", None)

def _thread_model_ladder():
    """This thread's pinned model ladder, or None to use the global one."""
    return getattr(_TL, "model_ladder", None)

def _is_subagent_thread():
    return getattr(_TL, "is_subagent", False)

def _record_usage(usage):
    _TL.last_usage = usage

def take_last_usage():
    """Return and clear the usage dict captured for the last ask_llm on this
    thread: {"prompt","completion","total"} or None if the provider omitted it."""
    u = getattr(_TL, "last_usage", None)
    _TL.last_usage = None
    return u

def take_last_model():
    """Model id that served the last successful request on THIS thread, or None.
    Cleared on read, like take_last_usage — feeds per-subagent cost telemetry so
    the UI can show which model actually answered, not just which was requested."""
    m = getattr(_TL, "last_model", None)
    _TL.last_model = None
    return m


_ACTIVE_CONFIG_ID = None   # representative entry id of the group now serving (badge)
_ACTIVE_MODEL = None       # the specific model in that group now serving (badge)
_ACTIVE_KEY = None         # the API key that last answered (sticky, so we don't rotate needlessly)
_MODEL_COOLDOWN = {}       # model id -> time.monotonic() until which it's skipped
_KEY_COOLDOWN = {}         # api key   -> time.monotonic() until which it's skipped

# How long a model / key is skipped after a model-level / rate-limit failure.
MODEL_COOLDOWN_SECONDS = 45
KEY_COOLDOWN_SECONDS = 30
# error_kinds that recover by ROTATING THE KEY (rest recover by switching MODEL).
_KEY_ERROR_KINDS = {"rate_limit", "auth"}
# error_kinds that put the MODEL in cooldown (a real model outage/overload, not a
# one-off blip — a transient 5xx/connection error switches model but isn't cooled).
_MODEL_COOLDOWN_KINDS = {"model_unavailable", "queue", "timeout"}


def reset_active_provider():
    """Forget the sticky model/key and clear all cooldowns so the next ask_llm
    call starts fresh from the primary model. (Not called automatically — the
    sticky pointers only move on success/failure, per the fallback contract.)"""
    global _ACTIVE_CONFIG_ID, _ACTIVE_MODEL, _ACTIVE_KEY
    _ACTIVE_CONFIG_ID = None
    _ACTIVE_MODEL = None
    _ACTIVE_KEY = None
    _MODEL_COOLDOWN.clear()
    _KEY_COOLDOWN.clear()


def _split_keys(raw):
    """Split a raw api_key field into one or more keys. A single entry may hold a
    whole pool separated by commas / whitespace / newlines, so "save all the API
    keys" works even in one field. Order is preserved, blanks dropped."""
    if not raw:
        return []
    parts = re.split(r"[\s,]+", str(raw).strip())
    return [p for p in parts if p]


def _build_groups(configs):
    """Fold the ordered effective configs into PROVIDER GROUPS with TWO FULLY
    DECOUPLED axes: a shared API-KEY POOL and a separate MODEL LADDER.

    Keys are NOT tied to models — every key in the pool can serve every model in
    the ladder (e.g. one NVIDIA NIM key handles both DeepSeek and GLM). Entries on
    the same provider+endpoint merge: their key pools union, their model ladders
    concatenate (priority order, primary first). Each model carries a copy of the
    group's SHARED settings (base_url / reasoning / max_tokens / …) from the first
    entry — never a specific key (that's drawn per-attempt from the pool). Reasoning
    is resolved PER MODEL: an explicit per-model override (model_settings) wins, else
    a multi-model ladder infers each model's STYLE from its name (auto) so a mixed
    ladder (DeepSeek + GLM + …) reasons correctly.
    Returns groups in config order:
        {provider, label, base_url, keys:[...], models:[{id,name,model,cfg}, ...]}
    """
    groups = []
    by_endpoint = {}
    for c in configs:
        endpoint = (c.get("provider"), (c.get("base_url") or "").rstrip("/"))
        g = by_endpoint.get(endpoint)
        if g is None:
            g = {"provider": c.get("provider"), "label": c.get("label", ""),
                 "base_url": c.get("base_url", ""), "keys": [], "_seen_keys": set(),
                 "model_ids": [], "_seen_models": set(),
                 "vision_ids": [], "_seen_vision": set(), "settings": c,
                 "model_settings": dict(c.get("model_settings") or {}),
                 "requires_key": c.get("requires_key", False)}
            by_endpoint[endpoint] = g
            groups.append(g)
        else:
            # Same endpoint from a later entry: fold in its per-model overrides too,
            # so a model's reasoning follows it whichever entry contributed it.
            ms = c.get("model_settings")
            if isinstance(ms, dict):
                g["model_settings"].update(ms)
        for k in c.get("api_keys") or _split_keys(c.get("api_key")):
            if k and k not in g["_seen_keys"]:
                g["_seen_keys"].add(k)
                g["keys"].append(k)
        for model in c.get("models") or ([c["model"]] if c.get("model") else []):
            if model and model not in g["_seen_models"]:
                g["_seen_models"].add(model)
                g["model_ids"].append(model)
        for vm in c.get("vision_models") or []:
            if vm and vm not in g["_seen_vision"]:
                g["_seen_vision"].add(vm)
                g["vision_ids"].append(vm)

    def _ladder(settings, model_ids, model_settings=None, disable_reasoning=False):
        model_settings = model_settings or {}
        multi = len(model_ids) > 1
        out = []
        for model in model_ids:
            mcfg = dict(settings)
            mcfg.pop("model_settings", None)   # not needed past this point
            mcfg["model"] = model
            override = model_settings.get(model) or {}
            # PER-MODEL reasoning override wins over the entry's group-level setting.
            # Effort: 'off' forces reasoning off, a level sets it; absent inherits the
            # entry's effort (already copied in via dict(settings)).
            eff = _norm_model_effort(override.get("reasoning_effort"))
            if eff == "off":
                mcfg["reasoning_effort"] = ""
            elif eff:
                mcfg["reasoning_effort"] = eff
            # Style: an explicit per-model style wins; else a heterogeneous ladder
            # can't share one style, so each model infers its own from its name
            # (DeepSeek V4 → deepseek_v4, GLM → thinking, …); a single-model group
            # keeps the entry's explicit style.
            sty = _norm_reasoning_style(override.get("reasoning_style"))
            if sty:
                mcfg["reasoning_style"] = sty
            elif multi:
                mcfg["reasoning_style"] = ""
            # Vision requests don't need extended reasoning, and some vision models
            # reject reasoning params — turn it off for the image ladder.
            if disable_reasoning:
                mcfg["reasoning_effort"] = ""
                mcfg["reasoning_style"] = "none"
            out.append({"id": settings.get("id"), "name": settings.get("name", ""),
                        "model": model, "cfg": mcfg})
        return out

    for g in groups:
        settings = g.pop("settings")
        model_settings = g.pop("model_settings", {})
        g["models"] = _ladder(settings, g.pop("model_ids"), model_settings)
        g["vision"] = _ladder(settings, g.pop("vision_ids"), model_settings, disable_reasoning=True)
        g.pop("_seen_keys", None)
        g.pop("_seen_models", None)
        g.pop("_seen_vision", None)
        if not g["keys"]:
            g["keys"] = [""]   # a keyless provider (local Ollama/LM Studio) still has one "slot"
    return groups


def _model_available(model_id):
    return _MODEL_COOLDOWN.get(model_id, 0) <= time.monotonic()


def _ordered_models(models):
    """The model ladder in try-order: available (not cooled) models first in
    capability order, then any cooled ones as a last resort — so a run never gives
    up entirely, but a known-down model is skipped while fresher ones exist."""
    available = [m for m in models if _model_available(m["model"])]
    cooled = [m for m in models if not _model_available(m["model"])]
    return available + cooled


# --- the COST SPINE: one global model ladder, ordered most-expensive first ----
# LADDER POSITION IS COST. The operator orders providers (drag-to-reorder,
# frontend/app.js:1765) and the models within a provider (frontend/app.js:1945);
# the flattened result is the spine every subagent routes against. A model may
# ALSO carry an explicit tier tag in model_settings[<model>]["tier"], which always
# wins over position — so adding a provider never reshuffles a TAGGED model
# between tiers. Only untagged models drift with position.
BUILTIN_TIERS = ("premium", "standard", "cheap")
DEFAULT_SUBAGENT_TIER = "standard"


def _derived_tier(rung, n):
    """Positional tier for an UNTAGGED model at `rung` of a ladder of length `n`.
    Top rung is premium, bottom rung is cheap, everything between is standard —
    a labeling rule (not a starting-rung rule) so every model has exactly one
    tier and tagged/untagged models resolve through the same code path."""
    if n <= 1 or rung <= 0:
        return "premium"
    if rung >= n - 1:
        return "cheap"
    return "standard"


def model_ladder():
    """The global cost spine: every configured TEXT model flattened across
    provider groups in config order, most capable/expensive first.

    Each entry: {rung, id, label, model, tier, tagged}. `tier` is the explicit
    model_settings tag when present (tagged=True), else derived from position.
    Returns [] when nothing is configured — callers treat that as "no override"
    and keep today's behavior."""
    configs = get_effective_configs()
    if not configs:
        return []
    tags = {}
    for c in configs:
        for model, s in (c.get("model_settings") or {}).items():
            t = _norm_tier((s or {}).get("tier"))
            if t:
                tags[model] = t
    out = []
    for g in _build_groups(configs):
        for m in g.get("models") or []:
            out.append({"id": m.get("id"),
                        "label": g.get("label") or g.get("provider") or "",
                        "model": m["model"]})
    n = len(out)
    for rung, e in enumerate(out):
        tag = tags.get(e["model"])
        e["rung"] = rung
        e["tier"] = tag or _derived_tier(rung, n)
        e["tagged"] = bool(tag)
    return out


def models_for_tier(tier, ladder=None):
    """Ordered model ids a subagent on `tier` should try.

    Body: the first model carrying `tier`, then everything BELOW it in ladder
    order (so it fails over to cheaper models first). Tail: the rungs ABOVE it,
    nearest first, appended as a LAST RESORT — this is what preserves ask_llm's
    "never give up" contract without silently paying premium prices. An unknown
    tier resolves to DEFAULT_SUBAGENT_TIER; an empty ladder yields []."""
    ladder = model_ladder() if ladder is None else ladder
    if not ladder:
        return []
    want = _norm_tier(tier) or DEFAULT_SUBAGENT_TIER
    matches = [e for e in ladder if e["tier"] == want]
    if not matches:
        matches = [e for e in ladder if e["tier"] == DEFAULT_SUBAGENT_TIER]
    if not matches:
        matches = ladder[:1]        # degenerate ladder — every tier is the top rung
    # Prefer tagged models (explicit tier) over derived ones; within each, keep ladder order.
    # This means an explicitly-tagged model *always* heads its tier's slice, even if an
    # untagged model happens to derive the same tier from a cheaper rung. The untagged
    # same-tier model then lands in the tail — a cost guard. This preserves "never
    # silently pay premium": exhaust the cost tier fully before escalating to more
    # expensive rungs. An explicit tag is a stronger signal than position-based derivation.
    matches = sorted(matches, key=lambda e: (not e["tagged"], e["rung"]))
    start = matches[0]["rung"]
    body = [e["model"] for e in ladder[start:]]
    tail = [e["model"] for e in reversed(ladder[:start])]
    return body + tail


def _live_keys(keys, dead):
    """Keys not marked dead this cycle, ordered to START at the sticky key that
    last worked (so we don't needlessly rotate off a good key), then the rest, with
    cooled-down keys pushed to the back. Returns [] when every key is dead."""
    live = [k for k in keys if k not in dead]
    if not live:
        return []
    now = time.monotonic()
    fresh = [k for k in live if _KEY_COOLDOWN.get(k, 0) <= now]
    cooled = [k for k in live if _KEY_COOLDOWN.get(k, 0) > now]
    ordered = fresh + cooled
    pin = _pinned_key()
    anchor = pin if (pin in ordered) else _ACTIVE_KEY
    if anchor in ordered:
        i = ordered.index(anchor)
        ordered = ordered[i:] + ordered[:i]
    return ordered


# A callback the app can register to be told when ask_llm fails over from one
# configured provider to the next, so the UI can surface which one is in use.
_FALLBACK_NOTIFIER = None


def set_fallback_notifier(fn):
    """Register callback(message: str), invoked when ask_llm fails over between
    configured providers. Pass None to clear."""
    global _FALLBACK_NOTIFIER
    _FALLBACK_NOTIFIER = fn


def _notify_fallback(message):
    fn = _FALLBACK_NOTIFIER
    if fn:
        try:
            fn(message)
        except Exception:
            pass


# A separate callback for the PERSISTENT "which LLM is active right now"
# indicator (distinct from the transient fallback messages above). It's called
# with a dict {id, name, label, model} whenever the provider actually serving
# requests changes — including the first successful call of a run — so the UI can
# keep a live badge in sync with the sticky fallback pointer.
_ACTIVE_NOTIFIER = None
_LAST_NOTIFIED_ACTIVE_ID = None


def set_active_provider_notifier(fn):
    """Register callback(info: dict) for the active-provider indicator, invoked
    when the provider serving requests changes. Resets the change-tracker so the
    next successful call re-emits for this fresh listener. Pass None to clear."""
    global _ACTIVE_NOTIFIER, _LAST_NOTIFIED_ACTIVE_ID
    _ACTIVE_NOTIFIER = fn
    _LAST_NOTIFIED_ACTIVE_ID = None


def _notify_active(cfg):
    """Tell the app which provider+model just answered — but only when it changed
    since the last notification, so a normal run doesn't emit an event on every
    call. Tracked by (id, model) so switching MODEL within one provider group
    (e.g. DeepSeek → GLM) updates the badge too, not just switching provider."""
    global _LAST_NOTIFIED_ACTIVE_ID
    sig = (cfg.get("id") or None, cfg.get("model", ""))
    if sig == _LAST_NOTIFIED_ACTIVE_ID:
        return
    _LAST_NOTIFIED_ACTIVE_ID = sig
    fn = _ACTIVE_NOTIFIER
    if fn:
        try:
            fn({"id": sig[0], "name": cfg.get("name", ""),
                "label": cfg.get("label", ""), "model": cfg.get("model", "")})
        except Exception:
            pass


def get_active_provider():
    """The provider+model currently serving requests: the sticky active one if a
    call has landed on it, otherwise the primary model of the first group. Returns
    {id, name, label, model} or None when nothing is configured. Used by the UI to
    populate its active-LLM badge on load/refresh (live changes come via the
    active-provider notifier)."""
    configs = get_effective_configs()
    if not configs:
        return None
    chosen = None
    if _ACTIVE_CONFIG_ID:
        for c in configs:
            if c.get("id") == _ACTIVE_CONFIG_ID:
                chosen = c
                break
    if chosen is None:
        chosen = configs[0]
    # Reflect the specific active model when we have one (a group can hold several).
    model = _ACTIVE_MODEL or chosen.get("model", "")
    if _ACTIVE_MODEL and _ACTIVE_MODEL not in (chosen.get("models") or [chosen.get("model", "")]):
        model = chosen.get("model", "")   # active model belongs to a different group
    return {"id": chosen.get("id"), "name": chosen.get("name", ""),
            "label": chosen.get("label", ""), "model": model}


def active_supports_native_tools():
    """Whether the model that will actually serve requests is flagged for native
    function-calling. Resolves the active provider + model (same logic the badge
    uses) and checks its per-model supports_native_tools. Used by the agent to
    build a native-aware system prompt (no JSON-envelope protocol, compact tool
    index) that MATCHES how the request is sent. Best-effort → False on any error."""
    try:
        active = get_active_provider()
        if not active:
            return False
        model = active.get("model")
        for c in get_effective_configs():
            if c.get("id") == active.get("id") or model in (c.get("models") or [c.get("model")]):
                cfg = dict(c)
                cfg["model"] = model
                return _supports_native_tools(cfg)
        return False
    except Exception:
        return False


def native_tools_payload_chars(active_groups=None):
    """Serialized size (chars) of the native function-calling `tools=` array that
    ask_llm sends OUT OF BAND for the active model — matching the exact schemas
    built in _openai_request (openai_tools_for(active_groups)). Returns 0 when the
    model isn't driven natively: there the full schemas ride INLINE in the system
    prompt and are already counted in the message list. The agent adds this to its
    context estimate so the header/summarize-guard reflect the true request size
    (in native mode the tools array is tens of thousands of tokens the messages
    never carry). Best-effort → 0 on any error."""
    try:
        if not active_supports_native_tools():
            return 0
        from tools import tool_schema
        return len(json.dumps(tool_schema.openai_tools_for(active_groups)))
    except Exception:
        return 0


# --- user-selected preferred model --------------------------------------------
# The chat composer lets the user pick which model requests should START at. The
# choice is persisted in llm_config.json (top-level "preferred_model") so it
# survives restarts. Fallback is DOWNWARD-ONLY from the selection: rungs ABOVE it
# are never tried, and the cooldown mechanic brings requests back to the selected
# model as soon as it recovers. No selection = the full ladder from the top.
def get_preferred_model():
    """The user's pinned starting model, validated against the current config.
    Returns {"config_id", "model"} or None (start from the primary)."""
    data = _read_config_file()
    pref = data.get("preferred_model") if isinstance(data, dict) else None
    if not isinstance(pref, dict):
        return None
    model = (pref.get("model") or "").strip()
    if not model:
        return None
    cid = (pref.get("config_id") or "").strip()
    for c in get_effective_configs():
        if model in (c.get("models") or []):
            if not cid or c.get("id") == cid:
                return {"config_id": c.get("id"), "model": model}
    return None


def set_preferred_model(config_id, model):
    """Pin (or clear, with a falsy model) the starting model for requests."""
    data = _read_config_file()
    if not isinstance(data, dict) or not isinstance(data.get("configs"), list):
        data = {"version": 2, "configs": [_minimize_entry(c) for c in load_configs()]}
    model = (model or "").strip()
    if model:
        data["preferred_model"] = {"config_id": (config_id or "").strip(), "model": model}
    else:
        data.pop("preferred_model", None)
    return _write_config_file(data)


def list_model_options():
    """Every text-model rung across all provider groups, flattened in fallback
    order, for the composer's model selector. Marks the user's preferred rung
    (defaulting to the primary when nothing is pinned)."""
    pref = get_preferred_model()
    out = []
    for g in _build_groups(get_effective_configs()):
        for m in g.get("models") or []:
            out.append({
                "config_id": m.get("id"),
                "name": m.get("name") or g.get("label") or g.get("provider"),
                "label": g.get("label") or g.get("provider"),
                "model": m["model"],
                "preferred": bool(pref and pref["model"] == m["model"]
                                  and (not pref.get("config_id") or pref["config_id"] == m.get("id"))),
            })
    if out and not any(o["preferred"] for o in out):
        out[0]["preferred"] = True
    return out


def _apply_preference(groups, pref):
    """Trim the group list so requests START at the user's preferred rung and only
    fall DOWNWARD from it (never up to a more-primary model). The preferred model
    stays first in the trimmed ladder, so the existing cooldown logic naturally
    returns to it as soon as it recovers."""
    if not pref:
        return groups
    model = pref.get("model")
    cid = pref.get("config_id")
    for gi, g in enumerate(groups):
        ids = [m["model"] for m in g.get("models") or []]
        if model in ids and (not cid or any(m.get("id") == cid for m in g["models"])):
            trimmed = dict(g)
            trimmed["models"] = g["models"][ids.index(model):]
            return [trimmed] + groups[gi + 1:]
    return groups


def _apply_model_override(groups, model_ids):
    """Re-emit `groups` so models are tried in EXACTLY `model_ids` order.

    Consecutive ids belonging to the SAME source group are merged into one
    emitted group so `_run_group`'s per-call dead-key set is still shared between
    them — splitting every model into its own group would re-probe keys already
    known dead. Ids not present in `groups` are skipped; returns [] if none match
    (the caller then keeps the full ladder rather than having nothing to call)."""
    index = {}
    for g in groups:
        for m in g.get("models") or []:
            index.setdefault(m["model"], (g, m))
    out = []
    cur_src = None
    for mid in model_ids:
        hit = index.get(mid)
        if hit is None:
            continue
        src, m = hit
        if out and cur_src is src:
            out[-1]["models"].append(m)
            continue
        ng = dict(src)
        ng["models"] = [m]
        out.append(ng)
        cur_src = src
    return out


def _one_request(cfg, messages, temperature):
    if cfg["protocol"] == "anthropic":
        return _anthropic_request(cfg, messages, temperature)
    return _openai_request(cfg, messages, temperature)


# A predicate the app can register so ask_llm's retry/backoff loop stays
# interruptible — it's polled while waiting and between attempts, so the Stop
# button still works even mid-backoff.
_STOP_CHECK = None


def set_stop_check(fn):
    """Register callable() -> bool that returns True when the user has asked to
    stop. Lets the never-give-up retry loop below break out. None clears it."""
    global _STOP_CHECK
    _STOP_CHECK = fn


def _stop_requested():
    fn = _STOP_CHECK
    if fn:
        try:
            return bool(fn())
        except Exception:
            return False
    return False


def _await_or_stop(fn, poll=0.1):
    """Run fn() on a daemon thread and return its result — but if a stop is
    requested while waiting, return the {"__stopped__": True} sentinel IMMEDIATELY
    and abandon the in-flight call. This is what makes the Stop button abort a
    blocking, non-streaming requests.post mid-flight: the orphan thread finishes on
    its own and its result is discarded (its tokens are forfeit — the accepted cost
    of an instant Stop). A worker exception is re-raised so existing error handling
    in _run_group's callers is preserved."""
    result = {}
    done = threading.Event()

    def _worker():
        try:
            result["value"] = fn()
        except BaseException as e:  # noqa: BLE001 — re-raised below, nothing swallowed
            result["error"] = e
        finally:
            done.set()

    threading.Thread(target=_worker, daemon=True).start()
    while not done.wait(poll):
        if _stop_requested():
            return {"__stopped__": True}
    if "error" in result:
        raise result["error"]
    return result["value"]


def _interruptible_sleep(seconds):
    """Sleep up to `seconds`, waking early (returning True) if a stop is
    requested. Returns True if interrupted, False if the full time elapsed."""
    end = time.time() + seconds
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            return False
        if _stop_requested():
            return True
        time.sleep(min(1.0, remaining))


# Escalating wait between FULL retry cycles once every configured provider has
# failed: 30s, then 1 min, then 5 min, then 10 min — and 10 min stays the cap for
# every cycle after that. The chat is never abandoned on an API error; it keeps
# cycling on this schedule until a provider answers or the user stops.
_BACKOFF_SCHEDULE = [30, 60, 300, 600]


def _fmt_wait(seconds):
    if seconds >= 60 and seconds % 60 == 0:
        m = seconds // 60
        return f"{m} minute" + ("s" if m != 1 else "")
    return f"{seconds} second" + ("s" if seconds != 1 else "")


def _stopped_response():
    return json.dumps({
        "type": "final_answer",
        "content": "[Stopped] Halted while waiting to retry the LLM (no provider was reachable yet).",
    })


def _mask_key(key):
    """A short, non-secret tag for a pool key, e.g. '…Gwq', for UI messages."""
    if not key:
        return "(no key)"
    return "…" + key[-4:] if len(key) > 4 else "…"


def _model_label(group, m):
    name = m.get("name") or group.get("label") or group.get("provider") or "model"
    model = m.get("model") or _effective({"provider": group.get("provider")})["model"] or "default"
    return f"{name} · {model}"


def _run_group(group, messages, temperature, ladder=None, track_active=True, active_groups=None):
    """Serve one request from a single provider GROUP, recovering on the correct
    axis per failure kind: rotate the API KEY on a rate limit (429/auth), switch
    the MODEL on an unavailable/queued/slow model. Models are tried primary-first
    (cooled ones last); keys rotate within a model until one answers or the whole
    pool is exhausted. `ladder` selects which model list to use — the text models
    (default) or the vision models; `track_active` updates the active-model badge
    (kept off for vision calls so the badge keeps showing the text model). Returns
    {ok, content, model, key, cfg} on success, else {ok: False, errors, all_keys_dead}."""
    global _ACTIVE_CONFIG_ID, _ACTIVE_MODEL, _ACTIVE_KEY
    keys = group["keys"]
    dead = set()          # keys throttled/forbidden this cycle — skip for every model
    errors = []
    if ladder is None:
        ladder = group["models"]
    if not ladder:
        return {"ok": False, "errors": errors, "no_models": True}
    for m in _ordered_models(ladder):
        if _stop_requested():
            return {"ok": False, "errors": errors}
        # Try this model, rotating through live keys on a rate limit.
        while True:
            live = _live_keys(keys, dead)
            if not live:
                # Every key is rate-limited/forbidden — no model can proceed now.
                return {"ok": False, "errors": errors, "all_keys_dead": True}
            key = live[0]
            cfg = dict(m["cfg"])
            cfg["api_key"] = key
            cfg["active_groups"] = active_groups
            res = _one_request(cfg, messages, temperature)
            if res.get("ok"):
                _MODEL_COOLDOWN.pop(m["model"], None)   # it works again
                _TL.last_model = m["model"]             # thread-local; feeds take_last_model()
                if not _is_subagent_thread():
                    _ACTIVE_KEY = key                   # shared key pool (text + vision)
                    if track_active:
                        _ACTIVE_CONFIG_ID = m.get("id") or None
                        _ACTIVE_MODEL = m["model"]
                        _notify_active(dict(cfg))
                return {"ok": True, "content": res["content"], "model": m, "key": key, "cfg": cfg}

            kind = res.get("error_kind", "other")
            errors.append(f"{_model_label(group, m)} [key {_mask_key(key)}]: {res.get('error', 'unknown error')}")
            if kind in _KEY_ERROR_KINDS:
                # Per-key problem: retire this key and try the SAME model on another.
                dead.add(key)
                _KEY_COOLDOWN[key] = time.monotonic() + KEY_COOLDOWN_SECONDS
                if _live_keys(keys, dead) and not _is_subagent_thread():
                    _notify_fallback(
                        f"API key {_mask_key(key)} rate-limited ({kind}) on {_model_label(group, m)} "
                        f"— rotating to another key.")
                continue  # same model, next key
            # Model-level problem: cool the model (if it's a real outage) and move on.
            if kind in _MODEL_COOLDOWN_KINDS:
                _MODEL_COOLDOWN[m["model"]] = time.monotonic() + MODEL_COOLDOWN_SECONDS
            _notify_fallback(
                f"{_model_label(group, m)} failed ({kind}) — switching model.")
            break  # advance to the next model in the ladder
    return {"ok": False, "errors": errors}


def ask_llm(messages, temperature=0.7, active_groups=None):
    """Send the conversation to the configured LLM(s) and return the first
    successful reply's raw text.

    TWO-AXIS FALLBACK: configured entries are folded into provider groups, each
    with a shared pool of interchangeable API KEYS and a capability-ordered MODEL
    ladder (see _build_groups). Within a group the engine recovers on the axis that
    matches the failure — a rate limit rotates the key on the same model; an
    unavailable/queued/slow model switches model on the same key — and always
    prefers the most capable (primary) model, skipping any model in cooldown from a
    recent outage. Groups are tried in config order, so a whole provider being down
    still fails over to the next provider.

    Resilience contract: the chat NEVER stops because of an API error. If every
    group fails (or every key is rate-limited), it waits on an escalating backoff
    (30s, 1 min, 5 min, then 10 min as the cap) and tries again, re-reading the
    config each cycle so fixing a key / adding a provider mid-wait recovers
    automatically. The fallback notifier surfaces each transition; the stop-check
    keeps the waits interruptible."""
    cycle = 0
    while True:
        if _stop_requested():
            return _stopped_response()

        configs = get_effective_configs()
        if not configs:
            # Nothing to call yet — but don't kill the chat. Wait and re-check, so
            # adding a provider in LLM Settings mid-wait recovers on the next cycle.
            wait = _BACKOFF_SCHEDULE[min(cycle, len(_BACKOFF_SCHEDULE) - 1)]
            _notify_fallback(
                f"No LLM is configured — add one in LLM Settings. "
                f"Retrying in {_fmt_wait(wait)} (the chat will resume automatically)."
            )
            if _interruptible_sleep(wait):
                return _stopped_response()
            cycle += 1
            continue

        # A SUBAGENT thread routes on its own pinned ladder (cost-aware, chosen by
        # the orchestrator); the MAIN thread starts at the user's selected model
        # (composer dropdown) and falls DOWNWARD only. Re-read each cycle so a
        # changed selection — or a changed config — takes effect mid-run.
        groups = _build_groups(configs)
        override = _thread_model_ladder()
        if override:
            groups = _apply_model_override(groups, override) or groups
        else:
            groups = _apply_preference(groups, get_preferred_model())
        errors = []
        all_keys_dead = True   # only meaningful if we never got a non-key failure
        for gi, group in enumerate(groups):
            if _stop_requested():
                return _stopped_response()
            # Run the (blocking, non-streaming) provider call on a worker thread so
            # a mid-flight Stop returns control instantly instead of waiting out the
            # request. One wrap point covers every provider/protocol.
            res = _await_or_stop(
                lambda: _run_group(group, messages, temperature, active_groups=active_groups))
            if isinstance(res, dict) and res.get("__stopped__"):
                return _stopped_response()
            if res.get("ok"):
                if gi > 0 or cycle > 0:
                    _notify_fallback(f"{_model_label(group, res['model'])} responded — continuing.")
                return res["content"]
            errors.extend(res.get("errors", []))
            if not res.get("all_keys_dead"):
                all_keys_dead = False
            if gi < len(groups) - 1:
                _notify_fallback(
                    f"Provider '{group.get('label') or group.get('provider')}' exhausted its "
                    f"models/keys — falling back to the next provider…")

        # Everything failed this cycle. Do NOT return an error — wait on the
        # escalating backoff and try again.
        wait = _BACKOFF_SCHEDULE[min(cycle, len(_BACKOFF_SCHEDULE) - 1)]
        last_err = errors[-1] if errors else "unknown error"
        reason = ("every API key is rate-limited" if all_keys_dead
                  else "all configured models/providers failed")
        _notify_fallback(
            f"{reason.capitalize()} (attempt {cycle + 1}). Waiting {_fmt_wait(wait)} before "
            f"trying again — the chat will resume automatically. Last error: {last_err[:200]}"
        )
        if _interruptible_sleep(wait):
            return _stopped_response()
        cycle += 1
        _notify_fallback("Retrying LLM providers now…")


def ask_vision(messages, temperature=0.2):
    """Send an IMAGE-reasoning request to the configured VISION (image-to-text)
    models, using the SAME two-axis fallback as ask_llm but over each group's
    vision ladder (rotate the shared key on a 429, switch vision model on a
    503/queue/timeout). `messages` are OpenAI-vision-shaped (a user message whose
    content is a list of text + image_url blocks).

    Unlike ask_llm this does NOT loop forever: a vision call happens mid-task, so
    on total failure it returns an error the agent can handle rather than hanging.
    Returns {ok: True, content, model} or {ok: False, error}."""
    groups = [g for g in _build_groups(get_effective_configs()) if g.get("vision")]
    if not groups:
        return {"ok": False, "error": (
            "No vision (image-to-text) model is configured. Open LLM Settings and add one to the "
            "provider's 'vision models' list (it reuses the same API-key pool as the text models).")}
    errors = []
    for g in groups:
        if _stop_requested():
            return {"ok": False, "error": "Stopped."}
        res = _run_group(g, messages, temperature, ladder=g["vision"], track_active=False)
        if res.get("ok"):
            return {"ok": True, "content": res["content"], "model": res["model"]["model"]}
        errors.extend(res.get("errors", []))
    return {"ok": False, "error": "All configured vision models failed: " + " | ".join(errors[-3:] or ["unknown error"])}


def get_vision_endpoint_config():
    """{'url','key','model'} for the PRIMARY configured vision model, for callers
    that build their own OpenAI-vision requests (the emulator keyframe analyzer).
    Draws the key from the shared pool. Returns None when no vision model is set."""
    for cfg in get_effective_configs():
        vms = cfg.get("vision_models") or []
        if vms and cfg["protocol"] == "openai" and cfg["base_url"]:
            keys = cfg.get("api_keys") or ([cfg["api_key"]] if cfg.get("api_key") else [""])
            return {"url": cfg["base_url"].rstrip("/") + "/chat/completions",
                    "key": keys[0], "model": vms[0]}
    return None


def has_vision_model():
    """Whether any configured provider has a vision (image-to-text) model."""
    return any(cfg.get("vision_models") for cfg in get_effective_configs())


def test_connection(overrides=None):
    """Do a tiny live request against the given (possibly unsaved) config so the
    UI can verify a provider/key/model before saving. Returns {ok, model,
    provider, reply} or {ok: False, error, ...}."""
    cfg = get_effective_config(overrides)
    probe = [{"role": "user", "content": "Reply with exactly the single word: pong"}]
    if cfg["protocol"] == "anthropic":
        cfg = dict(cfg)
        cfg["max_tokens"] = 64  # a probe never needs more
        res = _anthropic_request(cfg, probe, 0.0)
    else:
        res = _openai_request(cfg, probe, 0.0)
    if res.get("ok"):
        reply = (res.get("content") or "").strip()
        return {"ok": True, "provider": cfg["label"], "model": cfg["model"], "reply": reply[:200]}
    return {"ok": False, "error": res.get("error", "unknown error"),
            "provider": cfg["label"], "model": cfg["model"]}


# ---------------------------------------------------------------------------
# OpenAI-compatible PASSTHROUGH proxy
#
# ask_llm() above is the AGENT's own path: it wraps replies into the agent's
# JSON protocol (final_answer / tool_call envelopes) and loops forever on total
# failure. That's wrong for a generic OpenAI client (opencode, Cursor, curl):
# such a client sends its OWN system prompt, tools and params and expects a
# STANDARD OpenAI chat-completions response back — native tool_calls intact, no
# agent envelope, and a real error instead of an infinite hang.
#
# passthrough_chat() below reuses the SAME two-axis fallback engine (the provider
# groups, shared key pool, model ladder, and per-key/per-model cooldowns from
# _build_groups / _ordered_models / _live_keys) but relays the raw upstream
# response and makes exactly ONE full pass over every provider/model/key before
# returning an error — so a client never blocks for minutes.
# ---------------------------------------------------------------------------

def _openai_passthrough_request(cfg, client_payload):
    """Relay ONE OpenAI chat-completions request to `cfg`'s endpoint and return
    the upstream JSON verbatim. Unlike _openai_request this does NOT reshape the
    reply into the agent protocol — tool_calls, usage and multi-choice output are
    passed straight back. `client_payload` is the caller's OpenAI body; we override
    only `model` (to this ladder rung), inject reasoning per the config, and attach
    the key. Returns {'ok': True, 'data': <raw json>} or the same {'ok': False,
    'error_kind', 'error'} shape the fallback engine already understands."""
    if not cfg["base_url"]:
        return {"ok": False, "error_kind": "server",
                "error": f"No base URL set for {cfg['label']}."}

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = dict(client_payload)
    payload.pop("stream", None)          # we always call upstream non-streaming
    payload.pop("stream_options", None)
    payload["model"] = cfg["model"]      # pin to this rung of the ladder
    messages = payload.get("messages") or []
    messages, reasoning_on, style = _apply_openai_reasoning(payload, cfg, messages)
    payload["messages"] = messages
    # The OpenAI reasoning style rejects sampling params; every other style keeps
    # whatever temperature the client sent (or none).
    if reasoning_on and style == "openai":
        payload.pop("temperature", None)
    # Honor the client's own max_tokens; only fall back to the config's cap when the
    # client didn't ask for one and the provider entry sets an explicit cap.
    if "max_tokens" not in payload and cfg.get("max_tokens_set"):
        payload["max_tokens"] = cfg["max_tokens"]

    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"

    last_error = None
    last_kind = None
    for _ in range(MAX_RETRIES):
        try:
            response = requests.post(url, json=payload, headers=headers,
                                     timeout=(CONNECT_TIMEOUT, REQUEST_TIMEOUT))
            if response.status_code == 202:
                response = _poll_queued_result(cfg, response)
                if response is None:
                    return {"ok": False, "error_kind": "queue",
                            "error": f"{cfg['label']} queued the request (HTTP 202) and it wasn't ready."}
            if response.status_code == 429:
                return {"ok": False, "error_kind": "rate_limit",
                        "error": f"{cfg['label']} rate-limited this key (HTTP 429): {response.text[:300]}"}
            if not response.ok:
                return {"ok": False, "error_kind": _classify_status(response.status_code),
                        "error": f"{cfg['label']} HTTP {response.status_code}: {response.text[:800]}"}
            try:
                data = response.json()
            except Exception:
                return {"ok": False, "error_kind": "server",
                        "error": f"Invalid JSON from {cfg['label']}:\n{response.text[:800]}"}
            # Unwrap Cline's {"data": {...}} envelope, same as _openai_request.
            if (isinstance(data, dict) and isinstance(data.get("data"), dict)
                    and "choices" not in data and "choices" in data["data"]):
                data = data["data"]
            if not (isinstance(data, dict) and data.get("choices")):
                return {"ok": False, "error_kind": "server",
                        "error": f"No choices from {cfg['label']}:\n{json.dumps(data)[:800]}"}
            return {"ok": True, "data": data}
        except requests.exceptions.Timeout:
            return {"ok": False, "error_kind": "timeout",
                    "error": f"{cfg['label']} did not respond within {REQUEST_TIMEOUT}s."}
        except requests.exceptions.ConnectionError as e:
            last_error, last_kind = f"Connection error: {e}", "connection"
        except Exception as e:
            last_error, last_kind = str(e), "other"
    return {"ok": False, "error_kind": last_kind or "server",
            "error": last_error or "unknown error"}


def _passthrough_ladder(group, requested_model):
    """The group's text ladder in try-order. When the client asked for a model id
    that this group actually serves, pin to just that one (respect an explicit
    choice); otherwise use the full capability-ordered ladder so the proxy manages
    the fallback itself."""
    models = group.get("models") or []
    if requested_model:
        exact = [m for m in models if m["model"] == requested_model]
        if exact:
            return exact
    return _ordered_models(models)


def passthrough_chat(client_payload):
    """Serve one OpenAI chat-completions request through the full fallback stack
    and return the RAW upstream response. Reuses the two-axis engine — rotate the
    KEY on a rate limit, switch the MODEL on an unavailable/queued/slow one, then
    fall through to the next provider group — but makes a SINGLE pass (no forever
    loop): a proxy client gets a real answer or a real error, never a hang.

    Only OpenAI-protocol providers participate (a generic OpenAI client can't be
    served the Anthropic Messages shape). Returns {'ok': True, 'data': <openai
    response>, 'served': {'provider','model'}} or {'ok': False, 'error', 'status'}."""
    global _ACTIVE_KEY
    requested_model = (client_payload.get("model") or "").strip()
    groups = [g for g in _build_groups(get_effective_configs()) if _one_group_is_openai(g)]
    if not groups:
        return {"ok": False, "status": 503,
                "error": ("No OpenAI-compatible provider is configured. Add one in the agent's "
                          "LLM Settings (the passthrough proxy can't serve Anthropic-only setups).")}
    errors = []
    for group in groups:
        keys = group["keys"]
        dead = set()
        ladder = _passthrough_ladder(group, requested_model)
        for m in ladder:
            while True:
                live = _live_keys(keys, dead)
                if not live:
                    break                       # every key throttled — next group
                key = live[0]
                cfg = dict(m["cfg"])
                cfg["api_key"] = key
                res = _openai_passthrough_request(cfg, client_payload)
                if res.get("ok"):
                    _ACTIVE_KEY = key
                    _MODEL_COOLDOWN.pop(m["model"], None)
                    data = res["data"]
                    if isinstance(data, dict):
                        data.setdefault("model", m["model"])
                    return {"ok": True, "data": data,
                            "served": {"provider": group.get("label") or group.get("provider"),
                                       "model": m["model"]}}
                kind = res.get("error_kind", "other")
                errors.append(f"{_model_label(group, m)}: {res.get('error', 'unknown error')}")
                if kind in _KEY_ERROR_KINDS:
                    dead.add(key)
                    _KEY_COOLDOWN[key] = time.monotonic() + KEY_COOLDOWN_SECONDS
                    continue                    # same model, next key
                if kind in _MODEL_COOLDOWN_KINDS:
                    _MODEL_COOLDOWN[m["model"]] = time.monotonic() + MODEL_COOLDOWN_SECONDS
                break                           # next model in the ladder
    return {"ok": False, "status": 502,
            "error": "All configured models/providers failed. " + " | ".join(errors[-4:] or ["unknown error"])}


def _one_group_is_openai(group):
    """A provider group serves the OpenAI protocol when its representative entry's
    preset does (groups built from effective configs don't carry `protocol`, so
    resolve it from the provider preset)."""
    provider = group.get("provider")
    preset = PROVIDERS.get(provider) or PROVIDERS.get("other", {})
    return preset.get("protocol", "openai") == "openai"


def list_passthrough_models():
    """The union of configured TEXT model ids across every OpenAI-protocol group,
    for the proxy's GET /v1/models listing (so a client can discover real ids)."""
    seen, out = set(), []
    for g in _build_groups(get_effective_configs()):
        if not _one_group_is_openai(g):
            continue
        for m in g.get("models") or []:
            mid = m["model"]
            if mid and mid not in seen:
                seen.add(mid)
                out.append(mid)
    return out
