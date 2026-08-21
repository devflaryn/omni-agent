"""Mechanical hook-application verification.

The missing half of the learn-and-apply machine-check net. The Component 2
constraint gate proves *file-level* facts about a rebuilt APK ("no new .so",
"classes4.dex present"), but it CANNOT prove that the technique itself — the
recorded `hook_points` — was actually applied to the target. A build in which
the agent applied zero of N hooks (methods still present, but unedited, or a
hook silently skipped) sails through the constraint gate: file set unchanged,
so every file-level constraint passes while the technique is absent. That is the
exact "silently-wrong result" learn-and-apply exists to prevent.

This module closes that hole. Given the target's BASE decode dir and its EDITED
decode dir, it checks, for each recorded hook point, that:

  - the method is PRESENT in the edited tree (found by class+method NAME, so it
    survives apktool/APKEditor smali renumbering — same name-based discipline
    the apply phase uses), AND
  - its body actually CHANGED versus the base (an edit landed there), OR the
    class/method is NEWLY ADDED in the edited tree (a freshly injected hook).

A hook whose method is missing, or present-but-identical-to-base, FAILS — the
agent's claim that it applied the technique is contradicted by the bytes.

Pure module: operates on decoded smali trees on disk, no shell, no agent.py
coupling — offline-testable with tiny fixtures, exactly like `constraints.py`
and `learned_technique.py`."""
import os

from tool_registry import registry
from tools import learned_technique as _lt


# --- smali name/path handling ------------------------------------------------

def _class_to_suffix(class_name):
    """Normalize a class reference to the '.../a/b/Foo.smali' path SUFFIX used to
    locate it, plus a bare-basename flag.

    Accepts smali form (`La/b/Foo;`), dotted (`a.b.Foo`), slashed (`a/b/Foo`),
    or a bare leaf (`Foo`). Returns (suffix, is_bare). For a fully-qualified name
    the suffix keeps the package path (so `a/b/Foo` and `x/Foo` never collide);
    a bare leaf matches any file basename `Foo.smali`."""
    s = (class_name or "").strip()
    if s.startswith("L") and s.endswith(";"):
        s = s[1:-1]
    s = s.replace(".", "/").strip("/")
    # An inner class `a/b/Foo$Bar` lives in `a/b/Foo$Bar.smali`, so keep '$'.
    if not s:
        return "", True
    is_bare = "/" not in s
    return s + ".smali", is_bare


def _find_smali_file(root, class_name):
    """Absolute path of the .smali file for `class_name` under `root`, or None.

    Path-suffix match (not exact join) so it finds the class wherever apktool
    landed it — `smali/`, `smali_classes2/`, `smali_classes4/`, … — without the
    caller knowing which dex it ended up in."""
    suffix, is_bare = _class_to_suffix(class_name)
    if not suffix:
        return None
    sep_suffix = os.sep + suffix.replace("/", os.sep)
    base = suffix.split("/")[-1]
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith(".smali"):
                continue
            full = os.path.join(dirpath, fn)
            if is_bare:
                if fn == base:
                    return full
            elif full.endswith(sep_suffix):
                return full
    return None


def _normalize_body(lines):
    """Collapse a method body to its semantically-meaningful lines so cosmetic
    deltas don't read as edits and real edits aren't masked.

    Drops `.line N` directives (line numbers renumber between builds), comments,
    `.local`/`.source`-style debug noise, and blank lines; trims each line."""
    out = []
    for ln in lines:
        t = ln.strip()
        if not t:
            continue
        if t.startswith("#"):
            continue
        if t.startswith(".line"):
            continue
        # apktool debug metadata that shifts without semantic change
        if t.startswith(".local ") or t.startswith(".end local") \
                or t.startswith(".restart local") or t.startswith(".prologue"):
            continue
        out.append(t)
    return "\n".join(out)


def _extract_method_bodies(text, method_name):
    """All normalized bodies of methods named `method_name` in a smali file.

    Matches the token immediately before '(' so overloads (same name, different
    signatures) are all captured; returns a list (one entry per overload)."""
    bodies = []
    lines = text.splitlines()
    i, n = 0, len(lines)
    while i < n:
        stripped = lines[i].strip()
        if stripped.startswith(".method "):
            head = stripped[len(".method "):]
            paren = head.find("(")
            name = head[:paren].split()[-1] if paren != -1 else ""
            if name == method_name:
                body = []
                i += 1
                while i < n and lines[i].strip() != ".end method":
                    body.append(lines[i])
                    i += 1
                bodies.append(_normalize_body(body))
        i += 1
    return bodies


def _method_signature(base_dir, output_dir, cls, method):
    """(base_bodies, output_bodies, base_present, output_present) for a method.

    Each *_bodies is the set of normalized overload bodies found for the method
    name in that tree; *_present is whether the CLASS FILE exists in that tree."""
    def bodies_for(root):
        path = _find_smali_file(root, cls)
        if not path:
            return None, set()
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            return path, set()
        return path, set(_extract_method_bodies(text, method))

    base_path, base_bodies = bodies_for(base_dir)
    out_path, out_bodies = bodies_for(output_dir)
    return base_bodies, out_bodies, base_path is not None, out_path is not None


