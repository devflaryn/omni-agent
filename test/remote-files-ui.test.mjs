// The file pane and the transcript when the window is on another machine: its content may be hostile, and actions must not land on the wrong computer.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, isRemote, machine, mode, onLeaveCheck, rawUrl, setMachine, setTransportEnv } from "../ui/transport.js";
import { diffCounts, editDiff, esc, md, toolLabel } from "../ui/lib.js";
import { fileIcon, iconFor } from "../ui/fileicons.js";
import { highlight, languageFor } from "../ui/highlight.js";
import { showName } from "../ui/lib.js";

const read = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");
const HOSTILE = `<img src=x onerror="alert(1)">`;
const answer = (status, body) => new Response(JSON.stringify(body), { status });

let realFetch;
let store, reloads, asked, answerToAsk;
const storage = () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) });
/** `rebuild`: what a reload does. Without it the page goes on, as it would if a prompt had kept it open. */
const environment = (rebuild = true) => { const page = { storage: storage(), reload: () => { reloads++; if (rebuild) setTransportEnv(page); }, confirm: (t) => { asked.push(t); return answerToAsk; } }; return page; };
beforeEach(() => { realFetch = globalThis.fetch; store = new Map(); reloads = 0; asked = []; answerToAsk = true; setTransportEnv(environment()); });
afterEach(() => { globalThis.fetch = realFetch; });

test("a refused save carries the answer, here and on another machine: the pane offers Overwrite or Reload from it", async () => {
  const conflict = { error: "the file changed on disk", conflict: true, hash: "abc" };
  globalThis.fetch = async () => answer(409, conflict);
  await assert.rejects(api("POST", "/api/fs/write", {}), (e) => e.status === 409 && e.body?.conflict === true);
  setMachine("far", { name: "Ubuntu" });
  await assert.rejects(api("POST", "/api/fs/write", {}), (e) => e.status === 409 && e.body?.conflict === true);
  globalThis.fetch = async () => answer(500, { error: "no trash", trashFailed: true });
  await assert.rejects(api("POST", "/api/fs/delete", {}), (e) => e.body?.trashFailed === true);
});

