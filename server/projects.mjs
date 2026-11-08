/**
 * Per-project storage for missions, outside the project's own folder:
 *
 *   <root>/<slug>/                  slug = basename + 8 hex of sha1(absolute dir)
 *     project.json                  { dir, name, createdAt }
 *     memory/                       the project's own vault (server/memory.mjs Vault)
 *     graph/                        the knowledge graph (kg.sqlite) and raw imports
 *     artifacts/                    dumps, decrypted binaries, scripts, Ghidra projects
 *     missions/<mission-id>/        one MissionFiles each
 *
 * Nothing here ever writes into the project directory itself.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Atomic JSON write: a temp file next to it, then rename. */
export function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 1)}\n`);
  renameSync(tmp, file);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** A stable, filesystem-safe folder name for a project directory. */
export function projectSlug(dir) {
  let abs = resolve(String(dir || ".")).replace(/[\\/]+$/, "");
  if (process.platform === "win32" || /^[A-Za-z]:\\/.test(String(dir))) abs = abs.toLowerCase();
  const name = (basename(String(dir).replace(/[\\/]+$/, "").replace(/\\/g, "/")) || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

export class ProjectStore {
  constructor({ root }) { this.root = root; }

  /** The project's folders (created on first use) for a project directory. */
  project(dir) {
    const abs = resolve(dir);
    const slug = projectSlug(abs);
    const root = join(this.root, slug);
    const p = { slug, dir: abs, root, memoryDir: join(root, "memory"), graphDir: join(root, "graph"), artifactsDir: join(root, "artifacts"), missionsDir: join(root, "missions") };
    for (const d of [p.memoryDir, p.graphDir, p.artifactsDir, p.missionsDir]) mkdirSync(d, { recursive: true });
    const meta = join(root, "project.json");
    if (!existsSync(meta)) writeJsonAtomic(meta, { dir: abs, name: basename(abs), createdAt: Date.now() });
    return p;
  }

  /** Every project's project.json (with its slug). */
  list() {
    let names = [];
    try { names = readdirSync(this.root); } catch { return []; }
    return names.map((slug) => { const j = readJson(join(this.root, slug, "project.json")); return j ? { ...j, slug } : null; }).filter(Boolean);
  }
}

/** One mission's folder: mission.json (state), events.jsonl, ledger.md, reports/, workers/. */
export class MissionFiles {
  constructor({ dir }) { this.dir = dir; }
  get file() { return join(this.dir, "mission.json"); }
  read() { return readJson(this.file); }
  write(obj) { writeJsonAtomic(this.file, obj); }
  /** Deletes the mission's folder. The project's memory, graph and artifacts are outside it. */
  remove() { rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  append(ev) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "events.jsonl"), `${JSON.stringify({ ts: Date.now(), ...ev })}\n`);
  }
  ledger(line) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "ledger.md"), `- ${new Date().toISOString()} ${String(line).replace(/\r?\n/g, " ")}\n`);
  }
  writeReport(workerId, text) {
    const f = join(this.dir, "reports", `${workerId}.md`);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(text ?? ""));
    return f;
  }
  writeBrief(workerId, text, name = "brief.md") {
    const f = join(this.dir, "workers", workerId, name);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(text ?? ""));
    return f;
  }
}
