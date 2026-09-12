/**
 * Obsidian-vault memory manager. Pure filesystem + markdown, no dependencies.
 *
 * Layout (openable directly as an Obsidian vault):
 *   MEMORY.md            auto-generated index: one line per note under Memory/
 *   Memory/<slug>.md     one durable fact per note (frontmatter + body + [[links]])
 *   Memory/claude/<project>/*.md   notes imported from Claude Code auto-memory
 *   Sessions/<harness>/<date>_<id>.md   auto-written session digests
 *   Projects/<name>.md   one note per working directory, linked from digests
 *   Inbox/               scratch notes the user drops in
 */
import { promises as fs, existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const NOTE_TYPES = ["user", "feedback", "project", "reference", "session", "inbox"];

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "note";
}

export function extractLinks(body) {
  const out = [];
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(body || ""))) out.push(m[1].trim());
  return out;
}

function parseYamlValue(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  if (/^(true|false)$/.test(v)) return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, "");
}

/** Minimal YAML frontmatter: scalars, [a, b] lists, one level of nesting (flattened). */
export function parseNote(text) {
  const src = String(text || "");
  if (!src.startsWith("---")) return { frontmatter: {}, body: src };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: src };
  const head = src.slice(3, end).replace(/^\r?\n/, "");
  const body = src.slice(end + 4).replace(/^(\r?\n)+/, "");
  const fm = {};
  let parentKey = null;
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      parentKey = top[2].trim() === "" ? top[1] : null;
      if (top[2].trim() !== "") fm[top[1]] = parseYamlValue(top[2]);
    } else if (nested && parentKey) {
      // flatten e.g. metadata.type -> type (Claude Code memory files use this)
      if (!(nested[1] in fm)) fm[nested[1]] = parseYamlValue(nested[2]);
    }
  }
  return { frontmatter: fm, body };
}

