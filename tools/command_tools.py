"""Command tools — let the LLM discover and run plugin-contributed WORKFLOWS.

A command is a named, multi-step workflow a plugin ships under commands/<name>.md
(frontmatter + Markdown body). Where a skill is a focused technique, a command is a
broader end-to-end procedure that often orchestrates skills, subagents, and plan
steps (e.g. plan-feature: brainstorm -> architect -> plan_create -> execute).

Same progressive-disclosure model as skills: the base prompt shows only the command
INDEX (name + description, via PluginRegistry.get_commands_prompt); the full body is
pulled in on demand here. This is the model-facing half of the plugin command
system — the loader/registry half lives in plugins.py.

Note: distinct from the core `run_command` tool, which runs a shell command in the
shell. `use_command` loads a workflow's instructions; it executes nothing itself.
"""
import plugins


def _registry():
    # Lazy so importing this module never forces a plugin scan (matches skills_loader).
    return plugins.get_registry()


from tool_registry import registry


@registry.register(
    name="list_commands",
    description=(
        "Lists all available workflow COMMANDS contributed by enabled plugins, with their descriptions. "
        "A command is a proven, multi-step procedure (broader than a single skill — it may orchestrate "
        "skills, subagents, and plan steps end-to-end). Use this to discover which ready-made workflows "
        "exist before running one with use_command."
    ),
    params_schema={},
    output="One line per command: name and description. Load a command's full step-by-step body with use_command.",
    when_to_use="Call this when you want to check whether a ready-made workflow already covers the task at hand.",
    summary="list plugin-contributed multi-step workflow commands (load one with use_command)",
)
def list_commands():
    cmds = _registry().list_commands()
    if not cmds:
        return {"stdout": "No commands available."}
    lines = []
    for c in cmds:
        lines.append(f"Command: {c['name']}")
        lines.append(f"  Description: {c['description']}")
        lines.append(f"  Source plugin: {c.get('plugin', '?')}")
        lines.append("")
    return {"stdout": "\n".join(lines)}


@registry.register(
    name="use_command",
    description=(
        "Loads the full step-by-step body of a workflow COMMAND by name and returns it so you can follow the "
        "procedure. Commands are broader than skills: one command often chains several skills, delegates to "
        "subagents, and drives the plan. Reach for a command when the whole task matches its description — it "
        "is the fastest path through a proven end-to-end workflow. (This only loads instructions; it does not "
        "run anything. To run a shell command, use run_command instead.)"
    ),
    params_schema={"name": "string — the exact command name from list_commands / the AVAILABLE COMMANDS index (e.g. 'plan-feature', 're-triage', 'verify-work')."},
    output="The full Markdown body of the command — the workflow steps to follow. Any skills/subagents it names are loaded the usual way (use_skill / delegate) as the steps instruct.",
    when_to_use="Call this when the current task matches a command's description in the AVAILABLE COMMANDS index, then follow the returned steps in order.",
    summary="load one plugin workflow command's full step-by-step instructions",
)
def use_command(name):
    cmd = _registry().get_command(name)
    if cmd is None:
        available = ", ".join(c["name"] for c in _registry().list_commands()) or "(none)"
        return {"error": f"Command '{name}' not found. Available commands: {available}. Call list_commands to see all options."}
    out = f"=== Command: {name} ===\n{cmd['body']}"
    return {"stdout": out}
