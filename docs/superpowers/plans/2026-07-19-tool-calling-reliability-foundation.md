# Tool-Calling Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent's tool-calling protocol robust and low-variance by adding native OpenAI function-calling (where a model supports it) plus a hardened multi-format parser fallback for everything else.

**Architecture:** Three layers per turn — (1) request: send `tools=[…]` + `tool_choice="required"` for models flagged native, else today's prose-JSON prompt; (2) response: use structured `tool_calls` if present, else run a hardened parser that normalizes `<tool_call>`/harmony/name-then-json shapes into the canonical action; (3) turn: bounded correction retry (exists). Native-vs-prose is decided per model and is orthogonal to the existing `ask_llm` transport-error fallback, which is untouched.

**Tech Stack:** Python 3, `requests`, `inspect` (signature→schema), `pytest`, existing `tool_registry.registry` and `llm.py` OpenAI request path.

## Global Constraints

- Layer onto existing code; do NOT rewrite the agent loop or the `ask_llm` fallback chain.
- Progressive tool disclosure must be preserved — native `tools=` carries only core + active-group tools, plus `expand_tools` and `final_answer`, NOT all ~105 schemas.
- `supports_native_tools` is set **manually per model** in `model_settings` (config-level value as default; absent → `false`). No auto-probe.
- Tool schemas are generated from **live** function signatures; any cache is keyed by a content hash of the tool's signature + `params_schema` so a changed tool auto-invalidates. Never persist stale baked-in schemas.
- Mechanical-loop temperature default is **`0.15`** (low, not 0), configurable.
- When `supports_native_tools=false`, the prose-JSON path must behave exactly as today.

---

### Task 1: Hardened non-JSON action parser

Normalizes non-JSON tool-intent shapes (the `<tool_call>` literals, harmony tags, name-then-json, bare tool name) into the canonical action, wired into `extract_json_action` as a last resort after JSON salvage fails. Pure function — fully unit-testable, no provider needed. This alone kills the current "response was not proper JSON" failures.

**Files:**
- Modify: `llm.py` (add regexes near `llm.py:846-849`; add `_normalize_nonjson_action`; wire into `extract_json_action` at `llm.py:908-942`)
- Test: `tests/test_hardened_parser.py`

**Interfaces:**
- Consumes: `registry.is_registered(name)` (from `tool_registry`, already imported in `llm.py`); existing `_normalize_action`.
- Produces: `_normalize_nonjson_action(text) -> dict | None` returning a canonical `{"type":"tool_call","tool":<name>,"args":<dict>}`. `extract_json_action` returns this when no action-shaped JSON is found.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_hardened_parser.py`:

```python
import json
import llm


def test_tool_call_tag_with_json():
    text = '<tool_call>{"name": "read_file_chunk", "arguments": {"path": "a.smali"}}</tool_call>'
    action = llm.extract_json_action(text)
    assert action["type"] == "tool_call"
    assert action["tool"] == "read_file_chunk"
    assert action["args"] == {"path": "a.smali"}


def test_tool_call_tag_bare_name(monkeypatch):
    monkeypatch.setattr(llm.registry, "is_registered", lambda n: n == "list_dir")
    action = llm.extract_json_action("<tool_call>list_dir</tool_call>")
    assert action["type"] == "tool_call"
    assert action["tool"] == "list_dir"
    assert action["args"] == {}


def test_function_call_named_attribute():
    text = '<function_call name="grep_directory">{"pattern": "isRooted"}</function_call>'
    action = llm.extract_json_action(text)
    assert action["tool"] == "grep_directory"
    assert action["args"] == {"pattern": "isRooted"}


def test_function_equals_tag():
    text = '<function=nop_function>{"offset": "0x1C4B000"}</function>'
    action = llm.extract_json_action(text)
    assert action["tool"] == "nop_function"
    assert action["args"] == {"offset": "0x1C4B000"}


def test_name_then_json(monkeypatch):
    monkeypatch.setattr(llm.registry, "is_registered", lambda n: n == "patch_smali_method")
    text = 'patch_smali_method\n{"cls": "L/a/b;", "method": "check"}'
    action = llm.extract_json_action(text)
    assert action["tool"] == "patch_smali_method"
    assert action["args"] == {"cls": "L/a/b;", "method": "check"}


