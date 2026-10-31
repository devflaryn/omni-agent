/**
 * A project's knowledge graph: one SQLite file (node:sqlite) of nodes and edges that importers seed (graphify for
 * source, Ghidra for binaries) and workers annotate as they learn. Queries are token-budgeted text, so an agent
 * starts from the map instead of re-reading code or disassembly.
 *
 *   nodes  id, kind, name, binary, addr, summary, status (unknown|hypothesis|confirmed), confidence, evidence, tags
 *   edges  src, dst, rel (imports, calls, xref, contains, reads, writes, decrypts, implements, related), note
 *   FTS5 over name / summary / tags.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let DatabaseSync = null;
/** node:sqlite (Node ≥ 22.13 unflagged); loaded lazily so Omni still starts on a Node without it. */
async function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  const orig = process.emitWarning;
  // node:sqlite prints an ExperimentalWarning on first use; it is expected here.
  process.emitWarning = (w, ...a) => { if (String(w?.message ?? w).includes("SQLite")) return; return orig.call(process, w, ...a); };
  try { ({ DatabaseSync } = await import("node:sqlite")); } finally { process.emitWarning = orig; }
  return DatabaseSync;
}

export const NODE_KINDS = ["file", "module", "symbol", "binary", "function", "string", "offset", "struct", "concept", "class", "method"];
export const STATUS_RANK = { unknown: 0, hypothesis: 1, confirmed: 2 };
const FIELDS = ["kind", "name", "binary", "addr", "summary", "status", "confidence", "evidence", "tags"];
const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const clipChars = (s, n) => (s.length > n ? `${s.slice(0, n - 30)}\n… (cut to the budget)` : s);

/** An FTS5 query from free text: each word as a prefix term, OR-ed. Pure. */
export function ftsQuery(text) {
  const words = String(text ?? "").toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [];
  return [...new Set(words)].slice(0, 12).map((w) => `"${w}"*`).join(" OR ");
}

export class KGraph {
  /** Use `await KGraph.open(file)`. */
  constructor(db, file) { this.db = db; this.file = file; this.prepare(); }

