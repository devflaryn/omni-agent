#!/usr/bin/env python3
"""Code knowledge-graph query engine (runs INSIDE the Docker sandbox).

Usage:
    python3 _kg_query.py <query_type> [name] [limit]

query_type:
    stats          - graph summary + biggest classes
    search_classes - classes whose descriptor contains <name> (substring)
    class          - one class: super, interfaces, fields, methods (with line), file
    method         - methods matching <name> ("Class;->proto" or substring); shows file:line + callees + strings
    callers        - who calls a method/class-method (reverse edges)
    callees        - what a method/class calls
    string_refs    - where a const-string literal is referenced (file:line, holder)
    hierarchy      - superclass chain + direct subclasses + interfaces
    so_symbols     - exported/imported symbols of native .so libs
    graph_data     - returns nodes/edges/legend JSON for visualization

Reads from the chunked graph files in /workspace/.codegraph/ (meta.json,
manifest.json, classes_*.json, callers.json, subclasses.json,
string_refs_*.json, so_symbols.json) — never loads the whole graph at once.
"""
import sys
import os
import json

GRAPH_DIR = "/workspace/.codegraph"
META_PATH = os.path.join(GRAPH_DIR, "meta.json")
MANIFEST_PATH = os.path.join(GRAPH_DIR, "manifest.json")


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _load_manifest():
    return _load_json(MANIFEST_PATH)


def _load_meta():
    return _load_json(META_PATH)


def _load_all_classes(manifest):
    """Load and merge all class shards into one dict."""
    classes = {}
    for shard_name in manifest.get("class_shards", []):
        shard = _load_json(os.path.join(GRAPH_DIR, shard_name))
        if isinstance(shard, dict):
            classes.update(shard)
    return classes


def _load_all_string_refs(manifest):
    """Load and merge all string_ref shards into one list."""
    refs = []
    for shard_name in manifest.get("string_ref_shards", []):
        shard = _load_json(os.path.join(GRAPH_DIR, shard_name))
        if isinstance(shard, list):
            refs.extend(shard)
    return refs


def find_class(name, classes):
    if name in classes:
        return name
    if not name.endswith(";") and not name.startswith("["):
        cand = "L" + name.replace(".", "/") + ";"
        if cand in classes:
            return cand
    matches = [c for c in classes if name in c]
    if len(matches) == 1:
        return matches[0]
    return matches if matches else None


# Tableau-10 inspired palette for community coloring (like graphify)
_PALETTE = [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
    "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
    "#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD",
]


