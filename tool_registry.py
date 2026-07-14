import inspect
import json


class ToolRegistry:
    def __init__(self):
        self._tools = {}

    def register(self, name, description, params_schema, output=None, when_to_use=None):
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
        """
        def decorator(func):
            self._tools[name] = {
                "description": description,
                "params": params_schema,
                "output": output or "",
                "when_to_use": when_to_use or "",
                "func": func
            }
            return func
        return decorator

    def get_tool_prompt(self, allowed_tools=None):
        """
        Generates the system prompt segment listing available tools. Each entry
        is compact — name, what it does, when to use it, params and output — with
        the call format stated ONCE up front instead of repeated per tool (that
        repetition was pure token overhead and, on smaller models, noise that
        encouraged malformed calls).
        """
        prompt = (
            "AVAILABLE TOOLS\n"
            'Call ONE tool per turn as JSON: {"type":"tool_call","tool":"<name>","args":{...}}. '
            "Use only the args listed for that tool. Each entry below is: name — what it does; "
            "When: when to pick it; Params: its arguments; Output: what you get back.\n"
        )
        for name, data in self._tools.items():
            if allowed_tools is not None and name not in allowed_tools:
                continue

            prompt += f"\n### {name}\n{data['description']}\n"
            if data["when_to_use"]:
                prompt += f"When: {data['when_to_use']}\n"
            prompt += f"Params: {json.dumps(data['params'])}\n"
            if data["output"]:
                prompt += f"Output: {data['output']}\n"

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
