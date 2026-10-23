/**
 * OpenCode → pi translation. `opencode serve` streams `{type, properties}` payloads over SSE; the rest of Omni
 * speaks pi: live events go through `normalizeRpcEvent` and history is pi session JSONL read by `normalizePiEntry`.
 * `OpencodeTranslator` turns one session's payloads into both — the pi RPC event objects (`agent_start`,
 * `message_update`, `message_end`, `tool_execution_*`, `compaction_*`, `agent_settled`) and the pi JSONL entries
 * (`message`, `compaction`, `custom_message`, `model_change`) for the chat's mirror file. `historyEntries` does the
 * mirror part for a `GET /session/:id/message` snapshot. Pure: no I/O.
 */

import { randomUUID } from "node:crypto";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const iso = (ms) => new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now()).toISOString();
/** Parts that become pi content blocks (step-start/step-finish/patch/… do not). */
const CONTENT_PARTS = new Set(["text", "reasoning", "tool"]);
/** A background agent's report is delivered as a user prompt starting with this; it reads as pi's custom message. */
const AGENT_RESULT = "[omni-agent-result]";

/** pi stopReason of an assistant message's info. */
export function stopReasonOf(info) {
  const e = info?.error;
  if (e) return e.name === "MessageAbortedError" ? "aborted" : "error";
  return info?.finish === "tool-calls" ? "toolUse" : info?.finish === "length" ? "length" : "stop";
}

/** One line for an OpenCode error: `APIError` → `"<statusCode>: <responseBody or message>"`, others → `data.message || name`. */
export function errorText(err) {
  if (!err || typeof err !== "object") return String(err || "");
  const d = err.data || {};
  if (err.name === "APIError" && d.statusCode) return `${d.statusCode}: ${d.responseBody || d.message || ""}`;
  return d.message || err.name || "error";
}

/** pi usage from OpenCode `tokens` + `cost` (reasoning tokens count as output). */
export function piUsage(tokens, cost) {
  const input = num(tokens?.input), output = num(tokens?.output) + num(tokens?.reasoning), cacheRead = num(tokens?.cache?.read), cacheWrite = num(tokens?.cache?.write);
  return { input, output, cacheRead, cacheWrite, totalTokens: num(tokens?.total) || input + output + cacheRead + cacheWrite, cost: { total: num(cost) } };
}

/** A `file` part carrying a base64 image `data:` URL → pi image content; anything else → null. */
function imageOf(p) {
  const m = p?.type === "file" && /^data:(image\/[^;,]+);base64,(.*)$/s.exec(p.url || "");
  return m ? { type: "image", mimeType: m[1], data: m[2] } : null;
}

const finished = (p) => p.state?.status === "completed" || p.state?.status === "error";
/** pi tool result content of a tool part (an unfinished one reads as interrupted). */
function toolContent(p) {
  const st = p.state || {};
  const text = st.status === "completed" ? String(st.output ?? "") : st.error || "Tool call was interrupted before it finished.";
  return [{ type: "text", text }, ...(st.attachments || []).map(imageOf).filter(Boolean)];
}

/** pi assistant message of a finished OpenCode assistant message. */
function assistantMessage(info, parts) {
  const content = [];
  for (const p of parts) {
    if (p.type === "text") content.push({ type: "text", text: p.text || "" });
    else if (p.type === "reasoning") content.push({ type: "thinking", thinking: p.text || "" });
    else if (p.type === "tool") content.push({ type: "toolCall", id: p.callID, name: p.tool, arguments: p.state?.input || {} });
  }
  const m = { role: "assistant", content, usage: piUsage(info.tokens, info.cost), stopReason: stopReasonOf(info), model: info.modelID, provider: info.providerID, responseId: info.id, timestamp: info.time?.completed || info.time?.created || Date.now() };
  if (info.error) m.errorMessage = errorText(info.error);
  return m;
}

/** Entry ids/parentIds/timestamps of the mirror, plus the last model (a change writes a `model_change`). */
class Chain {
  constructor(parentId = null) { this.last = parentId; this.model = null; }
  add(type, id, ms, rest) { const e = { type, id, parentId: this.last, timestamp: iso(ms), ...rest }; this.last = id; return e; }
}

/** A finished user message → its mirror entry (and the rpc custom message for an agent report). */
function userOut(info, parts, chain, out) {
  const texts = parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text || "");
  const ms = info.time?.created;
  const joined = texts.join("\n");
  if (joined.startsWith(AGENT_RESULT)) {
    const content = joined.slice(AGENT_RESULT.length).trimStart();
    out.rpc.push({ type: "message_end", message: { role: "custom", customType: "omni-agent-result", content, display: true, responseId: info.id, timestamp: ms || Date.now() } });
    out.entries.push(chain.add("custom_message", info.id, ms, { customType: "omni-agent-result", content, display: true }));
    return;
  }
  const content = [...texts.filter(Boolean).map((text) => ({ type: "text", text })), ...parts.map(imageOf).filter(Boolean)];
  if (content.length) out.entries.push(chain.add("message", info.id, ms, { message: { role: "user", content, timestamp: ms || Date.now() } }));
}

