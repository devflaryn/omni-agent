/**
 * The desktop's /remote/<deviceId>/<path> proxy, which the window's own UI talks to. The links themselves are in
 * ui/machine-links.js, shared with the web page and the iPhone app.
 *
 * What crosses is built here, field by field, in both directions. The window's cookie and everything else about this
 * computer stay on this side, and a far machine's reply can set nothing and run nothing in the window's origin.
 */
import { validateHeaderValue } from "node:http";
import { channelAllowed } from "./access.mjs";
import { SAFE_REQUEST_HEADERS, channelClient } from "./channel-host.mjs";
import { MachineLinks as SharedLinks, MachineError } from "../ui/machine-links.js";

export { MachineError };

const SECOND = 1000;
const DRAIN_MS = 2 * SECOND;
const SELF = "That is this computer: there is nothing to connect to.";
// Not content-disposition: it beats the page's a.download, so a far machine could save notes.txt as notes.txt.exe.
const REPLY_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified", "content-encoding", "x-accel-buffering"];

/** Nothing a far machine sends may run in this window's origin, which holds the account's cookie. */
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";
/** A sandbox stops the browser's PDF viewer, and a PDF runs nothing in the origin: it may be framed by this page alone. */
const PDF_POLICY = "default-src 'none'; object-src 'self'; frame-ancestors 'self'";

/** The links, with a response's body as a Node stream. */
export class MachineLinks extends SharedLinks {
  constructor(options) { super({ client: channelClient, ...options }); }
}

class BodyTooLarge extends Error {
  fromCaller = true; // not the machine's failure
}

/** Only what the far machine needs to answer: none of this computer's cookies, addresses, or anything it did not list. */
function requestHeaders(given) {
  const out = {};
  for (const name of SAFE_REQUEST_HEADERS) if (typeof given[name] === "string") out[name] = given[name];
  return out;
}

function replyHeaders(given) {
  const out = {};
  for (const name of REPLY_HEADERS) {
    const value = given?.[name];
    if (typeof value !== "string" && typeof value !== "number") continue;
    // The defence against a second response on this connection rests on the proxy and the browser reading this number alike.
    // Anything else goes, and chunked takes over.
    if (name === "content-length" && !/^\d{1,15}$/.test(String(value))) continue;
    try { validateHeaderValue(name, value); out[name] = String(value); } catch { /* a value that could break the header block is no header */ }
  }
  return out;
}

async function* limited(req, max) {
  let size = 0;
  // Not destroyed on the way out: the answer still has to go back down this socket.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw new BodyTooLarge("request too large");
    yield chunk;
  }
}

const parseTarget = (url) => {
  const m = /^\/remote\/([^/?#]+)(\/[^#]*)?$/.exec(url);
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return { bad: true }; }
  return { id, path: m[2] ?? null };
};

/** /remote/<deviceId>/<path>. The caller has checked the window cookie and the Origin. */
export async function proxyToMachine(req, res, { links, send }) {
  const target = parseTarget(req.url);
  if (!target) return send(res, 404, { error: "/remote/<device>/<path>" });
  if (target.bad) return send(res, 400, { error: "that device id is not readable" });
  const fail = (e) => send(res, e.status, { error: e.message, code: e.code, ...(e.machine ? { machine: e.machine } : {}) });
  const { maxBodyBytes, slowReaderMs } = links.options;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  // The cookie is SameSite and a change must name this page, which leaves a read from another page on this site: another port.
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return send(res, 403, { error: "that request did not come from the Omni window" });

  if (target.path === null) {
    if (links.isSelf(target.id)) return send(res, 400, { error: SELF, code: "self" });
    return send(res, 404, { error: "/remote/<device>/<path>" });
  }
  // The far machine refuses these too. Asked here, nothing has to cross to learn it.
  if (!channelAllowed(req.method, target.path)) return send(res, 403, { error: "that is not available on another machine" });
  if (Number(req.headers["content-length"]) > maxBodyBytes) return refuseTooLarge(req, res, send);

  const gone = new AbortController();
  const onClose = () => { if (!res.writableFinished) gone.abort(new Error("the window went away")); };
  res.once("close", onClose);

  let response;
  try {
    response = await links.request(target.id, {
      method: req.method,
      path: target.path,
      headers: requestHeaders(req.headers),
      body: hasBody ? limited(req, maxBodyBytes) : undefined,
      signal: gone.signal,
    });
  } catch (error) {
    if (error instanceof MachineError) { if (hasBody) req.resume(); return fail(error); }
    if (error instanceof BodyTooLarge) return refuseTooLarge(req, res, send);
    if (gone.signal.aborted) return undefined;
    throw error;
  }
  return relay(req, res, response, { slowReaderMs, send, hasBody });
}

/** Reads and drops what is on its way for a moment first: a socket closed under a sender loses this answer to a reset. */
async function refuseTooLarge(req, res, send) {
  req.resume();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, DRAIN_MS);
    timer.unref?.();
    req.once("end", resolve);
    req.once("close", resolve);
  });
  res.setHeader("Connection", "close");
  return send(res, 413, { error: "request too large" });
}

