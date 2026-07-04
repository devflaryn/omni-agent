"""Code Knowledge Graph tools.

These let the agent analyze thousands of .smali files (and .so native symbol
tables) WITHOUT re-reading them every turn, which saves a huge amount of
tokens and context. The heavy lifting is done by two Python scripts that run
INSIDE the Docker sandbox:

  - _kg_indexer.py : walks a directory, parses every .smali file into a graph
                     (classes / methods / call-edges / string-xrefs / .so
                     symbols), and caches it at /workspace/.codegraph/graph.json
  - _kg_query.py   : answers compact queries against that cached graph

The scripts are shipped from the host to the container as base64 so there are
no shell-escaping issues (same trick write_file uses), and they require no
extra dependencies beyond python3 + nm (both present in the sandbox image).
"""
import os

from tool_registry import registry
from tools.common import normalize_path, run_script_in_sandbox

_HERE = os.path.dirname(os.path.abspath(__file__))
_INDEXER_PATH = os.path.join(_HERE, "_kg_indexer.py")
_QUERY_PATH = os.path.join(_HERE, "_kg_query.py")


def _run_script_in_sandbox(script_path, args, timeout):
    return run_script_in_sandbox(script_path, args, timeout)


@registry.register(
    name="build_code_graph",
    description=(
        "Builds (or refreshes) a queryable knowledge graph of all .smali code (and optionally .so native symbols) under a directory. "
        "Use this ONCE after decompiling an APK (e.g. root_dir = the apktool output dir, or a specific smali* folder) so you can later query classes/methods/call-graphs/string-xrefs WITHOUT re-reading thousands of files (saves tokens & context). "
        "Parses every .smali file for: class/super/interfaces, methods (with file:line), fields, invoke call-edges (caller->callee), and const-string references. "
        "Also indexes exported/imported symbols of every .so file via nm. "
        "The graph is cached at /workspace/.codegraph/graph.json and only rebuilt when smali files change (unless force=true). "
        "Returns a compact summary (counts + top classes) — NOT the source code. After this, use query_code_graph to navigate."
    ),
    params_schema={
        "root_dir": "string (directory to index, e.g. 'app_decompiled' or 'app_decompiled/smali', relative to /workspace)",
        "include_so": "boolean (optional, default true) — also index .so native symbol tables",
        "force": "boolean (optional, default false) — force a full rebuild even if cache is fresh"
    },
    output="A compact summary: smali_files count, classes count, methods count, call-edges count, string-refs count, and the top 10 classes by method count. NOT the source code. The graph is saved as small chunked JSON files under /workspace/.codegraph/.",
    when_to_use="Call this ONCE after decompiling an APK (root_dir = apktool output) so you can later query classes/methods/call-graphs/string-xrefs cheaply via query_code_graph instead of re-reading thousands of smali files."
)
def build_code_graph(root_dir, include_so=True, force=False):
    root_dir = normalize_path(root_dir)
    sandbox_root = "/workspace" if root_dir == "." else "/workspace/" + root_dir
    inc = "1" if include_so in (True, "true", "True", 1, "1") else "0"
    frc = "1" if force in (True, "true", "True", 1, "1") else "0"
    res = _run_script_in_sandbox(_INDEXER_PATH, [sandbox_root, inc, frc], timeout=900)
    if res.get("returncode") == 0 and res.get("stdout"):
        return {"stdout": res["stdout"]}
    return res


@registry.register(
    name="query_code_graph",
    description=(
        "Queries the code knowledge graph built by build_code_graph. Lets you navigate thousands of .smali files cheaply instead of re-reading them. "
        "Returns compact results with file:line so you can then read_file_chunk only the relevant slice. "
        "query_type options: "
        "'stats' (graph summary + biggest classes); "
        "'search_classes' (name=substring -> matching class descriptors + files); "
        "'class' (name=class descriptor or 'com.foo.Bar' -> super/interfaces/fields/methods with line + file); "
        "'method' (name='Class;->proto' or substring -> file:line + callees + referenced strings); "
        "'callers' (name=method or class-method -> who calls it, reverse call-edges); "
        "'callees' (name=method or class -> what it calls); "
        "'string_refs' (name=substring -> where that const-string literal is referenced: file:line + holder method — great for finding signature/anti-tamper checks); "
        "'hierarchy' (name=class -> superclass chain + direct subclasses + interfaces); "
        "'so_symbols' (name=.so path or symbol substring -> exported/imported native symbols)."
    ),
    params_schema={
        "query_type": "string (stats | search_classes | class | method | callers | callees | string_refs | hierarchy | so_symbols)",
        "name": "string (the class/method/string/so to look up; meaning depends on query_type; optional for stats)",
        "limit": "integer (optional, max results to return, default 40)"
    },
    output="Compact text results WITH file:line references, so you can then use read_file_chunk on just the relevant slice. Format depends on query_type — e.g. 'class' shows super/interfaces/fields/methods with line numbers; 'callers' shows reverse call-edges; 'string_refs' shows where a string literal is used (file:line + holder method).",
    when_to_use="Use this to navigate the code graph built by build_code_graph. 'string_refs' is great for finding signature/anti-tamper checks. 'callers' finds who calls a method. 'hierarchy' walks the superclass chain."
)
def query_code_graph(query_type, name="", limit=40):
    try:
        limit = int(limit)
    except Exception:
        limit = 40
    res = _run_script_in_sandbox(_QUERY_PATH, [query_type, name, str(limit)], timeout=120)
    if res.get("returncode") == 0 and res.get("stdout"):
        return {"stdout": res["stdout"]}
    return res
