import { test } from "node:test";
import assert from "node:assert/strict";
import { planBlocks, meterLabel, jumpShown, JUMP_GAP, paintGap } from "../ui/chat-live.js";
import { chatHash, parseHash } from "../ui/route.js";
import { shortcutFor, isTyping, rankItems, keyLabel } from "../ui/keys.js";
import { createDrafts, HERE } from "../ui/machines.js";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");

// ------------------------------------------------------------------ streaming patches
test("a stream patch keeps every block that did not change and replaces only the rest", () => {
  assert.deepEqual(planBlocks([], ["<p>a</p>"]), { keep: 0, replace: [], append: [0], remove: 0 });
  assert.deepEqual(planBlocks(["<p>a</p>"], ["<p>ab</p>"]), { keep: 0, replace: [0], append: [], remove: 0 });
  assert.deepEqual(planBlocks(["<h2>T</h2>", "<p>a</p>"], ["<h2>T</h2>", "<p>ab</p>", "<ul><li>x</li></ul>"]), { keep: 1, replace: [1], append: [2], remove: 0 });
  assert.deepEqual(planBlocks(["<p>a</p>", "<p>b</p>"], ["<p>a</p>"]), { keep: 1, replace: [], append: [], remove: 1 });
  assert.deepEqual(planBlocks(["<p>a</p>", "<p>b</p>"], ["<p>a</p>", "<p>b</p>"]), { keep: 2, replace: [], append: [], remove: 0 });
});

test("a slow render paints less often, never slower than about 8 a second", () => {
  assert.equal(paintGap(1), 0);
  assert.equal(paintGap(6), 0);
  assert.ok(paintGap(20) >= 40);
  assert.equal(paintGap(500), 120);
});

// ------------------------------------------------------------------ status line
test("the status line says what is happening: writing, thinking, running, or waiting", () => {
  const base = { done: false, live: true, ms: 3000, tokens: 0, rate: 0 };
  assert.deepEqual(meterLabel({ ...base, phase: "wait" }), { label: "Working…", stats: "3s", waiting: true });
  assert.deepEqual(meterLabel({ ...base, phase: "write", quiet: false, tokens: 43, rate: 40 }), { label: "Writing…", stats: "3s · 43 tokens · 40 tok/sec", waiting: false });
  assert.deepEqual(meterLabel({ ...base, phase: "think", quiet: false, tokens: 12 }), { label: "Thinking…", stats: "3s · 12 tokens", waiting: false });
  assert.deepEqual(meterLabel({ ...base, phase: "write", quiet: true, tokens: 43 }), { label: "Writing…", stats: "3s · 43 tokens", waiting: true }, "a pause shimmers but keeps its word");
  assert.deepEqual(meterLabel({ ...base, phase: "tool", running: "Running pytest…" }), { label: "Running pytest…", stats: "3s", waiting: true });
  assert.equal(meterLabel({ ...base, phase: "wait", tokens: 0 }).stats.includes("token"), false, "never 0 tokens");
});

test("a finished turn says how it went, without a zero", () => {
  const done = { done: true, ms: 4000, tokens: 160 };
  assert.equal(meterLabel({ ...done, live: false }).label, "Replied in 4s");
  assert.equal(meterLabel({ ...done, live: true }).label, "Replied in 4s");
  assert.equal(meterLabel({ ...done, live: true, sawThinking: true }).label, "Thought for 4s");
  assert.equal(meterLabel({ ...done, live: true, sawTool: true, sawThinking: true }).label, "Worked for 4s");
  assert.equal(meterLabel({ ...done, live: true }).stats, "160 tokens");
  assert.equal(meterLabel({ ...done, live: true, tokens: 0 }).stats, "");
});

test("jump to latest shows past 150 px from the bottom", () => {
  assert.equal(JUMP_GAP, 150);
  assert.equal(jumpShown(0), false);
  assert.equal(jumpShown(150), false);
  assert.equal(jumpShown(151), true);
});

// ------------------------------------------------------------------ chat URLs
test("a chat's URL names its machine and its id, and reads back", () => {
  assert.equal(chatHash("here", "pi:abc-1"), "#/c/here/pi%3Aabc-1");
  assert.deepEqual(parseHash("#/c/here/pi%3Aabc-1"), { kind: "chat", machine: "here", sid: "pi:abc-1" });
  assert.deepEqual(parseHash(chatHash("dev/ice#1", "claude:x/y?z")), { kind: "chat", machine: "dev/ice#1", sid: "claude:x/y?z" });
  assert.deepEqual(parseHash("#missions"), { kind: "missions" });
  assert.deepEqual(parseHash(""), { kind: "home" });
  assert.deepEqual(parseHash("#/"), { kind: "home" });
  assert.deepEqual(parseHash("#/c/here"), { kind: "home" });
  assert.deepEqual(parseHash("#/c/%E0%A4%A/x"), { kind: "home" }, "a broken escape is no route");
  assert.deepEqual(parseHash("#/c//x"), { kind: "home" });
});