async function relay(req, res, response, { slowReaderMs, send, hasBody }) {
  const stop = () => { response.abort(); res.destroy(); };
  // 1xx would change what this connection is, and anything under 200 or past 599 is not an answer.
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    response.abort();
    return send(res, 502, { error: "the other machine sent an answer that makes no sense" });
  }
  const headers = replyHeaders(response.headers);
  const pdf = /^application\/pdf\b/i.test(headers["content-type"] ?? "");
  res.setHeader("Content-Security-Policy", pdf ? PDF_POLICY : SANDBOX);
  if (pdf) res.removeHeader("X-Frame-Options");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // An event stream's head goes now, not with its first event. While an upload may still be running it waits for the first
  // byte of the answer: a far side that answers early must not be able to turn the 413 for that upload into a reset.
  const sendHead = () => {
    if (res.headersSent) return;
    res.writeHead(response.status, headers);
    res.flushHeaders();
  };
  if (!hasBody) sendHead();

  // Counted here: passed on as it stands, a false length would let the rest be read as another response on this connection.
  const declared = headers["content-length"] === undefined || req.method === "HEAD" || response.status === 204 || response.status === 304 ? null : Number(headers["content-length"]);
  let sent = 0;
  try {
    for await (const chunk of response.body) {
      if (req.method === "HEAD") continue;
      sent += chunk.length;
      if (declared !== null && sent > declared) { stop(); return undefined; }
      sendHead();
      if (!res.write(chunk)) await drained(res, slowReaderMs);
    }
  } catch (error) {
    if (error instanceof BodyTooLarge && !res.headersSent) return refuseTooLarge(req, res, send);
    // The channel went, or the reader did. Ended cleanly, a part of an answer would pass for all of it.
    stop();
    return undefined;
  }
  if (declared !== null && sent < declared) { stop(); return undefined; }
  if (hasBody) req.resume(); // the far machine has answered: whatever is left of an upload goes nowhere
  sendHead();
  res.end();
  return undefined;
}

const MAX_MERGED = 64;
const MERGED_CAP = 4 * 1024 * 1024; // a window that stops reading is let go of, as /events does
const sseEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * /remote/~events?m=[{id, since, boot}]: every other machine's /events in one stream, for the desktop window. A browser holds
 * six connections to a host, and one stream per machine would spend them all. Each machine's stream runs on its own, so a slow
 * or silent one holds up none of the others. Each of its events goes out whole, as
 *   event: m     {id, name, data}       name is the far stream's event name ("message", "resync"), data its text
 *   event: link  {id, up, error, code}  its stream came up, or was lost, naming why
 * A lost stream is tried again from the last seq it gave. The caller has checked the window cookie and the Origin.
 */
