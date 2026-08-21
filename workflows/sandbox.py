"""Turning workflow SOURCE into something runnable.

Two problems this module exists to solve:

1. The agreed script form ends in `return {...}`, which is a SyntaxError at
   Python module level. Rather than ask authors to wrap everything in a function
   (and rather than rewrite indentation, which breaks on multi-line strings), the
   module body is lifted into a synthesized `def __workflow__():` at the AST
   level. `return` becomes legal and no source text is touched.

2. Resume replays cached agent results. A script that can produce different
   values on replay makes the journal a liar, so time/randomness are blocked and
   imports are whitelisted.

This is a CORRECTNESS boundary, not a security one. The agent already runs
arbitrary shell through host_exec; anyone reading this should not mistake it for
a sandbox that contains a hostile script.
"""
import ast

ALLOWED_IMPORTS = frozenset({"json", "math", "re", "itertools", "collections", "textwrap"})

# Blocked because they break replay determinism. The error names the fix.
BLOCKED_NAMES = frozenset({"time", "random", "datetime", "os", "sys", "secrets", "uuid"})

_META_REQUIRED = ("name", "description")

# A small, deliberate builtins surface. Everything a workflow legitimately needs
# for list/dict wrangling; nothing that touches the filesystem or the import
# system directly.
_SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "filter": filter, "float": float, "int": int,
    "isinstance": isinstance, "len": len, "list": list, "map": map, "max": max,
    "min": min, "range": range, "repr": repr, "reversed": reversed,
    "round": round, "set": set, "setattr": setattr, "sorted": sorted, "str": str,
    "sum": sum, "tuple": tuple, "zip": zip, "print": print,
    "True": True, "False": False, "None": None,
    "Exception": Exception, "ValueError": ValueError, "KeyError": KeyError,
    "TypeError": TypeError, "IndexError": IndexError,
}


class WorkflowScriptError(Exception):
    """An authoring fault. The message is fed back to the model verbatim, so it
    must say what is wrong AND what to do instead."""


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root in BLOCKED_NAMES:
        raise WorkflowScriptError(
            f"'{root}' is not available inside a workflow: replay-determinism "
            f"requires that a script produce the same values on resume. "
            f"Pass timestamps, random seeds, or paths in via `args` instead."
        )
    if root not in ALLOWED_IMPORTS:
        raise WorkflowScriptError(
            f"'{root}' is not importable inside a workflow. Allowed: "
            f"{', '.join(sorted(ALLOWED_IMPORTS))}. Do the work in a subagent "
            f"via agent(...) rather than in the orchestration script."
        )
    return __import__(name, globals, locals, fromlist, level)


def _parse(src):
    try:
        return ast.parse(src)
    except SyntaxError as e:
        raise WorkflowScriptError(
            f"workflow script has a syntax error on line {e.lineno}: {e.msg}"
        ) from e


def extract_meta(src):
    """Read the module-level `meta = {...}` literal WITHOUT running the script.

    It must be a pure literal: meta is read to render the progress UI and the
    library listing before a single statement executes, so it cannot depend on
    anything the script computes."""
    tree = _parse(src)
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "meta" for t in node.targets):
            continue
        try:
            meta = ast.literal_eval(node.value)
        except (ValueError, SyntaxError) as e:
            raise WorkflowScriptError(
                "`meta` must be a pure literal dict — no variables, function "
                "calls, comprehensions, or f-strings. It is read before the "
                "script runs."
            ) from e
        if not isinstance(meta, dict):
            raise WorkflowScriptError("`meta` must be a dict literal.")
        missing = [f for f in _META_REQUIRED if not meta.get(f)]
        if missing:
            raise WorkflowScriptError(
                f"`meta` is missing required field(s): {', '.join(missing)}. "
                f"Required: {', '.join(_META_REQUIRED)}."
            )
        return meta
    raise WorkflowScriptError(
        "workflow script must start with a `meta = {...}` literal containing at "
        "least `name` and `description`."
    )


def compile_workflow(src, filename="<workflow>"):
    """Compile `src` into a code object that defines `__workflow__()`.

    The module body (minus the `meta` assignment, which is already extracted) is
    lifted wholesale into a synthesized function so top-level `return` is legal."""
    tree = _parse(src)
    body = [n for n in tree.body
            if not (isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "meta"
                            for t in n.targets))]
    if not body:
        body = [ast.Return(value=ast.Constant(value=None))]

    fn = ast.FunctionDef(
        name="__workflow__",
        args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[],
                           kw_defaults=[], kwarg=None, defaults=[]),
        body=body, decorator_list=[], returns=None, type_params=[],
    )
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    try:
        return compile(module, filename, "exec")
    except SyntaxError as e:
        # e.g. `return` used somewhere the wrap cannot make legal.
        raise WorkflowScriptError(
            f"workflow script could not be compiled (line {e.lineno}): {e.msg}"
        ) from e


def make_namespace(primitives, args=None):
    """The globals a workflow script executes with: safe builtins, the guarded
    importer, the runtime primitives, and `args`."""
    builtins = dict(_SAFE_BUILTINS)
    builtins["__import__"] = _guarded_import
    ns = {"__builtins__": builtins, "args": args}
    ns.update(primitives)
    return ns
