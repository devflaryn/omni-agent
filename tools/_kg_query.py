#!/usr/bin/env python3
"""Code knowledge-graph query engine (runs as a standalone script on the host).

Usage:
    python3 _kg_query.py <query_type> [name] [limit] [graph_id] [graph_id_b]

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
    graphs         - list every built graph namespace (id, root, counts, built_at)
    diff           - compare two graphs (graph_id vs graph_id_b): classes/methods
                     added/removed/changed + string-literal and native-symbol deltas

NAMED GRAPHS
------------
Graphs live in per-namespace subdirs <project>/.codegraph/<graph_id>/ so several
can coexist (e.g. two app versions). If <graph_id> is omitted, the most recently
built graph is used. A legacy flat graph at <project>/.codegraph/ (built before
namespacing) is still read as graph_id '(default)'.

Reads only the chunked shards it needs — never the whole graph at once.
"""
import sys
import os
import json

WORKSPACE = os.path.abspath(os.environ.get("CODEGRAPH_WORKSPACE") or os.getcwd())
GRAPH_ROOT = os.path.join(WORKSPACE, ".codegraph")
GRAPH_INDEX_PATH = os.path.join(GRAPH_ROOT, "graphs.json")


def _sanitize_graph_id(gid):
    """Mirror the indexer's slug rule so a requested id maps to the same dir."""
    import re
    gid = (gid or "").strip().replace("\\", "/")
    gid = gid.split("/")[-1]
    gid = re.sub(r"[^A-Za-z0-9._-]+", "_", gid)
    gid = gid.strip("._-")
    return gid[:64] or "default"


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _load_index():
    idx = _load_json(GRAPH_INDEX_PATH)
    return idx if isinstance(idx, dict) else {}


def _resolve_graph_dir(requested, idx):
    """Return (graph_id, graph_dir) for a requested id (or the most recent graph
    when none is given). Falls back to a legacy flat graph at the root. Returns
    (id, None) when the requested/most-recent graph has no manifest."""
    if requested:
        gid = _sanitize_graph_id(requested)
        gdir = os.path.join(GRAPH_ROOT, gid)
        if os.path.isfile(os.path.join(gdir, "manifest.json")):
            return gid, gdir
        return gid, None
    if idx:
        gid = max(idx, key=lambda k: idx[k].get("built_at_ts", 0))
        gdir = os.path.join(GRAPH_ROOT, gid)
        if os.path.isfile(os.path.join(gdir, "manifest.json")):
            return gid, gdir
    # Legacy flat layout (built before namespacing).
    if os.path.isfile(os.path.join(GRAPH_ROOT, "manifest.json")):
        return "(default)", GRAPH_ROOT
    return "", None


def _load_manifest(graph_dir):
    return _load_json(os.path.join(graph_dir, "manifest.json"))


def _load_meta(graph_dir):
    return _load_json(os.path.join(graph_dir, "meta.json")) or {}


def _load_all_classes(graph_dir, manifest):
    """Load and merge all class shards into one dict."""
    classes = {}
    for shard_name in manifest.get("class_shards", []):
        shard = _load_json(os.path.join(graph_dir, shard_name))
        if isinstance(shard, dict):
            classes.update(shard)
    return classes


def _load_all_string_refs(graph_dir, manifest):
    """Load and merge all string_ref shards into one list."""
    refs = []
    for shard_name in manifest.get("string_ref_shards", []):
        shard = _load_json(os.path.join(graph_dir, shard_name))
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


def _build_graph_data(meta, classes, callers, max_nodes=600):
    """Build vis-network-ready nodes/edges/legend for visualization."""
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


def _method_signature(mi):
    """A change-detection fingerprint for a method: its ordered call targets +
    string literals. Two versions of a method with the same fingerprint are
    treated as unchanged even if line numbers shifted."""
    return (tuple(mi.get("calls", [])), tuple(mi.get("strings", [])))


