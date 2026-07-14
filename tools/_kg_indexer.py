#!/usr/bin/env python3
"""Code knowledge-graph indexer (runs INSIDE the Docker sandbox).

Usage:
    python3 _kg_indexer.py <root_dir> <include_so:0|1> <force:0|1> [graph_id]

Walks <root_dir> for *.smali files and builds a compact, queryable graph:
  - classes  : class descriptor -> {file, super, interfaces, fields, methods}
  - methods  : each method records its start line, callees, and string refs
  - callers  : reverse index  callee -> [caller method refs]
  - subclasses: super -> [sub class descriptors]
  - string_refs: every const-string literal -> {string, holder, file, line}
  - so_symbols : every *.so -> {exports, imports} via nm

NAMED GRAPHS
------------
Every build lands in its own namespace under /workspace/.codegraph/<graph_id>/,
so several graphs can coexist without mixing — e.g. two versions of the same app
indexed separately for a diff. `graph_id` defaults (in the host wrapper) to a slug
of <root_dir>, so indexing `roblox_v1` and `roblox_v2` naturally yields two graphs.
A tiny /workspace/.codegraph/graphs.json index lists every built graph.

Each namespace holds SMALL CHUNKED JSON files (no single 100MB monolith):

  meta.json          — summary stats (tiny)
  manifest.json      — file tracking + shard index (tiny)
  classes_XX.json    — class descriptors sharded by prefix (each small)
  callers.json       — reverse call index
  subclasses.json    — super -> subclasses index
  string_refs_NN.json— string references sharded into fixed-size chunks
  so_symbols.json    — native .so symbol tables

A fresh build is skipped (unless force=1) when the cached manifest is newer
than the newest smali file. It prints a short summary only — never the source.
"""
import os
import re
import sys
import json
import time
import subprocess

# Base workspace path. Overridable via env ONLY so the indexer/query pair can be
# unit-tested against a temp dir on the host; inside the sandbox it stays
# /workspace (the env var is never set there).
WORKSPACE = os.environ.get("CODEGRAPH_WORKSPACE", "/workspace")
GRAPH_ROOT = os.path.join(WORKSPACE, ".codegraph")
GRAPH_INDEX_PATH = os.path.join(GRAPH_ROOT, "graphs.json")

# Max string-ref entries per shard file.
STRING_REFS_SHARD_SIZE = 20000


def _sanitize_graph_id(gid):
    """A graph id becomes a directory name under .codegraph/, so keep it a safe
    slug and never let it escape the graph root (strip path segments, '..', etc.)."""
    gid = (gid or "").strip().replace("\\", "/")
    gid = gid.split("/")[-1]                       # defeat any path traversal
    gid = re.sub(r"[^A-Za-z0-9._-]+", "_", gid)
    gid = gid.strip("._-")
    return gid[:64] or "default"


def _fs_path(path):
    r"""Return a filesystem path safe to open/create even when it exceeds the
    260-char MAX_PATH limit.

    On Windows, deeply nested decompiled trees (e.g. smali under long
    com/google/... packages) routinely blow past MAX_PATH; unless the host has
    long-path support turned on, os.walk/open then fail and the whole build
    dies. Prefixing an absolute path with the extended-length marker (\\?\)
    lifts that limit regardless of the OS setting. No-op on POSIX (the Docker
    sandbox) and for paths that are already prefixed."""
    if os.name != "nt" or not path:
        return path
    if path.startswith("\\\\?\\"):
        return path
    ap = os.path.abspath(path)
    if ap.startswith("\\\\"):            # UNC \\server\share -> \\?\UNC\server\share
        return "\\\\?\\UNC\\" + ap[2:]
    return "\\\\?\\" + ap


def _strip_ext_prefix(p):
    r"""Drop a Windows extended-length prefix from an already slash-normalized
    path (\\?\ becomes //?/ after replacing backslashes), so stripped
    descriptors stay clean and comparable to WORKSPACE."""
    if p.startswith("//?/UNC/"):
        return "//" + p[len("//?/UNC/"):]
    if p.startswith("//?/"):
        return p[len("//?/"):]
    return p


