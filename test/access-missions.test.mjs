import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, describe } from "../server/access.mjs";

test("remote access: mission reads are reads, agent tool endpoints are host-only, changes need approval", () => {
  for (const p of ["/api/missions", "/api/missions/m-0123abcd", "/api/missions/m-0123abcd/report/a-0123abcd", "/api/missions/m-0123abcd/kg/search", "/api/missions/scope"]) assert.equal(classify("GET", p), "read", p);
  for (const p of ["/api/missions/tool", "/mcp", "/api/missions/m-0123abcd/kg/load"]) assert.equal(classify("POST", p), "host", p);
  for (const p of ["/api/missions", "/api/missions/m-0123abcd/message", "/api/missions/m-0123abcd/stop", "/api/missions/m-0123abcd/workers/a-0123abcd/message"]) assert.equal(classify("POST", p), "write", p);
  assert.match(describe("POST", "/api/missions/m-0123abcd/stop").title, /Pause mission m-0123abcd .*stops every worker/);
  assert.equal(describe("POST", "/api/missions/m-0123abcd/message", { text: "hi" }).text, "hi");
  assert.match(describe("POST", "/api/missions", { dir: "C:/x", goal: "g", bossModel: "a/b" }).title, /Start a mission in C:\/x \(boss a\/b\)/);
});