test("the reveal action is hidden on another machine as well as in a remote browser, and never built without the check", () => {
  assert.match(read("app.js"), /createExplorer\(\{[^\n]*isRemote: \(\) => remote\.role === "remote" \|\| !focusM\(\)\?\.here/);
  const uses = read("explorer.js").split(/\r?\n/).filter((l) => /revealOnHost\(/.test(l) && !/async function/.test(l));
  assert.ok(uses.length >= 2);
  for (const l of uses) assert.match(l, /!isRemote\(\) &&/, l.trim());
});

test("unsaved work: No leaves the window exactly where it was, so a later refresh does not jump machines", async () => {
  onLeaveCheck(() => "A file has unsaved changes.");
  answerToAsk = false;
  assert.equal(setMachine("far", { name: "Ubuntu" }), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /unsaved changes/);
  assert.match(asked[0], /Ubuntu/, "the question names where the window would go");
  assert.equal(reloads, 0);
  assert.equal(store.size, 0, "nothing stored");
  assert.equal(isRemote(), false);
  assert.equal(await rawUrl("/api/fs/raw?path=a"), "/api/fs/raw?path=a");
});

test("unsaved work: Yes goes on, with no reload", () => {
  onLeaveCheck(() => "A file has unsaved changes.");
  onLeaveCheck(() => null);
  assert.equal(setMachine("far", { name: "Ubuntu" }), true);
  assert.equal(machine().id, "far");
  assert.equal(asked.length, 1);
  assert.equal(reloads, 0);
  assert.ok(store.has("omni.machine"));
});

test("a switch not chosen by the person never asks, and waits for the work to be saved", () => {
  let dirty = true;
  store.set("omni.machine", JSON.stringify({ id: "gone", name: "Gone" }));
  setTransportEnv(environment());
  onLeaveCheck(() => (dirty ? "A file has unsaved changes." : null));
  assert.equal(setMachine(null, { whenClean: true }), false);
  assert.equal(machine().id, "gone");
  assert.equal(asked.length, 0);
  assert.ok(store.has("omni.machine"));
  dirty = false;
  assert.equal(setMachine(null, { whenClean: true }), true);
  assert.equal(reloads, 0);
  assert.equal(machine(), null);
});

test("the file pane is the focused machine's: once a move is agreed its tabs close, and nothing of the last tree is drawn", () => {
  const app = read("app.js");
  const focus = app.slice(app.indexOf("function focusMachine("), app.indexOf("function chooseMachine("));
  assert.ok(focus.indexOf("setMachine(") > 0 && focus.indexOf("setMachine(") < focus.indexOf("explorer.switchMachine()"), "asked first, then the tabs go");
  assert.match(read("explorer.js"), /function switchMachine\(\) \{\s*real\?\.forgetAll\(\);\s*epoch\+\+;/);
  assert.match(read("explorer.js"), /if \(asked !== epoch\) return;/);
  assert.equal(mode(), "local");
  for (const f of ["app.js", "account.js", "explorer.js", "editor.js", "mission.js", "settings.js", "panel.js", "composer.js"]) assert.doesNotMatch(read(f), /beforeunload/, f);
  assert.match(read("account.js"), /choose\(null, null, \{ whenClean: true \}\)/);
});

test("names are shown without what would turn them around, and only shown", () => {
  assert.equal(showName("gpj.exe\u202e"), "gpj.exe");
  assert.equal(showName("a\u200bb\u2066c\u2028d\u0007e"), "abcde");
  assert.equal(showName("Résumé 文件.txt"), "Résumé 文件.txt", "ordinary names stay");
  assert.equal(showName("\u202e"), "?");
  assert.equal(showName(null), "?");
  const explorer = read("explorer.js"), pane = read("filepane.js");
  assert.match(explorer, /\.name"\)\.textContent = showName\(e\.name\)/);
  assert.match(explorer, /row\.dataset\.path = e\.path;/, "the path used for requests is the real one");
  assert.match(pane, /"pv-tab-name", showName\(t\.name\)/);
  assert.match(pane, /pathEl\.textContent = showName\(t\.path\)/);
  assert.match(pane, /q\(\{ root: t\.root, path: t\.path/, "and here");
  assert.match(pane, /copy\(absPath\(t\.root, t\.path\)\)/, "and what is copied");
  assert.match(read("transcript.js"), /"tfile", showName\(label\.target\)/);
});

test("the language of a name is a language, never an inherited property", () => {
  for (const name of ["constructor", "a.constructor", "__proto__", "a.tostring", "valueOf", "hasOwnProperty"]) assert.equal(languageFor(name), "plain", name);
  assert.equal(highlight("<x>", "constructor"), "&lt;x&gt;");
  assert.equal(languageFor("a.yml"), "yaml");
  assert.equal(languageFor("Dockerfile"), "docker");
});

test("counts another machine reports are numbers, because the row draws them as HTML", () => {
  assert.deepEqual(diffCounts({ added: HOSTILE, removed: `1"><script>` }), { added: 0, removed: 0 });
  assert.deepEqual(diffCounts({ added: 3, removed: "4", kind: "x", path: HOSTILE, verb: HOSTILE }), { added: 3, removed: 4 }, "and only the counts");
  assert.deepEqual(diffCounts({ added: -5, removed: 1.9 }), { added: 0, removed: 1 });
  assert.deepEqual(diffCounts(null), { added: 0, removed: 0 });
  assert.match(read("transcript.js"), /\.\.\.diffCounts\(c\.diffStat\)/);
  assert.doesNotMatch(read("transcript.js"), /\.\.\.c\.diffStat\b/);
});

test("a file name from another machine is only ever a name", () => {
  for (const name of ["constructor", "__proto__", "toString", "a.constructor", "b.__proto__", "c.hasownproperty"]) {
    assert.deepEqual(iconFor(name), ["text", "dim"], name);
    assert.match(fileIcon(name), /^<span class="ico ft ft-dim"><svg/, name);
  }
  assert.doesNotMatch(fileIcon(`${HOSTILE}.js`), /onerror/);
  assert.doesNotMatch(fileIcon(`x.${HOSTILE}`), /onerror/);
  // The language a name picks only ever chooses a class of ours.
  for (const name of ["constructor", "a.constructor", "__proto__", "a.tostring"]) assert.equal(highlight(HOSTILE, languageFor(name)).includes("<img"), false, name);
});

test("highlighting escapes everything, in every language", () => {
  for (const lang of ["js", "py", "html", "json", "sh", "css", "md", "diff", "plain", "nope", undefined]) {
    const out = highlight(`${HOSTILE}\n</code></pre><script>alert(1)</script>"'`, lang);
    assert.doesNotMatch(out, /<(?!span class="t-[\w-]+">|\/span>)/, String(lang));
  }
});

test("markdown from another machine: no tag, no attribute, no other scheme", () => {
  const out = md(`${HOSTILE}\n\n[x](javascript:alert(1)) [y](https://a"onmouseover="alert(1)) ![z](x)\n\n| a |\n|---|\n| ${HOSTILE} |`);
  assert.doesNotMatch(out, /<img|<script|href="javascript/);
  assert.doesNotMatch(out, /href="[^"]*"onmouseover/);
  assert.equal(esc(`"`), "&quot;");
});

test("a diff's rows are built from text only: the label and the rows stay data", () => {
  const d = editDiff("edit", { file_path: `${HOSTILE}.js`, old_string: HOSTILE, new_string: `${HOSTILE}!` });
  assert.ok(d.rows.every((r) => ["ctx", "add", "del"].includes(r.t)));
  const label = toolLabel("edit", { file_path: `${HOSTILE}.js`, old_string: "a", new_string: "b" }, "");
  assert.equal(typeof label.added, "number");
  assert.equal(typeof label.removed, "number");
  // The one place rows reach HTML: everything but the row kind and its computed numbers goes through esc or highlight.
  const src = read("transcript.js");
  assert.match(src, /d-file">\$\{esc\(showName\(r\.s\)\)\}/);
  assert.match(src, /class="cd">\$\{highlight\(r\.s, lang\)/);
  assert.match(src, /class="ln">\$\{esc\(r\.o \?\? ""\)\}<\/span><span class="ln">\$\{esc\(r\.n \?\? ""\)\}/, "and the line numbers");
  assert.match(src, /dv-head">\$\{esc\(showName\(c\.label\.path \|\| d\.path\)\)\}/);
});

test("the file pane puts another machine's text in the DOM as text", () => {
  const lines = read("filepane.js").split(/\r?\n/).filter((l) => /innerHTML/.test(l) && !/innerHTML = "";?/.test(l));
  for (const l of lines) assert.match(l, /innerHTML = (`<svg|`<span class="(pv-binary-ico|ico)">\$\{ICONS|`\$\{fileIcon\(n\.name\)\}<span class="name"><\/span>|fileIcon\(t\.name\)|md\(|kids\.hidden \? ICONS)/, l.trim());
  assert.doesNotMatch(read("editor.js").replace(/code\.innerHTML = plain \? "" : `\$\{highlight\(v, curLang\)\}\\n`/, ""), /innerHTML/);
});
