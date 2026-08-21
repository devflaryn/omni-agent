"""Discovery for the built-in workflows.

The .py files here are SOURCES, never imported as modules — they are read as
text and run through the sandbox like any authored script. Keeping the .py
extension buys editor highlighting and nothing else."""
import os

from ..sandbox import WorkflowScriptError, extract_meta

_HERE = os.path.dirname(os.path.abspath(__file__))


def _source_files():
    for fn in sorted(os.listdir(_HERE)):
        if fn.endswith(".py") and fn != "__init__.py":
            yield os.path.join(_HERE, fn)


def list_workflows():
    out = []
    for path in _source_files():
        try:
            with open(path, "r", encoding="utf-8") as f:
                meta = extract_meta(f.read())
        except (OSError, WorkflowScriptError):
            continue
        out.append({"name": meta.get("name", ""),
                    "description": meta.get("description", ""),
                    "when_to_use": meta.get("when_to_use", ""),
                    # Surfaced so the launch form and the tool description can
                    # read declared arg names instead of parsing prose.
                    "args_schema": meta.get("args_schema") or {},
                    "file": path})
    return out


def load_source(name):
    for w in list_workflows():
        if w["name"] == name:
            with open(w["file"], "r", encoding="utf-8") as f:
                return f.read()
    known = ", ".join(sorted(w["name"] for w in list_workflows()))
    raise WorkflowScriptError(
        f"no workflow named '{name}'. Available: {known}")