  static async open(file) {
    const D = await sqlite();
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const db = new D(file);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, binary TEXT, addr TEXT, summary TEXT, status TEXT DEFAULT 'unknown', confidence REAL, evidence TEXT, tags TEXT, updated_at INTEGER, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL, note TEXT, PRIMARY KEY (src, dst, rel));
      CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
      CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS nodes_bin_addr ON nodes(binary, addr);
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(name, summary, tags, tokenize = 'unicode61 remove_diacritics 2 tokenchars ''_''');`);
    return new KGraph(db, file);
  }

  prepare() {
    const d = this.db;
    this.q = {
      get: d.prepare("SELECT * FROM nodes WHERE id = ?"),
      byName: d.prepare("SELECT * FROM nodes WHERE name = ? COLLATE NOCASE ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'hypothesis' THEN 1 ELSE 2 END LIMIT 1"),
      // Names that start with the query (case-insensitive), shortest first: a name hit beats a noisy summary.
      prefix: d.prepare("SELECT * FROM nodes WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name) LIMIT ?"),
      byAddr: d.prepare("SELECT * FROM nodes WHERE addr = ? COLLATE NOCASE LIMIT 1"),
      // An upsert keeps the row's rowid, which keys its full-text entry (a rowid delete is a lookup, not a scan).
      put: d.prepare(`INSERT INTO nodes (id, kind, name, binary, addr, summary, status, confidence, evidence, tags, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, binary=excluded.binary, addr=excluded.addr, summary=excluded.summary, status=excluded.status,
        confidence=excluded.confidence, evidence=excluded.evidence, tags=excluded.tags, updated_at=excluded.updated_at, updated_by=excluded.updated_by RETURNING rowid`),
      ftsDel: d.prepare("DELETE FROM nodes_fts WHERE rowid = ?"),
      ftsPut: d.prepare("INSERT INTO nodes_fts (rowid, name, summary, tags) VALUES (?,?,?,?)"),
      edge: d.prepare("INSERT INTO edges (src, dst, rel, note) VALUES (?,?,?,?) ON CONFLICT(src, dst, rel) DO UPDATE SET note = COALESCE(excluded.note, edges.note)"),
      out: d.prepare("SELECT e.rel, e.note, n.id, n.name, n.kind, n.status, n.summary FROM edges e LEFT JOIN nodes n ON n.id = e.dst WHERE e.src = ? LIMIT ?"),
      in: d.prepare("SELECT e.rel, e.note, n.id, n.name, n.kind, n.status, n.summary FROM edges e LEFT JOIN nodes n ON n.id = e.src WHERE e.dst = ? LIMIT ?"),
      outN: d.prepare("SELECT COUNT(*) AS n FROM edges WHERE src = ?"),
      inN: d.prepare("SELECT COUNT(*) AS n FROM edges WHERE dst = ?"),
      fts: d.prepare("SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts, 10, 2, 1) LIMIT ?"),
      ftsKind: d.prepare("SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH ? AND n.kind = ? ORDER BY bm25(nodes_fts, 10, 2, 1) LIMIT ?"),
    };
  }

  /** A node id from what is given: its id, else kind:binary:addr, else kind:name. */
  static idOf(n) {
    if (n.id) return String(n.id);
    if (n.addr && n.binary) return `${n.kind || "function"}:${n.binary}:${String(n.addr).toLowerCase()}`;
    if (n.name) return `${n.kind || "symbol"}:${n.name}`;
    return "";
  }

  /**
   * Insert or merge nodes and edges in one transaction. Merge: a non-empty new value wins, `status` only moves up
   * (unknown → hypothesis → confirmed) unless `force`, evidence accumulates. → { nodes, edges } written.
   */
  upsert({ nodes = [], edges = [] } = {}, { by = "", force = false, now = Date.now() } = {}) {
    let nn = 0, ne = 0;
    this.db.exec("BEGIN");
    try {
      for (const raw of nodes) {
        if (!raw || typeof raw !== "object") continue;
        const id = KGraph.idOf(raw);
        if (!id) continue;
        const old = this.q.get.get(id) || {};
        const v = {};
        for (const f of FIELDS) {
          let x = raw[f];
          if (f === "tags" && Array.isArray(x)) x = x.join(" ");
          v[f] = x !== undefined && x !== null && x !== "" ? x : old[f] ?? null;
        }
        if (raw.status && !force && old.status && (STATUS_RANK[raw.status] ?? 0) < (STATUS_RANK[old.status] ?? 0)) v.status = old.status;
        if (v.status && !(v.status in STATUS_RANK)) v.status = "unknown";
        if (raw.evidence && old.evidence && !String(old.evidence).includes(String(raw.evidence))) v.evidence = `${old.evidence}\n${raw.evidence}`.slice(-4000);
        v.confidence = v.confidence == null ? null : Math.max(0, Math.min(1, Number(v.confidence) || 0));
        if (v.addr) v.addr = String(v.addr).toLowerCase();
        const { rowid } = this.q.put.get(id, v.kind || "symbol", v.name || id, v.binary, v.addr, v.summary ? String(v.summary).slice(0, 4000) : null, v.status || "unknown", v.confidence, v.evidence, v.tags, now, by || old.updated_by || null);
        if (old.id) this.q.ftsDel.run(rowid);
        this.q.ftsPut.run(rowid, v.name || id, v.summary || "", v.tags || "");
        nn++;
      }
      for (const e of edges) {
        if (!e?.src || !e?.dst) continue;
        this.q.edge.run(String(e.src), String(e.dst), String(e.rel || "related"), e.note ? String(e.note).slice(0, 500) : null);
        ne++;
      }
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
    return { nodes: nn, edges: ne };
  }

  /** A node by id, else by exact name, else by address. */
  find(key) {
    const k = String(key ?? "").trim();
    if (!k) return null;
    return this.q.get.get(k) || this.q.byName.get(k) || (/^(0x)?[0-9a-f]+$/i.test(k) ? this.q.byAddr.get(k.toLowerCase().startsWith("0x") ? k.toLowerCase() : `0x${k.toLowerCase()}`) : null) || null;
  }

  line(n) {
    const where = [n.addr ? `@${n.addr}` : "", n.binary ? `in ${n.binary}` : ""].filter(Boolean).join(" ");
    return `${n.id} [${n.kind}${n.status && n.status !== "unknown" ? `, ${n.status}${n.confidence != null ? ` ${Math.round(n.confidence * 100)}%` : ""}` : ""}] ${n.name}${where ? ` ${where}` : ""}${n.summary ? ` — ${oneLine(n.summary, 200)}` : ""}`;
  }

  /** Free-text search, best first; exact id/name hits lead. Budget in tokens (~4 chars each). */
  search(text, { kind = "", limit = 20, budget = 1200 } = {}) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const seen = new Set(), rows = [];
    const exact = this.find(text);
    if (exact && (!kind || exact.kind === kind)) { rows.push(exact); seen.add(exact.id); }
    const word = String(text ?? "").trim();
    if (word && !/\s/.test(word)) for (const r of this.q.prefix.all(`${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, lim)) if (!seen.has(r.id) && (!kind || r.kind === kind)) { seen.add(r.id); rows.push(r); }
    const q = ftsQuery(text);
    if (q) for (const r of (kind ? this.q.ftsKind.all(q, kind, lim) : this.q.fts.all(q, lim))) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    if (!rows.length) return `No knowledge-graph nodes match "${oneLine(text, 80)}". (${this.stats().nodes} nodes in the graph)`;
    return clipChars(rows.slice(0, lim).map((r) => this.line(r)).join("\n"), Math.max(400, budget * 4));
  }

  /** One node with its evidence and its neighbours (depth 1, or 2 for the neighbours' own links in short form). */
  node(key, { depth = 1, budget = 1500, edgeLimit = 40 } = {}) {
    const n = this.find(key);
    if (!n) return `No node "${oneLine(key, 80)}". Try kg_search.`;
    const out = [this.line(n)];
    if (n.evidence) out.push(`evidence: ${oneLine(n.evidence, 600)}`);
    if (n.tags) out.push(`tags: ${n.tags}`);
    if (n.updated_by) out.push(`last updated by ${n.updated_by}`);
    const fmt = (r) => `  ${r.rel} ${r.id ? `${r.id} [${r.kind}${r.status && r.status !== "unknown" ? `, ${r.status}` : ""}] ${r.name}${r.summary ? ` — ${oneLine(r.summary, 100)}` : ""}` : "(unknown node)"}${r.note ? ` (${oneLine(r.note, 80)})` : ""}`;
    const outs = this.q.out.all(n.id, edgeLimit), ins = this.q.in.all(n.id, edgeLimit);
    const total = (s, rows) => { const c = s.get(n.id).n; return c > rows.length ? ` (${rows.length} of ${c})` : ""; };
    if (outs.length) out.push(`→ out${total(this.q.outN, outs)}:`, ...outs.map(fmt));
    if (ins.length) out.push(`← in${total(this.q.inN, ins)}:`, ...ins.map(fmt));
    if (Number(depth) >= 2) for (const r of outs.slice(0, 8)) if (r.id) { const sub = this.q.out.all(r.id, 6); if (sub.length) out.push(`  ${r.name} →`, ...sub.map((x) => `    ${x.rel} ${x.name || x.id}`)); }
    return clipChars(out.join("\n"), Math.max(400, budget * 4));
  }

  stats() {
    const nodes = this.db.prepare("SELECT COUNT(*) AS n FROM nodes").get().n;
    const edges = this.db.prepare("SELECT COUNT(*) AS n FROM edges").get().n;
    const byKind = Object.fromEntries(this.db.prepare("SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind ORDER BY n DESC").all().map((r) => [r.kind, r.n]));
    const byStatus = Object.fromEntries(this.db.prepare("SELECT status, COUNT(*) AS n FROM nodes GROUP BY status").all().map((r) => [r.status, r.n]));
    return { nodes, edges, byKind, byStatus };
  }

  close() { try { this.db.close(); } catch { /* closed */ } }
}
