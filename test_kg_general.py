"""Host-only regression test for the GENERALIZED code knowledge graph.

Unlike test_code_graph.py (which drives the tools through the live Docker
sandbox), this test runs the indexer/query scripts directly on the host via the
CODEGRAPH_WORKSPACE env override, so it needs nothing but python3. It verifies
that build_code_graph now indexes ordinary source — Python, JavaScript and Java
— into the same schema smali uses, that call edges resolve across files, that
string literals and class hierarchy are captured, and that multiple top-level
projects in one workspace land in separate communities.

Run from the project root:
    python test_kg_general.py
"""
import os
import sys
import shutil
import json
import tempfile
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
INDEXER = os.path.join(HERE, "tools", "_kg_indexer.py")
QUERY = os.path.join(HERE, "tools", "_kg_query.py")

PY = """\
class Base:
    def __init__(self):
        self.x = 1

class Auth(Base):
    def login(self, user):
        token = "SECRET_TOKEN"
        return self.validate(user)

    def validate(self, user):
        if check_signature(user):
            return True
        return False

def check_signature(u):
    msg = "GET_SIGNATURES"
    return len(u) > 0
"""

JS = """\
class Widget extends Base {
  render() {
    const label = "hello-widget";
    return draw(label);
  }
}
function draw(x) {
  return x + "!";
}
"""

JAVA = """\
public class Server extends Thread implements Runnable {
    private int port;
    public void start() {
        String banner = "welcome-banner";
        handle(banner);
    }
    public void handle(String s) {
        System.out.println(s);
    }
}
"""


def run(script, args, ws):
    env = dict(os.environ, CODEGRAPH_WORKSPACE=ws)
    r = subprocess.run([sys.executable, script] + [str(a) for a in args],
                       capture_output=True, text=True, env=env, timeout=120)
    if r.returncode != 0:
        raise AssertionError("script failed: %s\n%s" % (script, r.stderr))
    return r.stdout


def check(cond, msg):
    if not cond:
        raise AssertionError("FAILED: " + msg)
    print("  ok:", msg)


def main():
    ws = tempfile.mkdtemp(prefix="kg_general_")
    try:
        os.makedirs(os.path.join(ws, "backend"))
        os.makedirs(os.path.join(ws, "frontend"))
        os.makedirs(os.path.join(ws, "service"))
        with open(os.path.join(ws, "backend", "auth.py"), "w") as f:
            f.write(PY)
        with open(os.path.join(ws, "frontend", "app.js"), "w") as f:
            f.write(JS)
        with open(os.path.join(ws, "service", "Server.java"), "w") as f:
            f.write(JAVA)

        print(">>> build (whole workspace, as auto-build does)")
        out = run(INDEXER, [ws, "0", "1", "workspace"], ws)
        print(out.strip().splitlines()[-1] if out.strip() else "(no output)")

        print(">>> class Auth: super + methods")
        out = run(QUERY, ["class", "Auth", "40", "workspace"], ws)
        check("super: Base" in out, "Auth records super=Base")
        check("login" in out and "validate" in out, "Auth methods captured")

        print(">>> method login: cross-method call resolved + string literal")
        out = run(QUERY, ["method", "login", "40", "workspace"], ws)
        check("->validate" in out, "login -> validate call resolved")
        check("SECRET_TOKEN" in out, "login string literal captured")

        print(">>> callers of validate")
        out = run(QUERY, ["callers", "validate", "40", "workspace"], ws)
        check("login" in out, "validate has login as a caller")

        print(">>> callees of Auth (module-level fn resolution)")
        out = run(QUERY, ["callees", "Auth", "40", "workspace"], ws)
        check("check_signature" in out, "validate -> check_signature resolved to module fn")

        print(">>> string_refs across languages")
        out = run(QUERY, ["string_refs", "GET_SIGNATURES", "40", "workspace"], ws)
        check("auth.py" in out, "python string ref found with file")
        out = run(QUERY, ["string_refs", "welcome-banner", "40", "workspace"], ws)
        check("Server.java" in out, "java string ref found with file")

        print(">>> hierarchy for JS class")
        out = run(QUERY, ["hierarchy", "Widget", "40", "workspace"], ws)
        check("Base" in out, "Widget super chain includes Base")

        print(">>> graph_data: 3 projects -> 3 communities")
        out = run(QUERY, ["graph_data", "", "40", "workspace"], ws)
        data = json.loads(out)
        labels = sorted(l["label"] for l in data["legend"])
        check(labels == ["backend", "frontend", "service"],
              "communities are the 3 top-level projects, got %s" % labels)
        check(len(data["nodes"]) > 0 and len(data["stats"]) > 0, "viz nodes + stats present")

        print(">>> no-graph query message (drives auto-build detection)")
        empty_ws = tempfile.mkdtemp(prefix="kg_empty_")
        try:
            out = run(QUERY, ["stats", "", "40", ""], empty_ws)
            check("No graph built yet" in out, "empty workspace reports 'No graph built yet'")
        finally:
            shutil.rmtree(empty_ws, ignore_errors=True)

        print("\nALL GENERAL-GRAPH TESTS PASSED.")
    finally:
        shutil.rmtree(ws, ignore_errors=True)


if __name__ == "__main__":
    main()
