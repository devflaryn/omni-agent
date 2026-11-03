// What travels inside a channel, version 2 (added PING and PONG). One file for Node 20+, browsers and iOS WKWebView.
// Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md, section 7.
//
// Sealed frame, inside the channel's encryption:
//   byte 0      FRAME_VERSION
//   byte 1      type (FRAME)
//   bytes 2-5   stream id, big endian. The client picks it, one per request, and never reuses it on a channel. 0 for READY.
//   the rest    payload
//
// A request:   REQ {method, path, headers?}, REQ_BODY chunks, REQ_END
// A response:  RES {status, headers}, RES_BODY chunks, RES_END
// Either side: ABORT ends one stream. ACK (4 bytes, big endian) gives back that many bytes of body the receiver has
// consumed: a sender stops at WINDOW unacknowledged, which is what makes a stalled reader stop a large file being read.
// READY is the first sealed frame each side sends: its own log and device checks have passed. Nothing else may come first.
// PING asks the host to answer with PONG. It proves the far side still reads this channel, which a hub can claim falsely but
// cannot forge inside the seal, and which no request has to do: a request can rightly take minutes to answer.
//
// Outer message, the text the hub carries in `opaque`, which it can read and change, so nothing here is believed:
//   {v, c, t: "hello", eph, logHead}    the handshake's hello; c is a fresh channel id from the side that opens
//   {v, c, t: "proof", proof}           the handshake's signature
//   {v, c, t: "data", d}                a sealed frame, base64
//   {v, c, t: "close", reason}          one of CLOSE_REASONS. A hub can forge this, but it can drop the channel anyway.
//   {v, t: "review", id}                a hint for the other full devices' cards. A hub can forge it: it only changes a label.

export const FRAME_VERSION = 2;
export const FRAME = Object.freeze({ REQ: 1, REQ_BODY: 2, REQ_END: 3, RES: 4, RES_BODY: 5, RES_END: 6, ABORT: 7, ACK: 8, READY: 9, PING: 10, PONG: 11 });
export const MAX_CHUNK = 256 * 1024;      // base64 of this fits the hub's 1 MiB message with room to spare
export const WINDOW = 2 * 1024 * 1024;    // unacknowledged body bytes per channel, in each direction
export const MAX_HEAD = 64 * 1024;
export const CLOSE_REASONS = Object.freeze({
  closed: "the other side closed the channel",
  removed: "refused: the device is no longer on the account",
  expired: "refused: the web page's 30 days have run out",
  "not-on-log": "refused: this device is not on that machine's list",
  "web-access-off": "refused: that machine has Allow web page access turned off",
  "log-mismatch": "refused: the two devices could not reconcile their logs",
  "frame-failed": "a frame failed its check, so the channel was closed: open a new one",
  busy: "refused: that machine has too many channels open",
  unavailable: "refused: that machine is not signed in",
  version: "that machine runs a different version of Omni: update both computers",
});

const HEADER_BYTES = 6;
const TYPES = new Set(Object.values(FRAME));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type, stream, payload = new Uint8Array(0)) {
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = FRAME_VERSION;
  out[1] = type;
  new DataView(out.buffer).setUint32(2, stream);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** Throws on anything but a well-formed frame of this version. */
export function decodeFrame(bytes) {
  if (bytes.length < HEADER_BYTES) throw new Error("channel frame: too short");
  if (bytes[0] !== FRAME_VERSION) throw new Error(`channel frame: unknown version ${bytes[0]}`);
  if (!TYPES.has(bytes[1])) throw new Error(`channel frame: unknown type ${bytes[1]}`);
  const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2);
  return { type: bytes[1], stream, payload: bytes.subarray(HEADER_BYTES) };
}

export const encodeJson = (value) => encoder.encode(JSON.stringify(value));

/** The object in a head frame, or null when it is too large or is not a JSON object. */
export function decodeHead(payload) {
  if (payload.length > MAX_HEAD) return null;
  try {
    const value = JSON.parse(decoder.decode(payload));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function encodeAck(bytes) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, bytes);
  return out;
}

export function decodeAck(payload) {
  if (payload.length !== 4) throw new Error("channel frame: bad ack");
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
}

export const encodeOuter = (fields) => JSON.stringify({ v: FRAME_VERSION, ...fields });

/** The version of an outer message of another version, for saying so, or null. Nothing else in it is believed. */
export function foreignOuter(text) {
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value.v !== FRAME_VERSION && typeof value.c === "string" && typeof value.t === "string" ? { c: value.c, t: value.t } : null;
  } catch {
    return null;
  }
}

/** The fields of an outer message of this version, or null. Each field's own shape is the caller's to check. */
export function decodeOuter(text) {
  try {
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value.v === FRAME_VERSION && typeof value.t === "string" ? value : null;
  } catch {
    return null;
  }
}
