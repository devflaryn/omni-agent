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
        Generates the system prompt segment that lists available tools with
        detailed, structured definitions: WHAT IT DOES, WHEN TO USE,
        PARAMETERS, and OUTPUT FORMAT.
        """
        prompt = "AVAILABLE TOOLS:\n"
        for name, data in self._tools.items():
            if allowed_tools is not None and name not in allowed_tools:
                continue

            prompt += f"\n### Tool: {name}\n"
            prompt += f"WHAT IT DOES: {data['description']}\n"
            if data["when_to_use"]:
                prompt += f"WHEN TO USE: {data['when_to_use']}\n"
            prompt += f"PARAMETERS (JSON): {json.dumps(data['params'])}\n"
            if data["output"]:
                prompt += f"OUTPUT: {data['output']}\n"
            prompt += f'To call this tool, output exactly: {{"type": "tool_call", "tool": "{name}", "args": <parameters>}}\n'

        prompt += "\nEND OF TOOL LIST.\n"
        return prompt

    def list_tools(self):
        """Returns a list of (name, description) for all registered tools."""
        return [(name, data["description"]) for name, data in self._tools.items()]

    def execute(self, name, kwargs):
        """Executes a registered tool by name with the given arguments."""
        if name not in self._tools:
            return {"error": f"Tool '{name}' not found. Please check the available tools."}

        try:
            return self._tools[name]["func"](**kwargs)
        except Exception as e:
            return {"error": f"Error executing tool '{name}': {str(e)}"}


# Global registry instance
registry = ToolRegistry()
