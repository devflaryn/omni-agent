#!/usr/bin/env python3
"""Code knowledge-graph indexer (runs INSIDE the Docker sandbox).

Usage:
    python3 _kg_indexer.py <root_dir> <include_so:0|1> <force:0|1>

Walks <root_dir> for *.smali files and builds a compact, queryable graph:
  - classes  : class descriptor -> {file, super, interfaces, fields, methods}
  - methods  : each method records its start line, callees, and string refs
  - callers  : reverse index  callee -> [caller method refs]
  - subclasses: super -> [sub class descriptors]
  - string_refs: every const-string literal -> {string, holder, file, line}
  - so_symbols : every *.so -> {exports, imports} via nm

The graph is written to /workspace/.codegraph/ as SMALL CHUNKED JSON files
(no single 100MB monolith):

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

GRAPH_DIR = "/workspace/.codegraph"
META_PATH = os.path.join(GRAPH_DIR, "meta.json")
MANIFEST_PATH = os.path.join(GRAPH_DIR, "manifest.json")

# Max string-ref entries per shard file.
STRING_REFS_SHARD_SIZE = 20000


def strip_workspace(path):
    if path.startswith("/workspace/"):
        return path[len("/workspace/"):]
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
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "/workspace"
    include_so = (len(sys.argv) > 2 and sys.argv[2] == "1")
    force = (len(sys.argv) > 3 and sys.argv[3] == "1")

    if not os.path.isdir(root):
        print("[code_graph] ERROR: root dir does not exist: %s" % root)
        sys.exit(0)

    # Collect smali files
    smali_files = []
    for dp, _dn, fn in os.walk(root):
        for f in fn:
            if f.endswith(".smali"):
                smali_files.append(os.path.join(dp, f))

    # Cached / up-to-date check using manifest
    if not force and os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, encoding="utf-8") as fh:
                manifest = json.load(fh)
            graph_mtime = manifest.get("built_at_ts", 0)
            newest = max((os.path.getmtime(p) for p in smali_files), default=0)
            if graph_mtime >= newest and manifest.get("smali_count") == len(smali_files):
                with open(META_PATH, encoding="utf-8") as fh:
                    m = json.load(fh)
                print("[code_graph] Graph is up to date (use force=true to rebuild).")
                print("[code_graph] smali_files=%s classes=%s methods=%s edges=%s string_refs=%s so_files=%s"
                      % (m.get("smali_files", 0), m.get("classes", 0), m.get("methods", 0),
                         m.get("edges", 0), m.get("string_refs", 0), m.get("so_files", 0)))
                print("[code_graph] Graph dir: %s" % GRAPH_DIR)
                print("[code_graph] Use query_code_graph to search it.")
                sys.exit(0)
        except Exception:
            pass  # corrupt cache -> rebuild

    INVOKE_RE = re.compile(
        r"invoke-(?:virtual|direct|static|super|interface)(?:/range)?\s+\{[^}]*\}\s*,\s*(\S+)"
    )
    CONSTSTR_RE = re.compile(r'const-string(?:/jumbo)?\s+v\d+,\s*"((?:[^"\\]|\\.)*)"')

    classes = {}
    calls = []          # {src, dst, file, line}
    string_refs = []    # {string, holder, file, line}

    for path in smali_files:
        rel = strip_workspace(path)
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                lines = fh.read().splitlines()
        except Exception:
            continue

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

            # method invocations -> call edges
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

            # const-string -> string reference
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
        for dp, _dn, fn in os.walk(root):
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
    os.makedirs(GRAPH_DIR, exist_ok=True)

    # Clean old files (including the legacy single graph.json)
    for old in os.listdir(GRAPH_DIR):
        if old.endswith(".json") or old.endswith(".json.tmp"):
            try:
                os.remove(os.path.join(GRAPH_DIR, old))
            except OSError:
                pass

    # meta.json
    meta = {
        "root": strip_workspace(root),
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "built_at_ts": time.time(),
        "smali_files": len(smali_files),
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
    _write_json(META_PATH, meta)

    # classes sharded by package prefix
    class_shards = {}
    for cname, cinfo in classes.items():
        key = _shard_key(cname)
        class_shards.setdefault(key, {})[cname] = cinfo
    class_shard_names = []
    for key, shard in class_shards.items():
        fname = "classes_%s.json" % key
        _write_json(os.path.join(GRAPH_DIR, fname), shard)
        class_shard_names.append(fname)

    # callers.json
    _write_json(os.path.join(GRAPH_DIR, "callers.json"), callers)

    # subclasses.json
    _write_json(os.path.join(GRAPH_DIR, "subclasses.json"), subclasses)

    # string_refs sharded into fixed-size chunks
    string_ref_shard_names = []
    for idx, i in enumerate(range(0, len(string_refs), STRING_REFS_SHARD_SIZE)):
        chunk = string_refs[i:i + STRING_REFS_SHARD_SIZE]
        fname = "string_refs_%03d.json" % idx
        _write_json(os.path.join(GRAPH_DIR, fname), chunk)
        string_ref_shard_names.append(fname)

    # so_symbols.json
    _write_json(os.path.join(GRAPH_DIR, "so_symbols.json"), so_symbols)

    # manifest.json — tracks what was indexed + lists shard files
    manifest = {
        "built_at": meta["built_at"],
        "built_at_ts": meta["built_at_ts"],
        "smali_count": len(smali_files),
        "class_shards": sorted(class_shard_names),
        "string_ref_shards": sorted(string_ref_shard_names),
        "files": {
            "callers": "callers.json",
            "subclasses": "subclasses.json",
            "so_symbols": "so_symbols.json",
            "meta": "meta.json",
        },
    }
    _write_json(MANIFEST_PATH, manifest)

    # --- Summary -------------------------------------------------------------
    m = meta
    print("[code_graph] Built graph for %s" % strip_workspace(root))
    print("[code_graph] smali_files=%s classes=%s methods=%s fields=%s call_edges=%s string_refs=%s so_files=%s so_symbols=%s"
          % (m["smali_files"], m["classes"], m["methods"], m["fields"],
             m["edges"], m["string_refs"], m["so_files"], m["so_symbols"]))
    print("[code_graph] Saved %d class shards, %d string_ref shards to %s"
          % (len(class_shard_names), len(string_ref_shard_names), GRAPH_DIR))
    print("[code_graph] Top classes by method count:")
    ranked = sorted(classes.items(), key=lambda kv: len(kv[1]["methods"]), reverse=True)[:10]
    for cname, c in ranked:
        print("  %4d methods  %s  (%s)" % (len(c["methods"]), cname, c["file"]))
    print("[code_graph] Done. Use query_code_graph to query without re-reading files.")


if __name__ == "__main__":
    main()
