"""Machine-checked build constraints.

The vocabulary is deliberately app-agnostic: this module knows how to check a
stated constraint, never which constraints a given app needs. Domain knowledge
("this app needs classes4.dex") lives in the user's mission prompt.

fnmatch note: `*` matches `/`, so `*.so` matches `lib/arm64-v8a/libfoo.so`.
`**` is NOT fnmatch syntax."""
import fnmatch
import zipfile

KINDS = ("file_present", "file_absent", "no_new_files_matching",
         "file_set_unchanged", "file_unmodified")


def apk_members(path):
    """Sorted list of member names in an APK/zip."""
    with zipfile.ZipFile(path) as z:
        return sorted(i.filename for i in z.infolist())


def _matching(members, pattern):
    return {m for m in members if fnmatch.fnmatch(m, pattern)}


def evaluate(constraints, base_members, output_members):
    """Check each constraint against base vs output member lists."""
    results = []
    for c in constraints:
        kind = c.get("kind")
        pat = c.get("pattern", "")
        ok, detail = False, ""
        if kind == "file_present":
            ok = bool(_matching(output_members, pat))
            detail = "" if ok else f"no output member matches {pat!r}"
        elif kind == "file_absent":
            hits = sorted(_matching(output_members, pat))
            ok = not hits
            detail = "" if ok else f"present in output: {hits[:5]}"
        elif kind == "no_new_files_matching":
            new = sorted(_matching(output_members, pat)
                         - _matching(base_members, pat))
            ok = not new
            detail = "" if ok else f"added since base: {new}"
        elif kind == "file_set_unchanged":
            b = _matching(base_members, pat)
            o = _matching(output_members, pat)
            ok = b == o
            if not ok:
                detail = f"added: {sorted(o - b)} removed: {sorted(b - o)}"
        elif kind == "file_unmodified":
            in_base = pat in set(base_members)
            in_out = pat in set(output_members)
            ok = in_base and in_out
            if not ok:
                detail = f"{pat!r} in base={in_base} in output={in_out}"
        else:
            detail = f"unknown constraint kind {kind!r}; expected one of {KINDS}"
        results.append({"kind": kind, "pattern": pat, "ok": ok, "detail": detail})
    return results


def format_results(results):
    """Render results for the run report and for model feedback."""
    if not results:
        return "No constraints were declared for this mission."
    lines = []
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        line = f"[{mark}] {r['kind']}({r['pattern']!r})"
        if r["detail"]:
            line += f" — {r['detail']}"
        lines.append(line)
    failed = sum(1 for r in results if not r["ok"])
    lines.append(f"{len(results) - failed}/{len(results)} constraints satisfied.")
    return "\n".join(lines)


def all_passed(results):
    return all(r["ok"] for r in results)