export async function mergedEvents(req, res, { links, send, retryMs = 1000, kaMs = 20_000 }) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return send(res, 403, { error: "that request did not come from the Omni window" });
  let list;
  try { list = JSON.parse(new URL(req.url, "http://x").searchParams.get("m") ?? ""); } catch { list = null; }
  const valid = Array.isArray(list) && list.length <= MAX_MERGED && list.every((x) => x && typeof x.id === "string" && x.id && x.id.length <= 256 && (x.since === undefined || Number.isSafeInteger(x.since)) && (x.boot === undefined || (typeof x.boot === "string" && x.boot.length <= 64)));
  if (!valid) return send(res, 400, { error: `m must be a list of up to ${MAX_MERGED} machines: [{id, since, boot}]` });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": open\n\n");
  const gone = new AbortController();
  const write = (text) => {
    if (gone.signal.aborted) return;
    if ((res.writableLength || 0) > MERGED_CAP) { gone.abort(); res.destroy(); return; }
    try { res.write(text); } catch { gone.abort(); }
  };
  res.once("close", () => gone.abort());
  const ka = setInterval(() => write(sseEvent("ka", {})), kaMs);
  ka.unref?.();
  gone.signal.addEventListener("abort", () => clearInterval(ka), { once: true });
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    follow(x.id, x.since ?? 0, x.boot ?? "");
  }
  return undefined;

  async function follow(id, since, boot) {
    let attempt = 0;
    while (!gone.signal.aborted) {
      let response = null;
      try {
        response = await links.request(id, { method: "GET", path: `/events?since=${since}${boot ? `&boot=${encodeURIComponent(boot)}` : ""}`, headers: { accept: "text/event-stream" }, signal: gone.signal });
        if (gone.signal.aborted) { response.abort?.(); return; }
        if (response.status !== 200) { response.abort?.(); throw new MachineError(response.status, "machine-refused", `the machine answered ${response.status}`); }
        write(sseEvent("link", { id, up: true }));
        attempt = 0;
        const decoder = new TextDecoder();
        let buffer = "", name = "message", data = [];
        const line = (text) => {
          if (text === "") {
            if (data.length && name !== "ka") {
              const joined = data.join("\n");
              if (name === "resync") { try { const r = JSON.parse(joined); boot = typeof r.boot === "string" ? r.boot.slice(0, 64) : boot; since = 0; } catch { /* its own reader says so */ } }
              else if (name === "message") { try { const seq = JSON.parse(joined).seq; if (Number.isSafeInteger(seq) && seq > since) since = seq; } catch { /* passed on as it is */ } }
              write(sseEvent("m", { id, name, data: joined }));
            }
            name = "message";
            data = [];
            return;
          }
          if (text.startsWith(":")) return;
          const at = text.indexOf(":");
          const field = at < 0 ? text : text.slice(0, at);
          const value = at < 0 ? "" : text.slice(at + 1).replace(/^ /, "");
          if (field === "event") name = value;
          else if (field === "data") data.push(value);
        };
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > MERGED_CAP) throw new Error("an event with no end");
          const parts = buffer.split(/\r\n|\n|\r(?!$)/);
          buffer = parts.pop();
          for (const text of parts) line(text);
          if (gone.signal.aborted) return;
        }
        throw new Error("the stream ended");
      } catch (error) {
        response?.abort?.();
        if (gone.signal.aborted) return;
        write(sseEvent("link", { id, up: false, error: String(error.message ?? error), code: error.code ?? null }));
      }
      const wait = Math.min(30_000, retryMs * 2 ** Math.min(attempt++, 5));
      await new Promise((resolve) => {
        const t = setTimeout(resolve, wait);
        t.unref?.();
        gone.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }
}

function drained(res, ms) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      if (error) reject(error); else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error("the reader went away"));
    const timer = setTimeout(() => done(new Error("the reader stopped reading")), ms);
    timer.unref?.();
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}
