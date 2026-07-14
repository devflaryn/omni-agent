"""Code Knowledge Graph tools.

These let the agent analyze thousands of .smali files (and .so native symbol
tables) WITHOUT re-reading them every turn, which saves a huge amount of
tokens and context. The heavy lifting is done by two Python scripts that run
INSIDE the Docker sandbox:

  - _kg_indexer.py : walks a directory, parses every .smali file into a graph
                     (classes / methods / call-edges / string-xrefs / .so
                     symbols), and caches it under /workspace/.codegraph/
  - _kg_query.py   : answers compact queries against those cached graphs

NAMED GRAPHS (multi-version support)
------------------------------------
Each build is stored in its OWN namespace, /workspace/.codegraph/<graph_id>/, so
several graphs can coexist instead of overwriting/mixing. `graph_id` defaults to a
slug of `root_dir`, so indexing two versions of an app in different directories
(e.g. `roblox_v1` and `roblox_v2`) automatically produces two independent graphs.
`diff_code_graphs` then compares them, and `list_code_graphs` lists them.

The scripts are shipped from the host to the container as base64 so there are
no shell-escaping issues (same trick write_file uses), and they require no
extra dependencies beyond python3 + nm (both present in the sandbox image).
"""
import os
import re
import json

from tool_registry import registry
from tools.common import normalize_path, run_script_in_sandbox

_HERE = os.path.dirname(os.path.abspath(__file__))
_INDEXER_PATH = os.path.join(_HERE, "_kg_indexer.py")
_QUERY_PATH = os.path.join(_HERE, "_kg_query.py")


def _run_script_in_sandbox(script_path, args, timeout):
    return run_script_in_sandbox(script_path, args, timeout)


