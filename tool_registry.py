import inspect
import json

# --- Progressive tool disclosure --------------------------------------------
# The module a tool is defined in determines its "toolset". CORE toolsets are
# always shown in the prompt in full; the rest are shown only as a compact
# one-line catalog until they are ACTIVATED — either by the model calling one of
# their tools (usage-driven auto-expand) or via the expand_tools() tool. An
# activated toolset folds its full schemas into the prompt on subsequent turns.
#
# This is the single biggest context win: the base prompt drops from ~35k tokens
# of tool schemas (all 105 tools) to a small core + a ~1k-token catalog, without
# hiding any capability — every tool still executes if called, and a malformed
# call to a catalog-only tool gets that tool's full schema back so the model can
# self-correct immediately (see agent.py's error-injection path).
CORE_GROUP = "core"
_GROUP_BY_MODULE = {
    # Always-on core: file/shell/search, code navigation, the plan +
    # investigation workflow, skills, review, web, hashing.
    "filesystem": CORE_GROUP,
    "shell": CORE_GROUP,
    "text_analysis": CORE_GROUP,
    "code_graph": CORE_GROUP,
    "codebase_qa": CORE_GROUP,
    "plan_tools": CORE_GROUP,
    "investigation_tools": CORE_GROUP,
    "skill_tools": CORE_GROUP,
    "reviewer": CORE_GROUP,
    "web_tools": CORE_GROUP,
    "hash_tools": CORE_GROUP,
    "meta_tools": CORE_GROUP,
    "delegation_tools": CORE_GROUP,
    # On-demand domain toolsets:
    "apk_tools": "apk",
    "session_bootstrap": "apk",
    "dex_editing": "smali",
    "binary_analysis": "native",
    "binary_editing": "native",
    "hex_patching": "native",
    "native_codegen": "native",
    "android_emulator": "emulator",
    "vision_tools": "emulator",
    "roblox_session": "emulator",
    "frida_tools": "frida",
}
# Per-tool overrides that beat the module mapping. Used to pull a few heavy or
# rarely-first-used tools out of core (e.g. graph BUILDING — query_code_graph
# auto-builds, so the verbose build/diff/list tools don't need to sit in the
# base prompt — and web tools) into their own on-demand toolsets.
_GROUP_BY_TOOL = {
    "build_code_graph": "graph",
    "diff_code_graphs": "graph",
    "list_code_graphs": "graph",
    "web_search": "web",
    "read_webpage": "web",
    "download_file": "web",
}
# Human-facing one-liners for the on-demand toolset headers in the catalog.
GROUP_LABELS = {
    "apk": "APK unpack / decode / rebuild / sign / inspect / manifest",
    "smali": "standalone DEX & smali disassembly / method+field patching",
    "native": "native .so analysis + byte / assembly / C patching",
    "emulator": "Android emulator: install / launch / logcat / screenshots / vision",
    "frida": "Frida runtime hooking + tracing + unpinning (dev base: root + frida-server)",
    "graph": "build / diff / list code knowledge-graphs (query_code_graph auto-builds, so only needed to index a sub-dir or a named version)",
    "web": "internet search / fetch a page / download a file",
}


