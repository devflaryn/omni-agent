"""Skill tools — let the LLM discover and load specialized skill instructions.

Three tools implement Claude-Code-style progressive disclosure over the
skills/ directory:
  - list_skills          : cheap index of every skill (name/description/when_to_use/resources)
  - use_skill             : loads one skill's full SKILL.md body
  - read_skill_resource   : loads one bundled reference/asset file for a skill, by exact path
"""
import os
from tool_registry import registry
from skills_loader import load_skills, get_skills_prompt


@registry.register(
    name="list_skills",
    description="Lists all available skills with their names, descriptions, when-to-use guidance, and any bundled resource files. Skills are specialized, detailed workflows (APK modding, native patching, signature bypass, SSL pinning bypass, anti-debug bypass, string deobfuscation, manifest/resource editing, dex/multidex handling, project scaffolding, code graph analysis). Use this to discover what skills exist and what supporting reference material they carry before loading one with use_skill.",
    params_schema={},
    output="One block per skill: name, description, when_to_use, and (if any) a list of bundled resource file paths that can be pulled in individually with read_skill_resource.",
    when_to_use="Call this if you are unsure which skills exist or which skill applies to the current task."
)
def list_skills():
    skills = load_skills()
    if not skills:
        return {"stdout": "No skills available."}
    lines = []
    for name, s in skills.items():
        lines.append(f"Skill: {name}")
        lines.append(f"  Description: {s['description']}")
        if s["when_to_use"]:
            lines.append(f"  When to use: {s['when_to_use']}")
        if s["resources"]:
            lines.append(f"  Bundled resources: {', '.join(s['resources'])}")
        lines.append("")
    return {"stdout": "\n".join(lines)}


@registry.register(
    name="use_skill",
    description="Loads the full instructions of a skill by name and returns them so you can follow the skill's workflow step by step. The skill instructions tell you exactly which tools to call, in what order, and which bundled resource files (if any) to pull in with read_skill_resource for deeper detail.",
    params_schema={"skill_name": "string (the exact skill name from list_skills, e.g. 'apk-modding', 'native-patching', 'signature-bypass', 'ssl-pinning-bypass', 'anti-debug-bypass', 'string-deobfuscation', 'manifest-resource-editing', 'dex-multidex-handling', 'project-scaffolding', 'code-graph-analysis')"},
    output="The full Markdown body of the skill's SKILL.md — step-by-step instructions and critical rules — plus, if the skill has bundled resource files, a list of their paths so you know what's available to pull in with read_skill_resource.",
    when_to_use="Call this when the task matches a skill's description. After reading the instructions, follow them step by step, calling the appropriate tools in the order the skill specifies, and pulling in bundled resources only when the instructions say to."
)
def use_skill(skill_name):
    skills = load_skills()
    if skill_name not in skills:
        available = ", ".join(skills.keys()) if skills else "(none)"
        return {"error": f"Skill '{skill_name}' not found. Available skills: {available}. Call list_skills to see all options."}
    skill = skills[skill_name]
    out = f"=== Skill: {skill_name} ===\n{skill['body']}"
    if skill["resources"]:
        out += f"\n\n=== Bundled resources for '{skill_name}' ===\n"
        out += "\n".join(f"- {r}" for r in skill["resources"])
        out += (
            f"\nLoad any of these with use tool read_skill_resource, args "
            f"{{\"skill_name\": \"{skill_name}\", \"resource_path\": <one of the paths above>}}, "
            "when the instructions above tell you to.\n"
        )
    return {"stdout": out}


@registry.register(
    name="read_skill_resource",
    description="Reads one bundled resource file (a reference doc, lookup table, search-pattern list, or template) that belongs to a specific skill. Skills keep deep-dive material out of their main SKILL.md to save context — use this to pull in a specific file only when the skill's instructions say you need it.",
    params_schema={
        "skill_name": "string (the skill this resource belongs to, e.g. 'native-patching')",
        "resource_path": "string (the relative path of the resource, exactly as listed by use_skill or list_skills, e.g. 'reference/arm64-opcodes.md')"
    },
    output="The full text content of the requested resource file, or an error if the skill or resource path doesn't exist.",
    when_to_use="Call this only after use_skill (or list_skills) has told you a specific resource file exists and is relevant — don't guess file paths."
)
def read_skill_resource(skill_name, resource_path):
    skills = load_skills()
    if skill_name not in skills:
        return {"error": f"Skill '{skill_name}' not found."}
    skill = skills[skill_name]
    if resource_path not in skill["resources"]:
        available = ", ".join(skill["resources"]) or "(none)"
        return {"error": f"Resource '{resource_path}' not found for skill '{skill_name}'. Available: {available}"}
    skill_dir = os.path.abspath(skill["dir"])
    full_path = os.path.abspath(os.path.join(skill_dir, resource_path))
    if os.path.commonpath([skill_dir, full_path]) != skill_dir:
        return {"error": "Invalid resource path."}
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        return {"error": f"Could not read resource: {e}"}
    return {"stdout": f"=== {skill_name}/{resource_path} ===\n{content}"}
