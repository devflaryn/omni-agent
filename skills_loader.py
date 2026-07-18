"""Skills system — loadable, specialized instruction sets, Claude-Code style.

Each skill lives in its own directory under ./skills/<skill-name>/ containing:
  - SKILL.md          (required) YAML-ish frontmatter + Markdown instructions
  - reference/*.md    (optional) deep-dive docs (lookup tables, pattern lists)
  - assets/*          (optional) templates/snippets the instructions point to

This mirrors Claude Code's skill model — progressive disclosure. The LLM only
ever sees a lightweight index (name + description + when_to_use + the names
of any bundled resource files) in the system prompt. It must explicitly call
use_skill to pull in a skill's full SKILL.md body, and read_skill_resource to
pull in any one bundled file, only when the task actually needs that level of
detail. This keeps the base system prompt small no matter how many skills or
how much reference material exists.
"""
import os

SKILLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")

# Additional skill roots contributed by enabled plugins (plugins.py registers each
# plugin's skills/ dir here on load). load_skills() scans SKILLS_DIR + these, so
# the base first-party skills stay put and plugins layer more on top without moving
# anything. Ordered; a later root with the same skill name wins (plugin override).
_EXTRA_ROOTS = []


def register_skill_root(path):
    """Add a plugin's skills/ directory to the scan set (idempotent)."""
    if path and os.path.isdir(path) and path not in _EXTRA_ROOTS:
        _EXTRA_ROOTS.append(path)


def clear_skill_roots():
    """Drop all plugin skill roots (called before a plugin reload)."""
    _EXTRA_ROOTS.clear()


def skill_roots():
    """Every directory load_skills() scans, base first then plugin roots in order."""
    return [SKILLS_DIR] + list(_EXTRA_ROOTS)


def _parse_frontmatter(text):
    """Parse simple YAML-like frontmatter delimited by --- lines."""
    meta = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                if ":" in line:
                    key, _, val = line.partition(":")
                    meta[key.strip()] = val.strip()
            body = parts[2].strip()
    return meta, body


def _discover_resources(skill_dir):
    """List every file in a skill's directory except SKILL.md itself, as
    paths relative to the skill directory (forward-slash separated, so they
    look the same on Windows and Linux)."""
    resources = []
    for root, _dirs, files in os.walk(skill_dir):
        for fname in files:
            if root == skill_dir and fname.upper() == "SKILL.MD":
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, skill_dir).replace(os.sep, "/")
            resources.append(rel)
    return sorted(resources)


def _registry():
    """Lazily fetch the global tool registry + its CORE group name.

    Imported lazily (not at module top) so skills_loader stays usable in
    isolation — e.g. an offline test that never imports the tool modules — and
    so import order never matters: by the time the base prompt is built every
    tool is already registered. Returns (None, None) if the registry can't be
    imported yet."""
    try:
        from tool_registry import registry, CORE_GROUP
        return registry, CORE_GROUP
    except Exception:
        return None, None


def skill_toolsets(allowed_tools):
    """The on-demand toolset groups a skill's allowed-tools belong to, in a
    stable first-seen order (core tools contribute nothing).

    This is the bridge between skills and progressive tool disclosure: loading a
    skill should bring EXACTLY these toolsets online, so every tool the skill
    tells you to call arrives with its full parameter schema instead of a
    one-line catalog entry you'd have to guess against. Empty if the registry
    isn't importable or the skill only uses always-on core tools."""
    reg, core = _registry()
    if reg is None:
        return []
    seen = []
    for t in allowed_tools:
        g = reg.group_of(t)
        if g and g != core and g not in seen:
            seen.append(g)
    return seen


def skill_tool_issues(allowed_tools):
    """allowed-tools that don't resolve to a registered tool — a skill-authoring
    bug (a typo, or a tool that was renamed/removed). Empty if the registry
    isn't importable. Surfaced when a skill is loaded so it gets fixed rather
    than silently doing nothing."""
    reg, _core = _registry()
    if reg is None:
        return []
    return [t for t in allowed_tools if not reg.is_registered(t)]


def load_skills():
    """Load all skills from every skill root (./skills plus any plugin skills/).

    Returns a dict: {skill_name: {"name", "description", "when_to_use",
    "allowed_tools", "body", "dir", "resources", "source"}}. Roots are scanned in
    order, so a plugin skill with the same name as a base skill overrides it.
    """
    skills = {}
    for root in skill_roots():
        if not os.path.isdir(root):
            continue
        for entry in sorted(os.listdir(root)):
            skill_dir = os.path.join(root, entry)
            if not os.path.isdir(skill_dir):
                continue
            skill_md = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(skill_md):
                continue
            try:
                with open(skill_md, "r", encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                continue
            meta, body = _parse_frontmatter(text)
            name = meta.get("name", entry)
            allowed_tools = [t.strip() for t in meta.get("allowed-tools", "").split(",") if t.strip()]
            skills[name] = {
                "name": name,
                "description": meta.get("description", ""),
                "when_to_use": meta.get("when_to_use", ""),
                "allowed_tools": allowed_tools,
                "body": body,
                "dir": skill_dir,
                "resources": _discover_resources(skill_dir),
                "source": os.path.basename(os.path.dirname(root)) if root != SKILLS_DIR else "base",
            }
    return skills


def get_skills_prompt():
    """Generate the system-prompt segment listing available skills.

    Only the index (name/description/when_to_use/resource filenames) is
    shown here — full SKILL.md bodies and resource file contents are loaded
    on demand via the use_skill / read_skill_resource tools, so adding more
    skills or thicker reference material never bloats the base prompt.
    """
    skills = load_skills()
    if not skills:
        return ""
    prompt = "\nAVAILABLE SKILLS\n"
    prompt += (
        "Skills are detailed, battle-tested workflows under ./skills/. When a task matches a "
        'skill\'s "When" line, load it with {"type":"tool_call","tool":"use_skill","args":'
        '{"skill_name":"<name>"}} and follow its steps. Only load the ONE skill that fits (this '
        "index is all you need to choose). Loading a skill ALSO brings its \"Toolsets\" online — "
        "their full parameter schemas fold into your live tool list on the next turn — so after "
        "use_skill you can call the exact tools the skill names without expand_tools or guessing "
        "arguments. A skill's own instructions say when to pull a bundled resource via "
        "read_skill_resource — don't guess a resource's contents.\n"
    )
    for name, s in skills.items():
        prompt += f"\n### {name}\n{s['description']}\n"
        if s["when_to_use"]:
            prompt += f"When: {s['when_to_use']}\n"
        toolsets = skill_toolsets(s["allowed_tools"])
        if toolsets:
            prompt += f"Toolsets: {', '.join(toolsets)} (auto-loaded on use_skill)\n"
        if s["resources"]:
            prompt += f"Resources: {', '.join(s['resources'])}\n"
    prompt += "\nEND OF SKILL LIST.\n"
    return prompt
