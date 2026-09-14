// test/ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDuration, tokRate, estimateTokens, editStats, editedFiles, groupToolRuns, relPath, md, groupLabel, splitAttachments, toolKind, toolLabel, workSummary, fileKind, fmtBytes, buildTree } from "../ui/lib.js";
import { titleFrom } from "../server/watchers.mjs";

test("fmtDuration", () => {
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(12_400), "12s");
  assert.equal(fmtDuration(8 * 60_000 + 4_000), "8m 4s");
  assert.equal(fmtDuration(62 * 60_000), "1h 02m");
});

test("tokRate", () => {
  assert.equal(tokRate(15_000, 11 * 60_000 + 20_000), 22);
  assert.equal(tokRate(0, 1000), 0);
  assert.equal(tokRate(100, 0), 0);
});

test("estimateTokens", () => { assert.equal(estimateTokens("abcdefgh"), 2); assert.equal(estimateTokens(""), 0); });

test("editStats counts lines for Edit, Write, MultiEdit and pi's edit/write; ignores other tools", () => {
  assert.deepEqual(editStats("Edit", { file_path: "a.js", old_string: "x\ny", new_string: "x\ny\nz" }), { path: "a.js", added: 3, removed: 2 });
  assert.deepEqual(editStats("Write", { file_path: "b.js", content: "1\n2\n3" }), { path: "b.js", added: 3, removed: 0 });
  assert.deepEqual(editStats("MultiEdit", { file_path: "c.js", edits: [{ old_string: "a", new_string: "b\nc" }, { old_string: "", new_string: "d" }] }), { path: "c.js", added: 3, removed: 1 });
  assert.deepEqual(editStats("edit", { path: "d.py", oldText: "a\nb", newText: "a" }), { path: "d.py", added: 1, removed: 2 });
  assert.deepEqual(editStats("write", { path: "e.py", content: "q" }), { path: "e.py", added: 1, removed: 0 });
  assert.equal(editStats("Bash", { command: "ls" }), null);
  assert.equal(editStats("Edit", null), null);
});

test("editedFiles aggregates per path and totals", () => {
  const r = editedFiles([
    { name: "Edit", args: { file_path: "a.js", old_string: "1", new_string: "1\n2" } },
    { name: "Edit", args: { file_path: "a.js", old_string: "x\ny\nz", new_string: "x" } },
    { name: "Write", args: { file_path: "b.js", content: "n\nm" } },
    { name: "Read", args: { file_path: "c.js" } },
  ]);
  assert.deepEqual(r.files, [{ path: "a.js", added: 3, removed: 4 }, { path: "b.js", added: 2, removed: 0 }]);
  assert.equal(r.added, 5); assert.equal(r.removed, 4);
});

test("groupToolRuns folds consecutive tools into work groups and text breaks them", () => {
  const segs = groupToolRuns([
    { kind: "tool", startTs: 1000, endTs: 3000 },
    { kind: "tool", startTs: 3000, endTs: 9000 },
    { kind: "text" },
    { kind: "tool", startTs: 10_000, endTs: null },
  ], 15_000);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].kind, "work"); assert.equal(segs[0].items.length, 2); assert.equal(segs[0].durationMs, 8000); assert.equal(segs[0].open, false);
  assert.equal(segs[1].kind, "text");
  assert.equal(segs[2].open, true); assert.equal(segs[2].durationMs, 5000);
});

test("relPath strips the cwd and normalizes slashes", () => {
  assert.equal(relPath("C:\\Users\\b\\proj\\ui\\app.js", "C:\\Users\\b\\proj"), "ui/app.js");
  assert.equal(relPath("C:\\other\\x.js", "C:\\Users\\b\\proj"), "C:/other/x.js");
  assert.equal(relPath("ui/app.js", null), "ui/app.js");
});