export function serializeNote(fm, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else lines.push(`${k}: ${String(v)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${(body || "").replace(/^\n+/, "")}`.replace(/\s*$/, "\n");
}

const tokenize = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

export class Vault {
  constructor(root) {
    this.root = root;
  }

  abs(rel) {
    return join(this.root, rel);
  }

  rel(abs) {
    return relative(this.root, abs).split(sep).join("/");
  }

  ensure() {
    for (const d of [".obsidian", "Memory", "Sessions", "Projects", "Inbox"]) {
      const p = this.abs(d);
      if (!existsSync(p)) fsSyncMkdir(p);
    }
    const app = this.abs(".obsidian/app.json");
    if (!existsSync(app)) fsSyncWrite(app, JSON.stringify({ alwaysUpdateLinks: true, newFileLocation: "folder", newFileFolderPath: "Inbox", useMarkdownLinks: false }, null, 2));
    const idx = this.abs("MEMORY.md");
    if (!existsSync(idx)) fsSyncWrite(idx, "# Memory index\n\n_No memories yet. Save one from Omni Agent, or let a harness call `memory_save`._\n");
    return this;
  }

  async walk(dir = "") {
    const out = [];
    const start = this.abs(dir);
    if (!existsSync(start)) return out;
    const stack = [start];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith(".md") && !(d === start && dir === "" && e.name === "MEMORY.md")) out.push(p);
      }
    }
    return out.sort();
  }

  async read(rel) {
    const abs = this.abs(rel);
    const text = await fs.readFile(abs, "utf8");
    const { frontmatter, body } = parseNote(text);
    const st = await fs.stat(abs);
    return { path: rel, frontmatter, body, links: extractLinks(body), mtime: st.mtimeMs, size: st.size, raw: text };
  }

  async write(rel, text) {
    const abs = this.abs(rel);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
    if (rel.startsWith("Memory/")) await this.rebuildIndex();
    return { path: rel };
  }

  async remove(rel) {
    await fs.rm(this.abs(rel), { force: true });
    if (rel.startsWith("Memory/")) await this.rebuildIndex();
  }

  async list(dir = "") {
    const files = await this.walk(dir);
    const out = [];
    for (const f of files) {
      let fm = {};
      let preview = "";
      try {
        const text = await fs.readFile(f, "utf8");
        const n = parseNote(text);
        fm = n.frontmatter;
        preview = n.body.replace(/\s+/g, " ").slice(0, 160);
      } catch { /* unreadable */ }
      const st = await fs.stat(f);
      out.push({ path: this.rel(f), name: fm.name || basename(f, ".md"), description: fm.description || "", type: fm.type || (this.rel(f).split("/")[0] || "").toLowerCase(), tags: Array.isArray(fm.tags) ? fm.tags : [], mtime: st.mtimeMs, size: st.size, preview });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** Save a durable memory note. Returns { path, created }. */
  async save({ name, description = "", type = "project", tags = [], body = "", source = "", path }) {
    if (!name) throw new Error("name required");
    const slug = slugify(name);
    const rel = path || `Memory/${slug}.md`;
    const abs = this.abs(rel);
    const exists = existsSync(abs);
    const now = new Date().toISOString().slice(0, 10);
    let fm = { name: slug, description, type: NOTE_TYPES.includes(type) ? type : "project", tags, created: now, updated: now, source };
    let finalBody = body;
    if (exists) {
      const old = parseNote(await fs.readFile(abs, "utf8"));
      fm = { ...old.frontmatter, description: description || old.frontmatter.description, type: fm.type, tags: tags.length ? tags : old.frontmatter.tags, updated: now, source: source || old.frontmatter.source };
      if (!finalBody) finalBody = old.body;
    }
    await this.write(rel, serializeNote(fm, finalBody));
    return { path: rel, created: !exists };
  }

  async rebuildIndex() {
    const notes = (await this.list("Memory")).sort((a, b) => a.path.localeCompare(b.path));
    const lines = ["# Memory index", "", "_One line per note. Auto-generated by Omni Agent; edit the notes, not this file._", ""];
    for (const n of notes) {
      const hook = n.description || n.preview;
      lines.push(`- [${n.name}](${n.path}) — ${hook}${n.type ? ` _(${n.type})_` : ""}`);
    }
    await fs.writeFile(this.abs("MEMORY.md"), `${lines.join("\n")}\n`, "utf8");
    return notes.length;
  }

  /** Term-overlap ranking over name/description/tags/body. */
  async search(query, { limit = 20, dir = "" } = {}) {
    const q = tokenize(query);
    const files = await this.walk(dir);
    const scored = [];
    for (const f of files) {
      let text;
      try { text = await fs.readFile(f, "utf8"); } catch { continue; }
      const { frontmatter: fm, body } = parseNote(text);
      const rel = this.rel(f);
      const nameT = tokenize(`${fm.name || basename(f, ".md")} ${rel}`);
      const descT = tokenize(`${fm.description || ""} ${(fm.tags || []).join(" ")}`);
      const bodyT = tokenize(body);
      let score = 0;
      for (const w of q) {
        if (nameT.includes(w)) score += 5;
        if (descT.includes(w)) score += 3;
        const c = bodyT.filter((x) => x === w).length;
        if (c) score += Math.min(3, c);
        // prefix matches ("compact" ~ "compaction")
        if (!nameT.includes(w) && nameT.some((x) => x.startsWith(w))) score += 2;
      }
      if (q.length === 0) score = 1;
      if (score > 0) scored.push({ path: rel, name: fm.name || basename(f, ".md"), description: fm.description || "", type: fm.type || "", score, preview: body.replace(/\s+/g, " ").slice(0, 200), body });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, limit);
  }

  /**
   * Build a compact markdown block of the most relevant notes that fits a token
   * budget (chars/4). This is what gets injected into a harness prompt.
   */
  async pack(query, { budgetTokens = 1500, dir = "Memory" } = {}) {
    const hits = await this.search(query, { limit: 12, dir });
    const budget = budgetTokens * 4;
    let out = "";
    for (const h of hits) {
      const bodyLimit = Math.max(120, Math.floor(budget / Math.max(3, hits.length)));
      const body = h.body.replace(/\s+/g, " ").trim().slice(0, bodyLimit);
      const entry = `- **${h.name}** (${h.type || "note"}, ${h.path}): ${h.description ? `${h.description}. ` : ""}${body}\n`;
      if (out.length + entry.length > budget) break;
      out += entry;
    }
    return out ? `<omni-memory>\n${out}</omni-memory>` : "";
  }

  projectName(cwd) {
    if (!cwd) return "unknown";
    // Session files may come from a Windows machine (C:\\x\\proj) or a POSIX one (/x/proj); split on both.
    return slugify(String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "") || "root";
  }

  async ensureProject(cwd) {
    const name = this.projectName(cwd);
    const rel = `Projects/${name}.md`;
    if (!existsSync(this.abs(rel))) {
      await this.write(rel, serializeNote({ name, description: `Project at ${cwd}`, type: "project", cwd, created: new Date().toISOString().slice(0, 10) }, `# ${name}\n\nWorking directory: \`${cwd}\`\n\n## Notes\n\n## Sessions\n_Digests link here automatically._\n`));
    }
    return { name, path: rel };
  }

  /** Write (or overwrite) a digest note for one session; idempotent per session id. */
  async writeSessionDigest(d) {
    const project = await this.ensureProject(d.cwd);
    const day = new Date(d.startedAt || Date.now()).toISOString().slice(0, 10);
    const shortId = String(d.sid || "").split(":").pop().slice(0, 8);
    const rel = `Sessions/${d.harness}/${day}_${shortId}.md`;
    const u = d.usage || {};
    const tools = Object.entries(d.tools || {}).sort((a, b) => b[1] - a[1]);
    const fm = { name: `${d.harness}-${day}-${shortId}`, description: d.title || (d.prompts?.[0] || "").slice(0, 120), type: "session", harness: d.harness, session: d.sid, cwd: d.cwd, model: d.model, started: new Date(d.startedAt || Date.now()).toISOString(), ended: new Date(d.endedAt || Date.now()).toISOString(), tokens_total: u.total || 0, cost_usd: Number((d.cost || 0).toFixed(4)) };
    const body = [
      `# ${d.title || `${d.harness} session ${shortId}`}`,
      "",
      `Project: [[Projects/${project.name}]] · Harness: **${d.harness}** · Model: \`${d.model || "?"}\``,
      "",
      "## Tokens",
      `| input | output | cache read | cache write | total | cost |`,
      `|---|---|---|---|---|---|`,
      `| ${u.input || 0} | ${u.output || 0} | ${u.cacheRead || 0} | ${u.cacheWrite || 0} | ${u.total || 0} | $${(d.cost || 0).toFixed(4)} |`,
      "",
      "## Prompts",
      ...(d.prompts || []).slice(0, 30).map((p) => `- ${String(p).replace(/\s+/g, " ").slice(0, 300)}`),
      "",
      "## Tools used",
      ...(tools.length ? tools.map(([n, c]) => `- ${n}: ${c}`) : ["- (none)"]),
      "",
      "## Last assistant message",
      (d.lastAssistant || "").slice(0, 3000),
      "",
    ].join("\n");
    await this.write(rel, serializeNote(fm, body));
    return { path: rel, project };
  }

  /** Copy Claude Code auto-memory notes into Memory/claude/<project>/. */
  async importClaudeMemory(projectsDir) {
    const imported = [];
    if (!existsSync(projectsDir)) return imported;
    const projects = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const memDir = join(projectsDir, p.name, "memory");
      if (!existsSync(memDir)) continue;
      const short = p.name.replace(/^C--Users-[^-]+-Desktop-?/, "").replace(/^C--Users-[^-]+-?/, "") || "home";
      const target = `Memory/claude/${slugify(short) || "home"}`;
      for (const f of await fs.readdir(memDir)) {
        if (!f.endsWith(".md") || f === "MEMORY.md") continue;
        const text = await fs.readFile(join(memDir, f), "utf8");
        const { frontmatter, body } = parseNote(text);
        const fm = { name: frontmatter.name || basename(f, ".md"), description: frontmatter.description || "", type: frontmatter.type || "reference", source: `claude-code:${p.name}`, imported: new Date().toISOString().slice(0, 10) };
        const rel = `${target}/${f}`;
        await this.write(rel, serializeNote(fm, body));
        imported.push(rel);
      }
    }
    await this.rebuildIndex();
    return imported;
  }

  async graph() {
    const files = await this.walk("");
    const nodes = [];
    const links = [];
    for (const f of files) {
      const rel = this.rel(f);
      let text = "";
      try { text = await fs.readFile(f, "utf8"); } catch { continue; }
      const { frontmatter } = parseNote(text);
      nodes.push({ id: rel.replace(/\.md$/, ""), type: frontmatter.type || rel.split("/")[0] });
      for (const l of extractLinks(text)) links.push({ source: rel.replace(/\.md$/, ""), target: l });
    }
    return { nodes, links };
  }
}

import { mkdirSync, writeFileSync } from "node:fs";
function fsSyncMkdir(p) { mkdirSync(p, { recursive: true }); }
function fsSyncWrite(p, text) { writeFileSync(p, text, "utf8"); }
