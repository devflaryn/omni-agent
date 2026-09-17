/**
 * Normalizers: turn the four raw sources into one "omni event" shape.
 *
 *   { sid, harness, ts, kind, ... }
 *
 * kinds:
 *   session  { cwd?, title?, model?, sessionId?, file? }
 *   msg      { id, groupId?, role: user|assistant|tool|system, blocks[], usage?, model?, cost?, live }
 *   delta    { index, part: text|thinking|tool_args, delta, toolId? }
 *   block    { index, phase: start|end, part, toolId?, name?, text? }
 *   tool     { toolId, name, phase: start|update|end, args?, text?, isError? }
 *   status   { streaming }
 *   usage    { usage }
 *   compaction { summary }
 *   run      { phase: end, cost?, sessionId?, isError?, text? }
 *
 * blocks: { type: text|thinking|tool_call|tool_result|image, text?, name?, args?, toolId?, isError? }
 */

import { cleanTitle } from "../ui/lib.js";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usageFromPi(u) {
  if (!u) return undefined;
  const input = num(u.input), output = num(u.output), cacheRead = num(u.cacheRead), cacheWrite = num(u.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: num(u.totalTokens) || input + output + cacheRead + cacheWrite };
}

export function usageFromClaude(u) {
  if (!u) return undefined;
  const input = num(u.input_tokens), output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens), cacheWrite = num(u.cache_creation_input_tokens);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function base(ctx, kind, ts, extra) {
  return { sid: ctx.sid, harness: ctx.harness, ts: ts || Date.now(), kind, ...extra };
}

function tsOf(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Largest base64 payload carried on an event; bigger images stay in the file but are not shown. */
const IMAGE_DATA_MAX = 8 * 1024 * 1024;
/** Image blocks of a tool result (pi `{type:"image",data,mimeType}` or Claude `{type:"image",source:{...}}`) → `[{ mimeType, data }]`. */
export function contentImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (c?.type !== "image") continue;
    const data = c.data ?? c.source?.data;
    const mimeType = c.mimeType ?? c.source?.media_type;
    if (typeof data !== "string" || !data || data.length > IMAGE_DATA_MAX) continue;
    out.push({ mimeType: mimeType || "image/png", data });
  }
  return out;
}
/** A tool_result block; `images` is only present when the result carried some. */
function toolResultBlock(toolId, name, content, isError) {
  const b = { type: "tool_result", toolId, name, text: contentText(content), isError: !!isError };
  if (name === undefined) delete b.name;
  const images = contentImages(content);
  if (images.length) b.images = images;
  return b;
}

// ------------------------------------------------------------------ pi

function piBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text") { if (c.text) out.push({ type: "text", text: c.text }); }
    else if (c.type === "thinking") { if (c.thinking?.trim()) out.push({ type: "thinking", text: c.thinking }); }
    else if (c.type === "toolCall") out.push({ type: "tool_call", toolId: c.id, name: c.name, args: c.arguments });
    else if (c.type === "image") out.push({ type: "image", mimeType: c.mimeType, data: c.data });
  }
  return out;
}

export function piMessageToMsg(message, ctx, { id, ts, live }) {
  if (!message || typeof message !== "object") return [];
  const role = message.role;
  const t = tsOf(ts ?? message.timestamp);
  if (role === "toolResult") {
    return [base(ctx, "msg", t, {
      id, role: "tool", live: !!live,
      blocks: [toolResultBlock(message.toolCallId, message.toolName, message.content, message.isError)],
    })];
  }
  if (role === "user" || role === "assistant") {
    const ev = { id, role, live: !!live, blocks: piBlocks(message.content) };
    if (role === "assistant") {
      ev.model = message.model;
      ev.usage = usageFromPi(message.usage);
      if (message.usage?.cost) ev.cost = num(message.usage.cost.total);
      ev.stopReason = message.stopReason;
      if (message.stopReason === "error" && (message.errorMessage || ev.blocks.length === 0)) ev.blocks.push({ type: "text", text: `Model error: ${message.errorMessage || "the provider returned no content"}` });
    }
    if (role === "assistant" && ev.blocks.length === 0) return []; // aborted/empty turn: nothing to show
    return [base(ctx, "msg", t, ev)];
  }
  if (role === "custom" || role === "bashExecution") {
    const text = contentText(message.content) || message.command || "";
    // The fallback extension's switch notice reads as a plain system line ("model error on a/x → switched to b/y").
    if (message.customType === "omni-fallback") return [base(ctx, "msg", t, { id, role: "system", live: !!live, fallback: true, blocks: [{ type: "text", text }] })];
    return [base(ctx, "msg", t, { id, role: "system", live: !!live, blocks: [{ type: "text", text: `[${message.customType || role}] ${text}`.trim() }] })];
  }
  return [];
}

