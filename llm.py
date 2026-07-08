import json
import os
import re
import time
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
MAX_RETRIES = 3
RETRY_BACKOFF = 2             # seconds to wait before retrying a provider-side error
DEFAULT_MAX_TOKENS = 8192      # only the Anthropic protocol needs an explicit output cap
DEFAULT_PROVIDER = "cline"

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
tools run on the Windows host instead (their descriptions say so)."""


def get_full_system_prompt():
    base_prompt = DEFAULT_SYSTEM_PROMPT

    base_prompt += """

RESPONSE FORMAT (always valid JSON, nothing else):
- Tool call:    {"type": "tool_call", "tool": "<name>", "args": { ... }}
- Final answer: {"type": "final_answer", "content": "<text>"}
Exactly ONE JSON object per turn — one tool at a time. No markdown, no code fences, no text outside the JSON.

PLAN-AND-EXECUTE (default; the runtime expects it):
- For any task beyond a one-line answer, call `plan_create` FIRST with a short summary + ordered steps. Extend the
  plan later as you learn; a trivial question needing no tools can skip it.
- Keep the plan live, not just at the end: `plan_update_task(id, status="in_progress")` when you start a step,
  `"completed"` the moment it's done, `plan_add_task` when you find new work, `"skipped"` (with a note) when a step
  proves unnecessary. `plan_view` shows ids and current state. An active plan is appended below as "CURRENT PLAN" —
  treat it as the source of truth and fix it rather than drifting from it.

BIG / UNFAMILIAR / OBFUSCATED CODEBASES — map first, then read (HARD RULE):
- The moment you land in a large tree (a decompiled APK, OR any sizeable project), build a map BEFORE reading source.
  The code graph works for smali AND ordinary source (Python, JS/TS, Java, Go, C/C++, Rust, ...). Either call
  build_code_graph once on the relevant dir, or just call query_code_graph / ask_codebase — they AUTO-BUILD a
  workspace graph if none exists yet. Then query_code_graph (string_refs / callers / callees / class / hierarchy)
  jumps you to an exact file:line, and only THEN do you read_file_chunk that one slice.
- Search, don't browse. Never open files one-by-one to "get oriented" — that burns context fast. find_files (by
  name), grep_directory / search_smali (by content) and the code graph are how you locate things; read_file_chunk is
  only for the specific slice a query already pinpointed.
- Use ask_codebase for a "how/why/where does X work" question whose answer would otherwise cost many reads — it
  investigates in an isolated context and returns just the answer.
- For Android specifically: jadx_decompile gives readable Java/Kotlin (deobf=true on ProGuard/R8 apps) and
  ghidra_decompile gives C pseudocode for native .so — both for UNDERSTANDING; make the actual edit in smali
  (patch_smali_method) or on the .so. For obfuscated string checks no plaintext search finds, load the
  string-deobfuscation skill; bypassing the check usually beats fully decrypting the string.