def _build_graph_data(manifest, classes, callers, max_nodes=600):
    """Build vis-network-ready nodes/edges/legend for visualization."""
    meta = _load_meta() or {}

    # Determine communities by top-level package (first segment after L)
    pkg_groups = {}
    for cname in classes:
        d = cname.lstrip("L[").rstrip(";")
        top = d.split("/")[0] if "/" in d else "(default)"
        pkg_groups.setdefault(top, []).append(cname)

    # Assign colors per community
    comm_ids = {}
    for i, pkg in enumerate(sorted(pkg_groups.keys())):
        comm_ids[pkg] = i % len(_PALETTE)

    legend = []
    for pkg in sorted(pkg_groups.keys()):
        cid = comm_ids[pkg]
        legend.append({
            "cid": cid,
            "color": _PALETTE[cid],
            "label": pkg,
            "count": len(pkg_groups[pkg]),
        })

    # Build call edges (limit for performance)
    edges_set = {}  # (src,dst) -> count
    for cname, cinfo in classes.items():
        for m, mi in cinfo.get("methods", {}).items():
            src = "%s->%s" % (cname, m)
            for cal in mi.get("calls", []):
                key = (src, cal)
                edges_set[key] = edges_set.get(key, 0) + 1

    # Limit nodes: pick top classes by degree
    degree = {}
    for (src, dst) in edges_set:
        degree[src] = degree.get(src, 0) + 1
        degree[dst] = degree.get(dst, 0) + 1

    # Also include classes that have methods even if low degree
    class_deg = {}
    for cname in classes:
        d = 0
        for m in classes[cname].get("methods", {}):
            d += degree.get("%s->%s" % (cname, m), 0)
        class_deg[cname] = d

    top_classes = sorted(class_deg, key=lambda c: class_deg[c], reverse=True)[:max_nodes]
    top_set = set(top_classes)

    nodes = []
    for cname in top_classes:
        d = cname.lstrip("L[").rstrip(";")
        top = d.split("/")[0] if "/" in d else "(default)"
        cid = comm_ids.get(top, 0)
        color = _PALETTE[cid]
        deg = class_deg[cname]
        nodes.append({
            "id": cname,
            "label": d.split("/")[-1] if "/" in d else d,
            "color": {"background": color, "border": color, "highlight": {"background": "#ffffff", "border": color}},
            "size": 10 + min(deg * 0.5, 30),
            "community": cid,
            "community_name": top,
            "source_file": classes[cname].get("file", ""),
            "file_type": "smali",
            "degree": deg,
            "title": cname,
        })

    # Build edges between class-level nodes
    # Map method->class for edge aggregation
    method_to_class = {}
    for cname in classes:
        for m in classes[cname].get("methods", {}):
            method_to_class["%s->%s" % (cname, m)] = cname

    class_edges = {}
    for (src, dst) in edges_set:
        src_cls = method_to_class.get(src, src.split("->")[0] if "->" in src else src)
        dst_cls = method_to_class.get(dst, dst.split("->")[0] if "->" in dst else dst)
        if src_cls in top_set and dst_cls in top_set and src_cls != dst_cls:
            key = (src_cls, dst_cls)
            class_edges[key] = class_edges.get(key, 0) + 1

    edges = []
    for (src, dst), w in class_edges.items():
        edges.append({
            "from": src,
            "to": dst,
            "label": "",
            "title": "%d call(s)" % w,
            "width": min(1 + w * 0.3, 6),
            "color": {"opacity": 0.5},
            "dashes": False,
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "legend": legend,
        "stats": {
            "total_nodes": len(nodes),
            "total_edges": len(edges),
            "total_communities": len(legend),
            "classes": meta.get("classes", len(classes)),
            "methods": meta.get("methods", 0),
            "call_edges": meta.get("edges", len(edges_set)),
        },
    }


def main():
    qtype = sys.argv[1] if len(sys.argv) > 1 else "stats"
    name = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 40
    except Exception:
        limit = 40

    manifest = _load_manifest()
    if not manifest:
        print("[code_graph] No graph manifest found at %s" % MANIFEST_PATH)
        print("[code_graph] Run build_code_graph first.")
        sys.exit(0)

    meta = _load_meta() or {}
    callers = _load_json(os.path.join(GRAPH_DIR, manifest.get("files", {}).get("callers", "callers.json"))) or {}
    subclasses = _load_json(os.path.join(GRAPH_DIR, manifest.get("files", {}).get("subclasses", "subclasses.json"))) or {}
    so_symbols = _load_json(os.path.join(GRAPH_DIR, manifest.get("files", {}).get("so_symbols", "so_symbols.json"))) or {}
    out = []

    # graph_data is a special query that returns compact JSON for visualization
    if qtype == "graph_data":
        classes = _load_all_classes(manifest)
        data = _build_graph_data(manifest, classes, callers, max_nodes=limit * 10 if limit > 40 else 600)
        print(json.dumps(data, separators=(",", ":")))
        return

    # For queries that need classes, load them lazily
    classes = None
    string_refs = None

    if qtype == "stats":
        out.append("Graph stats for %s:" % meta.get("root", "?"))
        out.append("  smali_files=%s classes=%s methods=%s fields=%s call_edges=%s string_refs=%s so_files=%s so_symbols=%s"
                   % (meta.get("smali_files", 0), meta.get("classes", 0), meta.get("methods", 0),
                      meta.get("fields", 0), meta.get("edges", 0), meta.get("string_refs", 0),
                      meta.get("so_files", 0), meta.get("so_symbols", 0)))
        out.append("  built_at=%s" % meta.get("built_at", "?"))
        out.append("  class_shards=%d string_ref_shards=%d" % (len(manifest.get("class_shards", [])), len(manifest.get("string_ref_shards", []))))
        out.append("Top classes by method count:")
        classes = _load_all_classes(manifest)
        ranked = sorted(classes.items(), key=lambda kv: len(kv[1]["methods"]), reverse=True)[:10]
        for cname, c in ranked:
            out.append("  %4d methods  %s  (%s)" % (len(c["methods"]), cname, c["file"]))

    elif qtype == "search_classes":
        classes = _load_all_classes(manifest)
        n = name.lower()
        ms = [c for c in classes if n in c.lower()]
        out.append("Classes matching '%s' (%d found, showing up to %d):" % (name, len(ms), limit))
        for c in ms[:limit]:
            out.append("  %s  ->  %s  (%d methods)" % (c, classes[c]["file"], len(classes[c]["methods"])))
        if len(ms) > limit:
            out.append("  ... %d more. Narrow your search." % (len(ms) - limit))

    elif qtype == "class":
        classes = _load_all_classes(manifest)
        c = find_class(name, classes)
        if not c:
            out.append("No class matched '%s'. Try search_classes first." % name)
        elif isinstance(c, list):
            out.append("Multiple classes matched '%s': %s" % (name, c[:20]))
        else:
            info = classes[c]
            out.append("Class: %s" % c)
            out.append("  file: %s" % info["file"])
            out.append("  super: %s" % info.get("super"))
            if info.get("interfaces"):
                out.append("  implements: %s" % ", ".join(info["interfaces"]))
            if info.get("fields"):
                out.append("  fields (%d):" % len(info["fields"]))
                for f in info["fields"][:limit]:
                    out.append("    %s" % f)
            out.append("  methods (%d):" % len(info["methods"]))
            for m, mi in list(info["methods"].items())[:limit]:
                out.append("    %s  @line %d  calls=%d strings=%d  (%s)"
                           % (m, mi["line"], len(mi["calls"]), len(mi["strings"]), info["file"]))
            if len(info["methods"]) > limit:
                out.append("    ... %d more methods." % (len(info["methods"]) - limit))

    elif qtype == "method":
        classes = _load_all_classes(manifest)
        found = []
        if "->" in name:
            for cname, info in classes.items():
                for m, mi in info["methods"].items():
                    if name in ("%s->%s" % (cname, m)):
                        found.append((cname, m, mi))
        else:
            n = name.lower()
            for cname, info in classes.items():
                for m, mi in info["methods"].items():
                    if n in m.lower() or n in cname.lower():
                        found.append((cname, m, mi))
        out.append("Methods matching '%s' (%d found, showing up to %d):" % (name, len(found), limit))
        for cname, m, mi in found[:limit]:
            out.append("  %s->%s" % (cname, m))
            out.append("    file: %s  @line %d" % (classes[cname]["file"], mi["line"]))
            if mi["calls"]:
                out.append("    calls (%d): %s" % (len(mi["calls"]), ", ".join(mi["calls"][:8])))
            if mi["strings"]:
                out.append("    strings: %s" % [s for s in mi["strings"][:8]])

    elif qtype == "callers":
        if "->" in name:
            targets = [name]
        else:
            targets = [d for d in callers if name in d]
        out.append("Callers of '%s' (%d target(s)):" % (name, len(targets)))
        total = 0
        for t in targets[:limit]:
            srcs = callers.get(t, [])
            total += len(srcs)
            out.append("  %s  <-  %d caller(s)" % (t, len(srcs)))
            for s in srcs[:limit]:
                out.append("      %s" % s)
        out.append("Total caller edges: %d" % total)

    elif qtype == "callees":
        classes = _load_all_classes(manifest)
        if "->" in name:
            cname, _, m = name.partition("->")
            info = classes.get(cname)
            if info and m in info["methods"]:
                cal = info["methods"][m]["calls"]
                out.append("%s calls (%d):" % (name, len(cal)))
                for c in cal[:limit]:
                    out.append("  -> %s" % c)
            else:
                out.append("Method '%s' not found." % name)
        else:
            c = find_class(name, classes)
            if not c or isinstance(c, list):
                out.append("No single class matched '%s'." % name)
            else:
                info = classes[c]
                edges = []
                for m, mi in info["methods"].items():
                    for cal in mi["calls"]:
                        edges.append(("%s->%s" % (c, m), cal, mi["line"]))
                out.append("Callees of class %s (%d edges):" % (c, len(edges)))
                for src, dst, ln in edges[:limit]:
                    out.append("  %s @line %d -> %s" % (src, ln, dst))

    elif qtype == "string_refs":
        string_refs = _load_all_string_refs(manifest)
        n = name.lower()
        refs = [r for r in string_refs if n in r["string"].lower()]
        out.append("String references matching '%s' (%d found, showing up to %d):" % (name, len(refs), limit))
        for r in refs[:limit]:
            disp = r["string"][:60]
            out.append('  "%s"  @ %s:%d  in %s' % (disp, r["file"], r["line"], r["holder"]))

    elif qtype == "hierarchy":
        classes = _load_all_classes(manifest)
        c = find_class(name, classes)
        if not c or isinstance(c, list):
            out.append("No single class matched '%s'." % name)
        else:
            info = classes[c]
            out.append("Hierarchy for %s:" % c)
            chain = []
            cur = info.get("super")
            while cur and cur not in chain:
                chain.append(cur)
                cur = classes.get(cur, {}).get("super") if cur in classes else None
            out.append("  super chain: %s" % (" -> ".join(chain) if chain else "(none)"))
            if info.get("interfaces"):
                out.append("  implements: %s" % ", ".join(info["interfaces"]))
            subs = subclasses.get(c, [])
            out.append("  direct subclasses (%d): %s" % (len(subs), ", ".join(subs[:limit])))

    elif qtype == "so_symbols":
        n = name.lower()
        libs = {p: s for p, s in so_symbols.items() if n in p.lower()}
        if libs:
            for p, s in libs.items():
                out.append("Native lib %s:" % p)
                exp = s.get("exports", [])
                out.append("  exports (%d):" % len(exp))
                for sym in exp[:limit]:
                    out.append("    + %s" % sym)
                imp = s.get("imports", [])
                out.append("  imports (%d):" % len(imp))
                for sym in imp[:limit]:
                    out.append("    - %s" % sym)
        else:
            out.append("Native symbols matching '%s' across %d .so files:" % (name, len(so_symbols)))
            cnt = 0
            for p, s in so_symbols.items():
                for sym in s.get("exports", []):
                    if n in sym.lower():
                        out.append("  [exp] %s  (%s)" % (sym, p))
                        cnt += 1
                        if cnt >= limit:
                            break
                for sym in s.get("imports", []):
                    if n in sym.lower():
                        out.append("  [imp] %s  (%s)" % (sym, p))
                        cnt += 1
                        if cnt >= limit:
                            break
                if cnt >= limit:
                    break
            out.append("Total matching symbols shown: %d" % cnt)

    else:
        out.append("Unknown query_type '%s'. Valid: stats, search_classes, class, method, callers, callees, string_refs, hierarchy, so_symbols, graph_data." % qtype)

    print("\n".join(out))


if __name__ == "__main__":
    main()
