"""Plugin system — Claude-Code-style capability bundles.

A plugin is a self-contained directory under ./plugins/<name>/ that can contribute
any mix of:

    plugins/<name>/
      plugin.json          (required) {name, version, description, enabled?}
      agents/<agent>.md    subagent personas (frontmatter + Markdown body)
      skills/<skill>/SKILL.md   more skills (registered as an extra skills root)
      commands/<cmd>.md    named workflow prompts (frontmatter + body)
      hooks/hooks.json     lifecycle hooks {event: ["file.py:func", ...]}

This mirrors how Claude Code plugins package agents / skills / commands / hooks,
and it is the mechanism the user asked for: capability is DISCOVERED from disk and
DECLARED, not hard-coded into the 112-tool registry. The subagent engine
(subagents.py) executes the agent personas a plugin declares; delegation (Phase 4)
dispatches to them by name.

Loading is dependency-light and never raises for a single bad plugin — a broken
manifest/agent is skipped with the error captured in `.issues`, so one malformed
plugin can't take the app down. Enable/disable is driven by llm_config.json's
"plugins" map (default: every discovered plugin enabled).
"""
import importlib.util
import json
import os

import llm

from skills_loader import _parse_frontmatter, register_skill_root, clear_skill_roots
from subagents import AgentDef, DEFAULT_MAX_STEPS

PLUGINS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")

HOOK_EVENTS = ("pre_tool", "post_tool", "on_phase_change", "on_final_answer")


# --- small frontmatter coercions ---------------------------------------------

def _as_bool(val, default=False):
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def _as_float(val):
    try:
        return float(str(val).strip())
    except (TypeError, ValueError):
        return None


def _as_int(val, default):
    try:
        return int(str(val).strip())
    except (TypeError, ValueError):
        return default


def _as_list(val):
    if not val:
        return []
    return [t.strip() for t in str(val).replace(";", ",").split(",") if t.strip()]


# --- loaders -----------------------------------------------------------------