def _cmd_diff(id_a, id_b, limit, idx, out):
    """Compare two graphs and describe what changed. Leads with class/method
    structure, then string-literal and native-symbol deltas (which survive
    obfuscation better than class names — important for renamed/minified apps)."""
    if not id_a or not id_b:
        out.append("diff needs two graph ids: pass graph_id (A) and graph_id_b (B).")
        out.append("Available graphs: %s" % (", ".join(sorted(idx.keys())) or "(none — build_code_graph first)"))
        return
    gid_a, dir_a = _resolve_graph_dir(id_a, idx)
    gid_b, dir_b = _resolve_graph_dir(id_b, idx)
    if dir_a is None or dir_b is None:
        missing = []
        if dir_a is None:
            missing.append(gid_a)
        if dir_b is None:
            missing.append(gid_b)
        out.append("No graph found for: %s" % ", ".join(missing))
        out.append("Available graphs: %s" % (", ".join(sorted(idx.keys())) or "(none)"))
        return

    man_a, man_b = _load_manifest(dir_a), _load_manifest(dir_b)
    meta_a, meta_b = _load_meta(dir_a), _load_meta(dir_b)
    classes_a = _load_all_classes(dir_a, man_a)
    classes_b = _load_all_classes(dir_b, man_b)

    set_a, set_b = set(classes_a), set(classes_b)
    added = sorted(set_b - set_a)
    removed = sorted(set_a - set_b)
    common = set_a & set_b

    changed = []  # (class, +methods, -methods, changed_bodies)
    for c in common:
        ma = classes_a[c].get("methods", {})
        mb = classes_b[c].get("methods", {})
        na, nb = set(ma), set(mb)
        m_added = nb - na
        m_removed = na - nb
        body_changed = 0
        for m in (na & nb):
            if _method_signature(ma[m]) != _method_signature(mb[m]):
                body_changed += 1
        if m_added or m_removed or body_changed:
            changed.append((c, len(m_added), len(m_removed), body_changed))
    changed.sort(key=lambda t: (t[1] + t[2] + t[3]), reverse=True)

    # String-literal delta (stable across obfuscation).
    str_a = set(r.get("string", "") for r in _load_all_string_refs(dir_a, man_a))
    str_b = set(r.get("string", "") for r in _load_all_string_refs(dir_b, man_b))
    str_added = sorted(str_b - str_a)
    str_removed = sorted(str_a - str_b)

    # Native symbol delta, per shared .so (matched by path).
    so_a = _load_json(os.path.join(dir_a, "so_symbols.json")) or {}
    so_b = _load_json(os.path.join(dir_b, "so_symbols.json")) or {}
    so_libs_added = sorted(set(so_b) - set(so_a))
    so_libs_removed = sorted(set(so_a) - set(so_b))
    so_export_changes = []  # (lib, +exports, -exports)
    for lib in sorted(set(so_a) & set(so_b)):
        ea, eb = set(so_a[lib].get("exports", [])), set(so_b[lib].get("exports", []))
        add_e, rem_e = eb - ea, ea - eb
        if add_e or rem_e:
            so_export_changes.append((lib, sorted(add_e), sorted(rem_e)))

    # --- Report --------------------------------------------------------------
    out.append("Diff  A='%s' (%s)  ->  B='%s' (%s)"
               % (gid_a, meta_a.get("root", "?"), gid_b, meta_b.get("root", "?")))
    out.append("  A: classes=%s methods=%s string_refs=%s so_files=%s"
               % (meta_a.get("classes", len(classes_a)), meta_a.get("methods", 0),
                  meta_a.get("string_refs", 0), meta_a.get("so_files", 0)))
    out.append("  B: classes=%s methods=%s string_refs=%s so_files=%s"
               % (meta_b.get("classes", len(classes_b)), meta_b.get("methods", 0),
                  meta_b.get("string_refs", 0), meta_b.get("so_files", 0)))
    out.append("")
    out.append("CLASSES: +%d added  -%d removed  ~%d changed  (=%d common)"
               % (len(added), len(removed), len(changed), len(common)))

    # Heavy obfuscation heuristic: if almost every class is add+remove, names were
    # renamed between builds — steer the reader toward the stable signals.
    if common and (len(added) + len(removed)) > 4 * len(common):
        out.append("  (note: class names differ heavily between builds — likely re-obfuscated. "
                   "Rely on the STRING and NATIVE SYMBOL deltas below, which survive renaming.)")
    elif not common and (added or removed):
        # No shared descriptors at all. For smali this means a full rename; for
        # general source it usually means the two graphs were built from DIFFERENT
        # root directories (so paths, and thus descriptors, don't line up). Either
        # way the STRING / NATIVE deltas below are the reliable comparison.
        out.append("  (note: the two graphs share NO class descriptors. If these are general-source "
                   "graphs built from different root dirs, that's expected — descriptors are path-based. "
                   "Compare using the STRING and NATIVE SYMBOL deltas below, which are path-independent.)")

    for label, items in (("added classes", added), ("removed classes", removed)):
        if items:
            out.append("  %s (showing up to %d):" % (label, limit))
            for c in items[:limit]:
                src = classes_b.get(c) or classes_a.get(c) or {}
                out.append("    %s  (%s)" % (c, src.get("file", "")))
            if len(items) > limit:
                out.append("    ... %d more." % (len(items) - limit))
    if changed:
        out.append("  changed classes (showing up to %d, most-changed first):" % limit)
        for c, ap, rp, bc in changed[:limit]:
            out.append("    %s  (+%d/-%d methods, ~%d bodies)  (%s)"
                       % (c, ap, rp, bc, classes_b.get(c, {}).get("file", "")))
        if len(changed) > limit:
            out.append("    ... %d more changed classes." % (len(changed) - limit))

    out.append("")
    out.append("STRING LITERALS: +%d added  -%d removed" % (len(str_added), len(str_removed)))
    for label, items in (("added strings", str_added), ("removed strings", str_removed)):
        if items:
            out.append("  %s (showing up to %d):" % (label, limit))
            for st in items[:limit]:
                out.append('    "%s"' % (st[:80]))
            if len(items) > limit:
                out.append("    ... %d more." % (len(items) - limit))

    out.append("")
    out.append("NATIVE SYMBOLS: +%d libs added  -%d libs removed  ~%d libs with export changes"
               % (len(so_libs_added), len(so_libs_removed), len(so_export_changes)))
    for label, items in (("added .so", so_libs_added), ("removed .so", so_libs_removed)):
        if items:
            out.append("  %s: %s" % (label, ", ".join(items[:limit])))
    for lib, add_e, rem_e in so_export_changes[:limit]:
        out.append("  %s: +%d/-%d exports" % (lib, len(add_e), len(rem_e)))
        for s in add_e[:min(limit, 10)]:
            out.append("      + %s" % s)
        for s in rem_e[:min(limit, 10)]:
            out.append("      - %s" % s)