def _host_build_fallback(root_dir, inc, frc, gid):
    """Build the graph directly on the HOST (no Docker) into the same
    <workspace>/.codegraph/<gid>/ the Graph tab reads.

    Used as a fallback when the sandbox build produced nothing — e.g. the
    container isn't running or the bind mount didn't surface the .codegraph
    directory on the host. That failure mode is exactly what leaves the Graph
    tab stuck on "No knowledge graph found" even though the agent "built" one,
    so we retry natively rather than silently succeeding with no on-disk graph.

    Returns a result dict: {"stdout": ...} on success, else {"error": ...} with a
    concrete reason (so a failure is diagnosable rather than a vague error)."""
    import sys
    import subprocess
    from tools.common import resolve_workspace_path
    try:
        from docker_sandbox import get_workspace_host_path
        host_root = get_workspace_host_path()
    except Exception as e:
        return {"error": "no host workspace is available for a host-side build (%s)" % e}
    if not host_root or not os.path.isdir(host_root):
        return {"error": "host workspace path is missing or not a directory: %r" % host_root}
    target = resolve_workspace_path(root_dir)
    env = dict(os.environ)
    env["CODEGRAPH_WORKSPACE"] = host_root  # graphs land under <host_root>/.codegraph/
    try:
        proc = subprocess.run(
            [sys.executable, _INDEXER_PATH, target, inc, frc, gid],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", env=env, timeout=1800)
    except subprocess.TimeoutExpired:
        return {"error": "host build timed out after 1800s (try a specific sub-directory instead of the whole workspace)"}
    except Exception as e:
        return {"error": "host indexer failed to run: %s" % e}
    if proc.returncode == 0 and proc.stdout:
        return {"stdout": proc.stdout}
    return {"error": (proc.stderr or proc.stdout or "host build failed").strip()[:600]}


def _slug(value):
    """Turn a root_dir or a user-supplied id into a safe graph-namespace slug.

    Mirrors _kg_*.py's _sanitize_graph_id so the id we compute on the host maps to
    the same on-disk directory the sandbox scripts use. Path separators collapse to
    '__' (so 'app/smali' -> 'app__smali') rather than being stripped to the last
    segment, keeping distinct roots distinct.
    """
    s = (value or "").strip().strip("/").replace("\\", "/")
    if s in ("", "."):
        return "root"
    s = re.sub(r"[^A-Za-z0-9._/-]+", "_", s)
    s = s.replace("/", "__")
    s = s.strip("._-")
    return s[:64] or "root"


def _resolve_graph_id(graph_id, root_dir):
    """The explicit id if given, else a slug derived from root_dir."""
    gid = (graph_id or "").strip()
    return _slug(gid) if gid else _slug(root_dir)


# graph_id used when we auto-build a graph over the whole workspace because a
# graph-requiring tool was called before any graph existed.
_AUTO_GRAPH_ID = "workspace"


def _stdout_says_no_graph(res):
    """True when a query result indicates NO graph exists yet (as opposed to a
    graph that exists but simply had no match). Matches the indexer/query
    'no graph built' messages so we can auto-build and retry."""
    out = (res.get("stdout") or "") if isinstance(res, dict) else ""
    markers = (
        "No graph built yet",
        "No graphs built yet",
        "No knowledge graph",
    )
    return any(m in out for m in markers)


def _auto_build_workspace_graph():
    """Build a graph over the ENTIRE workspace ('.') under a stable id. Each
    top-level project becomes its own community, so multiple projects in one
    workspace stay visually and structurally separated while remaining queryable
    as a single graph. Returns the build result (a dict with 'stdout')."""
    return build_code_graph(".", include_so=True, force=False, graph_id=_AUTO_GRAPH_ID)


def _looks_empty(stdout):
    r"""True when an indexer run reported that it found NO classes/functions.

    On Windows this is the tell-tale of the Docker mount's long-path problem:
    Docker Desktop's file sharing can't serve host paths longer than 260 chars,
    so a deeply nested smali tree is silently skipped inside the container and
    the build comes back 'successful' but with 0 classes. We treat that as a
    failure so the host fallback (which opens files via the extended-length
    \\?\ API, where long paths work) gets a chance to actually index them."""
    if not stdout:
        return True
    if "WARNING: 0 classes" in stdout:
        return True
    m = re.search(r"classes=(\d+)", stdout)
    return bool(m) and int(m.group(1)) == 0


def _sandbox_build(sandbox_root, inc, frc, gid):
    """Run the indexer in the Docker sandbox. Returns {"stdout": ...} only when
    it produced a REAL (non-empty) graph; otherwise None (so the caller falls
    back to the host build)."""
    try:
        res = _run_script_in_sandbox(_INDEXER_PATH, [sandbox_root, inc, frc, gid], timeout=900)
    except Exception:
        return None
    out = (res.get("stdout") if isinstance(res, dict) else "") or ""
    if res.get("returncode") == 0 and out and not _looks_empty(out):
        return {"stdout": out}
    return None


@registry.register(
    name="build_code_graph",
    description=(
        "Builds (or refreshes) a queryable knowledge graph of a codebase under a directory — works for ANY large codebase, not just decompiled APKs. "
        "Indexes .smali (Android) AND ordinary source: Python, JavaScript/TypeScript, Java, Kotlin, Go, C/C++, C#, Rust, Ruby, PHP, Swift, Scala. "
        "Use this ONCE when you land in a big/unfamiliar tree (a decompiled APK's apktool/smali dir, OR a normal project root — pass '.' for the whole workspace) so you can query classes/functions/call-graphs/string-refs WITHOUT re-reading thousands of files (saves tokens & context). "
        "Parses each file for: classes (with super/interfaces where available), methods/functions with file:line, call-edges (caller->callee, resolved by name for general source), and string literals. Also indexes exported/imported symbols of every .so via nm. "
        "MULTI-PROJECT / MULTI-VERSION: each build is stored under its own graph_id (defaults to a slug of root_dir), so several graphs coexist without mixing — build one per project/app-version in separate directories, then compare with diff_code_graphs. Building over '.' indexes the whole workspace and separates each top-level project into its own colored community. "
        "Cached under /workspace/.codegraph/<graph_id>/ and only rebuilt when files change (unless force=true). "
        "NOTE: query_code_graph and ask_codebase will auto-build a workspace graph if none exists yet, so you usually don't need to call this by hand — do call it explicitly to index a SPECIFIC sub-directory or to name a version for a later diff. "
        "Returns a compact summary (counts + top classes + the graph_id used) — NOT the source code."
    ),
    params_schema={
        "root_dir": "string (directory to index, relative to /workspace). Examples: '.' for the whole workspace, a project root like 'backend', or a decompiled dir like 'app_decompiled/smali'.",
        "include_so": "boolean (optional, default true) — also index .so native symbol tables",
        "force": "boolean (optional, default false) — force a full rebuild even if cache is fresh",
        "graph_id": "string (optional) — name this graph so it doesn't collide with others. Defaults to a slug of root_dir. Use distinct ids (or distinct root_dirs) when indexing multiple projects/versions you want to keep separate or compare."
    },
    output="A compact summary: the graph_id used, file counts (smali + source, with detected languages), classes count, methods count, call-edges count, string-refs count, and the top 10 classes/modules by method count. NOT the source code. The graph is saved as small chunked JSON files under /workspace/.codegraph/<graph_id>/.",
    when_to_use="Call this ONCE per codebase/project/version to map a big tree. To compare two versions, build each into its OWN graph (different root_dir or explicit graph_id) then call diff_code_graphs. For a single project, query_code_graph/ask_codebase auto-build over the workspace, so prefer those unless you need a specific sub-dir or a named version."
)
def build_code_graph(root_dir, include_so=True, force=False, graph_id=None):
    root_dir = normalize_path(root_dir)
    sandbox_root = "/workspace" if root_dir == "." else "/workspace/" + root_dir
    inc = "1" if include_so in (True, "true", "True", 1, "1") else "0"
    frc = "1" if force in (True, "true", "True", 1, "1") else "0"
    gid = _resolve_graph_id(graph_id, root_dir)

    host_err = None  # remember the host build's error text, for reporting

    def try_host():
        nonlocal host_err
        fb = _host_build_fallback(root_dir, inc, frc, gid)
        if fb and "stdout" in fb and not _looks_empty(fb["stdout"]):
            return {"stdout": fb["stdout"]}
        # Distinguish "ran but found nothing" from a hard error, for the message.
        host_err = (fb or {}).get("error") or (
            "indexed 0 files — is this a directory with source/smali?"
            if fb and "stdout" in fb else "host build unavailable")
        return None

    # The agent host is Windows, where Docker Desktop's file sharing can't serve
    # paths >260 chars and is slow over the bind mount — so the SANDBOX build
    # routinely times out or comes back empty on big decompiled trees (the exact
    # failure the user hit). Index on the HOST first there (long paths via \\?\,
    # straight off local disk, same code path as the working "Build graph"
    # button); use the sandbox only as a backstop. On non-Windows hosts, prefer
    # the sandbox (nm there also fills in .so symbol tables).
    if os.name == "nt":
        r = try_host() or _sandbox_build(sandbox_root, inc, frc, gid)
    else:
        r = _sandbox_build(sandbox_root, inc, frc, gid) or try_host()
    if r:
        return r

    # Nothing produced a graph — surface the most useful reason we have so the
    # agent (and the user) sees WHY instead of a generic failure.
    if host_err:
        return {"error": "Could not build the code graph: %s" % host_err}
    return {"error": "Could not build the code graph (sandbox produced no graph and no host "
                     "workspace was available). Try the 'Build graph' button on the Graph tab."}


@registry.register(
    name="query_code_graph",
    description=(
        "Queries a code knowledge graph built by build_code_graph. Lets you navigate a big codebase (thousands of smali OR ordinary source files) cheaply instead of re-reading them. "
        "AUTO-BUILD: if no graph exists yet and you don't pass a graph_id, this builds one over the whole workspace automatically and answers from it — so you can query straight away without a separate build_code_graph call. "
        "Returns compact results with file:line so you can then read_file_chunk only the relevant slice. "
        "If you built multiple graphs (e.g. several app versions or projects), pass graph_id to pick one; otherwise the most recently built graph is used. "
        "query_type options: "
        "'stats' (graph summary + biggest classes); "
        "'search_classes' (name=substring -> matching class descriptors + files); "
        "'class' (name=class descriptor or 'com.foo.Bar' -> super/interfaces/fields/methods with line + file); "
        "'method' (name='Class;->proto' or substring -> file:line + callees + referenced strings); "
        "'callers' (name=method or class-method -> who calls it, reverse call-edges); "
        "'callees' (name=method or class -> what it calls); "
        "'string_refs' (name=substring -> where that const-string literal is referenced: file:line + holder method — great for finding signature/anti-tamper checks); "
        "'hierarchy' (name=class -> superclass chain + direct subclasses + interfaces); "
        "'so_symbols' (name=.so path or symbol substring -> exported/imported native symbols); "
        "'graphs' (list every graph you've built — ignores name)."
    ),
    params_schema={
        "query_type": "string (stats | search_classes | class | method | callers | callees | string_refs | hierarchy | so_symbols | graphs)",
        "name": "string (the class/method/string/so to look up; meaning depends on query_type; optional for stats/graphs)",
        "limit": "integer (optional, max results to return, default 40)",
        "graph_id": "string (optional) — which built graph to query. Defaults to the most recently built one. Use 'graphs' query_type to list available ids."
    },
    output="Compact text results WITH file:line references, so you can then use read_file_chunk on just the relevant slice. Format depends on query_type. When several graphs exist, the output notes which graph_id was used.",
    when_to_use="Use this to navigate ONE code graph. 'string_refs' finds signature/anti-tamper checks; 'callers' finds who calls a method; 'hierarchy' walks the superclass chain; 'graphs' lists what you've built. To COMPARE two graphs, use diff_code_graphs instead."
)
def query_code_graph(query_type, name="", limit=40, graph_id=None):
    try:
        limit = int(limit)
    except Exception:
        limit = 40
    gid = _slug(graph_id) if (graph_id or "").strip() else ""

    def _run(g):
        r = _run_script_in_sandbox(_QUERY_PATH, [query_type, name, str(limit), g, ""], timeout=120)
        if r.get("returncode") == 0 and r.get("stdout"):
            return {"stdout": r["stdout"]}
        return r

    res = _run(gid)
    # Auto-build: if no graph exists yet and the caller didn't target a specific
    # one, build a workspace graph once and retry — so query_code_graph "just
    # works" the first time instead of erroring out and pushing the model toward
    # sweeping files by hand. 'graphs' lists namespaces and never needs a build.
    if query_type != "graphs" and not gid and _stdout_says_no_graph(res):
        build = _auto_build_workspace_graph()
        retry = _run(_AUTO_GRAPH_ID)
        prefix = (
            "[auto-build] No code graph existed, so I built one over the whole workspace "
            "(graph_id='%s'). Build summary:\n%s\n\n--- query result ---\n"
            % (_AUTO_GRAPH_ID, (build.get("stdout") or build.get("error") or "").strip())
        )
        if "stdout" in retry:
            return {"stdout": prefix + retry["stdout"]}
        return {"stdout": prefix + json.dumps(retry)}
    return res


@registry.register(
    name="list_code_graphs",
    description=(
        "Lists every code knowledge graph you've built with build_code_graph (their graph_id, source root, "
        "class/method/string/so counts, and build time). Use this to see what versions/codebases are already "
        "indexed before querying or diffing them."
    ),
    params_schema={},
    output="A compact table: one row per built graph with its id, root dir and counts.",
    when_to_use="Call this to discover which graph_ids exist (e.g. before diff_code_graphs) or to confirm a build landed in its own namespace."
)
def list_code_graphs():
    res = _run_script_in_sandbox(_QUERY_PATH, ["graphs", "", "40", "", ""], timeout=60)
    if res.get("returncode") == 0 and res.get("stdout"):
        return {"stdout": res["stdout"]}
    return res


@registry.register(
    name="diff_code_graphs",
    description=(
        "Compares TWO code knowledge graphs (e.g. two versions of the same app) and reports what changed, WITHOUT "
        "re-reading either codebase. Build each version into its own graph first (build_code_graph with a distinct "
        "root_dir or graph_id), then diff them. "
        "Reports: classes added / removed / changed (a class is 'changed' if methods were added/removed or a method's "
        "call-set or string literals changed); string-literal deltas; and native (.so) symbol deltas. "
        "The string and native-symbol deltas survive obfuscation/renaming, so they stay meaningful even when class "
        "names are minified differently between builds — ideal for comparing two releases of an obfuscated app."
    ),
    params_schema={
        "graph_a": "string — graph_id of the FIRST/old version (as shown by list_code_graphs; often a slug of its root_dir)",
        "graph_b": "string — graph_id of the SECOND/new version to compare against A",
        "limit": "integer (optional, default 40) — max examples to show per change category"
    },
    output="A compact diff report: class add/remove/change counts with examples, string-literal deltas, and native-symbol deltas. Not the source — use query_code_graph / read_file_chunk to drill into anything interesting.",
    when_to_use="Use this when asked to compare two versions of an app ('what changed between v1 and v2'). It keeps the two codebases in separate graphs so they never mix, and surfaces the real differences (including obfuscation-resistant string/symbol changes) cheaply."
)
def diff_code_graphs(graph_a, graph_b, limit=40):
    try:
        limit = int(limit)
    except Exception:
        limit = 40
    a = _slug(graph_a)
    b = _slug(graph_b)
    res = _run_script_in_sandbox(_QUERY_PATH, ["diff", "", str(limit), a, b], timeout=180)
    if res.get("returncode") == 0 and res.get("stdout"):
        return {"stdout": res["stdout"]}
    return res
