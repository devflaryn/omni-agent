import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionFiles, ProjectStore, projectSlug } from "../server/projects.mjs";

const base = mkdtempSync(join(tmpdir(), "omni-projects-"));
after(() => rmSync(base, { recursive: true, force: true }));

test("projectSlug is stable and safe", () => {
  const dir = join(base, "My Repo");
  assert.equal(projectSlug(dir), projectSlug(dir + "/"));
  const s = projectSlug("C:\\A b\\My Repo");
  assert.ok(s.startsWith("my-repo-"), s);
  assert.match(s, /^[a-z0-9._-]+-[0-9a-f]{8}$/);
  assert.notEqual(projectSlug("C:\\x\\app"), projectSlug("C:\\y\\app"));
});

test("project() creates the layout once", async () => {
  const store = new ProjectStore({ root: join(base, "store1") });
  const dir = join(base, "proj1"); mkdirSync(dir);
  const p = store.project(dir);
  for (const d of [p.root, p.memoryDir, p.graphDir, p.artifactsDir, p.missionsDir]) assert.ok(existsSync(d), d);
  const first = JSON.parse(readFileSync(join(p.root, "project.json"), "utf8"));
  await new Promise((r) => setTimeout(r, 5));
  store.project(dir);
  const second = JSON.parse(readFileSync(join(p.root, "project.json"), "utf8"));
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.name, "proj1");
  assert.deepEqual(store.list().map((x) => x.name), ["proj1"]);
  assert.ok(!existsSync(join(dir, "graphify-out")) && !existsSync(join(dir, ".omni")), "nothing written into the project");
});

test("two missions share a project", () => {
  const store = new ProjectStore({ root: join(base, "store2") });
  const dir = join(base, "proj2"); mkdirSync(dir);
  const p = store.project(dir);
  const a = new MissionFiles({ dir: join(p.missionsDir, "m-a") }), b = new MissionFiles({ dir: join(p.missionsDir, "m-b") });
  a.write({ id: "m-a" }); b.write({ id: "m-b" });
  assert.equal(a.read().id, "m-a");
  assert.equal(b.read().id, "m-b");
});

test("MissionFiles round-trips and appends", () => {
  const f = new MissionFiles({ dir: join(base, "mf") });
  assert.equal(f.read(), null);
  f.write({ id: "m-1", n: 1 });
  assert.deepEqual(f.read(), { id: "m-1", n: 1 });
  f.append({ kind: "a" }); f.append({ kind: "b" });
  const lines = readFileSync(join(f.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["a", "b"]);
  assert.ok(lines[0].ts > 0);
  f.ledger("task t1 added"); f.ledger("worker a-1 done");
  const led = readFileSync(join(f.dir, "ledger.md"), "utf8");
  assert.match(led, /^- \d{4}-\d\d-\d\dT.* task t1 added$/m);
  assert.match(led, /worker a-1 done/);
  const rp = f.writeReport("a-12345678", "## Status\ndone");
  assert.ok(rp.includes(join("reports", "a-12345678.md")));
  assert.equal(readFileSync(rp, "utf8"), "## Status\ndone");
  const bp = f.writeBrief("a-12345678", "brief");
  assert.ok(bp.includes(join("workers", "a-12345678", "brief.md")));
});
