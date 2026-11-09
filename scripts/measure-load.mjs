#!/usr/bin/env node
// Real load numbers from headless Edge over CDP, with the link emulated. Read-only: it opens the page, clicks nothing and signs in to nothing.
//
//   node scripts/measure-load.mjs <url> [--link 50,10] [--label name] [--selector css] [--list] [--runs 3]
//
// --link <ms>,<mbps>   round trip and bandwidth, via Network.emulateNetworkConditions. Omit for no emulation.
// --selector <css>     "first real UI": when this element is on screen with a size. The figure the targets are about, since a
//                      first contentful paint can be a "Loading…". Sampled every animation frame from before the page's own scripts.
// --list               every request: size on the wire, size decoded, when it ended.
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const EDGE = process.env.OMNI_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A headless Edge with one tab: `cdp(method, params)`, `on(event, fn)`, `js(expression)`, `close()`. */
export async function openBrowser({ port = 9400 + Math.floor(Math.random() * 400), extraArgs = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "omni-measure-"));
  const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--ignore-certificate-errors", "--no-first-run", "--disable-gpu", "--window-size=1280,800", ...extraArgs, "about:blank"], { stdio: "ignore" });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); } catch { /* not up yet */ }
  }
  if (!target) throw new Error("Edge did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let n = 0;
  const waiting = new Map(), listeners = new Map();
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.id) { const w = waiting.get(d.id); waiting.delete(d.id); if (d.error) w?.reject(new Error(`${d.error.message}`)); else w?.resolve(d.result); return; }
    for (const fn of listeners.get(d.method) ?? []) fn(d.params);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); };
  const js = async (expression, { awaitPromise = true } = {}) => {
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  const close = async () => {
    try { ws.close(); } catch { /* */ }
    try { execSync(`taskkill /PID ${edge.pid} /T /F`, { stdio: "ignore" }); } catch { /* */ }
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* */ }
  };
  return { cdp, on, js, close, port };
}

/** Round trip and bandwidth on every request. offline=false. */
export const emulateLink = (browser, ms, mbps) => browser.cdp("Network.emulateNetworkConditions", { offline: false, latency: ms, downloadThroughput: mbps * 125000, uploadThroughput: mbps * 125000 });

