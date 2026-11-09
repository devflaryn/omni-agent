/**
 * The iPhone app's way to the hub: a fetch and a WebSocket for hub-socket.js, carried by the shell's `net` bridge
 * (ios/OmniAgent/HubLink.swift), which talks to the one hub the build names. The page itself connects to nothing: its policy allows
 * only its own origin. Why native: from the web view every request would carry the page's own origin, omni-agent://app, which the
 * hub refuses; from the shell there is none, as from the desktop app.
 *
 * `bridge.ask(message)` posts to the `net` handler and resolves with the reply's value, or rejects with its error.
 * `events` is where the shell's calls arrive: globalThis.__omniNet(id, kind, data).
 */

/** hubPost's fetchImpl: one JSON POST to the hub, by path, and nothing else. */
export function nativeFetch(bridge, hubUrl) {
  const origin = new URL(hubUrl).origin;
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin !== origin) throw new TypeError("the app talks only to its hub");
    if ((init.method ?? "GET") !== "POST") throw new TypeError("the app only posts to the hub");
    const { status, body } = await bridge.ask({ op: "post", path: target.pathname, body: String(init.body ?? "") });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    };
  };
}

/** A WebSocket class for hub-socket.js, with what it uses: onopen, onmessage, onclose, onerror, readyState, bufferedAmount, send, close. */
export function nativeWebSocket(bridge, hubUrl, events = globalThis) {
  const expected = `${new URL(hubUrl).origin.replace(/^http/, "ws")}/ws`;
  const open = new Map();
  let next = 0;
  events.__omniNet = (id, kind, data) => open.get(id)?.event(kind, data);

  return class NativeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = 0;
    bufferedAmount = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    #id;

    constructor(url) {
      if (String(url) !== expected) throw new SyntaxError("the app opens a socket only to its hub");
      this.#id = ++next;
      open.set(this.#id, this);
      bridge.ask({ op: "open", id: this.#id }).catch(() => this.event("close", 1006));
    }

    send(text) {
      if (this.readyState !== 1) throw new DOMException("not open", "InvalidStateError");
      const size = String(text).length;
      this.bufferedAmount += size;
      const sent = () => { this.bufferedAmount -= size; };
      bridge.ask({ op: "send", id: this.#id, text: String(text) }).then(sent, sent);
    }

    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      bridge.ask({ op: "close", id: this.#id }).catch(() => this.event("close", 1006));
    }

    /** From the shell. A close comes once, and ends it. */
    event(kind, data) {
      if (this.readyState === 3) return;
      if (kind === "open") {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({ type: "open" });
      } else if (kind === "message") {
        if (this.readyState === 1) this.onmessage?.({ type: "message", data: String(data) });
      } else if (kind === "close") {
        this.readyState = 3;
        open.delete(this.#id);
        this.onclose?.({ type: "close", code: Number(data) || 1006 });
      }
    }
  };
}