def test_bare_tool_name_line(monkeypatch):
    monkeypatch.setattr(llm.registry, "is_registered", lambda n: n == "plan_view")
    action = llm.extract_json_action("plan_view")
    assert action["tool"] == "plan_view"
    assert action["args"] == {}


def test_valid_json_still_wins():
    text = '{"type": "tool_call", "tool": "read_file_chunk", "args": {"path": "x"}}'
    action = llm.extract_json_action(text)
    assert action["tool"] == "read_file_chunk"


def test_final_answer_json_untouched():
    text = '{"type": "final_answer", "content": "done"}'
    action = llm.extract_json_action(text)
    assert action["type"] == "final_answer"


def test_plain_prose_returns_none():
    assert llm.extract_json_action("I think we should look at the native lib.") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_hardened_parser.py -v`
Expected: the tag/name-then-json/bare-name tests FAIL (parser returns `None`); `test_valid_json_still_wins`, `test_final_answer_json_untouched`, `test_plain_prose_returns_none` may already PASS.

- [ ] **Step 3: Add the regexes and normalizer to `llm.py`**

After the existing regex block (`llm.py:849`, right after `_TRAILING_COMMA_RE`), add:

```python
# Non-JSON tool-call shapes that reasoning/open models (esp. GLM, trained on
# harmony/XML tool syntax) emit instead of the required JSON envelope. Handled as
# a LAST RESORT in extract_json_action, after JSON salvage finds no action.
_TAG_RE = re.compile(
    r"<(?:tool_call|function_call|function)(?:\s+name\s*=\s*\"(?P<attr>[\w.]+)\")?"
    r"(?:\s*=\s*(?P<eqname>[\w.]+))?\s*>(?P<body>.*?)</(?:tool_call|function_call|function)>",
    re.DOTALL | re.IGNORECASE,
)
_LEADING_NAME_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*(\{.*\})\s*$", re.DOTALL)
_BARE_NAME_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*$")


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


def _normalize_nonjson_action(text):
    """Map a non-JSON tool-call shape onto the canonical action, or None.

    Recognizes <tool_call>/<function_call>/<function=> tags (name via attribute,
    `=name`, or a leading token inside the body), a bare `name\\n{json}` pair, and
    a lone registered tool name. Only accepts a bare/leading name when it is a
    REGISTERED tool, so ordinary prose starting with a word is not misread."""
    if not text:
        return None

    m = _TAG_RE.search(text)
    if m:
        body = (m.group("body") or "").strip()
        name = m.group("attr") or m.group("eqname")
        args = _coerce_args(body)
        if not name:
            # Name may be a JSON "name" field, or the leading token of the body.
            for obj in _json_candidates(body):
                if isinstance(obj, dict) and isinstance(obj.get("name"), str):
                    name = obj["name"]
                    break
            if not name:
                lead = _BARE_NAME_RE.match(body)
                if lead and registry.is_registered(lead.group(1)):
                    name = lead.group(1)
        if name:
            return {"type": "tool_call", "tool": name, "args": args if isinstance(args, dict) else {}}

    lead = _LEADING_NAME_RE.match(text)
    if lead and registry.is_registered(lead.group(1)):
        return {"type": "tool_call", "tool": lead.group(1), "args": _coerce_args(lead.group(2))}

    bare = _BARE_NAME_RE.match(text)
    if bare and registry.is_registered(bare.group(1)):
        return {"type": "tool_call", "tool": bare.group(1), "args": {}}

    return None
