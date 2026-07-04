"""End-to-end test for the code knowledge graph tools, run against the live
Docker sandbox (re_agent_sandbox). It creates a small synthetic smali tree,
builds the graph, and exercises every query_code_graph query type.

Run from the project root:
    python test_code_graph.py
"""
import json
import tools  # noqa: F401  (registers all tools)
from tool_registry import registry

SMALI_A = """\
.class public Lcom/example/Foo;
.super Lcom/example/Base;
.implements Lcom/example/ILog;

# instance fields
.field public tag:Ljava/lang/String;
.field private counter:I

# direct methods
.method public constructor <init>()V
    .registers 1
    invoke-direct {p0}, Lcom/example/Base;-><init>()V
    const-string v0, "FOO_INIT"
    invoke-virtual {p0, v0}, Lcom/example/Foo;->log(Ljava/lang/String;)V
    return-void
.end method

# virtual methods
.method public doWork(Ljava/lang/String;)I
    .registers 3
    const-string v1, "signature"
    invoke-virtual {p0, v1}, Lcom/example/Foo;->check(Ljava/lang/String;)Z
    invoke-static {p1}, Lcom/example/Util;->hash(Ljava/lang/String;)I
    return v1
.end method

.method public log(Ljava/lang/String;)V
    .registers 2
    invoke-interface {p0, p1}, Lcom/example/ILog;->write(Ljava/lang/String;)V
    return-void
.end method

.method public check(Ljava/lang/String;)Z
    .registers 2
    const-string v0, "GET_SIGNATURES"
    invoke-virtual {p1}, Ljava/lang/String;->length()I
    const/4 v0, 0x1
    return v0
.end method
"""

SMALI_BASE = """\
.class public Lcom/example/Base;
.super Ljava/lang/Object;

.method public constructor <init>()V
    .registers 1
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    return-void
.end method
"""

SMALI_UTIL = """\
.class public final Lcom/example/Util;
.super Ljava/lang/Object;

.method public static hash(Ljava/lang/String;)I
    .registers 2
    const-string v0, "hashing"
    invoke-virtual {p1}, Ljava/lang/String;->hashCode()I
    return v0
.end method
"""


def write(path, content):
    wf = registry.execute("write_file", {"filepath": path, "content": content})
    print("  write_file", path, "->", wf.get("stdout", "").strip() or wf)


def run_tool(name, args):
    print("\n=== %s %s ===" % (name, json.dumps(args)))
    res = registry.execute(name, args)
    out = res.get("stdout", "")
    if not out:
        out = json.dumps(res)
    print(out[:2500])
    return out


def main():
    print(">>> Setting up synthetic smali tree in /workspace/kg_test ...")
    write("kg_test/smali/com/example/Foo.smali", SMALI_A)
    write("kg_test/smali/com/example/Base.smali", SMALI_BASE)
    write("kg_test/smali/com/example/Util.smali", SMALI_UTIL)

    print("\n>>> Building graph ...")
    run_tool("build_code_graph", {"root_dir": "kg_test", "include_so": False, "force": True})

    print("\n>>> query: stats")
    run_tool("query_code_graph", {"query_type": "stats"})

    print("\n>>> query: search_classes name=example")
    run_tool("query_code_graph", {"query_type": "search_classes", "name": "example"})

    print("\n>>> query: class name=Lcom/example/Foo;")
    run_tool("query_code_graph", {"query_type": "class", "name": "Lcom/example/Foo;"})

    print("\n>>> query: method name=doWork")
    run_tool("query_code_graph", {"query_type": "method", "name": "doWork"})

    print("\n>>> query: callers name=check")
    run_tool("query_code_graph", {"query_type": "callers", "name": "check"})

    print("\n>>> query: callees name=Lcom/example/Foo;->doWork")
    run_tool("query_code_graph", {"query_type": "callees", "name": "Lcom/example/Foo;->doWork(Ljava/lang/String;)I"})

    print("\n>>> query: string_refs name=signature")
    run_tool("query_code_graph", {"query_type": "string_refs", "name": "signature"})

    print("\n>>> query: string_refs name=GET_SIGNATURES")
    run_tool("query_code_graph", {"query_type": "string_refs", "name": "GET_SIGNATURES"})

    print("\n>>> query: hierarchy name=Lcom/example/Foo;")
    run_tool("query_code_graph", {"query_type": "hierarchy", "name": "Lcom/example/Foo;"})

    print("\n>>> query: so_symbols (none expected) name=lib")
    run_tool("query_code_graph", {"query_type": "so_symbols", "name": "lib"})

    print("\n>>> Re-run build (should say up-to-date) ...")
    run_tool("build_code_graph", {"root_dir": "kg_test", "include_so": False, "force": False})

    print("\n>>> ALL DONE.")


if __name__ == "__main__":
    main()