def _cmd_graphs(idx, out):
    if not idx:
        out.append("No graphs built yet. Run build_code_graph (its graph_id defaults to a slug of root_dir).")
        return
    out.append("Built graphs (%d):" % len(idx))
    for gid in sorted(idx, key=lambda k: idx[k].get("built_at_ts", 0), reverse=True):
        g = idx[gid]
        out.append("  %-24s root=%s  classes=%s methods=%s string_refs=%s so_files=%s  built=%s"
                   % (gid, g.get("root", "?"), g.get("classes", 0), g.get("methods", 0),
                      g.get("string_refs", 0), g.get("so_files", 0), g.get("built_at", "?")))
    out.append("Query one with graph_id=<id>; compare two with diff_code_graphs.")


_KNOWN_QTYPES = {
    "search", "stats", "search_classes", "class", "method", "callers", "callees",
    "string_refs", "hierarchy", "so_symbols", "graph_data", "graphs", "diff",
}


def main():
    qtype = sys.argv[1] if len(sys.argv) > 1 else ""
    name = sys.argv[2] if len(sys.argv) > 2 else ""
    # Forgiving default: a bare name (or an unrecognized query_type given WITH a
    # name) becomes a universal search; nothing at all becomes stats. So the model
    # can just throw an identifier at the graph and get useful hits.
    qtype = (qtype or "").strip()
    if not qtype:
        qtype = "search" if name else "stats"
    elif qtype not in _KNOWN_QTYPES:
        qtype = "search" if name else "stats"
    try:
        limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 40
    except Exception:
        limit = 40
    req_id = sys.argv[4] if len(sys.argv) > 4 else ""
    req_id_b = sys.argv[5] if len(sys.argv) > 5 else ""

    idx = _load_index()
    out = []

    # Whole-registry queries first (they don't target a single graph).
    if qtype == "graphs":
        _cmd_graphs(idx, out)
        print("\n".join(out))
        return
    if qtype == "diff":
        _cmd_diff(req_id, req_id_b, limit, idx, out)
        print("\n".join(out))
        return

    # Resolve which single graph this query targets.
    gid, graph_dir = _resolve_graph_dir(req_id, idx)
    if graph_dir is None:
        if req_id:
            print("[code_graph] No graph named '%s'." % gid)
        else:
            print("[code_graph] No graph built yet.")
        avail = ", ".join(sorted(idx.keys())) if idx else "(none)"
        print("[code_graph] Available graphs: %s" % avail)
        print("[code_graph] Run build_code_graph first, or pass a valid graph_id.")
        sys.exit(0)

    manifest = _load_manifest(graph_dir)
    if not manifest:
        print("[code_graph] Graph '%s' has no manifest. Rebuild with build_code_graph." % gid)
        sys.exit(0)

    meta = _load_meta(graph_dir)
    callers = _load_json(os.path.join(graph_dir, manifest.get("files", {}).get("callers", "callers.json"))) or {}
    subclasses = _load_json(os.path.join(graph_dir, manifest.get("files", {}).get("subclasses", "subclasses.json"))) or {}
    so_symbols = _load_json(os.path.join(graph_dir, manifest.get("files", {}).get("so_symbols", "so_symbols.json"))) or {}

    # graph_data is a special query that returns compact JSON for visualization
    if qtype == "graph_data":
        classes = _load_all_classes(graph_dir, manifest)
        data = _build_graph_data(meta, classes, callers, max_nodes=limit * 10 if limit > 40 else 600)
        print(json.dumps(data, separators=(",", ":")))
        return

    # A gentle multi-graph hint on the human-readable queries.
    multi = len(idx) > 1
    hint = "  [graph '%s'; %d graphs exist - pass graph_id to target another]" % (gid, len(idx)) if multi else "  [graph '%s']" % gid

    # For queries that need classes, load them lazily
    classes = None
    string_refs = None

    if qtype == "stats":
        out.append("Graph stats for %s (root %s):%s" % (gid, meta.get("root", "?"), hint))
        out.append("  smali_files=%s classes=%s methods=%s fields=%s call_edges=%s string_refs=%s so_files=%s so_symbols=%s"
                   % (meta.get("smali_files", 0), meta.get("classes", 0), meta.get("methods", 0),
                      meta.get("fields", 0), meta.get("edges", 0), meta.get("string_refs", 0),
                      meta.get("so_files", 0), meta.get("so_symbols", 0)))
        out.append("  built_at=%s" % meta.get("built_at", "?"))
        out.append("  class_shards=%d string_ref_shards=%d" % (len(manifest.get("class_shards", [])), len(manifest.get("string_ref_shards", []))))
        out.append("Top classes by method count:")
        classes = _load_all_classes(graph_dir, manifest)
        ranked = sorted(classes.items(), key=lambda kv: len(kv[1]["methods"]), reverse=True)[:10]
        for cname, c in ranked:
            out.append("  %4d methods  %s  (%s)" % (len(c["methods"]), cname, c["file"]))

    elif qtype == "search_classes":
        classes = _load_all_classes(graph_dir, manifest)
        n = name.lower()
        ms = [c for c in classes if n in c.lower()]
        out.append("Classes matching '%s' in graph '%s' (%d found, showing up to %d):" % (name, gid, len(ms), limit))
        for c in ms[:limit]:
            out.append("  %s  ->  %s  (%d methods)" % (c, classes[c]["file"], len(classes[c]["methods"])))
        if len(ms) > limit:
            out.append("  ... %d more. Narrow your search." % (len(ms) - limit))

    elif qtype == "class":
        classes = _load_all_classes(graph_dir, manifest)
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
        classes = _load_all_classes(graph_dir, manifest)
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
        classes = _load_all_classes(graph_dir, manifest)
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
        string_refs = _load_all_string_refs(graph_dir, manifest)
        n = name.lower()
        refs = [r for r in string_refs if n in r["string"].lower()]
        out.append("String references matching '%s' (%d found, showing up to %d):" % (name, len(refs), limit))
        for r in refs[:limit]:
            disp = r["string"][:60]
            out.append('  "%s"  @ %s:%d  in %s' % (disp, r["file"], r["line"], r["holder"]))

    elif qtype == "hierarchy":
        classes = _load_all_classes(graph_dir, manifest)
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

    elif qtype == "search":
        # UNIVERSAL search — the forgiving default. Given any identifier the model
        # has in hand (a method name, a class fragment, a literal like
        # "/system/xbin/su", a native symbol), search string literals + methods +
        # classes + native symbols at once and return the best file:line hits, so
        # the model never has to guess the right axis (string_refs vs method vs
        # class) up front. Strings come first — they're how anti-tamper / root /
        # license / pinning checks are usually located.
        if not name:
            out.append("search needs a name. Example: query_code_graph(query_type='search', name='isRooted').")
            print("\n".join(out))
            return
        n = name.lower()
        per = max(5, limit // 3)
        classes = _load_all_classes(graph_dir, manifest)
        string_refs = _load_all_string_refs(graph_dir, manifest)

        str_hits = [r for r in string_refs if n in r["string"].lower()]
        meth_hits = []
        for cname, info in classes.items():
            for m, mi in info["methods"].items():
                if n in m.lower():
                    meth_hits.append((cname, m, mi, info["file"]))
        class_hits = [c for c in classes if n in c.lower()]
        sym_hits = []  # (kind, sym, lib)
        for p, s in so_symbols.items():
            for sym in s.get("exports", []):
                if n in sym.lower():
                    sym_hits.append(("exp", sym, p))
            for sym in s.get("imports", []):
                if n in sym.lower():
                    sym_hits.append(("imp", sym, p))

        total = len(str_hits) + len(meth_hits) + len(class_hits) + len(sym_hits)
        out.append("Search '%s' in graph '%s': %d hit(s) across strings/methods/classes/native.%s"
                   % (name, gid, total, hint))
        if total == 0:
            out.append("  Nothing matched. Try a shorter/different substring, search_classes for a class name, "
                       "or grep_directory/search_smali for a raw text/regex search of the files.")
        if str_hits:
            out.append("STRING LITERALS (%d) — where this text is referenced:" % len(str_hits))
            for r in str_hits[:per]:
                out.append('  "%s"  @ %s:%d  in %s' % (r["string"][:60], r["file"], r["line"], r["holder"]))
            if len(str_hits) > per:
                out.append("  ... %d more (query_type='string_refs' for all)." % (len(str_hits) - per))
        if meth_hits:
            out.append("METHODS (%d):" % len(meth_hits))
            for cname, m, mi, f in meth_hits[:per]:
                out.append("  %s->%s  @ %s:%d  (calls=%d strings=%d)"
                           % (cname, m, f, mi["line"], len(mi["calls"]), len(mi["strings"])))
            if len(meth_hits) > per:
                out.append("  ... %d more (query_type='method' for all)." % (len(meth_hits) - per))
        if class_hits:
            out.append("CLASSES (%d):" % len(class_hits))
            for c in class_hits[:per]:
                out.append("  %s  ->  %s  (%d methods)" % (c, classes[c]["file"], len(classes[c]["methods"])))
            if len(class_hits) > per:
                out.append("  ... %d more (query_type='search_classes' for all)." % (len(class_hits) - per))
        if sym_hits:
            out.append("NATIVE SYMBOLS (%d):" % len(sym_hits))
            for kind, sym, p in sym_hits[:per]:
                out.append("  [%s] %s  (%s)" % (kind, sym, p))
        out.append("Then read_file_chunk the exact file:line, or drill in with "
                   "query_type='callers'/'callees'/'class' on a hit above.")

    else:
        out.append("Unknown query_type '%s'. Valid: search (default — searches everything), stats, "
                   "search_classes, class, method, callers, callees, string_refs, hierarchy, so_symbols, "
                   "graph_data, graphs, diff. Tip: just pass a name with no query_type to search everything."
                   % qtype)

    print("\n".join(out))


if __name__ == "__main__":
    main()