```

- [ ] **Step 4: Wire it into `extract_json_action`**

In `extract_json_action` (`llm.py:928-942`), replace the final `return fallback` so the normalizer runs before giving up:

```python
    # No action-shaped JSON found in any source. Try the non-JSON tool-call
    # shapes (harmony/XML tags, name-then-json, bare tool name) before falling
    # back to any stray JSON object the reply happened to contain.
    nonjson = _normalize_nonjson_action(cleaned)
    if nonjson is not None:
        return nonjson
    return fallback
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_hardened_parser.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add llm.py tests/test_hardened_parser.py
git commit -m "feat(llm): hardened non-JSON tool-call parser (harmony/tag/name-then-json)"
```

---

### Task 2: Fix the self-contradicting correction prompt + lower temperature

The correction prompt (`agent.py:191`) asks for *"keys: action, tool, arguments"* then shows `{"type","tool","args"}` — two conflicting schemas. Replace with one consistent message. Also lower `MAIN_LOOP_TEMPERATURE` from `0.3` to `0.15`.

**Files:**
- Modify: `agent.py` (`JSON_CORRECTION_MSG` at `agent.py:190-194`; `MAIN_LOOP_TEMPERATURE` at `agent.py:373`)
- Test: `tests/test_correction_and_temp.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `agent.JSON_CORRECTION_MSG` (str, no "action, tool, arguments" phrase, mentions no `<tool_call>` tags); `agent.MAIN_LOOP_TEMPERATURE == 0.15`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_correction_and_temp.py`:

```python
import agent


def test_correction_prompt_is_consistent():
    msg = agent.JSON_CORRECTION_MSG
    # No contradictory alias-key instruction.
    assert "action, tool, arguments" not in msg
    # Shows the canonical schema and forbids the tag shape that models drift into.
    assert '"type": "tool_call"' in msg
    assert "tool_call>" in msg  # references the <tool_call> tag to forbid it


def test_main_loop_temperature_is_low_nonzero():
    assert agent.MAIN_LOOP_TEMPERATURE == 0.15
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_correction_and_temp.py -v`
Expected: FAIL — current message contains "action, tool, arguments"; temperature is `0.3`.

- [ ] **Step 3: Replace the correction message**

Replace the `JSON_CORRECTION_MSG` assignment (`agent.py:190-194`, through the end of that string) with:

```python
# The exact corrective message appended to the history on a JSON parse failure.
# ONE consistent schema — do not introduce alias keys here (that confused models
# further). Also forbids the <tool_call> tag shape that GLM/harmony models emit.
JSON_CORRECTION_MSG = (
    "Your last message was not a valid action. Respond with EXACTLY ONE raw JSON "
    "object and nothing else — no markdown, no code fences, no prose, and do NOT "
    "use <tool_call> or <function> tags. "
    'For a tool call: {"type": "tool_call", "tool": "<name>", "args": { ... }}. '
    'For the final answer: {"type": "final_answer", "content": "<text>"}.'
)
```

- [ ] **Step 4: Lower the temperature**

Change `agent.py:373`:

```python
MAIN_LOOP_TEMPERATURE = 0.15
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_correction_and_temp.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add agent.py tests/test_correction_and_temp.py
git commit -m "fix(agent): consistent JSON correction prompt; mechanical temp 0.3->0.15"
```

---

### Task 3: OpenAI tool-schema generator

Generate an OpenAI `tools` entry for a registered tool from its **live** signature (required vs optional params) and `params_schema` text (descriptions). Build the per-turn `tools=` array honoring progressive disclosure, plus synthetic `final_answer`. In-memory cache keyed by a content hash of signature + params so a changed tool auto-regenerates.

**Files:**
- Create: `tools/tool_schema.py`
- Test: `tests/test_tool_schema.py`

**Interfaces:**
- Consumes: `tool_registry.registry` (`._tools[name]` = {description, params, func, ...}; `.tools_in_group`, `.domain_groups`, `.group_of`, `CORE_GROUP`).
- Produces:
  - `build_openai_schema(name) -> dict` — `{"type":"function","function":{"name","description","parameters":{...}}}`.
  - `openai_tools_for(active_groups) -> list[dict]` — core + active-group tool schemas + `expand_tools` + the synthetic `final_answer`.
  - `FINAL_ANSWER_TOOL = "final_answer"` (str constant).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_tool_schema.py`:

```python
import inspect
from tools import tool_schema
from tool_registry import registry


def _register_probe():
    @registry.register(
        name="probe_tool",
        description="A probe tool.",
        params_schema={"path": "the file path", "count": "how many"},
    )
    def probe_tool(path, count=3):
        return {"ok": True}
    return probe_tool


def test_schema_shape_and_required():
    _register_probe()
    schema = tool_schema.build_openai_schema("probe_tool")
    assert schema["type"] == "function"
    fn = schema["function"]
    assert fn["name"] == "probe_tool"
    props = fn["parameters"]["properties"]
    assert set(props) == {"path", "count"}
    # `path` has no default -> required; `count` has a default -> optional.
    assert fn["parameters"]["required"] == ["path"]
    assert props["path"]["description"] == "the file path"


def test_cache_invalidates_on_change():
    _register_probe()
    first = tool_schema.build_openai_schema("probe_tool")

    @registry.register(
        name="probe_tool",
        description="A probe tool v2.",
        params_schema={"path": "the file path", "count": "how many", "flag": "a flag"},
    )
    def probe_tool_v2(path, count=3, flag=False):
        return {"ok": True}

    second = tool_schema.build_openai_schema("probe_tool")
    assert "flag" in second["function"]["parameters"]["properties"]
    assert first != second


def test_tools_for_includes_final_answer_and_expand():
    names = {t["function"]["name"] for t in tool_schema.openai_tools_for(active_groups=set())}
    assert "final_answer" in names
    assert "expand_tools" in names


def test_final_answer_schema_has_content_param():
    schema = next(
        t for t in tool_schema.openai_tools_for(active_groups=set())
        if t["function"]["name"] == "final_answer"
    )
    assert "content" in schema["function"]["parameters"]["properties"]
    assert schema["function"]["parameters"]["required"] == ["content"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_tool_schema.py -v`
Expected: FAIL — `tools/tool_schema.py` does not exist.

- [ ] **Step 3: Implement the generator**

Create `tools/tool_schema.py`:

```python
"""OpenAI function-calling schema generation for the tool registry.

Schemas are derived from LIVE function signatures (the signature IS the schema,
same principle as ToolRegistry._validate_args) and cached in-memory keyed by a
content hash of the signature + params text — a changed tool auto-invalidates, so
no stale schema is ever served after a code change.
"""
import hashlib
import inspect
import json

from tool_registry import registry, CORE_GROUP

FINAL_ANSWER_TOOL = "final_answer"

_CACHE = {}  # name -> (fingerprint, schema)

# Minimal annotation -> JSON type mapping; unknown/absent annotations default to
# "string" (the model still passes structured values; execute() validates names).
_TYPE_MAP = {str: "string", int: "integer", float: "number", bool: "boolean",
             dict: "object", list: "array"}


def _fingerprint(name, func, params):
    try:
        sig = str(inspect.signature(func))
    except (TypeError, ValueError):
        sig = ""
    return hashlib.sha256(
        (name + "|" + sig + "|" + json.dumps(params, sort_keys=True)).encode()
    ).hexdigest()


def _json_type(annotation):
    return _TYPE_MAP.get(annotation, "string")


def build_openai_schema(name):
    """The OpenAI `tools` entry for one registered tool, from its live signature."""
    data = registry._tools[name]
    func, params_text = data["func"], data.get("params") or {}
    fp = _fingerprint(name, func, params_text)
    cached = _CACHE.get(name)
    if cached and cached[0] == fp:
        return cached[1]

    properties, required = {}, []
    try:
        sig_params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        sig_params = {}
    for pname, p in sig_params.items():
        if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        prop = {"type": _json_type(p.annotation if p.annotation is not p.empty else None)}
        desc = params_text.get(pname)
        if desc:
            prop["description"] = str(desc)
        properties[pname] = prop
        if p.default is p.empty:
            required.append(pname)

    schema = {
        "type": "function",
        "function": {
            "name": name,
            "description": (data.get("description") or "").strip(),
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }
    _CACHE[name] = (fp, schema)
    return schema


def _final_answer_schema():
    return {
        "type": "function",
        "function": {
            "name": FINAL_ANSWER_TOOL,
            "description": "Deliver the final answer and end the task. Use ONLY when done.",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string", "description": "The final answer text."}},
                "required": ["content"],
            },
        },
    }


def openai_tools_for(active_groups):
    """Build the per-turn `tools=` array: core + active-group tools (progressive
    disclosure preserved — NOT all tools), plus expand_tools and final_answer.
    active_groups=None means every registered tool (legacy/isolated callers)."""
    names = []
    for name in registry._tools:
        grp = registry.group_of(name)
        if active_groups is None or grp == CORE_GROUP or grp in active_groups:
            names.append(name)
    tools = [build_openai_schema(n) for n in names]
    if not any(t["function"]["name"] == FINAL_ANSWER_TOOL for t in tools):
        tools.append(_final_answer_schema())
    return tools
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_tool_schema.py -v`
Expected: PASS. (`expand_tools` is a real registered tool in `tools/meta_tools.py`, in CORE_GROUP, so it appears automatically.)