class ToolRegistry:
    def __init__(self):
        self._tools = {}

    def register(self, name, description, params_schema, output=None,
                 when_to_use=None, summary=None):
        """
        Decorator to register a tool with the framework.

        Args:
            name:           The tool name the LLM uses to call it.
            description:    WHAT the tool does (plain language).
            params_schema:  Dict of {param_name: type_description}.
            output:         (optional) Description of the exact output the tool
                            returns — what the LLM will see in TOOL RESULT.
            when_to_use:    (optional) Short guidance on when to choose this
                            tool over alternatives.
            summary:        (optional) A <=90-char one-liner used in the compact
                            on-demand catalog. Falls back to the first sentence
                            of `description` when omitted.
        """
        def decorator(func):
            self._tools[name] = {
                "description": description,
                "params": params_schema,
                "output": output or "",
                "when_to_use": when_to_use or "",
                "summary": (summary or "").strip(),
                "func": func
            }
            return func
        return decorator

    def is_registered(self, name):
        """True iff `name` is a real registered tool. Used to validate a skill's
        allowed-tools so a typo / renamed / removed tool in a SKILL.md surfaces
        as an authoring bug instead of silently mapping to nothing."""
        return name in self._tools

    # --- toolset helpers ------------------------------------------------------
    def group_of(self, name):
        """The toolset a tool belongs to (its defining module's group, or
        CORE_GROUP if unmapped)."""
        if name in _GROUP_BY_TOOL:
            return _GROUP_BY_TOOL[name]
        data = self._tools.get(name)
        if not data:
            return CORE_GROUP
        mod = getattr(data["func"], "__module__", "") or ""
        base = mod.rsplit(".", 1)[-1]
        return _GROUP_BY_MODULE.get(base, CORE_GROUP)

    def domain_groups(self):
        """All non-core toolset names that actually have tools, in a stable
        order (order of first appearance in the registry)."""
        seen = []
        for name in self._tools:
            g = self.group_of(name)
            if g != CORE_GROUP and g not in seen:
                seen.append(g)
        return seen

    def tools_in_group(self, group):
        return [n for n in self._tools if self.group_of(n) == group]

    def _summary_line(self, name):
        data = self._tools[name]
        if data["summary"]:
            return data["summary"]
        d = (data["description"] or "").strip().replace("\n", " ")
        cut = d.find(". ")
        if 0 < cut <= 100:
            return d[:cut]
        return (d[:100].rstrip() + "…") if len(d) > 100 else d

    def _full_block(self, name):
        data = self._tools[name]
        block = f"\n### {name}\n{data['description']}\n"
        if data["when_to_use"]:
            block += f"When: {data['when_to_use']}\n"
        block += f"Params: {json.dumps(data['params'])}\n"
        if data["output"]:
            block += f"Output: {data['output']}\n"
        return block

    def full_tool_block(self, name):
        """Public: the full schema block for ONE tool (used by expand_tools and
        the malformed-call error-injection path). Empty string if unknown."""
        return self._full_block(name) if name in self._tools else ""

    def group_full_blocks(self, group):
        """Full schema blocks for every tool in a group, concatenated."""
        return "".join(self._full_block(n) for n in self.tools_in_group(group))

    def get_tool_prompt(self, allowed_tools=None, active_groups=None, native=False):
        """
        Generates the system prompt segment listing available tools. Each full
        entry is compact — name, what it does, when to use it, params, output —
        with the call format stated ONCE up front.

        Progressive disclosure:
          * active_groups is None  -> LEGACY behavior: every tool rendered in
            full (used by isolated sub-agents/tests that want the whole surface).
          * active_groups is a set -> CORE tools + tools of any active domain
            group are rendered in full; every other domain tool is shown as a
            single catalog line under its toolset header. The model can call a
            catalog tool directly (it still executes) or expand_tools("<group>")
            to pull the full schemas in first.

        native=True -> a COMPACT name+summary index of EVERY tool (grouped), with
        NO JSON call-format header and NO param blocks: the authoritative schemas
        are delivered out-of-band in the request's `tools=` array, so repeating
        them as text only wastes context and contradicts the function-calling
        protocol. The index still lets the model choose tools and pick skills.

        allowed_tools (if given) still hard-filters the visible surface.
        """
        def visible(name):
            return allowed_tools is None or name in allowed_tools

        if native:
            prompt = (
                "AVAILABLE TOOLS (index)\n"
                "Call these through your function-calling interface — their full parameter schemas are provided "
                "there. This list is your index for choosing a tool or a skill; one tool call per turn.\n"
            )
            # Core tools first, then each domain toolset, as one-line entries.
            core = [n for n in self._tools if visible(n) and self.group_of(n) == CORE_GROUP]
            if core:
                prompt += "\n[core]:\n"
                for name in core:
                    prompt += f"  - {name} — {self._summary_line(name)}\n"
            for grp in self.domain_groups():
                names = [n for n in self.tools_in_group(grp) if visible(n)]
                if not names:
                    continue
                label = GROUP_LABELS.get(grp, grp)
                prompt += f"\n[{grp}] {label}:\n"
                for name in names:
                    prompt += f"  - {name} — {self._summary_line(name)}\n"
            prompt += "\nEND OF TOOL LIST.\n"
            return prompt

        prompt = (
            "AVAILABLE TOOLS\n"
            'Call ONE tool per turn as JSON: {"type":"tool_call","tool":"<name>","args":{...}}. '
            "Use only the args listed for that tool. Each full entry below is: name — what it does; "
            "When: when to pick it; Params: its arguments; Output: what you get back.\n"
        )

        if active_groups is None:
            for name in self._tools:
                if visible(name):
                    prompt += self._full_block(name)
            prompt += "\nEND OF TOOL LIST.\n"
            return prompt

        active = set(active_groups or ())
        catalog = {}  # group -> [names] for inactive domain groups
        for name in self._tools:
            if not visible(name):
                continue
            grp = self.group_of(name)
            if grp == CORE_GROUP or grp in active:
                prompt += self._full_block(name)
            else:
                catalog.setdefault(grp, []).append(name)

        if catalog:
            prompt += (
                "\n---\nON-DEMAND TOOLSETS — these tools exist and work; only their full\n"
                "parameters are hidden to save context. Call one directly and its toolset\n"
                "auto-expands next turn, or call expand_tools(\"<group>\") to see full params first.\n"
            )
            for grp in self.domain_groups():
                names = catalog.get(grp)
                if not names:
                    continue
                label = GROUP_LABELS.get(grp, grp)
                prompt += f"\n[{grp}] {label}:\n"
                for name in names:
                    prompt += f"  - {name} — {self._summary_line(name)}\n"

        prompt += "\nEND OF TOOL LIST.\n"
        return prompt

    def list_tools(self):
        """Returns a list of (name, description) for all registered tools."""
        return [(name, data["description"]) for name, data in self._tools.items()]

    @staticmethod
    def _validate_args(name, func, kwargs):
        """Check kwargs against func's real signature and return a clear, actionable
        error string if they don't fit — or None if they do.

        This is 'strict tool schemas' without a schema rewrite: the function
        signature IS the schema. It turns the two most common malformed-call
        failures — a hallucinated argument name, or a missing required one — from
        an opaque `TypeError: got an unexpected keyword argument` into a message
        that names the bad/missing args and lists the valid ones, so the model can
        self-correct on the next turn. Lenient for functions that accept **kwargs
        / *args (they legitimately take anything). Never raises."""
        try:
            params = inspect.signature(func).parameters
        except (TypeError, ValueError):
            return None
        accepts_var_kw = any(p.kind == p.VAR_KEYWORD for p in params.values())
        accepts_var_pos = any(p.kind == p.VAR_POSITIONAL for p in params.values())
        named = [n for n, p in params.items()
                 if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)]
        if not accepts_var_kw:
            unknown = [k for k in kwargs if k not in params]
            if unknown:
                return (
                    f"Tool '{name}' got unexpected argument(s): {', '.join(sorted(unknown))}. "
                    f"Valid arguments are: {', '.join(named) or '(none)'}. "
                    "Re-issue the call using only the listed arguments."
                )
        if not accepts_var_pos:
            required = [n for n, p in params.items()
                        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)
                        and p.default is inspect.Parameter.empty]
            missing = [r for r in required if r not in kwargs]
            if missing:
                return (
                    f"Tool '{name}' is missing required argument(s): {', '.join(missing)}. "
                    f"Required: {', '.join(required) or '(none)'}. "
                    f"Provided: {', '.join(kwargs) or '(none)'}."
                )
        return None

    def execute(self, name, kwargs):
        """Executes a registered tool by name with the given arguments."""
        if name not in self._tools:
            return {"error": f"Tool '{name}' not found. Please check the available tools."}

        if not isinstance(kwargs, dict):
            return {"error": (
                f"Tool '{name}' arguments must be a JSON object of named parameters, got "
                f"{type(kwargs).__name__}. Pass args like {{\"name\": value, ...}}."
            )}

        func = self._tools[name]["func"]
        arg_error = self._validate_args(name, func, kwargs)
        if arg_error:
            return {"error": arg_error}

        try:
            return func(**kwargs)
        except Exception as e:
            return {"error": f"Error executing tool '{name}': {str(e)}"}


# Global registry instance
registry = ToolRegistry()