def _load_agent_md(path):
    """Parse one agents/<name>.md into a subagents.AgentDef."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    meta, body = _parse_frontmatter(text)
    name = meta.get("name") or os.path.splitext(os.path.basename(path))[0]
    return AgentDef(
        name=name,
        system_prompt=body,
        mode=meta.get("mode", "read"),
        description=meta.get("description", ""),
        toolsets=_as_list(meta.get("toolsets", "")),
        temperature=_as_float(meta.get("temperature")),
        max_steps=_as_int(meta.get("max_steps"), DEFAULT_MAX_STEPS),
        allow_optin_read=_as_bool(meta.get("allow_optin_read")),
        tier=meta.get("tier"),
        models=_as_list(meta.get("models", "")) or None,
        skills=_as_list(meta.get("skills", "")) or None,
    )


def _load_commands(cmd_dir):
    """Parse commands/<name>.md files into {name: {name, description, body, dir}}."""
    commands = {}
    for entry in sorted(os.listdir(cmd_dir)):
        if not entry.lower().endswith(".md"):
            continue
        path = os.path.join(cmd_dir, entry)
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        meta, body = _parse_frontmatter(text)
        name = meta.get("name") or os.path.splitext(entry)[0]
        commands[name] = {"name": name, "description": meta.get("description", ""),
                          "body": body, "path": path}
    return commands


def _resolve_hook_callable(hooks_dir, ref):
    """Resolve a hook reference 'file.py:func' (relative to hooks_dir) to a callable.
    Loads the file as an isolated module so plugin dirs need not be on sys.path."""
    if ":" not in ref:
        return None
    fname, func = ref.split(":", 1)
    path = os.path.join(hooks_dir, fname)
    if not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location(
        f"_plugin_hook_{abs(hash(path))}", path)
    if not spec or not spec.loader:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, func.strip(), None)


def _load_hooks(hooks_dir):
    """Parse hooks/hooks.json into {event: [callables]}."""
    manifest = os.path.join(hooks_dir, "hooks.json")
    hooks = {}
    if not os.path.isfile(manifest):
        return hooks
    try:
        with open(manifest, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return hooks
    for event, refs in (data or {}).items():
        if event not in HOOK_EVENTS:
            continue
        for ref in (refs if isinstance(refs, list) else [refs]):
            fn = _resolve_hook_callable(hooks_dir, str(ref))
            if fn:
                hooks.setdefault(event, []).append(fn)
    return hooks


class Plugin:
    def __init__(self, name, version, description, directory, enabled=True):
        self.name = name
        self.version = version
        self.description = description
        self.directory = directory
        self.enabled = enabled
        self.agents = {}      # name -> AgentDef
        self.commands = {}    # name -> dict
        self.hooks = {}       # event -> [callables]
        self.skills_dir = None
        self.issues = []      # authoring problems, surfaced not raised


def load_plugin(plugin_dir):
    """Load one plugin directory into a Plugin, or return None if it has no valid
    manifest. Individual bad sub-parts are captured in Plugin.issues, not raised."""
    manifest_path = os.path.join(plugin_dir, "plugin.json")
    if not os.path.isfile(manifest_path):
        return None
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        p = Plugin(os.path.basename(plugin_dir), "?", "", plugin_dir, enabled=False)
        p.issues.append(f"invalid plugin.json: {e}")
        return p

    name = manifest.get("name") or os.path.basename(plugin_dir)
    plugin = Plugin(name, manifest.get("version", "0"), manifest.get("description", ""),
                    plugin_dir, enabled=manifest.get("enabled", True))

    agents_dir = os.path.join(plugin_dir, "agents")
    if os.path.isdir(agents_dir):
        for entry in sorted(os.listdir(agents_dir)):
            if not entry.lower().endswith(".md"):
                continue
            try:
                ad = _load_agent_md(os.path.join(agents_dir, entry))
                plugin.agents[ad.name] = ad
            except Exception as e:
                plugin.issues.append(f"agent '{entry}' failed to load: {e}")

    cmd_dir = os.path.join(plugin_dir, "commands")
    if os.path.isdir(cmd_dir):
        try:
            plugin.commands = _load_commands(cmd_dir)
            for cdef in plugin.commands.values():
                cdef["plugin"] = plugin.name  # attribute each command to its source plugin
        except Exception as e:
            plugin.issues.append(f"commands failed to load: {e}")

    hooks_dir = os.path.join(plugin_dir, "hooks")
    if os.path.isdir(hooks_dir):
        try:
            plugin.hooks = _load_hooks(hooks_dir)
        except Exception as e:
            plugin.issues.append(f"hooks failed to load: {e}")

    skills_dir = os.path.join(plugin_dir, "skills")
    if os.path.isdir(skills_dir):
        plugin.skills_dir = skills_dir

    return plugin


class PluginRegistry:
    """Aggregated view of all loaded plugins: agents, commands, hooks."""

    def __init__(self):
        self.plugins = {}     # name -> Plugin (enabled + disabled, for introspection)
        self.agents = {}      # agent name -> AgentDef (from enabled plugins only)
        self.commands = {}    # command name -> dict
        self.hooks = {}       # event -> [callables]

    def get_agent(self, name):
        return self.agents.get(name)

    def list_agents(self):
        return sorted(self.agents.values(), key=lambda a: a.name)

    def run_hook(self, event, context):
        """Fire every callable registered for `event` with `context`. Never raises;
        returns the list of non-None results (a hook may return an advisory dict)."""
        results = []
        for fn in self.hooks.get(event, []):
            try:
                r = fn(context)
                if r is not None:
                    results.append(r)
            except Exception as e:
                results.append({"hook_error": str(e)})
        return results

    def get_agents_prompt(self):
        """System-prompt segment describing the delegatable subagents, so the
        planner can target them with a plan step's `delegate` field (Phase 4).
        Each agent shows its DEFAULT cost tier, and the live model ladder is
        appended so the model can pick a cheaper rung per dispatch without any
        hardcoded model names in this file."""
        if not self.agents:
            return ""
        lines = ["\nAVAILABLE SUBAGENTS (delegation targets)",
                 ("Delegate a bounded sub-task to one of these by tagging a plan step with "
                  "delegate=\"<name>\" (or delegate=\"<name>@<tier>\" to pick the model tier; or via "
                  "dispatch_agents for a parallel wave). Each runs in its OWN isolated context and returns "
                  "only a distilled report — keeping this conversation lean. READ agents can run in "
                  "parallel; WRITE agents run one at a time.\n")]
        for a in self.list_agents():
            ts = f" [toolsets: {', '.join(sorted(a.toolsets))}]" if a.toolsets else ""
            tier = f" [tier: {a.tier}]" if getattr(a, "tier", None) else ""
            lines.append(f"- {a.name} ({a.mode}){ts}{tier}: {a.description}")
        ladder = llm.model_ladder()
        if ladder:
            lines.append("\nMODEL LADDER (cost spine — most expensive first). Pick the CHEAPEST rung "
                         "that can actually do the job:")
            for e in ladder:
                lines.append(f"  {e['rung']}. {e['model']} — tier: {e['tier']}")
        lines.append("END OF SUBAGENTS.\n")
        return "\n".join(lines)

    # --- commands ------------------------------------------------------------

    def get_command(self, name):
        return self.commands.get(name)

    def list_commands(self):
        return sorted(self.commands.values(), key=lambda c: c["name"])

    def get_commands_prompt(self):
        """System-prompt segment listing invokable workflow COMMANDS a plugin
        contributes. Like skills, only the index (name + description) is shown;
        the full multi-step body loads on demand via the use_command tool, so
        adding commands never bloats the base prompt."""
        if not self.commands:
            return ""
        lines = ["\nAVAILABLE COMMANDS (named workflows)",
                 ('A command is a battle-tested, multi-step WORKFLOW (broader than a single skill — it may '
                  'orchestrate skills, subagents, and plan steps). Load one with {"type":"tool_call",'
                  '"tool":"use_command","args":{"name":"<name>"}} and follow its steps. Use a command when the '
                  "task matches its description; it is the fastest way to run a proven end-to-end procedure.\n")]
        for c in self.list_commands():
            lines.append(f"- {c['name']}: {c['description']}")
        lines.append("END OF COMMANDS.\n")
        return "\n".join(lines)

    def has_hooks(self, event=None):
        """True if any enabled plugin registered a hook (optionally for `event`).
        Lets the runtime skip all hook machinery with zero overhead when none exist."""
        if event is None:
            return any(self.hooks.values())
        return bool(self.hooks.get(event))


def _read_plugin_config():
    """The {name: {enabled: bool}} map from llm_config.json, or {} if absent."""
    cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "llm_config.json")
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            return (json.load(f) or {}).get("plugins", {}) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def load_plugins(config=None):
    """Discover and load every plugin under PLUGINS_DIR into a PluginRegistry.

    `config` (or llm_config.json's "plugins") is a {name: {"enabled": bool}} map;
    a plugin is included only if not explicitly disabled. Registers each enabled
    plugin's skills/ dir as an extra skills root (clearing prior ones first, so a
    reload is clean)."""
    if config is None:
        config = _read_plugin_config()
    reg = PluginRegistry()
    clear_skill_roots()

    if not os.path.isdir(PLUGINS_DIR):
        return reg

    for entry in sorted(os.listdir(PLUGINS_DIR)):
        plugin_dir = os.path.join(PLUGINS_DIR, entry)
        if not os.path.isdir(plugin_dir):
            continue
        plugin = load_plugin(plugin_dir)
        if plugin is None:
            continue
        override = config.get(plugin.name, {})
        if isinstance(override, dict) and "enabled" in override:
            plugin.enabled = bool(override["enabled"])
        reg.plugins[plugin.name] = plugin
        if not plugin.enabled:
            continue
        for aname, adef in plugin.agents.items():
            reg.agents[aname] = adef
        for cname, cdef in plugin.commands.items():
            reg.commands[cname] = cdef
        for event, fns in plugin.hooks.items():
            reg.hooks.setdefault(event, []).extend(fns)
        if plugin.skills_dir:
            register_skill_root(plugin.skills_dir)

    return reg


# --- module-level active registry (lazy) -------------------------------------
_ACTIVE = None


def get_registry(reload=False):
    """The process-wide PluginRegistry, loaded once (pass reload=True to rescan)."""
    global _ACTIVE
    if _ACTIVE is None or reload:
        _ACTIVE = load_plugins()
    return _ACTIVE


def get_agent(name):
    return get_registry().get_agent(name)


def list_agents():
    return get_registry().list_agents()


def get_command(name):
    return get_registry().get_command(name)


def list_commands():
    return get_registry().list_commands()


def has_hooks(event=None):
    return get_registry().has_hooks(event)


def run_hook(event, context):
    return get_registry().run_hook(event, context)
