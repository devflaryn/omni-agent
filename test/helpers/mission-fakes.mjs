/** Fakes for the mission tests: an orchestrator chat (OpencodeRpc-like), an AgentManager, manual timers. */
import { EventEmitter } from "node:events";

export function orchestratorFactory(bus) {
  const made = [];
  const createOrchestrator = (opts) => {
    const n = made.length + 1;
    const orchestrator = Object.assign(new EventEmitter(), {
      opts, n, sid: "pi:pending", streaming: false, state: null, proc: { pid: 2000 + n }, prompts: [], switched: [], models: [], newSessions: 0, stops: 0, lastContext: 0, refuse: null,
      start() { return this; },
      waitReady() { this.sid = `pi:orchestrator${n}`; this.state = { sessionId: `orchestrator${n}`, sessionFile: `/s/orchestrator${n}.jsonl`, model: { contextWindow: 1000000 } }; return Promise.resolve(); },
      async switchSession(f) { this.switched.push(f); const id = f.split("/").pop().replace(".jsonl", ""); this.sid = `pi:${id}`; this.state = { ...this.state, sessionId: id, sessionFile: f }; },
      async newSession() { this.newSessions++; const id = `orchestrator${n}g${this.newSessions}`; this.sid = `pi:${id}`; this.state = { ...this.state, sessionId: id, sessionFile: `/s/${id}.jsonl` }; },
      async prompt(text, o = {}) { this.prompts.push({ text, ...o }); return this.refuse ? { success: false, error: this.refuse } : { success: true }; },
      async setModel(provider, id) { this.models.push(`${provider}/${id}`); return { success: true }; },
      stop() { this.stops++; this.proc = null; },
      // drivers: one orchestrator turn
      stream(on) { this.streaming = on; bus.emit({ sid: this.sid, harness: "pi", kind: "status", ts: Date.now(), streaming: on }); },
      turn({ error = null, context = 0 } = {}) {
        this.stream(true);
        if (context) this.lastContext = context;
        bus.emit({ sid: this.sid, harness: "pi", kind: "msg", ts: Date.now(), role: "assistant", live: true, stopReason: error ? "error" : "stop", blocks: [{ type: "text", text: error ? `Model error: ${error}` : "ok" }] });
        this.stream(false);
      },
      crash(code = 1) { this.proc = null; this.emit("exit", code); },
    });
    made.push(orchestrator);
    return orchestrator;
  };
  return { made, createOrchestrator };
}

export class FakeAgents extends EventEmitter {
  constructor() { super(); this.recs = new Map(); this.n = 0; this.messages = []; }
  start(spec) {
    const id = `a-${String(++this.n).padStart(8, "0")}`;
    const rec = { id, kind: spec.kind, title: spec.title || spec.task.slice(0, 40), task: spec.task, status: "running", createdAt: Date.now(), startedAt: Date.now(), endedAt: null, sid: `pi:w${this.n}`, activity: [], resultText: "", delivered: false, turns: 0, cost: 0, error: null, ...spec, id };
    rec.status = "running";
    this.recs.set(id, rec);
    this.emit("change", { ...rec });
    return { ...rec };
  }
  get(id) { const r = this.recs.get(id); return r ? { ...r } : null; }
  list() { return [...this.recs.values()].reverse().map((r) => ({ ...r })); }
  agentBySid(sid) { for (const r of this.recs.values()) if (r.sid === sid) return r; return null; }
  async message(id, text) { this.messages.push({ id, text }); return { ok: true, how: "followUp" }; }
  async cancel(id) { return this.end(id, "cancelled"); }
  markDelivered(id) { const r = this.recs.get(id); if (r) { r.delivered = true; this.emit("change", { ...r }); } return true; }
  end(id, status = "done", resultText = "", extra = {}) {
    const r = this.recs.get(id);
    Object.assign(r, { status, resultText, endedAt: Date.now(), ...extra });
    this.emit("change", { ...r });
    return { ...r };
  }
}

/** Manual timers: `tick(ms)` runs everything due. */
export function fakeClock(start = 1_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
  };
}

export const flush = () => new Promise((r) => setImmediate(r));
