/**
 * The transport API over a channel this page holds itself, for ui/transport.js's channel mode. Same far-side rules as the
 * desktop's proxy: named failures, never success on a cut body, no queue. The links in machine-links.js hold the rest: the 30 s,
 * one channel per machine, and PING and PONG inside the seal.
 */
import { answerFrom, failure } from "./transport.js";
import { bytesToB64 } from "./channel-frames.js";
import { BATCHED_LIMIT, BATCH_BYTES, BLOB_LIMIT, DOWNLOAD_TYPE, HELD_LIMIT, SVG_LIMIT, downloadName, fileClass } from "./page-files.js";

const encoder = new TextEncoder();
const MAX_EVENT_BUFFER = 64 * 1024 * 1024; // one event a far machine never ends

/** A browser would send this path normalised and percent-encoded, and the far side refuses anything else. */
function target(path) {
  const url = new URL(path, "http://omni.invalid");
  return `${url.pathname}${url.search}`;
}

const declaredLength = (headers) => {
  const text = headers?.["content-length"];
  return typeof text === "string" && /^\d{1,15}$/.test(text) ? Number(text) : typeof text === "number" && Number.isSafeInteger(text) && text >= 0 ? text : null;
};

/** Each chunk as it comes. Throws if the far side ends it short of, or past, what it said it would send. */
async function* checkedBody(response) {
  const declared = declaredLength(response.headers);
  let seen = 0;
  for await (const chunk of response.body) {
    seen += chunk.length;
    if (declared !== null && seen > declared) throw new Error("more than it said it would send");
    yield chunk;
  }
  if (declared !== null && seen !== declared) throw new Error("less than it said it would send");
}

const validStatus = (status) => Number.isInteger(status) && status >= 200 && status <= 599;

class ChannelEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  #listeners = new Map();
  #stop = new AbortController();

  constructor(ask) {
    this.#run(ask).catch(() => this.#fail());
  }

  addEventListener(name, listener) {
    if (!this.#listeners.has(name)) this.#listeners.set(name, []);
    this.#listeners.get(name).push(listener);
  }

  removeEventListener(name, listener) {
    this.#listeners.set(name, (this.#listeners.get(name) ?? []).filter((l) => l !== listener));
  }

  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.#stop.abort(new Error("closed"));
  }

  #fail() {
    if (this.readyState === 2) return;
    this.close();
    this.onerror?.({ type: "error" });
  }

  #dispatch(type, data) {
    if (this.readyState === 2) return;
    const event = { type, data };
    if (type === "message") this.onmessage?.(event);
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  async #run(ask) {
    const response = await ask(this.#stop.signal);
    if (this.readyState === 2) { response.abort(); return; }
    if (response.status !== 200) { response.abort(); this.#fail(); return; }
    this.readyState = 1;
    this.onopen?.({ type: "open" });
    const decoder = new TextDecoder();
    let buffer = "", name = "message", data = [];
    const line = (text) => {
      if (text === "") {
        if (data.length) this.#dispatch(name, data.join("\n"));
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
      if (buffer.length > MAX_EVENT_BUFFER) throw new Error("an event with no end");
      const parts = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = parts.pop();
      for (const text of parts) line(text);
    }
    this.#fail(); // a stream that ends is a stream that dropped: createStream opens another
  }
}

/**
 * machine()   the chosen {id, name}
 * local       what stands in for this computer's server: PageAccount.routes()
 * browser     createObjectURL, revokeObjectURL, showSaveFilePicker, clickDownload, for tests
 */
export function createPageTransport({ links, machine, local, browser = {}, blobLimit = BLOB_LIMIT, heldLimit = HELD_LIMIT, batchedLimit = BATCHED_LIMIT }) {
  const { createObjectURL = (b) => URL.createObjectURL(b), revokeObjectURL = (u) => URL.revokeObjectURL(u) } = browser;
  const picker = "showSaveFilePicker" in browser ? browser.showSaveFilePicker : (globalThis.showSaveFilePicker ? (o) => globalThis.showSaveFilePicker(o) : null);
  const clickDownload = browser.clickDownload ?? ((url, name) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  const held = []; // { url, size }, oldest first
  let heldBytes = 0;

  const ask = (options) => links.request(machine().id, options);

  /** A status past 299, as the error the far side gave. */
  async function refused(response) {
    let text = "";
    const parts = [];
    let size = 0;
    try {
      for await (const chunk of checkedBody(response)) {
        size += chunk.length;
        if (size > 64 * 1024) { response.abort(); break; }
        parts.push(chunk);
      }
      text = new TextDecoder().decode(joined(parts));
    } catch { /* its status says enough */ }
    return answerFrom(response.status, text, machine());
  }

  const lost = () => failure(`The connection to ${machine().name} was lost during that answer. The action may or may not have run there.`, 502, "machine-lost");
  const senseless = (response) => { response.abort(); return failure(`${machine().name} sent an answer that makes no sense.`, 502, "machine-lost"); };
  const tooLarge = (size) => {
    const e = failure(`This file on ${machine().name} is too large to show in the web page. Download it instead.`, 413, "too-large-for-page");
    if (size !== undefined) e.size = size;
    return e;
  };

  function keep(url, size) {
    held.push({ url, size });
    heldBytes += size;
    while (heldBytes > heldLimit && held.length > 1) {
      const oldest = held.shift();
      heldBytes -= oldest.size;
      revokeObjectURL(oldest.url);
    }
  }

  return {
    local,

    async api(method, path, body) {
      const bytes = method !== "GET" && body !== undefined && body !== null ? encoder.encode(JSON.stringify(body)) : undefined;
      const response = await ask({ method, path: target(path), headers: method !== "GET" ? { "content-type": "application/json" } : {}, body: bytes });
      if (!validStatus(response.status)) throw senseless(response);
      const parts = [];
      let size = 0;
      try {
        for await (const chunk of checkedBody(response)) {
          size += chunk.length;
          if (size > blobLimit) { response.abort(); throw new Error("too much"); }
          parts.push(chunk);
        }
      } catch { throw lost(); }
      return answerFrom(response.status, new TextDecoder().decode(joined(parts)), machine());
    },

    eventSource(url) {
      return new ChannelEventSource((signal) => ask({ method: "GET", path: target(url), headers: { accept: "text/event-stream" }, signal }));
    },

    /** A URL for an <img>, a <video> or an <audio>, and for nothing else. See page-files.js. Throws not-viewable for the rest. */
    async rawUrl(path) {
      const response = await ask({ method: "GET", path: target(path), headers: {} });
      if (!validStatus(response.status)) throw senseless(response);
      if (response.status >= 300) throw await refused(response);
      const { kind, type } = fileClass(response.headers["content-type"]);
      if (kind === "other") {
        response.abort();
        throw failure(`${machine().name} sent a kind of file the web page does not show. Download it instead.`, 415, "not-viewable");
      }
      const limit = kind === "svg" ? Math.min(SVG_LIMIT, blobLimit) : blobLimit;
      const declared = declaredLength(response.headers);
      if (declared !== null && declared > limit) { response.abort(); throw tooLarge(declared); }
      const parts = [];
      let size = 0;
      try {
        for await (const chunk of checkedBody(response)) {
          size += chunk.length;
          if (size > limit) { response.abort(); throw tooLarge(); }
          parts.push(chunk);
        }
      } catch (error) {
        if (error.code === "too-large-for-page") throw error;
        throw lost();
      }
      if (kind === "svg") return `data:${type};base64,${bytesToB64(joined(parts))}`;
      const url = createObjectURL(new Blob(parts, { type }));
      keep(url, size);
      return url;
    },

    /**
     * Saves a file on this device. With a file dialog (Chrome, Edge) it goes straight to the disk as it arrives, so the page holds
     * no more than the channel's window, and a cut leaves no file. Without one (Safari, Firefox, phones) it is gathered in pieces
     * into blobs, which browsers may keep on disk, and offered once whole, with a type no browser runs. Returns {cancelled} if the
     * person closed the dialog.
     */
    async saveFile(path, name) {
      const suggestedName = downloadName(name);
      if (picker) {
        let handle;
        try {
          handle = await picker({ suggestedName });
        } catch (error) {
          if (error?.name === "AbortError") return { cancelled: true };
          // No click to go with it, or a browser that will not. The other way needs neither.
          return gathered(path, suggestedName);
        }
        const writable = await handle.createWritable();
        try {
          const response = await ask({ method: "GET", path: target(path), headers: {} });
          if (!validStatus(response.status)) throw senseless(response);
          if (response.status >= 300) throw await refused(response);
          try {
            for await (const chunk of checkedBody(response)) await writable.write(chunk);
          } catch { throw cutDownload(); }
          await writable.close();
          return {};
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      }
      return gathered(path, suggestedName);
    },
  };

  function cutDownload() {
    return failure(`The download from ${machine().name} was cut off, so nothing was saved. Try again.`, 502, "machine-lost");
  }

  async function gathered(path, name) {
    const response = await ask({ method: "GET", path: target(path), headers: {} });
    if (!validStatus(response.status)) throw senseless(response);
    if (response.status >= 300) throw await refused(response);
    const big = () => failure(`This file on ${machine().name} is too large to save in this browser. Use Chrome, or one of the installed apps.`, 413, "too-large-for-page");
    const declared = declaredLength(response.headers);
    if (declared !== null && declared > batchedLimit) { response.abort(); throw big(); }
    const blobs = [];
    let batch = [], inBatch = 0, total = 0;
    try {
      for await (const chunk of checkedBody(response)) {
        total += chunk.length;
        if (total > batchedLimit) { response.abort(); throw big(); }
        batch.push(chunk);
        inBatch += chunk.length;
        if (inBatch >= BATCH_BYTES) {
          blobs.push(new Blob(batch));
          batch = [];
          inBatch = 0;
        }
      }
    } catch (error) {
      if (error.code === "too-large-for-page") throw error;
      throw cutDownload();
    }
    const url = createObjectURL(new Blob([...blobs, ...batch], { type: DOWNLOAD_TYPE }));
    clickDownload(url, name);
    setTimeout(() => revokeObjectURL(url), 60_000).unref?.();
    return {};
  }
}

function joined(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