test("md renders code, bold, lists and escapes html", () => {
  assert.equal(md("**hi** <b>"), "<p><b>hi</b> &lt;b&gt;</p>");
  assert.match(md("```js\nlet a = 1\n```"), /<pre><code>let a = 1<\/code><\/pre>/);
  assert.match(md("- a\n- b"), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  // CRLF files (Windows-authored notes) render tables and lists too
  assert.match(md("| | |\r\n|---|---|\r\n| **File** | x |\r\n"), /<table><tr><th><\/th><th><\/th><\/tr><tr><td><b>File<\/b><\/td><td>x<\/td><\/tr><\/table>/);
});

test("splitAttachments strips leading omni-memory/repo-graph packs", () => {
  assert.deepEqual(splitAttachments("<omni-memory>stuff here</omni-memory>\n\nwhat's the plan?"), { text: "what's the plan?", attachments: ["memory"] });
  assert.deepEqual(
    splitAttachments("<omni-memory>mem</omni-memory>\n<repo-graph node=\"x\">graph</repo-graph>\n\nhello"),
    { text: "hello", attachments: ["memory", "repo graph"] }
  );
  assert.deepEqual(
    splitAttachments("<repo-graph>graph</repo-graph>\n<omni-memory>mem</omni-memory>\n\nhello"),
    { text: "hello", attachments: ["repo graph", "memory"] }
  );
  assert.deepEqual(splitAttachments("just plain text"), { text: "just plain text", attachments: [] });
  const mid = "before <omni-memory>mem</omni-memory> after";
  assert.deepEqual(splitAttachments(mid), { text: mid, attachments: [] });
});

test("groupLabel", () => {
  const now = new Date(2026, 8, 9, 12).getTime();
  assert.equal(groupLabel(now - 3600e3, now), "Today");
  assert.equal(groupLabel(now - 86400e3, now), "Yesterday");
  assert.equal(groupLabel(now - 3 * 86400e3, now), "This week");
});

test("toolKind classifies Claude Code, pi and MCP tool names", () => {
  assert.equal(toolKind("Bash"), "shell"); assert.equal(toolKind("PowerShell"), "shell"); assert.equal(toolKind("bash"), "shell");
  assert.equal(toolKind("Edit"), "edit"); assert.equal(toolKind("MultiEdit"), "edit"); assert.equal(toolKind("write"), "edit"); assert.equal(toolKind("NotebookEdit"), "edit");
  assert.equal(toolKind("Read"), "read"); assert.equal(toolKind("read"), "read");
  assert.equal(toolKind("Grep"), "search"); assert.equal(toolKind("Glob"), "search"); assert.equal(toolKind("find"), "search"); assert.equal(toolKind("ls"), "search");
  assert.equal(toolKind("Agent"), "agent"); assert.equal(toolKind("Task"), "agent"); assert.equal(toolKind("claude_task"), "agent");
  assert.equal(toolKind("mcp__claude-in-chrome__computer"), "browser");
  assert.equal(toolKind("WebFetch"), "web"); assert.equal(toolKind("WebSearch"), "web");
  assert.equal(toolKind("mcp__archi_automate__ifc_open"), "mcp"); assert.equal(toolKind("Skill"), "other");
});

test("toolLabel gives a one-line Claude-Code-style row label", () => {
  assert.deepEqual(toolLabel("Bash", { command: "git  status\n  --short" }), { kind: "shell", text: "Ran git status --short" });
  assert.deepEqual(toolLabel("Edit", { file_path: "C:/p/ui/cli.py", old_string: "a", new_string: "b\nc" }, "C:/p"), { kind: "edit", text: "Edited cli.py", added: 2, removed: 1 });
  assert.deepEqual(toolLabel("Write", { file_path: "x/new.css", content: "a\nb" }), { kind: "edit", text: "Wrote new.css", added: 2, removed: 0 });
  assert.deepEqual(toolLabel("Read", { file_path: "C:/p/ui/app.js" }, "C:/p"), { kind: "read", text: "Read ui/app.js" });
  assert.deepEqual(toolLabel("Grep", { pattern: "foo.*bar" }), { kind: "search", text: "Searched foo.*bar" });
  assert.deepEqual(toolLabel("Agent", { description: "Diagnose panel visibility", prompt: "long..." }), { kind: "agent", text: "Diagnose panel visibility" });
  assert.deepEqual(toolLabel("mcp__claude-in-chrome__computer", { action: "screenshot" }), { kind: "browser", text: "Used the browser" });
  assert.deepEqual(toolLabel("WebFetch", { url: "https://x.y/z" }), { kind: "web", text: "Fetched https://x.y/z" });
  assert.deepEqual(toolLabel("Skill", { skill: "graphify" }), { kind: "other", text: "Skill graphify" });
  assert.equal(toolLabel("Bash", { command: "x".repeat(300) }).text.length <= 141, true);
  assert.deepEqual(toolLabel("Bash", undefined), { kind: "shell", text: "Ran a command" });
});

test("workSummary joins verb phrases in first-seen order", () => {
  assert.equal(workSummary(["browser", "edit", "shell", "edit"]), "Used the browser, edited files, ran commands");
  assert.equal(workSummary(["shell"]), "Ran commands");
  assert.equal(workSummary(["read", "search"]), "Read files, searched files");
  assert.equal(workSummary(["agent", "web", "mcp", "other"]), "Ran subagents, fetched the web, used tools");
  assert.equal(workSummary([]), "Worked");
  assert.equal(workSummary(["shell"], true), "Running a command…");
  assert.equal(workSummary(["edit", "browser"], true), "Using the browser…");
});

test("fileKind picks the preview family from the name", () => {
  assert.equal(fileKind("app.apk"), "archive"); assert.equal(fileKind("Bundle.ZIP"), "archive"); assert.equal(fileKind("lib.jar"), "archive");
  assert.equal(fileKind("shot.png"), "image"); assert.equal(fileKind("a/b/photo.JPEG"), "image"); assert.equal(fileKind("logo.svg"), "image");
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("main.py"), "text"); assert.equal(fileKind("Makefile"), "text"); assert.equal(fileKind(".zshrc"), "text"); assert.equal(fileKind("LICENSE"), "text");
  assert.equal(fileKind("classes.dex"), "binary"); assert.equal(fileKind("a.tar.gz"), "binary");
});