// ------------------------------------------------------------------ keyboard
const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: { tagName: "BODY" }, ...o });
test("shortcuts: Ctrl on Windows, Cmd on a Mac", () => {
  assert.equal(shortcutFor(ev("k", { ctrlKey: true })), "palette");
  assert.equal(shortcutFor(ev("K", { ctrlKey: true })), "palette");
  assert.equal(shortcutFor(ev("k", { metaKey: true }), { mac: true }), "palette");
  assert.equal(shortcutFor(ev("k", { metaKey: true })), null, "Cmd is not Ctrl on Windows");
  assert.equal(shortcutFor(ev("k", { ctrlKey: true }), { mac: true }), null);
  assert.equal(shortcutFor(ev("O", { ctrlKey: true, shiftKey: true })), "new-chat");
  assert.equal(shortcutFor(ev(".", { ctrlKey: true })), "stop");
  assert.equal(shortcutFor(ev("b", { ctrlKey: true })), "files");
  assert.equal(shortcutFor(ev("\\", { ctrlKey: true })), "history");
  assert.equal(shortcutFor(ev("/", { ctrlKey: true })), "shortcuts");
  assert.equal(shortcutFor(ev("?", { shiftKey: true })), "shortcuts");
  assert.equal(shortcutFor(ev("/")), "focus-composer");
  assert.equal(shortcutFor(ev("k", { ctrlKey: true, altKey: true })), null, "AltGr is Ctrl+Alt: never a shortcut");
});

test("typing in a field keeps its keys, except the documented ones", () => {
  const field = { target: { tagName: "TEXTAREA" } };
  assert.equal(shortcutFor(ev("?", { shiftKey: true, ...field })), null);
  assert.equal(shortcutFor(ev("/", field)), null);
  assert.equal(shortcutFor(ev("k", { ctrlKey: true, ...field })), "palette");
  assert.equal(shortcutFor(ev(".", { ctrlKey: true, ...field })), "stop");
  assert.equal(shortcutFor(ev("a", { ctrlKey: true, ...field })), null, "select-all stays the field's");
  assert.equal(shortcutFor(ev("b", { ctrlKey: true, target: { tagName: "INPUT", type: "text" } })), "files");
  assert.equal(isTyping({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTyping({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTyping({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: "SELECT" }), true);
  assert.equal(isTyping(null), false);
});

test("key labels follow the platform", () => {
  assert.equal(keyLabel("mod+k", false), "Ctrl+K");
  assert.equal(keyLabel("mod+k", true), "⌘K");
  assert.equal(keyLabel("mod+shift+o", true), "⇧⌘O");
  assert.equal(keyLabel("mod+\\", false), "Ctrl+\\");
});

test("the palette ranks a prefix over a word start over a scattered match, and drops misses", () => {
  const items = [{ title: "Speed up the history drawer" }, { title: "History of the relay" }, { title: "Fix the hi-story" }, { title: "Unrelated" }, { title: "His toy story" }];
  assert.deepEqual(rankItems("hist", items).map((i) => i.title), ["History of the relay", "Speed up the history drawer", "His toy story", "Fix the hi-story"]);
  assert.deepEqual(rankItems("", items), items, "an empty query keeps the order");
  assert.deepEqual(rankItems("zzz", items), []);
  assert.equal(rankItems("relay", [{ title: "x", sub: "on the relay box" }]).length, 1, "the subtitle is searched too");
});

// ------------------------------------------------------------------ drafts
function fakeStorage() { const data = new Map(); return { data, get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) }; }
test("drafts outlive a reload when there is storage, still per chat per machine and taken once", () => {
  const storage = fakeStorage();
  const a = createDrafts({ storage });
  a.save("dev1", "s1", "half a thought");
  a.save(HERE, "s1", "here's");
  const b = createDrafts({ storage }); // the page again, after a reload
  assert.equal(b.take("dev1", "s1"), "half a thought");
  assert.equal(b.take("dev1", "s1"), "", "taken once");
  assert.equal(b.take(HERE, "s1"), "here's");
  a.save(HERE, "s2", "x"); a.save(HERE, "s2", "");
  assert.equal(createDrafts({ storage }).take(HERE, "s2"), "", "an emptied box leaves nothing behind");
});

test("stored drafts are capped, oldest first", () => {
  const storage = fakeStorage();
  let now = 0;
  const d = createDrafts({ storage, now: () => ++now, max: 3 });
  for (const s of ["a", "b", "c", "d"]) d.save(HERE, s, s);
  const again = createDrafts({ storage });
  assert.equal(again.take(HERE, "a"), "", "the oldest went");
  assert.equal(again.take(HERE, "d"), "d");
});

test("a storage that throws loses nothing in memory", () => {
  const storage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); }, key() { throw new Error("denied"); }, get length() { throw new Error("denied"); } };
  const d = createDrafts({ storage });
  d.save(HERE, "s", "kept");
  assert.equal(d.take(HERE, "s"), "kept");
});

// ------------------------------------------------------------------ wiring (source checks)
test("the composer never sends mid-IME, greys Send when empty, and stops on Esc", () => {
  const src = read("composer.js");
  assert.match(src, /e\.isComposing \|\| e\.keyCode === 229/);
  assert.match(src, /Escape/);
  assert.match(src, /pointer: fine/, "autofocus on a desktop pointer only");
});

test("the composer's placeholder comes from its caller, and an empty model list offers one way forward", () => {
  const src = read("composer.js");
  assert.doesNotMatch(src, /Do anything/);
  assert.match(src, /st\.placeholder !== undefined\) ta\.placeholder/);
  assert.match(src, /"Add a provider"/);
  assert.match(src, /"Add a model"/);
});

test("the chat's live text is painted once a frame at most, never token by token", () => {
  const src = read("transcript.js");
  assert.match(src, /requestAnimationFrame/);
  assert.doesNotMatch(src, /el\("span", "tok"/);
  assert.match(src, /closeOpen\(/);
});