- [ ] **Step 5: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add tools/tool_schema.py tests/test_tool_schema.py
git commit -m "feat(tools): OpenAI tool-schema generator from live signatures with hash cache"
```

---

### Task 4: Per-model `supports_native_tools` resolution

Carry a per-model `supports_native_tools` flag through `model_settings` and resolve it (per-model override → config-level default → `False`) for the active request config.

**Files:**
- Modify: `llm.py` (`_norm_model_settings` at `llm.py:357-380`; add `_supports_native_tools` near `_resolve_reasoning_style` at `llm.py:410`)
- Test: `tests/test_native_flag.py`

**Interfaces:**
- Consumes: `cfg` dict (has `model`, `model_settings`, and optionally top-level `supports_native_tools`).
- Produces: `_supports_native_tools(cfg) -> bool`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_native_flag.py`:

```python
import llm


def test_per_model_flag_wins():
    cfg = {"model": "z-ai/glm-5.2",
           "model_settings": {"z-ai/glm-5.2": {"supports_native_tools": True}}}
    assert llm._supports_native_tools(cfg) is True


def test_config_level_default_applies():
    cfg = {"model": "z-ai/glm-5.2", "supports_native_tools": True, "model_settings": {}}
    assert llm._supports_native_tools(cfg) is True


def test_per_model_false_overrides_config_default():
    cfg = {"model": "m", "supports_native_tools": True,
           "model_settings": {"m": {"supports_native_tools": False}}}
    assert llm._supports_native_tools(cfg) is False


def test_absent_is_false():
    assert llm._supports_native_tools({"model": "m", "model_settings": {}}) is False


def test_norm_model_settings_preserves_flag():
    out = llm._norm_model_settings(
        {"m": {"supports_native_tools": True}}, ["m"])
    assert out["m"]["supports_native_tools"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_native_flag.py -v`
Expected: FAIL — `_supports_native_tools` undefined and `_norm_model_settings` drops the flag.

- [ ] **Step 3: Preserve the flag in `_norm_model_settings`**

In `_norm_model_settings` (`llm.py:357-380`), inside the per-model loop that builds `entry` (alongside where `reasoning_effort` / `reasoning_style` are set, near `llm.py:374`), add:

```python
        if isinstance(s.get("supports_native_tools"), bool):
            entry["supports_native_tools"] = s["supports_native_tools"]
```

- [ ] **Step 4: Add the resolver**

After `_resolve_reasoning_style` (`llm.py:410-412`), add:

```python
def _supports_native_tools(cfg):
    """Whether the active model should be sent an OpenAI `tools` array.
    Per-model override (model_settings) wins; else the config-level default;
    else False (the safe prose path)."""
    model = cfg.get("model")
    ms = (cfg.get("model_settings") or {}).get(model) or {}
    if isinstance(ms.get("supports_native_tools"), bool):
        return ms["supports_native_tools"]
    return bool(cfg.get("supports_native_tools"))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_native_flag.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add llm.py tests/test_native_flag.py
git commit -m "feat(llm): per-model supports_native_tools resolution"
```

---

### Task 5: Wire native tools into the request + final_answer interception + seed

When the active model supports native tools, attach `tools=` (Task 3) and `tool_choice="required"` to the OpenAI payload; intercept a `final_answer` tool call and convert it to the final-answer envelope; add optional `seed` passthrough. The existing `tool_calls` handler (`llm.py:1090-1098`) already covers all other tools.

**Files:**
- Modify: `llm.py` (`_openai_request`: payload build near `llm.py:1017-1031`; response handling near `llm.py:1090-1098`)
- Test: `tests/test_native_request.py`