/** A finished assistant message → `message_end` for it and one per tool part's result, with their mirror entries. */
function assistantOut(info, parts, chain, out) {
  const ms = info.time?.completed || info.time?.created;
  const model = info.modelID ? `${info.providerID}/${info.modelID}` : null;
  if (model && model !== chain.model) {
    chain.model = model;
    out.entries.push(chain.add("model_change", `${info.id}:model`, ms, { provider: info.providerID, modelId: info.modelID }));
  }
  const message = assistantMessage(info, parts);
  out.rpc.push({ type: "message_end", message });
  out.entries.push(chain.add("message", info.id, ms, { message }));
  for (const p of parts) {
    if (p.type !== "tool") continue;
    const r = { role: "toolResult", toolCallId: p.callID, toolName: p.tool, content: toolContent(p), isError: p.state?.status !== "completed", details: p.state?.metadata, responseId: p.id, timestamp: p.state?.time?.end || message.timestamp };
    out.rpc.push({ type: "message_end", message: r });
    out.entries.push(chain.add("message", p.id, r.timestamp, { message: r }));
  }
}

/** A finished compaction summary message → `compaction_end` and the mirror's `compaction` entry. */
function summaryOut(info, parts, chain, out) {
  const summary = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
  out.rpc.push({ type: "compaction_end", summary });
  if (summary && !info.error) out.entries.push(chain.add("compaction", info.id, info.time?.completed || info.time?.created, { summary }));
}

const done = (info) => !!(info?.time?.completed || info?.error);

/**
 * One OpenCode session's SSE payloads → pi RPC events + pi JSONL mirror entries. `push(payload)` per payload
 * (`{type, properties}`); payloads of other sessions and noise give nothing. `parentId` continues an existing mirror.
 */
export class OpencodeTranslator {
  constructor({ sessionID, cwd, parentId = null } = {}) {
    this.sessionID = sessionID;
    this.cwd = cwd;
    this.streaming = false;
    this.chain = new Chain(parentId);
    this.msgs = new Map(); // message id → { info, parts: Map<partId, part>, live: Map<partId, state>, ended }
    this.pendingUser = null; // a user message is written once its parts are in (the next unrelated payload)
    this.errored = false; // this turn already showed its error: a following session.error adds nothing
  }

  /** @returns {{ rpc: object[], entries: object[] }} */
  push(payload) {
    const out = { rpc: [], entries: [] };
    if (!payload || typeof payload !== "object") return out;
    const p = payload.properties || {};
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (sid && sid !== this.sessionID) return out;
    if (this.pendingUser && (p.info?.id ?? p.part?.messageID ?? p.messageID) !== this.pendingUser) this.#flushUser(out);
    switch (payload.type) {
      case "session.status":
        if (p.status?.type === "busy") this.#start(out);
        else if (p.status?.type === "idle") this.#settle(out);
        break;
      case "session.idle": this.#settle(out); break;
      case "message.updated": this.#message(p.info, out); break;
      case "message.part.updated": this.#part(p.part, out); break;
      case "message.part.delta": this.#delta(p, out); break;
      case "session.error": this.#error(p.error, out); break;
    }
    return out;
  }