/** Watches for page errors and CSP refusals, for as long as the browser is open. Returns the array it fills. */
export function collectProblems(browser) {
  const problems = [];
  browser.on("Runtime.exceptionThrown", (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
  browser.on("Log.entryAdded", ({ entry }) => { if (entry.level === "error" && !/favicon/.test(entry.url ?? "")) problems.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`); });
  browser.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(" ")}`); });
  return problems;
}

const PROBE = (selector) => `(() => {
  const mark = () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { window.__firstUi = performance.now(); return; } }
    requestAnimationFrame(mark);
  };
  requestAnimationFrame(mark);
})();`;

/** One load of `url`. Waits for the load event, then `settleMs`. */
export async function loadOnce(browser, url, { selector, settleMs = 1500, requests = new Map(), waitForUiMs = 20000 } = {}) {
  requests.clear();
  const started = new Map();
  browser.onRequests ??= (() => {
    const handlers = { will: null, resp: null, data: null, done: null };
    browser.on("Network.requestWillBeSent", (p) => handlers.will?.(p));
    browser.on("Network.responseReceived", (p) => handlers.resp?.(p));
    browser.on("Network.dataReceived", (p) => handlers.data?.(p));
    browser.on("Network.loadingFinished", (p) => handlers.done?.(p));
    browser.on("Page.loadEventFired", () => browser.onLoaded?.());
    return handlers;
  })();
  const h = browser.onRequests;
  h.will = (p) => { started.set(p.requestId, p.timestamp); requests.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, wire: 0, decoded: 0, seenWire: 0 }); };
  h.resp = (p) => { const r = requests.get(p.requestId); if (r) { r.status = p.response.status; r.encoding = p.response.headers["content-encoding"] ?? p.response.headers["Content-Encoding"] ?? ""; r.fromCache = p.response.fromDiskCache; r.fromSw = p.response.fromServiceWorker; r.cc = p.response.headers["cache-control"] ?? p.response.headers["Cache-Control"] ?? ""; } };
  h.data = (p) => { const r = requests.get(p.requestId); if (r) { r.decoded += p.dataLength; r.seenWire += p.encodedDataLength; } };
  h.done = (p) => { const r = requests.get(p.requestId); if (r) { r.wire = p.encodedDataLength; r.endMs = Math.round((p.timestamp - started.get(p.requestId)) * 1000); r.finished = true; } };
  let script = null;
  if (selector) script = (await browser.cdp("Page.addScriptToEvaluateOnNewDocument", { source: PROBE(selector) })).identifier;
  const loaded = new Promise((resolve) => { browser.onLoaded = resolve; });
  await browser.cdp("Page.navigate", { url });
  await Promise.race([loaded, sleep(30000)]);
  if (selector) {
    const until = Date.now() + waitForUiMs;
    while (Date.now() < until && !(await browser.js("window.__firstUi ?? 0"))) await sleep(50);
  }
  await sleep(settleMs);
  const timing = await browser.js(`(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByName('first-contentful-paint')[0]; return { fcp: Math.round(p?.startTime || 0), dcl: Math.round(n?.domContentLoadedEventEnd || 0), load: Math.round(n?.loadEventEnd || 0), proto: n?.nextHopProtocol, firstUi: Math.round(window.__firstUi || 0) }; })()`);
  if (script) await browser.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: script });
  const all = [...requests.values()];
  const open = all.filter((r) => !r.finished);
  const bytes = all.reduce((sum, r) => sum + (r.finished ? r.wire : r.seenWire), 0);
  return { ...timing, requests: all.length, kb: Math.round(bytes / 102.4) / 10, stillOpen: open.length, list: all };
}

const name = (u) => { try { const x = new URL(u); return `${x.pathname}${x.search}`.slice(0, 70); } catch { return u.slice(0, 70); } };
export function printRequests(list) {
  for (const r of [...list].sort((a, b) => (b.finished ? b.wire : b.seenWire) - (a.finished ? a.wire : a.seenWire))) {
    const where = r.fromSw ? "sw" : r.fromCache ? "disk" : "";
    console.log(`  ${String(r.status ?? "-").padEnd(4)}${String(Math.round((r.finished ? r.wire : r.seenWire) / 102.4) / 10).padStart(9)} KB wire ${String(Math.round(r.decoded / 102.4) / 10).padStart(9)} KB body ${String(r.endMs ?? "open").padStart(6)} ms  ${(r.encoding || "-").padEnd(5)}${where.padEnd(5)}${name(r.url)}`);
  }
}

if (process.argv[1]?.endsWith("measure-load.mjs")) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { link: { type: "string" }, label: { type: "string" }, selector: { type: "string" }, list: { type: "boolean" }, runs: { type: "string", default: "3" } } });
  const [url] = positionals;
  const browser = await openBrowser();
  const problems = collectProblems(browser);
  try {
    await browser.cdp("Network.clearBrowserCache");
    if (values.link) { const [ms, mbps] = values.link.split(",").map(Number); await emulateLink(browser, ms, mbps); }
    const show = (label, m) => console.log(label.padEnd(8), JSON.stringify({ firstUi: m.firstUi, fcp: m.fcp, dcl: m.dcl, load: m.load, requests: m.requests, kb: m.kb, stillOpen: m.stillOpen, proto: m.proto }));
    const cold = await loadOnce(browser, url, { selector: values.selector });
    show("cold", cold);
    if (values.list) printRequests(cold.list);
    for (let i = 0; i < Number(values.runs); i++) {
      const warm = await loadOnce(browser, url, { selector: values.selector });
      show(`warm${i + 1}`, warm);
      if (values.list && i === Number(values.runs) - 1) printRequests(warm.list);
    }
    if (problems.length) console.log("problems:\n  " + [...new Set(problems)].join("\n  "));
  } finally { await browser.close(); }
  process.exit(0);
}