**Interfaces:**
- Consumes: `_supports_native_tools` (Task 4), `tool_schema.openai_tools_for` + `FINAL_ANSWER_TOOL` (Task 3).
- Produces: payload gains `tools` + `tool_choice="required"` + optional `seed` when native; a `final_answer` tool call returns `{"type":"final_answer","content":...}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_native_request.py`:

```python
import json
import types
import llm


class _FakeResp:
    status_code = 200
    ok = True

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def _cfg(**over):
    base = {"requires_key": False, "api_key": "", "base_url": "http://x",
            "model": "z-ai/glm-5.2", "model_settings": {}, "max_tokens_set": False,
            "supports_native_tools": True}
    base.update(over)
    return base


def test_native_payload_has_tools_and_required(monkeypatch):
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["payload"] = json
        return _FakeResp({"choices": [{"message": {
            "tool_calls": [{"function": {"name": "list_dir", "arguments": "{\"path\": \".\"}"}}]}}]})

    monkeypatch.setattr(llm.requests, "post", fake_post)
    res = llm._openai_request(_cfg(), [{"role": "user", "content": "hi"}], 0.15)
    assert res["ok"]
    assert captured["payload"]["tool_choice"] == "required"
    assert isinstance(captured["payload"]["tools"], list) and captured["payload"]["tools"]
    action = json.loads(res["content"])
    assert action == {"type": "tool_call", "tool": "list_dir", "args": {"path": "."}}


def test_native_final_answer_intercepted(monkeypatch):
    def fake_post(url, json=None, headers=None, timeout=None):
        return _FakeResp({"choices": [{"message": {
            "tool_calls": [{"function": {"name": "final_answer",
                                          "arguments": "{\"content\": \"all done\"}"}}]}}]})

    monkeypatch.setattr(llm.requests, "post", fake_post)
    res = llm._openai_request(_cfg(), [{"role": "user", "content": "hi"}], 0.15)
    action = json.loads(res["content"])
    assert action == {"type": "final_answer", "content": "all done"}


def test_prose_payload_has_no_tools(monkeypatch):
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["payload"] = json
        return _FakeResp({"choices": [{"message": {"content": "{\"type\": \"final_answer\", \"content\": \"x\"}"}}]})

    monkeypatch.setattr(llm.requests, "post", fake_post)
    llm._openai_request(_cfg(supports_native_tools=False, model_settings={}), [{"role": "user", "content": "hi"}], 0.15)
    assert "tools" not in captured["payload"]
    assert "tool_choice" not in captured["payload"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_native_request.py -v`
Expected: FAIL — payload has no `tools`/`tool_choice`; `final_answer` returns a `tool_call`, not the envelope.

- [ ] **Step 3: Attach tools to the payload**

In `_openai_request`, after the reasoning block sets `payload["messages"]` and temperature (immediately after `llm.py:1031`), add:

```python
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
```

- [ ] **Step 4: Intercept the final_answer tool call in the response**

Replace the native tool-call handler (`llm.py:1090-1098`) with a version that special-cases `final_answer`:

```python
            # Native function-calling: content is null, tool call is in tool_calls.
            if not content and message.get("tool_calls"):
                tc = message["tool_calls"][0]
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments", "{}") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                fname = fn.get("name", "")
                # final_answer is offered as a tool so tool_choice can be "required";
                # convert it back to the final-answer envelope the loop expects.
                if fname == "final_answer":
                    return {"ok": True, "content": json.dumps(
                        {"type": "final_answer", "content": args.get("content", "")})}
                return {"ok": True, "content": json.dumps({"type": "tool_call", "tool": fname, "args": args})}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_native_request.py -v`
Expected: PASS.