  #start(out) {
    if (this.streaming) return;
    this.streaming = true;
    this.errored = false;
    out.rpc.push({ type: "agent_start" });
  }

  #settle(out) {
    if (!this.streaming) return;
    this.streaming = false;
    out.rpc.push({ type: "agent_settled" });
  }

  #flushUser(out) {
    const m = this.msgs.get(this.pendingUser);
    this.pendingUser = null;
    if (!m || m.ended) return;
    userOut(m.info, [...m.parts.values()], this.chain, out);
    this.#close(m);
  }

  #close(m) { m.ended = true; m.parts = m.live = null; }

  #message(info, out) {
    if (!info?.id) return;
    let m = this.msgs.get(info.id);
    const first = !m;
    if (first) this.msgs.set(info.id, (m = { info, parts: new Map(), live: new Map(), ended: false }));
    if (m.ended) return;
    m.info = info;
    if (info.role === "user") { this.pendingUser = info.id; return; }
    if (info.role !== "assistant") return;
    if (info.summary === true) {
      if (done(info)) { summaryOut(info, [...m.parts.values()], this.chain, out); this.#close(m); }
      return;
    }
    if (first) {
      this.#start(out);
      out.rpc.push({ type: "message_start", message: { role: "assistant", model: info.modelID, provider: info.providerID } });
    }
    if (!done(info)) return;
    // A tool still open when its message ends (aborted, crashed) is closed as interrupted.
    for (const [id, part] of m.parts) {
      const s = m.live.get(id);
      if (part.type === "tool" && s && !s.done) out.rpc.push({ type: "tool_execution_end", toolCallId: part.callID, toolName: part.tool, result: { content: toolContent(part), details: part.state?.metadata }, isError: true });
    }
    assistantOut(info, [...m.parts.values()], this.chain, out);
    if (info.error) this.errored = true;
    this.#close(m);
  }

  #part(part, out) {
    const m = part && this.msgs.get(part.messageID);
    if (!m || m.ended) return;
    m.parts.set(part.id, part);
    if (m.info.role === "user") {
      if (part.type === "compaction" && !m.live.has(part.id)) { m.live.set(part.id, {}); out.rpc.push({ type: "compaction_start" }); }
      return;
    }
    if (m.info.role !== "assistant" || m.info.summary === true || !CONTENT_PARTS.has(part.type)) return;
    let s = m.live.get(part.id);
    if (!s) m.live.set(part.id, (s = { index: m.live.size, sent: "", started: false, ended: false, running: false, done: false, output: "" }));
    const ev = (type, extra) => out.rpc.push({ type: "message_update", assistantMessageEvent: { type, contentIndex: s.index, ...extra } });
    if (part.type === "tool") return this.#tool(part, s, ev, out);
    const kind = part.type === "reasoning" ? "thinking" : "text";
    if (!s.started) { s.started = true; ev(`${kind}_start`); }
    const text = part.text || "";
    // Text that arrived without deltas (or ahead of them) is streamed as one.
    if (text.length > s.sent.length && text.startsWith(s.sent)) { ev(`${kind}_delta`, { delta: text.slice(s.sent.length) }); s.sent = text; }
    if (part.time?.end && !s.ended) { s.ended = true; ev(`${kind}_end`, { content: text }); }
  }

  #tool(part, s, ev, out) {
    const st = part.state || {};
    const ids = { toolCallId: part.callID, toolName: part.tool };
    if (!s.started) { s.started = true; ev("toolcall_start", { id: part.callID, toolName: part.tool }); }
    if (st.status === "pending" || s.done) return;
    if (!s.running) {
      s.running = true;
      ev("toolcall_end", { toolCall: { id: part.callID, name: part.tool, arguments: st.input || {} } });
      out.rpc.push({ type: "tool_execution_start", ...ids, args: st.input || {} });
    }
    if (st.status === "running") {
      const o = st.metadata?.output;
      if (typeof o === "string" && o && o !== s.output) { s.output = o; out.rpc.push({ type: "tool_execution_update", ...ids, args: st.input || {}, partialResult: { content: [{ type: "text", text: o }] } }); }
    } else if (finished(part)) {
      s.done = true;
      out.rpc.push({ type: "tool_execution_end", ...ids, result: { content: toolContent(part), details: st.metadata }, isError: st.status === "error" });
    }
  }

  #delta(p, out) {
    const m = this.msgs.get(p.messageID);
    const part = m && !m.ended && m.parts.get(p.partID);
    const s = part && m.live.get(p.partID);
    if (!s || part.type === "tool" || typeof p.delta !== "string" || !p.delta) return;
    s.sent += p.delta;
    out.rpc.push({ type: "message_update", assistantMessageEvent: { type: part.type === "reasoning" ? "thinking_delta" : "text_delta", contentIndex: s.index, delta: p.delta } });
  }

  /** A session.error shows as a failed assistant message unless an open or just-failed message already carries it. */
  #error(err, out) {
    const open = [...this.msgs.values()].some((m) => !m.ended && m.info.role === "assistant" && m.info.summary !== true);
    const seen = this.errored || open;
    this.errored = true;
    if (seen) return;
    const now = Date.now();
    assistantOut({ id: `err_${randomUUID().slice(0, 8)}`, role: "assistant", error: err || { name: "UnknownError", data: {} }, time: { created: now, completed: now } }, [], this.chain, out);
  }
}

/**
 * Mirror entries for a `GET /session/:id/message` snapshot (`[{info, parts}]`, oldest first): the same entries
 * the live translator writes. Unfinished assistant messages are skipped. The `{ cwd }` options are accepted for
 * symmetry with the translator; entries carry no cwd (the mirror's session header does).
 */
export function historyEntries(messages, _opts = {}) {
  const chain = new Chain(), out = { rpc: [], entries: [] };
  for (const m of Array.isArray(messages) ? messages : []) {
    const info = m?.info, parts = Array.isArray(m?.parts) ? m.parts : [];
    if (!info?.id) continue;
    if (info.role === "user") userOut(info, parts, chain, out);
    else if (info.role === "assistant" && done(info)) (info.summary === true ? summaryOut : assistantOut)(info, parts, chain, out);
  }
  return out.entries;
}
