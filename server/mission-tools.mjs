/**
 * The mission tools, executed server-side for the Omni OpenCode plugin (POST /api/missions/tool) and the MCP endpoint
 * Claude Code workers use. The caller is identified by its chat (`sessionID`): a boss chat may use the boss tools, a
 * worker (or a worker's subagent) the worker tools. Every output is short and capped: the boss must never be handed
 * raw tool output.
 *
 * `deps` (optional): { kg: (m) => KGraph-like {search, node, upsert}, memory: (m) => Vault-like {pack, search, save} }.
 */
import { BOSS_TOOLS } from "./boss-prompt.mjs";
import { clip, renderState } from "./missions.mjs";

export const WORKER_TOOLS = Object.freeze(["ask_boss", "progress", "handoff"]);
const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

export async function runMissionTool(missions, { sessionID, tool, args = {} } = {}, deps = {}) {
  const max = missions.config?.toolMax || 4000;
  const out = (text, metadata) => ({ output: clip(String(text), max), ...(metadata ? { metadata } : {}) });
  const sid = String(sessionID || "");
  const m = missions.bySession(sid);
  if (!m) return out("This chat is not part of a mission.", { error: true });
  const full = sid.includes(":") ? sid : `pi:${sid}`;
  const boss = missions.isBoss(m, full);
  const name = String(tool || "");
  if (BOSS_TOOLS.includes(name) && !boss && !["kg_search", "kg_node", "memory_recall"].includes(name)) return out(`${name} is for the mission's boss only.`, { error: true });
  if (WORKER_TOOLS.includes(name) && boss) return out(`${name} is for workers; you are the boss.`, { error: true });
  const a = args && typeof args === "object" ? args : {};
  const me = boss ? null : missions.agents?.agentBySid?.(full);
  try {
    switch (name) {
      case "mission_state": return out(renderState(m, { workers: missions.workersOf(m), now: missions.now(), max }));
      case "task_add": {
        const items = Array.isArray(a.tasks) && a.tasks.length ? a.tasks : [a];
        const made = items.map((t) => missions.addTask(m, { title: t.title, parent: t.parent, detail: t.detail }));
        return out(`Added ${made.map((t) => `${t.id} "${oneLine(t.title, 80)}"`).join(", ")}.`, { ids: made.map((t) => t.id) });
      }
      case "task_update": {
        const t = missions.updateTask(m, a.id, { status: a.status, summary: a.summary, title: a.title });
        return out(`Task ${t.id} is ${t.status}${t.summary ? ` — ${oneLine(t.summary, 200)}` : ""}.`);
      }
      case "worker_spawn": {
        const scope = a.scope && typeof a.scope === "object" ? { files: list(a.scope.files), notes: list(a.scope.notes), kg: list(a.scope.kg) } : undefined;
        const rec = missions.spawnWorker(m, { task: a.task, kind: a.kind, taskId: a.task_id || a.taskId, title: a.title, agent: a.agent, model: a.model, scope, timeoutMinutes: a.timeout_minutes });
        return out(`Started worker ${rec.id} (${rec.kind === "claude" ? "claude" : "opencode"}${rec.model ? ` ${rec.model}` : ""})${rec.taskId ? ` for task ${rec.taskId}` : ""}${rec.status === "queued" ? " — queued until a slot frees" : ""}. Its report arrives by itself; keep going.`, { id: rec.id, status: rec.status });
      }
      case "worker_message": {
        if (a.question_id && missions.answerQuestion(m, a.question_id, a.message)) return out(`Answered ${a.question_id}; worker ${a.id} continues with it.`);
        const r = await missions.messageWorker(m, a.id, a.message, { from: "boss" });
        const how = { steer: "it gets it in its current run", followUp: "it gets it after its current step", resumed: "it had finished and is running again", restarted: "it was restarted on its session" };
        return out(`Sent to worker ${a.id}: ${how[r?.how] || r?.how || "delivered"}.`);
      }
      case "worker_summary": return out(await missions.workerSummary(m, String(a.id || "")));
      case "worker_cancel": { const r = await missions.cancelWorker(m, String(a.id || "")); return out(`Worker ${r.id} ${r.status}.`); }
      case "note": { const n = missions.addNote(m, { kind: a.kind, title: a.title, body: a.body }); return out(`Noted ${n.id} [${n.kind}] ${n.title}.`); }
      case "notify": { const n = missions.notify(m, { title: a.title, body: a.body, urgency: a.urgency, question: a.question }); return out(`Notification ${n.id} sent (${n.urgency}).${n.question ? " The user's answer arrives as a message; keep working on what does not depend on it." : ""}`); }
      case "mission_done": missions.finish(m, a.summary); return out("Mission marked done. The user has been notified.");
      case "kg_search": case "kg_node": {
        const kg = await deps.kg?.(m);
        if (!kg) return out("The knowledge graph is not available yet for this project.");
        return out(name === "kg_search" ? kg.search(String(a.query || ""), { kind: a.kind, limit: a.limit, budget: Math.min(max, Number(a.budget) || 1500) }) : kg.node(String(a.id || a.name || ""), { depth: a.depth, budget: Math.min(max, Number(a.budget) || 1500) }));
      }
      case "memory_recall": {
        const mem = deps.memory?.(m);
        if (!mem) return out("Project memory is not available.");
        return out((await mem.pack(String(a.topic || ""), { budgetTokens: Math.min(1000, Number(a.budget_tokens) || 800) })) || "Nothing relevant in project memory.");
      }
      case "memory_search": {
        const mem = deps.memory?.(m);
        if (!mem) return out("Project memory is not available.");
        const hits = await mem.search(String(a.query || ""), { limit: Math.min(20, Number(a.limit) || 8) });
        return out(hits.length ? hits.map((h) => `- ${h.name} [${h.type || "note"}] (${h.path}): ${h.description || h.preview}`).join("\n") : "No matching notes.");
      }
      case "memory_save": {
        const mem = deps.memory?.(m);
        if (!mem) return out("Project memory is not available.");
        const r = await mem.save({ name: a.name, description: a.description, type: a.type || "project", body: a.body, tags: list(a.tags), source: `mission:${m.id}:${me?.id || "boss"}` });
        return out(`${r.created ? "Saved" : "Updated"} ${r.path}`);
      }
      case "kg_upsert": {
        const kg = await deps.kg?.(m);
        if (!kg) return out("The knowledge graph is not available yet for this project.");
        const r = kg.upsert({ nodes: Array.isArray(a.nodes) ? a.nodes : [], edges: Array.isArray(a.edges) ? a.edges : [] }, { by: me?.id || "boss" });
        return out(`Recorded ${r.nodes} node(s) and ${r.edges} edge(s).`);
      }
      case "kg_import": {
        if (!deps.kgImport) return out("Knowledge-graph import is not available.", { error: true });
        const r = await deps.kgImport(m, { source: String(a.source || ""), path: a.path ? String(a.path) : "", callerSid: full, by: me?.id || "boss" });
        return out(r.text, r.meta);
      }
      case "ask_boss": {
        if (!me) return out("Only a mission worker can ask the boss.", { error: true });
        const answer = await missions.askBoss(m, me.role === "worker" ? me.id : `${me.id} (subagent)`, a.question);
        return out(answer == null ? "No answer from the boss yet. Continue with your best assumption and note it in your report." : `The boss answers: ${answer}`, { answered: answer != null });
      }
      case "progress": {
        if (!me) return out("Only a mission worker can report progress.", { error: true });
        missions.ledger(m, `progress ${me.id}: ${oneLine(a.note, 400)}`);
        return out("Noted.");
      }
      case "handoff": {
        if (!me || typeof missions.handoffWorker !== "function") return out("handoff is not available.", { error: true });
        const next = await missions.handoffWorker(m, me.role === "worker" ? me.id : me.id, a.note);
        return out(`Handed off to ${next.id}. Stop now: your successor continues the task.`, { successor: next.id });
      }
      default: return out(`Unknown mission tool "${name}".`, { error: true });
    }
  } catch (e) {
    return out(`${name} failed: ${e?.message || e}`, { error: true });
  }
}