def strip_workspace(path):
    # Normalize to forward slashes so descriptors/shard keys are separator-stable
    # regardless of host OS (the sandbox is Linux; host unit tests run on Windows).
    # Also drop any extended-length prefix so a \\?\-walked path still matches
    # the (unprefixed) WORKSPACE root.
    path = _strip_ext_prefix(path.replace("\\", "/"))
    base = _strip_ext_prefix(WORKSPACE.replace("\\", "/").rstrip("/"))
    if path == base:
        # The root IS the workspace itself (a whole-workspace build) — record it
        # as "." rather than the full absolute path, so the graph index / UI
        # selector reads cleanly instead of showing a giant host path.
        return "."
    prefix = base + "/"
    if path.startswith(prefix):
        return path[len(prefix):]
    return path


def _shard_key(descriptor):
    """Map a class descriptor to a 2-char shard key based on its package prefix.

    e.g. 'Lcom/foo/Bar;' -> 'co', 'Lorg/baz/Qux;' -> 'or', 'Lnet/...' -> 'ne'.
    Falls back to 'xx' for anything weird.
    """
    d = descriptor.lstrip("L[").rstrip(";")
    parts = d.split("/")
    if len(parts) >= 2:
        pkg = parts[0]
        if len(pkg) >= 2:
            return pkg[:2].lower()
        return (pkg + "x")[:2].lower()
    return "xx"


