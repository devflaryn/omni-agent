"""Code Knowledge Graph tools.

These let the agent analyze thousands of .smali files (and .so native symbol
tables) WITHOUT re-reading them every turn, which saves a huge amount of
tokens and context. The heavy lifting is done by two Python scripts:

  - _kg_indexer.py : walks a directory, parses every .smali file into a graph
                     (classes / methods / call-edges / string-xrefs / .so
                     symbols), and caches it under <project>/.codegraph/
  - _kg_query.py   : answers compact queries against those cached graphs

NAMED GRAPHS (multi-version support)
------------------------------------
Each build is stored in its OWN namespace, <project>/.codegraph/<graph_id>/, so
several graphs can coexist instead of overwriting/mixing. `graph_id` defaults to a
slug of `root_dir`, so indexing two versions of an app in different directories
(e.g. `roblox_v1` and `roblox_v2`) automatically produces two independent graphs.
`diff_code_graphs` then compares them, and `list_code_graphs` lists them.

The scripts are piped into python3 as base64 so there are no shell-escaping
issues (same trick write_file uses), and they require no extra dependencies
beyond python3 + nm. Running them through the shell tool path (rather than
importing them) is deliberate: a full index of a large tree can take minutes,
and that path is the one that honors the user's Stop button and the timeout
decider. An in-process build is kept as a backstop for when the shell run comes
back empty.
"""
import os
import re
import json

from tool_registry import registry
from tools.common import normalize_path, run_python_script

_HERE = os.path.dirname(os.path.abspath(__file__))
_INDEXER_PATH = os.path.join(_HERE, "_kg_indexer.py")
_QUERY_PATH = os.path.join(_HERE, "_kg_query.py")


def _run_python_script(script_path, args, timeout):
    return run_python_script(script_path, args, timeout)