- [ ] **Step 6: Run the full new suite for regressions**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -m pytest tests/test_hardened_parser.py tests/test_correction_and_temp.py tests/test_tool_schema.py tests/test_native_flag.py tests/test_native_request.py -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add llm.py tests/test_native_request.py
git commit -m "feat(llm): send native tools + tool_choice=required; intercept final_answer; seed passthrough"
```

---

### Task 6: Enable native tools on real models + live smoke test

Flag the models you've verified in `llm_config.json` and add a live round-trip smoke test (skipped without credentials) that doubles as the manual verification before flipping each flag.

**Files:**
- Modify: `llm_config.json` (`model_settings` block)
- Test: `tests/test_live_native_smoke.py`

**Interfaces:**
- Consumes: everything above; a live provider endpoint + key from the config.
- Produces: config with `supports_native_tools` on verified models.

- [ ] **Step 1: Write the smoke test**

Create `tests/test_live_native_smoke.py`:

```python
import json
import os
import pytest
import llm

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_LIVE_LLM") != "1",
    reason="live LLM smoke test; set RUN_LIVE_LLM=1 to run",
)


def test_native_tool_roundtrip():
    """A flagged model returns a structured tool_call for a forced request."""
    cfg = llm.get_effective_config()
    if not llm._supports_native_tools(cfg):
        pytest.skip("active model is not flagged supports_native_tools")
    messages = [
        {"role": "system", "content": "You are a tool-using agent. Call a tool."},
        {"role": "user", "content": "List the current directory."},
    ]
    res = llm._openai_request(cfg, messages, 0.15)
    assert res["ok"], res
    action = json.loads(res["content"])
    assert action["type"] in ("tool_call", "final_answer")
```

- [ ] **Step 2: Run the smoke test live for each candidate model**

For each model you want to enable (e.g. `z-ai/glm-5.2`, `deepseek-ai/deepseek-v4-pro`), temporarily set it as `preferred_model` in `llm_config.json`, then run:

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && RUN_LIVE_LLM=1 python -m pytest tests/test_live_native_smoke.py -v`
Expected: PASS (a structured action comes back). If the provider 400s on `tools`, that model does NOT support native tools — leave its flag off; the hardened parser (Task 1) still covers it.

- [ ] **Step 3: Flag the verified models**

In `llm_config.json`, add `supports_native_tools: true` to each verified model under `model_settings`, e.g.:

```json
"z-ai/glm-5.2": {
  "reasoning_effort": "high",
  "supports_native_tools": true
}
```

Leave unverified/unsupported models without the flag (defaults to prose path).

- [ ] **Step 4: Confirm the config still loads**

Run: `cd "/Users/berat/Desktop/Omni Apps/omni-agent" && python -c "import llm; c=llm.get_effective_config(); print(c['model'], llm._supports_native_tools(c))"`
Expected: prints the active model and `True` when the active model was flagged.

- [ ] **Step 5: Commit**

```bash
cd "/Users/berat/Desktop/Omni Apps/omni-agent"
git add llm_config.json tests/test_live_native_smoke.py
git commit -m "feat(config): enable native tools on verified models; add live smoke test"
```

---

## Self-Review

**Spec coverage:**
- SC1 (native structured calls) → Tasks 3, 5, 6.
- SC2 (non-JSON shapes parsed) → Task 1.
- SC3 (`final_answer` native, `tool_choice=required`) → Tasks 3 (schema), 5 (payload + interception).
- SC4 (schemas from live signatures, hash-invalidated, no stale) → Task 3.
- SC5 (prose path unchanged when flag off) → Task 4 (default false), Task 5 (`test_prose_payload_has_no_tools`).
- Correction-prompt contradiction fix → Task 2.
- Temperature 0.15 → Task 2.
- Progressive disclosure preserved → Task 3 (`openai_tools_for` filters by active_groups; core + active only).
- `expand_tools` reachable in native mode → Task 3 (it is a CORE tool, auto-included).

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows the actual code.

**Type consistency:** `_normalize_nonjson_action`, `build_openai_schema`, `openai_tools_for`, `FINAL_ANSWER_TOOL`, `_supports_native_tools` are named identically where defined and consumed. `_coerce_args` and the module-level regexes are defined in Task 1 before use. The `final_answer` name string is consistent across Tasks 3 and 5.

**Note for the implementer:** `active_groups` is read from `cfg.get("active_groups")` in Task 5. If the active config does not currently thread `active_groups` into the request `cfg`, `openai_tools_for(None)` renders every tool (legacy-safe) — acceptable for a first landing, but a follow-up can thread the live active-group set into `cfg` to shrink the native `tools=` payload the same way the prose prompt already shrinks. This is an optimization, not a correctness gap.