/** Session .jsonl entries (see docs/session-format.md). */
export function normalizePiEntry(entry, ctx) {
  if (!entry || typeof entry !== "object") return [];
  const ts = tsOf(entry.timestamp);
  switch (entry.type) {
    case "session":
      return [base(ctx, "session", ts, { cwd: entry.cwd, sessionId: entry.id, version: entry.version })];
    case "model_change":
      return [base(ctx, "session", ts, { model: entry.modelId, provider: entry.provider })];
    case "session_info":
      return entry.name ? [base(ctx, "session", ts, { title: cleanTitle(entry.name) || entry.name })] : [];
    case "message":
      return piMessageToMsg(entry.message, ctx, { id: entry.id, ts: entry.timestamp, live: false });
    case "compaction":
      return [base(ctx, "compaction", ts, { id: entry.id, summary: entry.summary || "" })];
    default:
      return [];
  }
}

/** `pi --mode rpc` stdout events (see docs/rpc.md). */
export function normalizePiRpcEvent(ev, ctx) {
  if (!ev || typeof ev !== "object") return [];
  const now = Date.now();
  switch (ev.type) {
    case "agent_start":
      return [base(ctx, "status", now, { streaming: true })];
    case "agent_settled":
      return [base(ctx, "status", now, { streaming: false })];
    case "message_start":
      if (ev.message?.role === "assistant") return [base(ctx, "block", now, { phase: "message_start", model: ev.message.model })];
      return [];
    case "message_update": {
      const a = ev.assistantMessageEvent;
      const out = [];
      const pushUsage = () => { if (ev.usage) out.push(base(ctx, "usage", now, { usage: usageFromPi(ev.usage) })); };
      if (!a) { pushUsage(); return out; }
      const i = a.contentIndex ?? 0;
      if (a.type === "text_delta") out.push(base(ctx, "delta", now, { index: i, part: "text", delta: a.delta || "" }));
      else if (a.type === "thinking_delta") out.push(base(ctx, "delta", now, { index: i, part: "thinking", delta: a.delta || "" }));
      else if (a.type === "toolcall_delta") out.push(base(ctx, "delta", now, { index: i, part: "tool_args", delta: a.delta || "", toolId: a.id }));
      else if (a.type === "text_start") out.push(base(ctx, "block", now, { index: i, phase: "start", part: "text" }));
      else if (a.type === "thinking_start") out.push(base(ctx, "block", now, { index: i, phase: "start", part: "thinking" }));
      else if (a.type === "toolcall_start") out.push(base(ctx, "block", now, { index: i, phase: "start", part: "tool_call", toolId: a.id, name: a.toolName }));
      else if (a.type === "text_end") out.push(base(ctx, "block", now, { index: i, phase: "end", part: "text", text: a.content }));
      else if (a.type === "thinking_end") out.push(base(ctx, "block", now, { index: i, phase: "end", part: "thinking", text: a.content }));
      else if (a.type === "toolcall_end") out.push(base(ctx, "block", now, { index: i, phase: "end", part: "tool_call", toolId: a.toolCall?.id, name: a.toolCall?.name, args: a.toolCall?.arguments }));
      pushUsage();
      return out;
    }
    case "message_end":
      if (ev.message?.role === "user") return [];
      return piMessageToMsg(ev.message, ctx, { id: ev.message?.responseId || `live-${now}`, ts: now, live: true });
    case "tool_execution_start":
      return [base(ctx, "tool", now, { toolId: ev.toolCallId, name: ev.toolName, phase: "start", args: ev.args })];
    case "tool_execution_update":
      return [base(ctx, "tool", now, { toolId: ev.toolCallId, name: ev.toolName, phase: "update", text: contentText(ev.partialResult?.content) })];
    case "tool_execution_end": {
      const out = { toolId: ev.toolCallId, name: ev.toolName, phase: "end", text: contentText(ev.result?.content), isError: !!ev.isError };
      const images = contentImages(ev.result?.content);
      if (images.length) out.images = images;
      return [base(ctx, "tool", now, out)];
    }
    case "compaction_start":
      return [base(ctx, "status", now, { compacting: true })];
    case "compaction_end":
      return [base(ctx, "status", now, { compacting: false }), base(ctx, "compaction", now, { summary: ev.summary || "" })];
    case "extension_error":
      return [base(ctx, "msg", now, { id: `err-${now}`, role: "system", live: true, blocks: [{ type: "text", text: `extension error: ${ev.error || ev.message || ""}` }] })];
    default:
      return [];
  }
}

// -------------------------------------------------------------- claude

function claudeBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text") { if (c.text) out.push({ type: "text", text: c.text }); }
    else if (c.type === "thinking") { if (c.thinking?.trim()) out.push({ type: "thinking", text: c.thinking }); }
    else if (c.type === "tool_use") out.push({ type: "tool_call", toolId: c.id, name: c.name, args: c.input });
    else if (c.type === "tool_result") out.push(toolResultBlock(c.tool_use_id, undefined, c.content, c.is_error));
    else if (c.type === "image") out.push({ type: "image", mimeType: c.source?.media_type, data: c.source?.data });
  }
  return out;
}

function claudeMessageToMsg(line, ctx, live) {
  const m = line.message;
  if (!m) return [];
  const ts = tsOf(line.timestamp);
  const blocks = claudeBlocks(m.content);
  if (blocks.length === 0) return [];
  const id = line.uuid || `${m.id || "m"}-${ts}`;
  if (m.role === "assistant") {
    return [base(ctx, "msg", ts, { id, groupId: m.id, role: "assistant", live, model: m.model, usage: usageFromClaude(m.usage), blocks, stopReason: m.stop_reason })];
  }
  // user line: either a real prompt or tool results
  const toolResults = blocks.filter((b) => b.type === "tool_result");
  if (toolResults.length) return [base(ctx, "msg", ts, { id, role: "tool", live, blocks: toolResults })];
  const text = blocks.map((b) => b.text || "").join("\n");
  if (/^<(local-command|command-name|command-message|bash-input|bash-stdout)/.test(text.trim())) return [];
  return [base(ctx, "msg", ts, { id, role: "user", live, blocks })];
}

/** ~/.claude/projects/<proj>/<session>.jsonl lines. */
export function normalizeClaudeEntry(line, ctx) {
  if (!line || typeof line !== "object") return [];
  const ts = tsOf(line.timestamp);
  switch (line.type) {
    case "assistant":
    case "user": {
      if (line.isMeta) return [];
      const out = claudeMessageToMsg(line, ctx, false);
      if (line.cwd) for (const ev of out) ev.cwd = line.cwd;
      return out;
    }
    case "ai-title":
      return line.aiTitle ? [base(ctx, "session", ts, { title: line.aiTitle })] : [];
    case "summary":
      return line.summary ? [base(ctx, "session", ts, { title: line.summary })] : [];
    case "system":
      if (line.subtype === "compact_boundary" || /compact/i.test(line.subtype || "")) return [base(ctx, "compaction", ts, { summary: line.content || "" })];
      return [];
    default:
      return [];
  }
}

/** `claude -p --output-format stream-json --include-partial-messages --verbose` lines. */
export function normalizeClaudeStream(line, ctx) {
  if (!line || typeof line !== "object") return [];
  const now = Date.now();
  switch (line.type) {
    case "system":
      if (line.subtype === "init") return [base(ctx, "session", now, { sessionId: line.session_id, cwd: line.cwd, model: line.model }), base(ctx, "status", now, { streaming: true })];
      if (line.subtype === "compact_boundary") return [base(ctx, "compaction", now, { summary: "" })];
      return [];
    case "stream_event": {
      const e = line.event;
      if (!e) return [];
      if (e.type === "message_start") return [base(ctx, "block", now, { phase: "message_start", model: e.message?.model })];
      if (e.type === "content_block_start") {
        const cb = e.content_block || {};
        const part = cb.type === "tool_use" ? "tool_call" : cb.type === "thinking" ? "thinking" : "text";
        return [base(ctx, "block", now, { index: e.index, phase: "start", part, toolId: cb.id, name: cb.name })];
      }
      if (e.type === "content_block_delta") {
        const d = e.delta || {};
        if (d.type === "text_delta") return [base(ctx, "delta", now, { index: e.index, part: "text", delta: d.text || "" })];
        if (d.type === "thinking_delta") return d.thinking ? [base(ctx, "delta", now, { index: e.index, part: "thinking", delta: d.thinking })] : [];
        if (d.type === "input_json_delta") return [base(ctx, "delta", now, { index: e.index, part: "tool_args", delta: d.partial_json || "" })];
        return [];
      }
      if (e.type === "content_block_stop") return [base(ctx, "block", now, { index: e.index, phase: "end" })];
      if (e.type === "message_delta") return e.usage ? [base(ctx, "usage", now, { usage: usageFromClaude(e.usage) })] : [];
      return [];
    }
    case "assistant":
    case "user":
      return claudeMessageToMsg(line, ctx, true);
    case "result":
      return [
        base(ctx, "run", now, { phase: "end", cost: num(line.total_cost_usd), sessionId: line.session_id, isError: !!line.is_error || line.subtype !== "success", text: line.result || "", turns: line.num_turns, durationMs: line.duration_ms }),
        base(ctx, "status", now, { streaming: false }),
      ];
    default:
      return [];
  }
}
