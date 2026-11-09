import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(process.cwd(), "desktop", "omni_desktop.pyw");
// Windows installs `python`; macOS and most Linux distros only ship `python3`.
const PY = ["python3", "python"].find((p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0);
const havePython = !!PY;
const run = (...args) => spawnSync(PY, [script, ...args], { encoding: "utf8" });

test("desktop launcher --plan prints node args with --cwd, and no --lan (that listener is gone)", { skip: !havePython && "python not on PATH" }, () => {
  const r = run("--plan", "C:\\some\\project", "--port", "4567", "--lan");
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.port, 4567);
  assert.equal(plan.url, "http://127.0.0.1:4567/?desktop=1");
  assert.ok(!plan.args.includes("--lan"), "not added, and not passed on when given");
  assert.equal(plan.args[plan.args.indexOf("--cwd") + 1], "C:\\some\\project");
  assert.ok(plan.args[1].endsWith("index.mjs"));
  assert.ok(!plan.args.includes("--plan"));
});

test("desktop launcher hands the logo to pywebview on Windows, or the window gets Python's icon", { skip: (!havePython && "python not on PATH") || (process.platform !== "win32" && "Windows only") }, () => {
  const code = `
import importlib.machinery, importlib.util, json, os, sys, types
seen = {}
fake = types.ModuleType("webview")
class Win:
    def evaluate_js(self, _): raise SystemExit
fake.create_window = lambda *a, **k: Win()
fake.start = lambda **k: seen.update(k)
sys.modules["webview"] = fake
loader = importlib.machinery.SourceFileLoader("omni_desktop", sys.argv[1])
spec = importlib.util.spec_from_loader("omni_desktop", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.open_window("http://x/")
print(json.dumps({"icon": seen.get("icon"), "exists": os.path.isfile(seen.get("icon") or "")}))
`;
  const r = spawnSync(PY, ["-c", code, script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.match(got.icon, /omni\.ico$/);
  assert.equal(got.exists, true, "the logo file ships with the launcher");
});

test("desktop launcher defaults cwd to the Desktop", { skip: !havePython && "python not on PATH" }, () => {
  const r = run("--plan");
  const plan = JSON.parse(r.stdout);
  assert.match(plan.args[plan.args.indexOf("--cwd") + 1], /Desktop$/);
});

test("desktop launcher --plan emits exactly one --port followed by the value", { skip: !havePython && "python not on PATH" }, () => {
  const r = run("--plan", "--port", "4567");
  const plan = JSON.parse(r.stdout);
  const count = plan.args.filter((a) => a === "--port").length;
  assert.equal(count, 1);
  assert.equal(plan.args[plan.args.indexOf("--port") + 1], "4567");
});

test("desktop launcher --plan reports the platform and a real node path", { skip: !havePython && "python not on PATH" }, () => {
  const r = run("--plan");
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.platform, process.platform === "win32" ? "windows" : process.platform);
  assert.ok(plan.node, "node resolved");
});