"""

    return base_prompt + "\n" + get_skills_prompt() + "\n" + registry.get_tool_prompt()


# --- config load / save ------------------------------------------------------
def _as_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_config():
    """Return the raw saved config dict. On first run (or if the file is missing
    / unreadable) seed it from the legacy Cline credentials and persist it so the
    UI has something to edit."""
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("provider"):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    save_config(_SEED_CONFIG)
    return dict(_SEED_CONFIG)


def save_config(cfg):
    """Persist the editable fields to llm_config.json (atomic write).

    base_url/model are stored ONLY when they differ from the provider's preset
    default. That keeps the config minimal and, crucially, means the active
    provider always falls back to its OWN defaults — switching providers never
    inherits a stale endpoint or model id from the previous one."""
    provider = (cfg.get("provider") or DEFAULT_PROVIDER)
    preset = PROVIDERS.get(provider) or PROVIDERS["other"]
    base_url = (cfg.get("base_url") or "").strip()
    model = (cfg.get("model") or "").strip()
    if base_url.rstrip("/") == (preset["base_url"] or "").rstrip("/"):
        base_url = ""
    if model == (preset["default_model"] or ""):
        model = ""
    data = {
        "provider": provider,
        "api_key": cfg.get("api_key", "") or "",
        "model": model,
        "base_url": base_url,
    }
    if cfg.get("max_tokens"):
        data["max_tokens"] = _as_int(cfg.get("max_tokens"), DEFAULT_MAX_TOKENS)
    tmp = _CONFIG_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, _CONFIG_PATH)
        return True
    except OSError:
        return False


def get_effective_config(overrides=None):
    """Merge the saved config with its provider preset (and optional unsaved
    overrides, used by test_connection) into a fully-resolved config the request
    functions can act on."""
    cfg = dict(load_config())
    if overrides:
        cfg.update({k: v for k, v in overrides.items() if v is not None})
    provider = cfg.get("provider") or DEFAULT_PROVIDER
    preset = PROVIDERS.get(provider) or PROVIDERS["other"]
    base_url = (cfg.get("base_url") or preset["base_url"] or "").strip().rstrip("/")
    model = (cfg.get("model") or preset["default_model"] or "").strip()
    return {
        "provider": provider,
        "protocol": preset["protocol"],
        "label": preset["label"],
        "base_url": base_url,
        "model": model,
        "api_key": (cfg.get("api_key") or "").strip(),
        "envelope": preset.get("envelope", False),
        "requires_key": preset.get("requires_key", False),
        "max_tokens": _as_int(cfg.get("max_tokens"), DEFAULT_MAX_TOKENS),
    }


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


def extract_json_action(text):
    """Find the agent-action JSON object in a raw LLM reply, or None.

    Tolerates reasoning prose before/after the JSON, <think> blocks, markdown
    code fences, stray braces inside the prose, and trailing commas. Prefers an
    object that looks like an action ({"type": ...} / {"tool": ...}) over any
    other JSON the reply happens to contain."""
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
    for source in sources:
        attempts = [source]
        defused = _TRAILING_COMMA_RE.sub(r"\1", source)
        if defused != source:
            attempts.append(defused)
        for attempt in attempts:
            for obj in _json_candidates(attempt):
                if not isinstance(obj, dict):
                    continue
                if obj.get("type") in ("tool_call", "final_answer") or "tool" in obj or "args" in obj:
                    return obj
                if fallback is None:
                    fallback = obj
    return fallback


# --- request helpers ---------------------------------------------------------
def _error_response(message):
    return json.dumps({
        "type": "final_answer",
        "content": f"[Error] {message}"
    })


def _openai_request(cfg, messages, temperature):
    """One OpenAI chat-completions request. Returns {'ok', 'content'} on success
    or {'ok': False, 'error'} on failure (with retries for transient errors)."""
    if cfg["requires_key"] and not cfg["api_key"]:
        return {"ok": False, "error": f"No API key set for {cfg['label']}. Open LLM Settings to add one."}
    if not cfg["base_url"]:
        return {"ok": False, "error": f"No base URL set for {cfg['label']}. Open LLM Settings to configure it."}

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    payload = {"model": cfg["model"], "messages": messages, "temperature": temperature}
    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"

    last_error = None
    for _ in range(MAX_RETRIES):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
            if not response.ok:
                return {"ok": False, "error": f"{cfg['label']} HTTP {response.status_code}: {response.text[:800]}"}
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
                tc = message["tool_calls"][0]
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments", "{}") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                return {"ok": True, "content": json.dumps({"type": "tool_call", "tool": fn.get("name", ""), "args": args})}

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

            return {"ok": True, "content": content}

        except requests.exceptions.Timeout:
            last_error = "Request timed out"
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {e}"
        except Exception as e:
            last_error = str(e)

    return {"ok": False, "error": last_error or "unknown error"}


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


def _anthropic_request(cfg, messages, temperature):
    """One Anthropic Messages API request. `temperature` is intentionally NOT
    sent — Claude Opus 4.7/4.8, Sonnet 5 and Fable 5 reject sampling params."""
    if not cfg["api_key"]:
        return {"ok": False, "error": "No API key set for Anthropic Claude. Open LLM Settings to add one."}

    base = cfg["base_url"] or "https://api.anthropic.com/v1"
    url = base.rstrip("/") + "/messages"
    system_text, conv = _split_anthropic_messages(messages)
    payload = {"model": cfg["model"], "max_tokens": cfg["max_tokens"], "messages": conv}
    if system_text:
        payload["system"] = system_text
    headers = {
        "Content-Type": "application/json",
        "x-api-key": cfg["api_key"],
        "anthropic-version": "2023-06-01",
    }

    last_error = None
    for _ in range(MAX_RETRIES):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
            if not response.ok:
                return {"ok": False, "error": f"Anthropic HTTP {response.status_code}: {response.text[:800]}"}
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
            return {"ok": True, "content": text}

        except requests.exceptions.Timeout:
            last_error = "Request timed out"
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {e}"
        except Exception as e:
            last_error = str(e)

    return {"ok": False, "error": last_error or "unknown error"}


def ask_llm(messages, temperature=0.7):
    """Send the conversation to the currently-configured LLM provider and return
    the assistant's raw text (or a JSON error envelope the agent loop can parse).
    Reads the live config on every call, so a change made in the UI takes effect
    on the next message."""
    cfg = get_effective_config()
    if cfg["protocol"] == "anthropic":
        res = _anthropic_request(cfg, messages, temperature)
    else:
        res = _openai_request(cfg, messages, temperature)
    if res.get("ok"):
        return res["content"]
    return _error_response(res.get("error", "unknown error"))


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
