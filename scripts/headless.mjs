#!/usr/bin/env node
/**
 * Headless runner: drive Omni's pi child through one task with no GUI and stream a compact log.
 * The same AgentApi loop the window uses (pi --mode rpc, its tools, extensions and skills), just
 * observed from the terminal. Exit code 0 when the agent settles, 2 on --max-seconds, 1 on error.
 *
 *   node scripts/headless.mjs --cwd <project> --task "…" [--task-file f] [--provider p] [--model id]
 *        [--thinking off|minimal|low|medium|high] [--max-seconds N] [--memory] [--log file.jsonl] [--port N]
 *
 * --max-seconds 0 = no cap (default 0). --memory prepends the vault memory pack like the composer does.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);

/** One line per event, or null for noise. Pure so it can be tested. */
export function formatEvent(ev, { started = Date.now(), width = 160 } = {}) {
  const one = (s, n = width) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const t = `${String(Math.floor((ev.ts - started) / 1000)).padStart(5)}s`;
  if (ev.kind === "tool" && ev.phase === "start") {
    const a = ev.args && typeof ev.args === "object" ? ev.args : {};
    const what = a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.query ?? a.task ?? JSON.stringify(a);
    return `${t} ▶ ${ev.name}: ${one(what)}`;
  }
  if (ev.kind === "tool" && ev.phase === "end") return `${t}   ${ev.isError ? "✗" : "✓"} ${one(ev.text)}`;
  if (ev.kind === "msg" && ev.role === "assistant") {
    const text = (ev.blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return text.trim() ? `${t} 🤖 ${one(text, width * 8)}` : null;
  }
  if (ev.kind === "msg" && ev.role === "system") return `${t} ⚠ ${one((ev.blocks || []).map((b) => b.text).join(" "))}`;
  if (ev.kind === "log" && (ev.level === "error" || ev.level === "stderr")) return `${t} [pi ${ev.level}] ${one(ev.text)}`;
  if (ev.kind === "compaction") return `${t} … context compacted`;
  return null;
}

export async function runHeadless({ cwd, task, provider, model, thinking, maxSeconds = 0, memory = false, log, port = 4491, out = console.log, cfg = {} }) {
  const started = Date.now();
  const app = await createApp({ port, host: "127.0.0.1", lan: false, cwd, autoStartPi: false, ...(provider ? { piProvider: provider } : {}), ...(model ? { piModel: model } : {}), ...cfg });
  await app.listen();
  const tools = new Map();
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost = 0, last = "", settled = false, sawStream = false;
  const pi = app.startPi(cwd);
  const finish = (code, why) => {
    const dur = Math.round((Date.now() - started) / 1000);
    out(`\n— ${why} after ${dur}s · tools: ${[...tools].map(([k, v]) => `${k}×${v}`).join(", ") || "none"} · tokens in/out ${tokens.input}/${tokens.output} (cache ${tokens.cacheRead}) · cost $${cost.toFixed(4)}`);
    if (last) out(`— last assistant text:\n${last}`);
    app.close();
    return code;
  };
  return new Promise((resolveRun) => {
    let timer = null;
    const onEvent = (ev) => {
      if (ev.sid !== pi.sid && ev.sid !== "pi:pending") return;
      if (log) appendFileSync(log, `${JSON.stringify(ev)}\n`);
      if (ev.kind === "tool" && ev.phase === "start") tools.set(ev.name, (tools.get(ev.name) || 0) + 1);
      if (ev.kind === "msg" && ev.role === "assistant") {
        if (ev.usage) for (const k of Object.keys(tokens)) tokens[k] += ev.usage[k] || 0;
        cost += ev.cost || 0;
        const text = (ev.blocks || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (text) last = text;
      }
      const line = formatEvent(ev, { started });
      if (line) out(line);
      if (ev.kind === "status" && ev.streaming === true) sawStream = true;
      if (ev.kind === "status" && ev.streaming === false && sawStream && !settled) {
        settled = true;
        clearTimeout(timer);
        app.bus.off("event", onEvent);
        setTimeout(() => resolveRun(finish(0, "agent settled")), 300);
      }
    };
    app.bus.on("event", onEvent);
    if (maxSeconds > 0) timer = setTimeout(() => { app.bus.off("event", onEvent); pi.abort?.().catch(() => {}); resolveRun(finish(2, `stopped at --max-seconds ${maxSeconds}`)); }, maxSeconds * 1000);
    (async () => {
      await pi.waitReady();
      const st = pi.state || {};
      out(`pi ready · session ${st.sessionFile || pi.sid} · model ${st.model?.provider || "?"}/${st.model?.id || "?"} · thinking ${st.thinkingLevel || "?"} · cwd ${cwd}`);
      if (thinking) { await pi.setThinking(thinking); out(`thinking → ${thinking}`); }
      let text = task;
      if (memory) { const pack = await app.vault.pack(task, { budgetTokens: app.cfg.memoryBudgetTokens }); if (pack) text = `${pack}\n\n${task}`; }
      out(`task → ${task.replace(/\s+/g, " ").slice(0, 200)}${task.length > 200 ? "…" : ""}\n`);
      await pi.prompt(text);
    })().catch((e) => { clearTimeout(timer); app.bus.off("event", onEvent); resolveRun(finish(1, `error: ${e.message}`)); });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const taskFile = arg("--task-file");
  const task = taskFile ? readFileSync(taskFile, "utf8") : arg("--task", "");
  if (!task.trim()) { console.error("usage: node scripts/headless.mjs --cwd <dir> --task \"…\" | --task-file f [--provider p] [--model id] [--thinking lvl] [--max-seconds N] [--memory] [--log f]"); process.exit(1); }
  const cwd = resolve(arg("--cwd", process.cwd()));
  const log = arg("--log", join(ROOT, "workspace", `headless-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  mkdirSync(dirname(log), { recursive: true });
  console.log(`event log → ${log}`);
  const code = await runHeadless({ cwd, task, provider: arg("--provider"), model: arg("--model"), thinking: arg("--thinking"), maxSeconds: Number(arg("--max-seconds", 0)), memory: has("--memory"), log, port: Number(arg("--port", 4491)) });
  process.exit(code);
}