def _write_json(path, data):
    """Write JSON with compact separators to keep file sizes small."""
    tmp = path + ".tmp"
    with open(_fs_path(tmp), "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
    os.replace(_fs_path(tmp), _fs_path(path))


# --- Smali parsing (unchanged semantics, factored into a helper) -------------
INVOKE_RE = re.compile(
    r"invoke-(?:virtual|direct|static|super|interface)(?:/range)?\s+\{[^}]*\}\s*,\s*(\S+)"
)
CONSTSTR_RE = re.compile(r'const-string(?:/jumbo)?\s+v\d+,\s*"((?:[^"\\]|\\.)*)"')


def _parse_smali_file(path, rel, classes, calls, string_refs):
    """Parse one .smali file into class/method/call-edge/string-ref structures.

    Appends to the shared `classes` dict and the `calls` / `string_refs` lists.
    This is the exact original smali logic, just extracted so main() can dispatch
    smali and general-source files through their own parsers."""
    try:
        with open(_fs_path(path), encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except Exception:
        return

    cur_class = None
    cur_method = None
    cls_info = None

    for i, raw in enumerate(lines, start=1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue

        if s.startswith(".class"):
            cur_class = None
            cls_info = None
            parts = s.split()
            if parts:
                cur_class = parts[-1]
                cls_info = {
                    "file": rel,
                    "super": None,
                    "interfaces": [],
                    "fields": [],
                    "methods": {},
                }
                classes[cur_class] = cls_info
            continue

        if s.startswith(".super"):
            parts = s.split()
            if parts and cls_info is not None:
                cls_info["super"] = parts[-1]
            continue

        if s.startswith(".implements"):
            parts = s.split()
            if parts and cls_info is not None:
                cls_info["interfaces"].append(parts[-1])
            continue

        if s.startswith(".field"):
            left = s.split("=")[0]
            parts = left.split()
            if parts and cls_info is not None:
                cls_info["fields"].append(parts[-1])
            continue

        if s.startswith(".method"):
            parts = s.split()
            cur_method = None
            if parts and cls_info is not None:
                cur_method = parts[-1]
                cls_info["methods"][cur_method] = {
                    "line": i, "calls": [], "strings": []
                }
            continue

        if s == ".end method":
            cur_method = None
            continue

        m = INVOKE_RE.search(s)
        if m and cur_method is not None and cls_info is not None and cur_class is not None:
            tail = m.group(1)
            if "->" in tail:
                callee_cls, callee_meth = tail.split("->", 1)
                dst = "%s->%s" % (callee_cls, callee_meth)
                src = "%s->%s" % (cur_class, cur_method)
                cls_info["methods"][cur_method]["calls"].append(dst)
                calls.append({"src": src, "dst": dst, "file": rel, "line": i})
            continue

        m = CONSTSTR_RE.search(s)
        if m and cur_method is not None and cls_info is not None and cur_class is not None:
            st = m.group(1)
            cls_info["methods"][cur_method]["strings"].append(st)
            string_refs.append({
                "string": st,
                "holder": "%s->%s" % (cur_class, cur_method),
                "file": rel,
                "line": i,
            })


# --- General-language source parsing -----------------------------------------
# The graph is not only for decompiled smali: it also indexes ordinary source so
# the same "navigate, don't sweep" workflow works on ANY large codebase (a big
# Python/JS/Java/Go project, not just an APK). Parsing is PRECISION-FIRST — we
# skip ambiguous lines rather than emit noisy, wrong nodes.
#
# Each source file yields, in the SAME schema smali uses:
#   - a module node  (descriptor = the file's relative path)   holding top-level
#     functions as "methods";
#   - one class node (descriptor = "path::ClassName") per class/struct/interface,
#     holding its methods; `super`/`interfaces` capture inheritance where cheap.
# Method entries carry {line, calls, strings} exactly like smali, so every
# query_type (class/method/callers/callees/string_refs/hierarchy/search_classes)
# and the visualization work unchanged. Call edges are resolved by name after all
# files are parsed (a called name maps to a definition when it's unambiguous).
SOURCE_EXTS = {
    ".py": "python", ".pyw": "python",
    ".js": "brace", ".jsx": "brace", ".mjs": "brace", ".cjs": "brace",
    ".ts": "brace", ".tsx": "brace",
    ".java": "brace", ".kt": "brace", ".kts": "brace",
    ".go": "brace", ".rs": "brace", ".php": "brace",
    ".cs": "brace", ".swift": "brace", ".scala": "brace",
    ".c": "brace", ".h": "brace", ".cc": "brace", ".cpp": "brace",
    ".cxx": "brace", ".hpp": "brace", ".hh": "brace", ".hxx": "brace",
    ".m": "brace", ".mm": "brace",
    ".rb": "ruby",
}

# Directories never worth indexing (VCS, dependencies, build output, caches).
# Not applied to smali collection paths themselves — apktool output lives in its
# own dirs, none of which are named below.
_SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", ".codegraph", "node_modules", "bower_components",
    "__pycache__", ".venv", "venv", "env", ".mypy_cache", ".pytest_cache",
    ".tox", ".gradle", ".idea", ".vscode", "vendor", "site-packages",
    "dist", "build", "out", ".next", ".nuxt", "coverage", ".dart_tool",
    "Pods", "DerivedData",
})
# Skip minified/generated blobs and anything too large to be hand-written source
# (keeps a graph over a big repo focused on real code, not bundles).
_SOURCE_MAX_BYTES = 2_000_000


def _skip_source(full_path, fname):
    low = fname.lower()
    if low.endswith((".min.js", ".min.css", ".bundle.js", ".map", ".d.ts")):
        return True
    try:
        if os.path.getsize(_fs_path(full_path)) > _SOURCE_MAX_BYTES:
            return True
    except OSError:
        return True
    return False

# Keywords that look like a call "kw(" or a def "kw(...) {" but are control flow,
# never a function definition/call worth an edge.
_CTRL_KW = frozenset({
    "if", "for", "while", "switch", "catch", "return", "with", "else", "elif",
    "do", "when", "match", "case", "sizeof", "throw", "await", "yield", "and",
    "or", "not", "in", "is", "new", "delete", "typeof", "super", "assert",
    "print", "func", "def", "fn", "function", "var", "let", "const", "using",
    "namespace", "import", "from", "package", "public", "private", "protected",
    "static", "final", "override", "async", "class", "struct", "interface",
    "enum", "trait", "object", "def", "lambda", "go", "defer", "select",
})

_STRING_RE = re.compile(r'"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\'')
_CALL_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\(")

_PY_CLASS_RE = re.compile(r"^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:")
_PY_DEF_RE = re.compile(r"^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(")

_BRACE_CLASS_RE = re.compile(
    r"\b(?:class|interface|struct|trait|enum|object|protocol)\s+([A-Za-z_]\w*)"
    r"([^\{;]*)"
)
_GO_TYPE_RE = re.compile(r"\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b")
# A function/method: "name(args) {" — captures the name, requires the opening
# brace on the same line, and excludes control-flow keywords via _CTRL_KW.
_BRACE_FUNC_RE = re.compile(
    r"(?:^|[\s\*&~+\-])([A-Za-z_]\w*)\s*\([^;{}]*\)\s*"
    r"(?:->\s*[\w:<>,\.\*&\[\]\s]+)?"          # rust/php/cpp trailing return type
    r"(?:const\s*)?(?:noexcept\s*)?\{"
)
_RUBY_CLASS_RE = re.compile(r"^\s*(?:class|module)\s+([A-Za-z_][\w:]*)(?:\s*<\s*([A-Za-z_][\w:]*))?")
_RUBY_DEF_RE = re.compile(r"^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)")


def _mask_line(line, hash_comment):
    """Blank out string/char literal contents and strip line comments so brace
    counting and call/def regexes don't trip over `{` inside a string or a `//`
    comment. Returns the masked line (same length up to the comment cut)."""
    out = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if c in "\"'":
            quote = c
            out.append(" ")
            i += 1
            while i < n:
                if line[i] == "\\":
                    out.append("  ")
                    i += 2
                    continue
                if line[i] == quote:
                    out.append(" ")
                    i += 1
                    break
                out.append(" ")
                i += 1
            continue
        if c == "/" and i + 1 < n and line[i + 1] == "/":
            break
        if c == "/" and i + 1 < n and line[i + 1] == "*":
            break  # start of block comment — ignore rest of line (precision-first)
        if hash_comment and c == "#":
            break
        out.append(c)
        i += 1
    return "".join(out)


def _mask_brace_line(line, in_block):
    """Like _mask_line but for curly-brace languages, tracking MULTI-LINE block
    comments across calls so `{`/`}` inside a `/* ... */` (or inside a string)
    never corrupt brace-depth scoping. Returns (masked_line, still_in_block)."""
    out = []
    i, n = 0, len(line)
    while i < n:
        if in_block:
            end = line.find("*/", i)
            if end == -1:
                out.append(" " * (n - i))
                i = n
            else:
                out.append(" " * (end + 2 - i))
                i = end + 2
                in_block = False
            continue
        c = line[i]
        if c == "/" and i + 1 < n and line[i + 1] == "*":
            in_block = True
            out.append("  ")
            i += 2
            continue
        if c == "/" and i + 1 < n and line[i + 1] == "/":
            break  # rest of line is a // comment
        if c in "\"'":
            quote = c
            out.append(" ")
            i += 1
            while i < n:
                if line[i] == "\\":
                    out.append("  "); i += 2; continue
                if line[i] == quote:
                    out.append(" "); i += 1; break
                out.append(" "); i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out), in_block


def _extract_strings(line):
    vals = []
    for m in _STRING_RE.finditer(line):
        s = m.group(1) if m.group(1) is not None else m.group(2)
        if s:
            vals.append(s)
    return vals


def _extract_calls(masked):
    names = []
    for m in _CALL_RE.finditer(masked):
        name = m.group(1)
        if name not in _CTRL_KW:
            names.append(name)
    return names


def _ensure_class(classes, desc, rel, super_name=None, interfaces=None):
    c = classes.get(desc)
    if c is None:
        c = {"file": rel, "super": super_name,
             "interfaces": list(interfaces or []), "fields": [], "methods": {}}
        classes[desc] = c
    else:
        if super_name and not c.get("super"):
            c["super"] = super_name
        for it in (interfaces or []):
            if it not in c["interfaces"]:
                c["interfaces"].append(it)
    return c


def _add_method(cls, name, line):
    m = cls["methods"].get(name)
    if m is None:
        m = {"line": line, "calls": [], "strings": [], "_callnames": []}
        cls["methods"][name] = m
    return m


def _split_bases(raw):
    """Pull base/interface names out of the text after a class name
    ('extends A implements B, C', ': A, B', '(A, B)'). Returns (super, others)."""
    if not raw:
        return None, []
    raw = raw.strip()
    raw = re.sub(r"^[\(:]", " ", raw)
    raw = raw.replace("extends", " ").replace("implements", " ").replace(":", " ")
    raw = re.sub(r"<[^>]*>", "", raw)          # drop generic params
    raw = raw.replace(")", " ").replace("(", " ")
    names = [re.sub(r"[^\w.]", "", t) for t in re.split(r"[,\s]+", raw) if t.strip()]
    names = [n for n in names if n and not n[0].isdigit()]
    if not names:
        return None, []
    return names[0], names[1:]


def _parse_python(rel, lines, classes, source_methods, defindex, string_refs):
    stack = []  # {"type": "class"|"def", "name", "desc", "indent"}
    for i, raw in enumerate(lines, start=1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        while stack and indent <= stack[-1]["indent"]:
            stack.pop()

        mc = _PY_CLASS_RE.match(raw)
        if mc:
            cname = mc.group(2)
            enclosing = next((e for e in reversed(stack) if e["type"] == "class"), None)
            qual = (enclosing["name"] + "." + cname) if enclosing else cname
            desc = "%s::%s" % (rel, qual)
            sup, others = _split_bases(mc.group(3))
            _ensure_class(classes, desc, rel, sup, others)
            stack.append({"type": "class", "name": qual, "desc": desc, "indent": indent})
            continue

        md = _PY_DEF_RE.match(raw)
        if md:
            fname = md.group(2)
            enclosing = next((e for e in reversed(stack) if e["type"] == "class"), None)
            owner = enclosing["desc"] if enclosing else rel
            if owner == rel:
                _ensure_class(classes, rel, rel)
            _add_method(classes[owner], fname, i)
            source_methods.append((owner, fname))
            defindex.setdefault(fname, set()).add(owner)
            stack.append({"type": "def", "name": fname, "desc": owner, "indent": indent})
            continue

        cur = next((e for e in reversed(stack) if e["type"] == "def"), None)
        if cur is not None:
            mi = classes[cur["desc"]]["methods"][cur["name"]]
            for st in _extract_strings(raw):
                mi["strings"].append(st)
                string_refs.append({"string": st, "holder": "%s->%s" % (cur["desc"], cur["name"]),
                                    "file": rel, "line": i})
            masked = _mask_line(raw, hash_comment=True)
            mi["_callnames"].extend(_extract_calls(masked))


def _parse_braces(rel, lines, classes, source_methods, defindex, string_refs):
    stack = []          # {"type","name","desc","depth"}  depth = brace depth AT open
    depth = 0
    in_block = False    # inside a multi-line /* ... */ comment
    pending_class = None  # (super, others) waiting for its opening brace
    for i, raw in enumerate(lines, start=1):
        masked, in_block = _mask_brace_line(raw, in_block)

        # Class / struct / interface declaration (Go uses `type X struct`).
        mc = _BRACE_CLASS_RE.search(masked) or _GO_TYPE_RE.search(masked)
        if mc:
            cname = mc.group(1)
            sup, others = (None, [])
            if mc.re is _BRACE_CLASS_RE:
                sup, others = _split_bases(mc.group(2))
            desc = "%s::%s" % (rel, cname)
            _ensure_class(classes, desc, rel, sup, others)
            pending_class = desc

        # Function / method definition on this line.
        mf = _BRACE_FUNC_RE.search(masked)
        if mf and not mc:
            fname = mf.group(1)
            enclosing = next((e for e in reversed(stack) if e["type"] == "class"), None)
            owner = enclosing["desc"] if enclosing else rel
            if owner == rel:
                _ensure_class(classes, rel, rel)
            _add_method(classes[owner], fname, i)
            source_methods.append((owner, fname))
            defindex.setdefault(fname, set()).add(owner)

        # Attribute strings + calls to the innermost open function.
        cur = next((e for e in reversed(stack) if e["type"] == "def"), None)
        if cur is not None:
            mi = classes[cur["desc"]]["methods"].get(cur["name"])
            if mi is not None:
                for st in _extract_strings(raw):
                    mi["strings"].append(st)
                    string_refs.append({"string": st, "holder": "%s->%s" % (cur["desc"], cur["name"]),
                                        "file": rel, "line": i})
                mi["_callnames"].extend(_extract_calls(masked))

        # Update brace depth, pushing/popping scopes as blocks open/close.
        for ch in masked:
            if ch == "{":
                depth += 1
                if pending_class is not None:
                    stack.append({"type": "class", "name": pending_class.split("::")[-1],
                                  "desc": pending_class, "depth": depth})
                    pending_class = None
                elif mf is not None:
                    # The function opened this block; record its scope.
                    enclosing = next((e for e in reversed(stack) if e["type"] == "class"), None)
                    owner = enclosing["desc"] if enclosing else rel
                    stack.append({"type": "def", "name": mf.group(1), "desc": owner, "depth": depth})
                    mf = None
                else:
                    stack.append({"type": "block", "depth": depth})
            elif ch == "}":
                while stack and stack[-1]["depth"] >= depth:
                    stack.pop()
                depth = max(0, depth - 1)


def _parse_ruby(rel, lines, classes, source_methods, defindex, string_refs):
    stack = []  # {"type","name","desc"}
    for i, raw in enumerate(lines, start=1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        mc = _RUBY_CLASS_RE.match(raw)
        if mc:
            cname = mc.group(1).replace("::", ".")
            desc = "%s::%s" % (rel, cname)
            sup = mc.group(2).replace("::", ".") if mc.group(2) else None
            _ensure_class(classes, desc, rel, sup, [])
            stack.append({"type": "class", "name": cname, "desc": desc})
            continue
        md = _RUBY_DEF_RE.match(raw)
        if md:
            fname = md.group(1)
            enclosing = next((e for e in reversed(stack) if e["type"] == "class"), None)
            owner = enclosing["desc"] if enclosing else rel
            if owner == rel:
                _ensure_class(classes, rel, rel)
            _add_method(classes[owner], fname, i)
            source_methods.append((owner, fname))
            defindex.setdefault(fname, set()).add(owner)
            stack.append({"type": "def", "name": fname, "desc": owner})
            continue
        if re.match(r"^\s*end\b", raw):
            if stack:
                stack.pop()
            continue
        cur = next((e for e in reversed(stack) if e["type"] == "def"), None)
        if cur is not None:
            mi = classes[cur["desc"]]["methods"][cur["name"]]
            for st in _extract_strings(raw):
                mi["strings"].append(st)
                string_refs.append({"string": st, "holder": "%s->%s" % (cur["desc"], cur["name"]),
                                    "file": rel, "line": i})
            masked = _mask_line(raw, hash_comment=True)
            mi["_callnames"].extend(_extract_calls(masked))


def _parse_source_file(path, rel, kind, classes, source_methods, defindex, string_refs):
    try:
        with open(_fs_path(path), encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except Exception:
        return
    if kind == "python":
        _parse_python(rel, lines, classes, source_methods, defindex, string_refs)
    elif kind == "ruby":
        _parse_ruby(rel, lines, classes, source_methods, defindex, string_refs)
    else:
        _parse_braces(rel, lines, classes, source_methods, defindex, string_refs)


def _resolve_source_calls(classes, source_methods, defindex, calls):
    """Turn each source method's raw called-names into call edges. A name that
    maps to exactly one definition becomes a precise edge (owner->name); an
    ambiguous or external name is kept as a bare target so callers/callees still
    show it but it won't create a phantom class node in the visualization."""
    for owner, mname in source_methods:
        mi = classes[owner]["methods"].get(mname)
        if mi is None:
            continue
        src = "%s->%s" % (owner, mname)
        resolved = []
        for cn in mi.pop("_callnames", []):
            owners = defindex.get(cn)
            if owners and len(owners) == 1:
                dst = "%s->%s" % (next(iter(owners)), cn)
            else:
                dst = cn
            resolved.append(dst)
            calls.append({"src": src, "dst": dst, "file": classes[owner]["file"], "line": mi["line"]})
        mi["calls"] = resolved


def _update_graph_index(graph_id, root, meta):
    """Read-modify-write the shared graphs.json index so every namespace is
    discoverable (by the query engine, the diff tool and the frontend selector)."""
    idx = {}
    try:
        with open(_fs_path(GRAPH_INDEX_PATH), encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            idx = loaded
    except Exception:
        idx = {}
    idx[graph_id] = {
        "graph_id": graph_id,
        "root": strip_workspace(root),
        "built_at": meta["built_at"],
        "built_at_ts": meta["built_at_ts"],
        "smali_files": meta["smali_files"],
        "source_files": meta.get("source_files", 0),
        "classes": meta["classes"],
        "methods": meta["methods"],
        "edges": meta["edges"],
        "string_refs": meta["string_refs"],
        "so_files": meta["so_files"],
    }
    _write_json(GRAPH_INDEX_PATH, idx)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else WORKSPACE
    include_so = (len(sys.argv) > 2 and sys.argv[2] == "1")
    force = (len(sys.argv) > 3 and sys.argv[3] == "1")
    graph_id = _sanitize_graph_id(sys.argv[4] if len(sys.argv) > 4 else "")

    graph_dir = os.path.join(GRAPH_ROOT, graph_id)
    meta_path = os.path.join(graph_dir, "meta.json")
    manifest_path = os.path.join(graph_dir, "manifest.json")

    if not os.path.isdir(_fs_path(root)):
        print("[code_graph] ERROR: root dir does not exist: %s" % root)
        sys.exit(0)

    # Collect indexable files in ONE walk: smali (Android) + ordinary source
    # (any large codebase). Skip vendored / build / VCS dirs and obviously
    # non-source blobs so a big repo doesn't drown the graph in noise.
    # Walk the extended-length root so deeply nested trees (long smali package
    # paths on Windows) are reachable even without OS long-path support; the
    # yielded paths carry the prefix and strip_workspace() removes it again.
    smali_files = []
    source_files = []   # (path, kind)
    lang_counts = {}
    for dp, dns, fn in os.walk(_fs_path(root)):
        dns[:] = [d for d in dns if d not in _SKIP_DIRS]
        for f in fn:
            full = os.path.join(dp, f)
            if f.endswith(".smali"):
                smali_files.append(full)
                continue
            ext = os.path.splitext(f)[1].lower()
            kind = SOURCE_EXTS.get(ext)
            if kind and not _skip_source(full, f):
                source_files.append((full, kind))
                lang_counts[ext] = lang_counts.get(ext, 0) + 1

    indexed_paths = smali_files + [p for p, _ in source_files]
    indexed_count = len(indexed_paths)

    # Cached / up-to-date check using this namespace's manifest (covers both
    # smali and source files, so editing a .py invalidates the graph too).
    if not force and os.path.exists(manifest_path):
        try:
            with open(manifest_path, encoding="utf-8") as fh:
                manifest = json.load(fh)
            graph_mtime = manifest.get("built_at_ts", 0)
            newest = max((os.path.getmtime(_fs_path(p)) for p in indexed_paths), default=0)
            cached_count = manifest.get("indexed_count", manifest.get("smali_count"))
            if graph_mtime >= newest and cached_count == indexed_count:
                with open(meta_path, encoding="utf-8") as fh:
                    m = json.load(fh)
                print("[code_graph] Graph '%s' is up to date (use force=true to rebuild)." % graph_id)
                print("[code_graph] files=%s (smali=%s source=%s) classes=%s methods=%s edges=%s string_refs=%s so_files=%s"
                      % (m.get("smali_files", 0) + m.get("source_files", 0), m.get("smali_files", 0),
                         m.get("source_files", 0), m.get("classes", 0), m.get("methods", 0),
                         m.get("edges", 0), m.get("string_refs", 0), m.get("so_files", 0)))
                print("[code_graph] Graph id: %s  dir: %s" % (graph_id, graph_dir))
                print("[code_graph] Use query_code_graph (graph_id='%s') to search it." % graph_id)
                sys.exit(0)
        except Exception:
            pass  # corrupt cache -> rebuild

    classes = {}
    calls = []            # {src, dst, file, line}
    string_refs = []      # {string, holder, file, line}
    source_methods = []   # (owner_desc, method_name) for post-pass call resolution
    defindex = {}         # method/func name -> set(owner descriptors that define it)

    for path in smali_files:
        _parse_smali_file(path, strip_workspace(path), classes, calls, string_refs)

    for path, kind in source_files:
        _parse_source_file(path, strip_workspace(path), kind, classes,
                            source_methods, defindex, string_refs)

    # Resolve general-source call-names into edges now that every definition is
    # known (a name that maps to exactly one def becomes a precise edge).
    _resolve_source_calls(classes, source_methods, defindex, calls)

    # Reverse indexes
    callers = {}
    for c in calls:
        callers.setdefault(c["dst"], []).append(c["src"])

    subclasses = {}
    for cname, c in classes.items():
        sup = c.get("super")
        if sup:
            subclasses.setdefault(sup, []).append(cname)

    # Native .so symbol tables
    so_symbols = {}
    if include_so:
        so_files = []
        for dp, _dn, fn in os.walk(_fs_path(root)):
            for f in fn:
                if f.endswith(".so"):
                    so_files.append(os.path.join(dp, f))
        for sop in so_files:
            rel = strip_workspace(sop)
            exp, imp = [], []
            try:
                r = subprocess.run(["nm", "-D", "--defined-only", sop],
                                   capture_output=True, text=True, timeout=60)
                for ln in r.stdout.splitlines():
                    p = ln.split()
                    if p:
                        exp.append(p[-1])
            except Exception:
                pass
            try:
                r = subprocess.run(["nm", "-D", "--undefined-only", sop],
                                   capture_output=True, text=True, timeout=60)
                for ln in r.stdout.splitlines():
                    p = ln.split()
                    if p:
                        imp.append(p[-1])
            except Exception:
                pass
            so_symbols[rel] = {"exports": exp, "imports": imp}

    method_count = sum(len(c["methods"]) for c in classes.values())
    field_count = sum(len(c["fields"]) for c in classes.values())
    so_sym_count = sum(len(v["exports"]) + len(v["imports"]) for v in so_symbols.values())

    # --- Write chunked graph files -------------------------------------------
    os.makedirs(_fs_path(graph_dir), exist_ok=True)

    # Clean old files WITHIN THIS NAMESPACE only (other graphs are untouched),
    # including any legacy single graph.json.
    for old in os.listdir(_fs_path(graph_dir)):
        if old.endswith(".json") or old.endswith(".json.tmp"):
            try:
                os.remove(_fs_path(os.path.join(graph_dir, old)))
            except OSError:
                pass

    # meta.json
    meta = {
        "graph_id": graph_id,
        "root": strip_workspace(root),
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "built_at_ts": time.time(),
        "smali_files": len(smali_files),
        "source_files": len(source_files),
        "languages": lang_counts,
        "classes": len(classes),
        "methods": method_count,
        "fields": field_count,
        "edges": len(calls),
        "string_refs": len(string_refs),
        "so_files": len(so_symbols),
        "so_symbols": so_sym_count,
        "shard_format": "classes_<prefix>.json, string_refs_<NN>.json",
        "string_refs_shard_size": STRING_REFS_SHARD_SIZE,
    }
    _write_json(meta_path, meta)

    # classes sharded by package prefix
    class_shards = {}
    for cname, cinfo in classes.items():
        key = _shard_key(cname)
        class_shards.setdefault(key, {})[cname] = cinfo
    class_shard_names = []
    for key, shard in class_shards.items():
        fname = "classes_%s.json" % key
        _write_json(os.path.join(graph_dir, fname), shard)
        class_shard_names.append(fname)

    # callers.json
    _write_json(os.path.join(graph_dir, "callers.json"), callers)

    # subclasses.json
    _write_json(os.path.join(graph_dir, "subclasses.json"), subclasses)

    # string_refs sharded into fixed-size chunks
    string_ref_shard_names = []
    for idx, i in enumerate(range(0, len(string_refs), STRING_REFS_SHARD_SIZE)):
        chunk = string_refs[i:i + STRING_REFS_SHARD_SIZE]
        fname = "string_refs_%03d.json" % idx
        _write_json(os.path.join(graph_dir, fname), chunk)
        string_ref_shard_names.append(fname)

    # so_symbols.json
    _write_json(os.path.join(graph_dir, "so_symbols.json"), so_symbols)

    # manifest.json — tracks what was indexed + lists shard files
    manifest = {
        "graph_id": graph_id,
        "built_at": meta["built_at"],
        "built_at_ts": meta["built_at_ts"],
        "smali_count": len(smali_files),
        "indexed_count": indexed_count,
        "class_shards": sorted(class_shard_names),
        "string_ref_shards": sorted(string_ref_shard_names),
        "files": {
            "callers": "callers.json",
            "subclasses": "subclasses.json",
            "so_symbols": "so_symbols.json",
            "meta": "meta.json",
        },
    }
    _write_json(manifest_path, manifest)

    # Register this graph in the shared index so it can be listed / diffed / viewed.
    _update_graph_index(graph_id, root, meta)

    # --- Summary -------------------------------------------------------------
    m = meta
    if len(classes) == 0:
        print("[code_graph] WARNING: 0 classes/functions found under '%s'. This graph will be "
              "EMPTY and the Graph tab will show nothing. Point at a directory that actually "
              "contains source: a decompiled smali root (apktool output or a 'smali*' folder) "
              "for an APK, or the project source root for an ordinary codebase — then rebuild."
              % strip_workspace(root))
    print("[code_graph] Built graph '%s' for %s" % (graph_id, strip_workspace(root)))
    if lang_counts:
        langs = ", ".join("%s:%d" % (e, n) for e, n in sorted(lang_counts.items(), key=lambda kv: -kv[1]))
        print("[code_graph] source languages: %s" % langs)
    print("[code_graph] files=%s (smali=%s source=%s) classes=%s methods=%s fields=%s call_edges=%s string_refs=%s so_files=%s so_symbols=%s"
          % (m["smali_files"] + m["source_files"], m["smali_files"], m["source_files"],
             m["classes"], m["methods"], m["fields"], m["edges"], m["string_refs"],
             m["so_files"], m["so_symbols"]))
    print("[code_graph] Saved %d class shards, %d string_ref shards to %s"
          % (len(class_shard_names), len(string_ref_shard_names), graph_dir))
    print("[code_graph] Top classes/modules by method count:")
    ranked = sorted(classes.items(), key=lambda kv: len(kv[1]["methods"]), reverse=True)[:10]
    for cname, c in ranked:
        print("  %4d methods  %s  (%s)" % (len(c["methods"]), cname, c["file"]))
    print("[code_graph] Done. Query with graph_id='%s'; compare versions with diff_code_graphs." % graph_id)


if __name__ == "__main__":
    main()
