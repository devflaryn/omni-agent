import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(process.cwd(), "desktop", "omni_desktop.pyw");
const py = spawnSync("python", ["--version"], { encoding: "utf8" });
const havePython = py.status === 0;

test("desktop launcher --plan prints node args with --lan and --cwd", { skip: !havePython && "python not on PATH" }, () => {
  const r = spawnSync("python", [script, "--plan", "C:\\some\\project", "--port", "4567"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.port, 4567);
  assert.equal(plan.url, "http://127.0.0.1:4567/?desktop=1");
  assert.ok(plan.args.includes("--lan"));
  assert.equal(plan.args[plan.args.indexOf("--cwd") + 1], "C:\\some\\project");
  assert.ok(plan.args[1].endsWith("index.mjs"));
  assert.ok(!plan.args.includes("--plan"));
});

test("desktop launcher defaults cwd to the Desktop", { skip: !havePython && "python not on PATH" }, () => {
  const r = spawnSync("python", [script, "--plan"], { encoding: "utf8" });
  const plan = JSON.parse(r.stdout);
  assert.match(plan.args[plan.args.indexOf("--cwd") + 1], /Desktop$/);
});
