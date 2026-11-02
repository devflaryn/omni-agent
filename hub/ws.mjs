// An RFC 6455 server for the hub: text messages only, no extensions. Everything it reads comes from the internet.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONTINUATION = 0, OP_TEXT = 1, OP_BINARY = 2, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;
const MAX_CONTROL_BYTES = 125;
const CLOSE_LINGER_MS = 1000;
const KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

export const CLOSE_PROTOCOL = 1002, CLOSE_UNSUPPORTED = 1003, CLOSE_BAD_TEXT = 1007, CLOSE_POLICY = 1008, CLOSE_TOO_BIG = 1009;

const validCloseCode = (code) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

/** Writes an HTTP refusal on a socket that asked to upgrade. */
export function refuseUpgrade(socket, status, reason, headers = {}) {
  const lines = [`HTTP/1.1 ${status} ${reason}`, "Connection: close", "Content-Length: 0", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  socket.end(`${lines.join("\r\n")}\r\n\r\n`);
}

/** Answers the upgrade, or refuses it and returns null. `options` as for HubSocket. */
export function acceptUpgrade(req, socket, head, options) {
  if (req.method !== "GET") { refuseUpgrade(socket, 405, "Method Not Allowed"); return null; }
  if (req.headers["sec-websocket-version"] !== "13") { refuseUpgrade(socket, 426, "Upgrade Required", { "Sec-WebSocket-Version": 13 }); return null; }
  const key = req.headers["sec-websocket-key"];
  const isUpgrade = /\bwebsocket\b/i.test(req.headers.upgrade ?? "") && /\bupgrade\b/i.test(req.headers.connection ?? "");
  if (!isUpgrade || !KEY_PATTERN.test(key ?? "") || Buffer.from(key, "base64").length !== 16) { refuseUpgrade(socket, 400, "Bad Request"); return null; }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new HubSocket(socket, head, options);
}

/**
 * options: maxMessageBytes (may be changed later through the property), maxFramesPerSecond, maxBuffered (bytes
 * waiting to be written before the socket is dropped), pingIntervalMs, onMessage(text), onClose(code).
 */
export class HubSocket {
  #socket; #onMessage; #onClose; #maxFrames; #maxBuffered;
  #chunks = []; #have = 0; #need = 2;
  #fragments = []; #fragmentBytes = 0; #inMessage = false;
  #closing = false; #closeCode = 1006; #alive = true;
  #windowStart = 0; #framesInWindow = 0;
  #pinger; #linger;

  constructor(socket, head, { maxMessageBytes, maxFramesPerSecond, maxBuffered, pingIntervalMs, onMessage, onClose }) {
    this.#socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.#maxFrames = maxFramesPerSecond;
    this.#maxBuffered = maxBuffered;
    this.#onMessage = onMessage;
    this.#onClose = onClose;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#read(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("end", () => socket.destroy());
    socket.on("close", () => this.#closed());
    this.#pinger = setInterval(() => this.#ping(), pingIntervalMs);
    if (head.length) this.#read(head);
  }

  /** Bytes accepted but not yet sent, so a caller can refuse to add to a reader that has stopped reading. */
  get bufferedAmount() { return this.#socket.writableLength; }

  send(text) {
    if (!this.#closing) this.#write(OP_TEXT, Buffer.from(text));
  }

  close(code, reason = "") {
    if (this.#closing) return;
    this.#closeCode = code;
    this.#write(OP_CLOSE, Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)]));
    this.#closing = true;
    this.#chunks = [];
    this.#socket.end();
    this.#linger = setTimeout(() => this.#socket.destroy(), CLOSE_LINGER_MS);
    this.#linger.unref();
  }

  destroy() { this.#socket.destroy(); }

  #write(opcode, payload) {
    const size = payload.length;
    let header;
    if (size < 126) header = Buffer.from([0x80 | opcode, size]);
    else if (size < 65536) {
      header = Buffer.from([0x80 | opcode, 126, size >> 8, size & 255]);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(size), 2);
    }
    this.#socket.write(Buffer.concat([header, payload]));
    if (this.#socket.writableLength > this.#maxBuffered) this.#socket.destroy();
  }

  #ping() {
    if (!this.#alive) { this.#socket.destroy(); return; }
    this.#alive = false;
    if (!this.#closing) this.#write(OP_PING, Buffer.alloc(0));
  }

  #closed() {
    clearInterval(this.#pinger);
    clearTimeout(this.#linger);
    this.#closing = true;
    this.#chunks = [];
    this.#fragments = [];
    this.#onClose?.(this.#closeCode);
    this.#onClose = null;
  }

  /** Waits for a whole frame before joining the chunks, so one byte at a time cannot cost a copy of everything so far. */
  #read(chunk) {
    if (this.#closing) return;
    this.#chunks.push(chunk);
    this.#have += chunk.length;
    while (!this.#closing && this.#have >= this.#need) {
      const buffer = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#have);
      const used = this.#frame(buffer);
      const rest = buffer.subarray(used);
      this.#chunks = rest.length ? [rest] : [];
      this.#have = rest.length;
      if (used) this.#need = 2;
    }
  }

  /** Returns the bytes used, or 0 with #need raised. Every check comes before waiting for the data it is about. */
  #frame(b) {
    const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f;
    if (b[0] & 0x70) return this.#fail(CLOSE_PROTOCOL, "reserved bit");
    if (!(b[1] & 0x80)) return this.#fail(CLOSE_PROTOCOL, "unmasked");
    const isControl = opcode >= OP_CLOSE;
    if (![OP_CONTINUATION, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) return this.#fail(CLOSE_PROTOCOL, "opcode");
    const short = b[1] & 0x7f;
    if (isControl && (!fin || short > MAX_CONTROL_BYTES)) return this.#fail(CLOSE_PROTOCOL, "control frame");
    if (opcode === OP_BINARY) return this.#fail(CLOSE_UNSUPPORTED, "text only");
    if (opcode === OP_CONTINUATION && !this.#inMessage) return this.#fail(CLOSE_PROTOCOL, "continuation");
    if (opcode === OP_TEXT && this.#inMessage) return this.#fail(CLOSE_PROTOCOL, "unfinished message");

    const lengthBytes = short === 126 ? 2 : short === 127 ? 8 : 0;
    const headerBytes = 2 + lengthBytes + 4;
    if (b.length < 2 + lengthBytes) { this.#need = 2 + lengthBytes; return 0; }
    let size = short;
    if (short === 126) {
      size = b.readUInt16BE(2);
      if (size < 126) return this.#fail(CLOSE_PROTOCOL, "length");
    } else if (short === 127) {
      const wide = b.readBigUInt64BE(2);
      if (wide >> 63n) return this.#fail(CLOSE_PROTOCOL, "length");
      if (wide < 65536n) return this.#fail(CLOSE_PROTOCOL, "length");
      size = Number(wide);
    }
    if (!isControl && this.#fragmentBytes + size > this.maxMessageBytes) return this.#fail(CLOSE_TOO_BIG, "too big");

    if (b.length < headerBytes + size) { this.#need = headerBytes + size; return 0; }
    if (!this.#countFrame()) return this.#fail(CLOSE_POLICY, "too many messages");
    this.#alive = true;

    const mask = b.subarray(2 + lengthBytes, headerBytes);
    const payload = b.subarray(headerBytes, headerBytes + size);
    for (let i = 0; i < size; i++) payload[i] ^= mask[i & 3];
    const used = headerBytes + size;

    if (opcode === OP_PING) this.#write(OP_PONG, payload);
    else if (opcode === OP_CLOSE) this.#peerClose(payload);
    else if (opcode !== OP_PONG) this.#data(payload, fin);
    return used;
  }

  #countFrame() {
    const now = performance.now();
    if (now - this.#windowStart >= 1000) {
      this.#windowStart = now;
      this.#framesInWindow = 0;
    }
    return ++this.#framesInWindow <= this.#maxFrames;
  }

  #data(payload, fin) {
    this.#fragments.push(payload);
    this.#fragmentBytes += payload.length;
    this.#inMessage = !fin;
    if (!fin) return;
    const whole = this.#fragments.length === 1 ? payload : Buffer.concat(this.#fragments, this.#fragmentBytes);
    this.#fragments = [];
    this.#fragmentBytes = 0;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(whole);
    } catch {
      this.#fail(CLOSE_BAD_TEXT, "not UTF-8");
      return;
    }
    this.#onMessage(text);
  }

  #peerClose(payload) {
    if (payload.length === 0) { this.close(1000); return; }
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0;
    if (!validCloseCode(code)) { this.close(CLOSE_PROTOCOL, "close code"); return; }
    this.close(code);
  }

  #fail(code, reason) {
    this.close(code, reason);
    return 0;
  }
}