def verify_hooks_applied(base_dir, output_dir, hook_points=None):
    """Check each hook point actually landed in `output_dir` vs `base_dir`.

    Returns a list of result dicts: {class, method, ok, status, detail} where
    status is one of: applied | added | missing-class | missing-method |
    unchanged. `applied`/`added` are the only PASS states."""
    if hook_points is None:
        tech = _lt.get_learned_technique()
        hook_points = (tech or {}).get("hook_points", []) if tech else []

    results = []
    for hp in hook_points:
        cls = hp.get("class", "")
        method = hp.get("method", "")
        base_bodies, out_bodies, base_cls, out_cls = _method_signature(
            base_dir, output_dir, cls, method)

        if not out_cls:
            status, ok, detail = ("missing-class", False,
                                  f"class {cls!r} not found in the edited tree")
        elif not out_bodies:
            status, ok, detail = ("missing-method", False,
                                  f"{cls}->{method} not present in the edited tree")
        elif not base_cls or not base_bodies:
            # Method (or its whole class) is new in the edited tree = injected hook.
            status, ok, detail = ("added", True,
                                  f"{cls}->{method} is newly added in the edited tree")
        elif out_bodies != base_bodies:
            status, ok, detail = ("applied", True,
                                  f"{cls}->{method} body differs from base (edit landed)")
        else:
            status, ok, detail = ("unchanged", False,
                                  f"{cls}->{method} is byte-identical to base — hook not applied")
        results.append({"class": cls, "method": method, "ok": ok,
                        "status": status, "detail": detail})
    return results


def format_hook_results(results):
    """Render hook-verification results for the report and model feedback."""
    if not results:
        return ("No hook points to verify (no learned technique recorded, or an "
                "empty hook_points list).")
    lines = []
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        lines.append(f"[{mark}] {r['class']}->{r['method']} "
                     f"({r['status']}) — {r['detail']}")
    failed = sum(1 for r in results if not r["ok"])
    lines.append(f"{len(results) - failed}/{len(results)} recorded hooks applied.")
    return "\n".join(lines)


def all_hooks_applied(results):
    return bool(results) and all(r["ok"] for r in results)


@registry.register(
    name="verify_hooks_applied",
    description=(
        "Mechanically verify that the modification technique you recorded with "
        "record_learned_technique was ACTUALLY applied to the target — the check "
        "the file-level constraint gate cannot do. For each recorded hook point "
        "it locates the method in the edited target tree BY NAME (surviving "
        "apktool/APKEditor smali renumbering) and confirms its body changed "
        "versus the base (an edit landed) or the method is newly injected. A hook "
        "whose method is missing, or present but byte-identical to the base, "
        "FAILS — proving you skipped or mis-applied it. Run this in the "
        "learn-and-apply verify phase, alongside the constraint gate, BEFORE the "
        "on-device test: it turns your recorded plan into a machine-checked "
        "post-condition instead of a checklist you are trusted to have walked."),
    params_schema={
        "base_dir": ("string — the target's BASE (unedited) apktool decode "
                     "directory, e.g. 'target_base_decompiled'."),
        "output_dir": ("string — the EDITED target apktool decode directory you "
                       "applied the hooks to, e.g. 'target_decompiled'."),
        "hook_points": ("array (optional) — hook points to check "
                        "[{class, method}, ...]. Omit to use the hook points from "
                        "the technique you recorded with record_learned_technique."),
    },
    output=("A PASS/FAIL line per recorded hook point (applied / added / "
            "missing-class / missing-method / unchanged) and an overall "
            "'N/M recorded hooks applied' tally."),
    when_to_use=(
        "In the learn-and-apply workflow's verify phase, after applying the hooks "
        "to the target and before (or with) recompile_apk — to prove every "
        "recorded hook actually landed, not just that no forbidden file appeared."),
)
def verify_hooks_applied_tool(base_dir=None, output_dir=None, hook_points=None):
    from tools.common import resolve_workspace_path
    if not base_dir or not output_dir:
        return {"error": ("verify_hooks_applied needs both 'base_dir' (the "
                          "target's unedited decode dir) and 'output_dir' (the "
                          "edited target decode dir).")}
    base = resolve_workspace_path(base_dir)
    out = resolve_workspace_path(output_dir)
    for label, path in (("base_dir", base), ("output_dir", out)):
        if not os.path.isdir(path):
            return {"error": f"{label} is not a directory: {path!r}"}

    tech = _lt.get_learned_technique()
    if hook_points is None and not tech:
        return {"error": ("No learned technique recorded and no hook_points "
                          "given — call record_learned_technique first, or pass "
                          "hook_points explicitly.")}
    results = verify_hooks_applied(base, out, hook_points)
    message = format_hook_results(results)
    return {"message": message, "all_applied": all_hooks_applied(results),
            "results": results}