test("fmtBytes", () => {
  assert.equal(fmtBytes(0), "0 B"); assert.equal(fmtBytes(2048), "2.0 KB"); assert.equal(fmtBytes(5 * 1048576), "5.0 MB"); assert.equal(fmtBytes(null), "");
});

test("titleFrom drops a leading memory pack so the history shows the real prompt", () => {
  assert.equal(titleFrom("<omni-memory>- **arceus-x-neo-rebuild** stuff</omni-memory>\n\nRebuild the APK"), "Rebuild the APK");
  assert.equal(titleFrom("  plain   prompt "), "plain prompt");
});

test("buildTree nests archive entries, folders first, implicit folders included", () => {
  const t = buildTree([
    { path: "classes.dex", size: 10 },
    { path: "res/values/strings.xml", size: 5 },
    { path: "res/", size: 0, dir: true },
    { path: "assets/notes.md", size: 7 },
    { path: "AndroidManifest.xml", size: 3 },
    { path: "lib/arm64-v8a/libx.so", size: 99 },
  ]);
  assert.deepEqual(t.map((n) => `${n.dir ? "d" : "f"}:${n.name}`), ["d:assets", "d:lib", "d:res", "f:AndroidManifest.xml", "f:classes.dex"]);
  const res = t.find((n) => n.name === "res");
  assert.equal(res.path, "res/"); assert.equal(res.count, 1);
  assert.deepEqual(res.children[0].children.map((n) => n.path), ["res/values/strings.xml"]);
  const lib = t.find((n) => n.name === "lib");
  assert.equal(lib.children[0].name, "arm64-v8a"); assert.equal(lib.children[0].children[0].size, 99);
  assert.equal(t.find((n) => n.name === "assets").children[0].entry.path, "assets/notes.md");
  assert.deepEqual(buildTree([]), []);
});
