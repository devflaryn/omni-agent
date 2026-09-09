import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, parseNote, serializeNote, slugify, extractLinks } from "../server/memory.mjs";

function freshVault() {
  const dir = mkdtempSync(join(tmpdir(), "omni-vault-"));
  const v = new Vault(dir);
  v.ensure();
  return { dir, v };
}

test("parse/serialize frontmatter round-trip; wikilinks extracted", () => {
  const text = "---\nname: foo-bar\ndescription: A thing\ntype: project\ntags: [a, b]\n---\n\nBody with [[other-note]] and [[Projects/x|alias]].\n";
  const n = parseNote(text);
  assert.equal(n.frontmatter.name, "foo-bar");
  assert.deepEqual(n.frontmatter.tags, ["a", "b"]);
  assert.match(n.body, /^Body/);
  assert.deepEqual(extractLinks(n.body), ["other-note", "Projects/x"]);
  const again = parseNote(serializeNote(n.frontmatter, n.body));
  assert.deepEqual(again.frontmatter, n.frontmatter);
  assert.equal(slugify("Hello, World! pi harness"), "hello-world-pi-harness");
});

test("ensure creates an Obsidian vault layout and index", () => {
  const { dir } = freshVault();
  for (const p of [".obsidian/app.json", "MEMORY.md", "Memory", "Sessions", "Projects", "Inbox"]) assert.ok(existsSync(join(dir, p)), p);
});

test("save/search/pack/index", async () => {
  const { dir, v } = freshVault();
  const a = await v.save({ name: "ngrok token hardcoded", description: "user chose to keep ngrok token hardcoded", type: "feedback", tags: ["colab"], body: "Do not raise it again. See [[llm-server-notebook]]." });
  await v.save({ name: "llm server notebook", description: "what llm-q5-k-p.ipynb is for", type: "project", body: "B300 hardware constraints for the LLM server notebook." });
  assert.equal(a.path, "Memory/ngrok-token-hardcoded.md");
  const idx = readFileSync(join(dir, "MEMORY.md"), "utf8");
  assert.match(idx, /ngrok-token-hardcoded\.md/);
  assert.match(idx, /llm-server-notebook\.md/);
  const hits = await v.search("ngrok token");
  assert.equal(hits[0].path, "Memory/ngrok-token-hardcoded.md");
  const pack = await v.pack("notebook hardware", { budgetTokens: 200 });
  assert.match(pack, /llm-server-notebook/);
  assert.ok(pack.length / 4 <= 260, "pack respects the token budget (chars/4 ≈ tokens)");
  const list = await v.list();
  assert.equal(list.filter((n) => n.path.startsWith("Memory/")).length, 2);
  const note = await v.read("Memory/llm-server-notebook.md");
  assert.equal(note.frontmatter.type, "project");
  assert.deepEqual(note.links, []);
});

test("session digest + project note + import of Claude auto-memory", async () => {
  const { dir, v } = freshVault();
  const out = await v.writeSessionDigest({
    harness: "pi", sid: "pi:01a086a6-c763", cwd: "C:\\Users\\berat\\Desktop\\last month\\rebuild", title: "Rebuild executor client",
    model: "Qwen/Qwen3.8-27B", startedAt: Date.parse("2026-09-09T14:51:12Z"), endedAt: Date.parse("2026-09-09T15:39:34Z"),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0,
    prompts: ["This file here is a modified roblox client"], lastAssistant: "Done for now.", tools: { bash: 120, read: 75 },
  });
  assert.match(out.path, /^Sessions\/pi\/2026-09-09_01a086a6/);
  const md = readFileSync(join(dir, out.path), "utf8");
  assert.match(md, /\[\[Projects\/rebuild\]\]/);
  assert.match(md, /bash.*120/);
  assert.ok(existsSync(join(dir, "Projects", "rebuild.md")));
  // import claude memory
  const proj = mkdtempSync(join(tmpdir(), "claude-projects-"));
  mkdirSync(join(proj, "C--Users-berat-Desktop-google-colab", "memory"), { recursive: true });
  writeFileSync(join(proj, "C--Users-berat-Desktop-google-colab", "memory", "note.md"), "---\nname: note\ndescription: d\nmetadata:\n  type: user\n---\n\nhello\n");
  writeFileSync(join(proj, "C--Users-berat-Desktop-google-colab", "memory", "MEMORY.md"), "- [x](note.md)\n");
  const imported = await v.importClaudeMemory(proj);
  assert.equal(imported.length, 1);
  assert.ok(existsSync(join(dir, "Memory", "claude", "google-colab", "note.md")));
  const n = await v.read("Memory/claude/google-colab/note.md");
  assert.equal(n.frontmatter.type, "user", "nested metadata.type is flattened");
});