def _host_build_fallback(root_dir, inc, frc, gid):
    """Build the graph IN-PROCESS (this app's own interpreter) into the same
    <workspace>/.codegraph/<gid>/ the Graph tab reads.

    Used as a backstop when the shell build produced nothing — e.g. no `python3`
    resolved on PATH, or the indexer walked the wrong root. That failure mode is
    exactly what leaves the Graph tab stuck on "No knowledge graph found" even
    though the agent "built" one, so we retry with the interpreter we know exists
    rather than silently succeeding with no on-disk graph.

    Returns a result dict: {"stdout": ...} on success, else {"error": ...} with a
    concrete reason (so a failure is diagnosable rather than a vague error)."""
    import sys
    import subprocess
    from tools.common import resolve_workspace_path
    try:
        from host_exec import workspace_root
        host_root = workspace_root()
    except Exception as e:
        return {"error": "no host workspace is available for a host-side build (%s)" % e}
    if not host_root or not os.path.isdir(host_root):
        return {"error": "host workspace path is missing or not a directory: %r" % host_root}
    target = resolve_workspace_path(root_dir)
    # Inherit the tool PATH (llvm/binutils `nm` for .so symbol tables, which the
    # app's own bare environment may not have) and then pin the workspace root.
    from host_exec import build_env
    env = build_env()
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
    the same on-disk directory the indexer/query scripts use. Path separators collapse to
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

    A build that walks the wrong root, or is stopped by a path the walker can't
    open (on Windows, a deeply nested smali tree past the 260-char limit),
    reports 'successful' with 0 classes. Treating that as a failure is what lets
    the in-process backstop — which opens files via the extended-length \\?\ API
    — get a chance to actually index them."""
    if not stdout:
        return True
    if "WARNING: 0 classes" in stdout:
        return True
    m = re.search(r"classes=(\d+)", stdout)
    return bool(m) and int(m.group(1)) == 0


def _shell_build(root_dir, inc, frc, gid):
    """Run the indexer through the shell tool path (so Stop and the timeout
    decider apply to a long index). Returns {"stdout": ...} only when it produced
    a REAL (non-empty) graph; otherwise None, so the caller falls back to the
    in-process build."""
    try:
        res = _run_python_script(_INDEXER_PATH, [root_dir, inc, frc, gid], timeout=900)
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
        "Cached in the project folder/.codegraph/<graph_id>/ and only rebuilt when files change (unless force=true). "
        "NOTE: query_code_graph and ask_codebase will auto-build a workspace graph if none exists yet, so you usually don't need to call this by hand — do call it explicitly to index a SPECIFIC sub-directory or to name a version for a later diff. "
        "Returns a compact summary (counts + top classes + the graph_id used) — NOT the source code."
    ),
    params_schema={
        "root_dir": "string (directory to index, relative to the project root). Examples: '.' for the whole workspace, a project root like 'backend', or a decompiled dir like 'app_decompiled/smali'.",
        "include_so": "boolean (optional, default true) — also index .so native symbol tables",
        "force": "boolean (optional, default false) — force a full rebuild even if cache is fresh",
        "graph_id": "string (optional) — name this graph so it doesn't collide with others. Defaults to a slug of root_dir. Use distinct ids (or distinct root_dirs) when indexing multiple projects/versions you want to keep separate or compare."
    },
    output="A compact summary: the graph_id used, file counts (smali + source, with detected languages), classes count, methods count, call-edges count, string-refs count, and the top 10 classes/modules by method count. NOT the source code. The graph is saved as small chunked JSON files in the project folder/.codegraph/<graph_id>/.",
    when_to_use="Call this ONCE per codebase/project/version to map a big tree. To compare two versions, build each into its OWN graph (different root_dir or explicit graph_id) then call diff_code_graphs. For a single project, query_code_graph/ask_codebase auto-build over the workspace, so prefer those unless you need a specific sub-dir or a named version."
)
def build_code_graph(root_dir, include_so=True, force=False, graph_id=None):
    root_dir = normalize_path(root_dir)
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

    # Prefer the shell build: indexing a large decompiled tree runs for minutes,
    # and only that path is interruptible by the user's Stop button and eligible
    # for the timeout decider's extensions. On Windows it can still come back
    # empty (paths past the 260-char limit), so the in-process build — which
    # opens files via the extended-length \\?\ API — is the backstop everywhere.
    r = _shell_build(root_dir, inc, frc, gid) or try_host()
    if r:
        return r

    # Nothing produced a graph — surface the most useful reason we have so the
    # agent (and the user) sees WHY instead of a generic failure.
    if host_err:
        return {"error": "Could not build the code graph: %s" % host_err}
    return {"error": "Could not build the code graph (the indexer produced no graph and no "
                     "workspace was active). Try the 'Build graph' button on the Graph tab."}


@registry.register(
    name="query_code_graph",
    description=(
        "Navigate a big codebase (thousands of smali OR source files) via its code knowledge graph instead of "
        "re-reading files — every result comes back as file:line so you read_file_chunk only the exact slice. "
        "AUTO-BUILDS a workspace graph on first use, so it just works.\n"
        "SIMPLEST USE — pass only name= and it SEARCHES EVERYTHING (string literals + methods + classes + native "
        "symbols) at once; you do NOT need to pick a query_type:\n"
        '  {\"tool\":\"query_code_graph\",\"args\":{\"name\":\"isRooted\"}}          # find a check/method/anything\n'
        '  {\"tool\":\"query_code_graph\",\"args\":{\"name\":\"/system/xbin/su\"}}   # find where a literal is used\n'
        "Reach for a specific query_type only to drill in after a search hit:\n"
        "  string_refs (where a const-string is referenced — best for root/license/signature/pinning checks), "
        "callers (who calls a method), callees (what it calls), class (fields+methods of a class), "
        "method (a method's file:line + callees + strings), hierarchy (super/subclasses), "
        "so_symbols (native .so exports/imports), stats (graph overview), graphs (list built graphs). "
        "Class names are matched loosely ('com.foo.Bar', 'Bar', or 'Lcom/foo/Bar;' all work)."
    ),
    params_schema={
        "name": "string — the identifier/literal to look up (method, class fragment, string, or symbol). This is the main argument.",
        "query_type": "string (OPTIONAL, default 'search' = search everything). Only set it to drill in: string_refs | callers | callees | class | method | hierarchy | so_symbols | stats | search_classes | graphs.",
        "limit": "integer (optional, max results, default 40)",
        "graph_id": "string (optional) — which built graph to query; defaults to the most recent. Use query_type='graphs' to list ids."
    },
    output="Compact text WITH file:line references. The default 'search' groups hits into STRING LITERALS / METHODS / CLASSES / NATIVE SYMBOLS; then read_file_chunk the exact file:line or drill in with callers/callees/class on a hit.",
    when_to_use="FIRST move on any big/obfuscated tree: pass name= to locate something (a check, a class, a string) without picking an axis. Then drill in with a specific query_type. To COMPARE two graphs use diff_code_graphs.",
    summary="search a big codebase's graph by any identifier/string -> file:line hits (auto-builds; no query_type needed)",
)
def query_code_graph(name="", query_type="search", limit=40, graph_id=None):
    try:
        limit = int(limit)
    except Exception:
        limit = 40
    gid = _slug(graph_id) if (graph_id or "").strip() else ""

    def _run(g):
        r = _run_python_script(_QUERY_PATH, [query_type, name, str(limit), g, ""], timeout=120)
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
    res = _run_python_script(_QUERY_PATH, ["graphs", "", "40", "", ""], timeout=60)
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
    res = _run_python_script(_QUERY_PATH, ["diff", "", str(limit), a, b], timeout=180)
    if res.get("returncode") == 0 and res.get("stdout"):
        return {"stdout": res["stdout"]}
    return res
