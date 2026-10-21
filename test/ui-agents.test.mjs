// test/ui-agents.test.mjs — background agents in the UI: nested history, the agents strip, report cards, Long runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nestSessions, agentTag, agentTone, agentKindLabel, agentTitle, agentsFor, agentSummary, agentSubline, agentElapsed, agentResultInfo, agentReportKey, withLiveReports, mergeAgentSnapshot, parseCompactAt, compactAtK, compactAtFromField, toolKind, toolLabel, AGENT_ACTIVE } from "../ui/lib.js";

// A DOM just big enough for sidebar.js and transcript.js's system-message path.
class FakeEl {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.className = ""; this.dataset = {}; this.attrs = {}; this.text = ""; this.html = ""; this.hidden = false; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; }
  get childNodes() { return this.children; }
  appendChild(c) { if (c && typeof c === "object") c.parent = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? { text: c, textContent: c } : c); }
  prepend(c) { if (c && typeof c === "object") c.parent = this; this.children.unshift(c); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  set textContent(v) { this.text = String(v ?? ""); this.children = []; }
  get textContent() { return this.text + this.children.map((c) => c.textContent ?? "").join(""); }
  set innerHTML(v) { this.html = String(v); this.text = ""; this.children = []; }
  get innerHTML() { return this.html; }
  insertAdjacentHTML(_where, h) { this.html += h; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() { /* */ }
  get classList() { const self = this; return { contains: (c) => self.className.split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  find(pred) { for (const c of this.children) { if (c instanceof FakeEl) { if (pred(c)) return c; const f = c.find(pred); if (f) return f; } } return null; }
  findAll(pred, out = []) { for (const c of this.children) if (c instanceof FakeEl) { if (pred(c)) out.push(c); c.findAll(pred, out); } return out; }
}
const hasClass = (cls) => (e) => e.className.split(/\s+/).includes(cls);
function withDom(ids, fn) {
  const prev = globalThis.document;
  globalThis.document = { createElement: (t) => new FakeEl(t), querySelector: (s) => ids[s] || null };
  try { return fn(); } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
}

// ------------------------------------------------------------------ nesting
test("nestSessions puts an agent's chat right under its parent, one level deeper, whatever its own date", () => {
  const list = [
    { sid: "pi:child", parentSid: "pi:p" },   // newest: the agent is busy while its parent waits
    { sid: "pi:x" },
    { sid: "pi:p" },
    { sid: "claude:k", parentSid: "pi:p" },
  ];
  assert.deepEqual(nestSessions(list).map(({ s, depth }) => `${s.sid}@${depth}`), ["pi:x@0", "pi:p@0", "pi:child@1", "claude:k@1"]);
});

test("nestSessions keeps a chat whose parent is not listed at the top level, and nests two levels", () => {
  const list = [{ sid: "pi:orphan", parentSid: "pi:gone" }, { sid: "pi:grand", parentSid: "pi:kid" }, { sid: "pi:root" }, { sid: "pi:kid", parentSid: "pi:root" }];
  assert.deepEqual(nestSessions(list).map(({ s, depth }) => `${s.sid}@${depth}`), ["pi:orphan@0", "pi:root@0", "pi:kid@1", "pi:grand@2"]);
});

test("nestSessions never loses a row: self-parents and parent cycles still show up once", () => {
  const list = [{ sid: "a", parentSid: "b" }, { sid: "b", parentSid: "a" }, { sid: "c", parentSid: "c" }];
  const out = nestSessions(list);
  assert.equal(out.length, 3);
  assert.deepEqual(new Set(out.map((r) => r.s.sid)), new Set(["a", "b", "c"]));
  assert.equal(out.find((r) => r.s.sid === "c").depth, 0);
  assert.deepEqual(nestSessions([]), []);
  assert.deepEqual(nestSessions(null), []);
});

test("nestSessions takes the parent from a lookup when the session itself does not carry it (agent registry)", () => {
  const agents = { "pi:kid": "pi:root" };
  const out = nestSessions([{ sid: "pi:kid" }, { sid: "pi:root" }], (s) => s.parentSid || agents[s.sid]);
  assert.deepEqual(out.map(({ s, depth }) => `${s.sid}@${depth}`), ["pi:root@0", "pi:kid@1"]);
});

test("agentTag labels agent chats only", () => {
  assert.equal(agentTag({ sid: "pi:a", harness: "pi", parentSid: "pi:p" }), "agent");
  assert.equal(agentTag({ sid: "claude:a", harness: "claude", parentSid: "pi:p" }), "Claude agent");
  assert.equal(agentTag({ sid: "pi:a", harness: "pi", agentId: "a-1", agentKind: "claude" }), "Claude agent");
  assert.equal(agentTag({ sid: "pi:a", harness: "pi" }, { id: "a-1", kind: "pi" }), "agent");
  assert.equal(agentTag({ sid: "pi:a", harness: "pi", owned: true }), null);
  assert.equal(agentTag({ sid: "claude:a", harness: "claude" }), null);
  assert.equal(agentTag(null), null);
});

test("the history drawer renders agent chats indented under their parent with a tag", async () => {
  const { createHistory } = await import("../ui/sidebar.js");
  const wrap = new FakeEl("div"), filter = new FakeEl("input"), btn = new FakeEl("button");
  filter.value = "";
  const now = Date.now();
  const S = { selected: "pi:child", sessions: new Map() };
  for (const s of [
    { sid: "pi:child", harness: "pi", owned: true, title: "task prompt line", parentSid: "pi:parent", agentKind: "pi", lastActivity: now - 1000 },
    { sid: "pi:orphan", harness: "pi", owned: true, title: "Orphan agent", parentSid: "pi:gone", lastActivity: now - 2000 },
    { sid: "pi:plain", harness: "pi", owned: true, title: "Plain chat", lastActivity: now - 3000 },
    { sid: "pi:parent", harness: "pi", owned: true, title: "Parent chat", lastActivity: now - 4000 },
    { sid: "claude:k", harness: "claude", title: "Claude run", lastActivity: now - 5000 },
  ]) S.sessions.set(s.sid, s);
  // claude:k carries no parentSid itself; the agent registry knows it.
  const recs = { "claude:k": { id: "a-0000000b", kind: "claude", parentSid: "pi:parent", title: "Refactor the store" }, "pi:child": { id: "a-0000000a", kind: "pi", parentSid: "pi:parent", title: "Find the flaky test" } };
  withDom({ "#history": wrap, "#sessionFilter": filter, "#btnNewChat": btn }, () => {
    const h = createHistory({ S, onSelect: () => {}, onNew: () => {}, onDelete: () => {}, agentFor: (sid) => recs[sid] || null });
    h.render();
  });
  const rows = wrap.children.filter(hasClass("hist-row"));
  const label = (r) => r.find(hasClass("hist"));
  assert.deepEqual(rows.map((r) => label(r).text), ["Orphan agent", "Plain chat", "Parent chat", "Find the flaky test", "Refactor the store"], "children follow the parent; the agent's own title wins");
  const [orphan, plain, parent, child, claude] = rows;
  assert.ok(!hasClass("child")(orphan) && !hasClass("child")(parent) && !hasClass("child")(plain));
  assert.ok(hasClass("child")(child) && hasClass("child")(claude));
  assert.equal(child.style.props["--depth"], "1");
  const tagOf = (r) => label(r).find(hasClass("own"))?.text;
  assert.equal(tagOf(child), "agent");
  assert.equal(tagOf(claude), "Claude agent");
  assert.equal(tagOf(orphan), "agent", "a top-level agent chat is still tagged");
  assert.equal(tagOf(plain), "in Omni");
  assert.ok(hasClass("active")(child), "the selected agent chat is highlighted");
  assert.equal(wrap.children.filter(hasClass("hist-group")).length, 1, "one day group: children never open a group of their own");
});

// -------------------------------------------------------------------- strip
const A = (id, status, extra = {}) => ({ id, status, kind: "pi", parentSid: "pi:p", title: `job ${id}`, startedAt: 1000, ...extra });

test("agentTone maps every status to a dot", () => {
  for (const s of ["queued", "starting", "running"]) { assert.equal(agentTone(s), "run"); assert.ok(AGENT_ACTIVE.has(s)); }
  assert.equal(agentTone("done"), "ok");
  for (const s of ["error", "timeout", "stalled", "interrupted"]) assert.equal(agentTone(s), "err");
  assert.equal(agentTone("cancelled"), "off");
  assert.equal(agentTone("weird"), "");
  assert.equal(agentTone(undefined), "");
});

test("agentSummary is the folded strip's one line", () => {
  assert.equal(agentSummary([A("1", "running"), A("2", "starting"), A("3", "done")]), "3 agents · 2 running · 1 done");
  assert.equal(agentSummary([A("1", "running"), A("2", "running"), A("3", "running"), A("4", "queued")]), "4 agents · 3 running · 1 queued");
  assert.equal(agentSummary([A("1", "error"), A("2", "timeout"), A("3", "cancelled"), A("4", "done"), A("5", "done")]), "5 agents · 2 failed · 2 done · 1 stopped");
  assert.equal(agentSummary([A("1", "done")]), "1 agent · 1 done");
  assert.equal(agentSummary([]), "0 agents");
});

test("agentsFor picks the selected chat's agents, newest first, a queued one on top", () => {
  const all = [A("old", "done", { startedAt: 100 }), A("new", "running", { startedAt: 300 }), A("other", "running", { parentSid: "pi:q", startedAt: 999 }), A("wait", "queued", { startedAt: null }), A("mid", "error", { startedAt: 200 })];
  assert.deepEqual(agentsFor(all, "pi:p").map((a) => a.id), ["wait", "new", "mid", "old"]);
  assert.deepEqual(agentsFor(new Map(all.map((a) => [a.id, a])).values(), "pi:q").map((a) => a.id), ["other"]);
  assert.deepEqual(agentsFor(all, null), []);
  assert.deepEqual(agentsFor(undefined, "pi:p"), []);
});

test("agentSubline: a running agent's latest move, else its status and how it ended", () => {
  assert.equal(agentSubline(A("1", "running", { activity: ["read(a.js)", "bash(npm test)"] })), "bash(npm test)");
  assert.equal(agentSubline(A("1", "running", { activity: [] })), "running");
  assert.equal(agentSubline(A("1", "starting", { activity: ["old"] })), "starting");
  assert.equal(agentSubline(A("1", "queued")), "queued");
  assert.equal(agentSubline(A("1", "error", { error: "provider 500", activity: ["x"] })), "error: provider 500");
  assert.equal(agentSubline(A("1", "done", { activity: ["x"] })), "done");
  assert.equal(agentSubline(null), "");
});

test("agentElapsed counts up while running and stops at the end", () => {
  assert.equal(agentElapsed({ startedAt: 1000 }, 66_000), "1m 5s");
  assert.equal(agentElapsed({ startedAt: 1000, endedAt: 13_000 }, 999_999), "12s");
  assert.equal(agentElapsed({ startedAt: null }, 5000), "");
});

test("agent labels and titles", () => {
  assert.equal(agentKindLabel("pi"), "pi agent");
  assert.equal(agentKindLabel("claude"), "Claude agent");
  assert.equal(agentKindLabel("shell"), "shell job");
  assert.equal(agentKindLabel(undefined), "agent");
  assert.equal(agentTitle({ title: "Fix it", task: "long" }), "Fix it");
  assert.equal(agentTitle({ task: "Investigate\n  the   build" }), "Investigate the build");
  assert.equal(agentTitle({ command: "npm test" }), "npm test");
  assert.equal(agentTitle({ id: "a-12345678" }), "a-12345678");
  assert.ok(agentTitle({ task: "x".repeat(300) }).length <= 91);
});

test("the agents extension's tools read as agent / job moves in the transcript", () => {
  assert.equal(toolKind("agent_start"), "agent"); assert.equal(toolKind("agent_wait"), "agent");
  assert.equal(toolKind("job_start"), "shell"); assert.equal(toolKind("job_wait"), "shell");
  assert.equal(toolKind("Agent"), "agent", "Claude Code's own Agent tool is unchanged");
  assert.equal(toolLabel("agent_start", { task: "Look into the flaky test", kind: "pi" }).text, "Started an agent: Look into the flaky test");
  assert.equal(toolLabel("agent_start", { task: "t", title: "Refactor", kind: "claude" }).text, "Started a Claude agent: Refactor");
  assert.equal(toolLabel("agent_wait", {}).text, "Waited for agents");
  assert.equal(toolLabel("agent_wait", { ids: ["a-1", "a-2"] }).text, "Waited for agent a-1, a-2");
  assert.equal(toolLabel("agent_status", {}).text, "Checked agents");
  assert.equal(toolLabel("agent_message", { id: "a-1", message: "x" }).text, "Messaged agent a-1");
  assert.equal(toolLabel("agent_cancel", { id: "a-1" }).text, "Stopped agent a-1");
  assert.equal(toolLabel("job_start", { command: "npm run build" }).text, "Started a job: npm run build");
  assert.equal(toolLabel("job_wait", { id: "a-3", until: "ready" }).text, "Waited for job a-3 until /ready/");
  assert.equal(toolLabel("job_wait", {}).text, "Waited for job");
  assert.equal(toolLabel("job_output", { id: "a-3" }).text, "Read the output of job a-3");
  assert.equal(toolLabel("job_kill", { id: "a-3" }).text, "Stopped job a-3");
});

// --------------------------------------------------------------- report card
test("agentResultInfo reads a key: value header", () => {
  const r = agentResultInfo("[omni-agent-result] Background agent finished\nid: a-1a2b3c4d\nkind: claude\ntitle: Refactor the store\nstatus: done\nelapsed: 4m 12s\n\n## Result\nAll green.");
  assert.deepEqual(r, { id: "a-1a2b3c4d", kind: "claude", title: "Refactor the store", status: "done", elapsed: "4m 12s", body: "## Result\nAll green." });
});

test("agentResultInfo reads a one-line header", () => {
  const r = agentResultInfo('[omni-agent-result] pi agent a-0f0f0f0f "Find the flaky test" failed after 3m 2s\n\nIt times out on CI only.');
  assert.equal(r.id, "a-0f0f0f0f");
  assert.equal(r.kind, "pi");
  assert.equal(r.title, "Find the flaky test");
  assert.equal(r.status, "error");
  assert.equal(r.elapsed, "3m 2s");
  assert.equal(r.body, "It times out on CI only.");
  const j = agentResultInfo("[omni-agent-result] Shell job a-00000001 timed out\n\nlast lines…");
  assert.equal(j.kind, "shell"); assert.equal(j.status, "timeout"); assert.equal(j.title, "Shell job a-00000001 timed out");
  const c = agentResultInfo("[omni-agent-result] Agent a-00000002 was cancelled");
  assert.equal(c.status, "cancelled"); assert.equal(c.body, "Agent a-00000002 was cancelled", "a report with no body shows its one line");
});

test("agentResultInfo: only the omni-agent-result notice is a report", () => {
  assert.equal(agentResultInfo("[omni-fallback] switched to b/y"), null);
  assert.equal(agentResultInfo("[omnidroid-late] ✓ boot finished after running long"), null);
  assert.equal(agentResultInfo("The [omni-agent-result] tag in prose"), null);
  assert.equal(agentResultInfo(""), null);
  assert.equal(agentResultInfo(undefined), null);
  const bare = agentResultInfo("[omni-agent-result]");
  assert.equal(bare.title, "Background agent"); assert.equal(bare.id, ""); assert.equal(bare.status, "");
  assert.equal(agentResultInfo("[omni-agent-result] id: a-deadbeef\nstatus: done\nresult text here").id, "a-deadbeef");
});

// The real header, from the extension's own report builder: every status, every kind, long runs.
test("agentResultInfo round-trips every report agentReport writes", async () => {
  const { agentReport, FINISHED } = await import("../integrations/pi/omni-agents-lib.mjs");
  const base = { id: "a-1a2b3c4d", kind: "pi", title: "Find the flaky test", startedAt: 1000, endedAt: 61000, resultText: "It times out on CI only." };
  const card = (rec) => agentResultInfo(`[omni-agent-result] ${agentReport(rec, { now: rec.endedAt })}`);
  for (const status of FINISHED) {
    for (const kind of ["pi", "claude", "shell"]) {
      const r = card({ ...base, kind, status, error: status === "done" ? undefined : "boom", exitCode: kind === "shell" && status === "error" ? 1 : undefined });
      assert.equal(r.status, status, `${kind} ${status}`);
      assert.equal(r.kind, kind, `${kind} ${status}`);
      assert.equal(r.id, "a-1a2b3c4d");
      assert.equal(r.title, "Find the flaky test");
      assert.equal(r.elapsed, "1m 0s", "the lib's 1m00s reads as the strip's own format");
    }
  }
  const failed = card({ ...base, status: "error", error: "boom" });
  assert.match(failed.body, /^Error: boom\n\nIt times out on CI only\./, "the error line opens the folded report");
  assert.equal(card({ ...base, status: "done", endedAt: 1000 + 3900e3 }).elapsed, "1h 05m");
  assert.equal(card({ ...base, status: "done", endedAt: 6000 }).elapsed, "5s");
  assert.equal(card({ ...base, status: "done", startedAt: null }).elapsed, "", "never started: no run time");
  // Words in the title are the title's, never the status or the kind.
  const t1 = card({ ...base, title: "Why the build failed", status: "done" });
  assert.equal(t1.status, "done"); assert.equal(t1.title, "Why the build failed");
  const t2 = card({ ...base, title: "Check the nightly job", status: "done" });
  assert.equal(t2.kind, "pi");
  const t3 = card({ ...base, kind: "claude", title: 'Fix the "finished: error" banner', status: "timeout" });
  assert.equal(t3.status, "timeout"); assert.equal(t3.kind, "claude"); assert.equal(t3.title, 'Fix the "finished: error" banner');
  const job = card({ ...base, kind: "shell", title: "Run tests", command: "npm test", status: "error", exitCode: 1, resultText: "1 failing" });
  assert.deepEqual([job.kind, job.status, job.title], ["shell", "error", "Run tests"]);
  assert.match(job.body, /Log tail:\n1 failing/);
});

test("transcript renders a report as a card with Open, and other notices as plain system lines", async () => {
  const { applyEvent } = await import("../ui/transcript.js");
  const opened = [];
  withDom({}, () => {
    const root = new FakeEl("div"), wrap = new FakeEl("div");
    const view = { sid: "pi:p", root, wrap, cwd: "", harness: "pi", tools: new Map(), turn: null, stream: null, lastTs: 0, empty: null, lastUser: null, openAgent: (id) => opened.push(id) };
    applyEvent(view, { kind: "msg", role: "system", ts: 5, blocks: [{ type: "text", text: "[omni-agent-result] Background agent finished\nid: a-12345678\nkind: pi\ntitle: Find the flaky test\nstatus: done\nelapsed: 2m 0s\n\nThe **fix** is in a.js" }] });
    const card = root.find(hasClass("ar-card"));
    assert.ok(card, "a report card");
    assert.equal(card.tagName, "DETAILS");
    assert.ok(hasClass("ok")(card), "done reads as ok");
    assert.equal(card.find(hasClass("ar-title")).text, "Find the flaky test");
    assert.equal(card.find(hasClass("ar-meta")).text, "pi agent · done · 2m 0s");
    assert.match(card.find(hasClass("ar-body")).innerHTML, /<b>fix<\/b>/);
    const open = card.find(hasClass("ar-open"));
    open.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, ["a-12345678"]);
    assert.ok(view.turn && !view.turn.done, "the report opens the parent's next turn");
    applyEvent(view, { kind: "msg", role: "system", ts: 6, blocks: [{ type: "text", text: "[omnidroid-late] boot finished" }] });
    const sys = root.findAll(hasClass("system"));
    assert.equal(sys.length, 1);
    assert.equal(sys[0].text, "[omnidroid-late] boot finished");
    // No Open when the app gave no handler, and a failed report reads as an error.
    const root2 = new FakeEl("div");
    applyEvent({ ...view, root: root2, turn: null, openAgent: null }, { kind: "msg", role: "system", ts: 7, blocks: [{ type: "text", text: "[omni-agent-result] agent a-87654321 stalled" }] });
    const c2 = root2.find(hasClass("ar-card"));
    assert.ok(hasClass("err")(c2));
    assert.equal(c2.find(hasClass("ar-open")), null);
  });
});

test("a real failed report renders as a red card; a pi agent titled with 'job' still opens its chat", async () => {
  const { applyEvent } = await import("../ui/transcript.js");
  const { agentReport } = await import("../integrations/pi/omni-agents-lib.mjs");
  const rec = { id: "a-1a2b3c4d", kind: "claude", title: "Check the nightly job", status: "error", error: "boom", startedAt: 0, endedAt: 75000, resultText: "half done", sessionId: "s1", turns: 3 };
  withDom({}, () => {
    const root = new FakeEl("div");
    const view = { sid: "pi:p", root, wrap: new FakeEl("div"), cwd: "", harness: "pi", tools: new Map(), turn: null, stream: null, lastTs: 0, empty: null, lastUser: null, openAgent: () => {} };
    applyEvent(view, { kind: "msg", role: "system", ts: 5, blocks: [{ type: "text", text: `[omni-agent-result] ${agentReport(rec, { now: 75000 })}` }] });
    const card = root.find(hasClass("ar-card"));
    assert.ok(hasClass("err")(card), "an error report is red, not a green done");
    assert.equal(card.find(hasClass("ar-title")).text, "Check the nightly job");
    assert.equal(card.find(hasClass("ar-meta")).text, "Claude agent · error · 1m 15s");
    assert.equal(card.find(hasClass("ar-open")).text, "Open");
  });
});

// ---------------------------------------------------------------- long runs
test("parseCompactAt turns the k field into tokens and refuses nonsense", () => {
  assert.deepEqual(parseCompactAt("256"), { compactAt: 256000 });
  assert.deepEqual(parseCompactAt(" 0 "), { compactAt: 0 });
  assert.deepEqual(parseCompactAt("128.5"), { compactAt: 128500 });
  assert.deepEqual(parseCompactAt(400), { compactAt: 400000 });
  for (const bad of ["", "abc", "-1", "12", "20000", null]) assert.ok(parseCompactAt(bad).error, `refuses ${JSON.stringify(bad)}`);
  assert.equal(compactAtK(256000), 256);
  assert.equal(compactAtK(262144), 262.1);
  assert.equal(compactAtK(0), 0);
  assert.equal(compactAtK(undefined), 0);
  assert.deepEqual(parseCompactAt(String(compactAtK(256000))), { compactAt: 256000 }, "round-trips");
});

test("compactAtFromField sends the saved token count back untouched while the field still shows it", () => {
  assert.deepEqual(compactAtFromField("262.1", 262144), { compactAt: 262144 }, "a checkbox-only save is no cap change");
  assert.deepEqual(compactAtFromField(" 262.1 ", 262144), { compactAt: 262144 });
  assert.deepEqual(compactAtFromField("300", 262144), { compactAt: 300000 }, "an edit is read as typed");
  assert.deepEqual(compactAtFromField("0", 0), { compactAt: 0 });
  assert.deepEqual(compactAtFromField("256", undefined), { compactAt: 256000 });
  assert.ok(compactAtFromField("12", 262144).error, "a bad edit is still refused");
});

// ------------------------------------------------- reports in a reopened chat, agent snapshots
const report = (ts, text, id = `live-${ts}`) => ({ kind: "msg", role: "system", id, ts, blocks: [{ type: "text", text: `[omni-agent-result] ${text}` }] });
test("agentReportKey knows a report msg and nothing else", () => {
  assert.equal(agentReportKey(report(1, "Background job a-00000001 \"x\" finished: done.")), '[omni-agent-result] Background job a-00000001 "x" finished: done.');
  assert.equal(agentReportKey({ kind: "msg", role: "system", blocks: [{ type: "text", text: "[omni-fallback] switched" }] }), "");
  assert.equal(agentReportKey({ kind: "msg", role: "assistant", blocks: [{ type: "text", text: "[omni-agent-result] quoted by the model" }] }), "");
  assert.equal(agentReportKey({ kind: "delta" }), "");
  assert.equal(agentReportKey(null), "");
});

test("withLiveReports puts a report only the live buffer has back in its place, and never doubles one", () => {
  const h = [{ kind: "msg", role: "user", id: "e1", ts: 10 }, { kind: "msg", role: "assistant", id: "e2", ts: 20 }, { kind: "msg", role: "assistant", id: "e3", ts: 40 }];
  const live = report(30, "A done");
  const buffer = [{ kind: "status", ts: 25 }, live, { kind: "delta", ts: 31 }];
  assert.deepEqual(withLiveReports(h, buffer).map((e) => e.id), ["e1", "e2", "live-30", "e3"], "older than the fetch, still shown, by its time");
  assert.deepEqual(withLiveReports(h, [report(50, "B done")]).map((e) => e.id), ["e1", "e2", "e3", "live-50"]);
  // Once the history carries the report (a session-file entry with its own id), the live copy is dropped.
  const withIt = [...h.slice(0, 2), report(29, "A done", "e9"), h[2]];
  assert.deepEqual(withLiveReports(withIt, buffer).map((e) => e.id), ["e1", "e2", "e9", "e3"]);
  assert.deepEqual(withLiveReports(h, [live, { ...live }]).map((e) => e.id), ["e1", "e2", "live-30", "e3"], "one copy of a report");
  assert.equal(withLiveReports(h, undefined), h, "nothing buffered: the history as it is");
  assert.equal(withLiveReports(h, buffer.filter((e) => e !== live)), h);
});

test("mergeAgentSnapshot keeps records that came in live while the snapshot was in flight", () => {
  const cur = new Map([["a-1", { id: "a-1", status: "done" }], ["a-2", { id: "a-2", status: "running" }], ["a-9", { id: "a-9", status: "queued" }], ["a-8", { id: "a-8", status: "done" }]]);
  // a-1 and a-9 were put live after the request (rev 5); a-2 and a-8 before it.
  const liveAt = new Map([["a-1", 6], ["a-2", 4], ["a-9", 7], ["a-8", 1]]);
  const snap = [{ id: "a-1", status: "running" }, { id: "a-2", status: "done" }, { id: "a-3", status: "running" }];
  const out = mergeAgentSnapshot(cur, snap, liveAt, 5);
  assert.equal(out.get("a-1").status, "done", "a finished agent never goes back to running");
  assert.equal(out.get("a-2").status, "done", "the snapshot wins over an older live record");
  assert.equal(out.get("a-3").status, "running", "new in the snapshot");
  assert.equal(out.get("a-9").status, "queued", "started after the snapshot was built: kept");
  assert.equal(out.has("a-8"), false, "gone from the server, not recent: dropped");
  assert.deepEqual([...mergeAgentSnapshot(new Map(), { x: { id: "a-4" } }, new Map(), 0).keys()], ["a-4"], "an object snapshot works too");
  assert.equal(mergeAgentSnapshot(cur, null, liveAt, 100).size, 0);
});
