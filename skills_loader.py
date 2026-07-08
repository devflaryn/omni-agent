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


def load_skills():
    """Load all skills from ./skills/<name>/SKILL.md.

    Returns a dict: {skill_name: {"name", "description", "when_to_use",
    "allowed_tools", "body", "dir", "resources"}}.
    """
    skills = {}
    if not os.path.isdir(SKILLS_DIR):
        return skills
    for entry in sorted(os.listdir(SKILLS_DIR)):
        skill_dir = os.path.join(SKILLS_DIR, entry)
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
        "index is all you need to choose). A skill's own instructions say when to pull a bundled "
        "resource via read_skill_resource — don't guess a resource's contents.\n"
    )
    for name, s in skills.items():
        prompt += f"\n### {name}\n{s['description']}\n"
        if s["when_to_use"]:
            prompt += f"When: {s['when_to_use']}\n"
        if s["resources"]:
            prompt += f"Resources: {', '.join(s['resources'])}\n"
    prompt += "\nEND OF SKILL LIST.\n"
    return prompt
