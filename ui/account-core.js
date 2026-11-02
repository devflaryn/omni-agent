// Crypto for Omni accounts. One file for Node 20+, browsers and iOS WKWebView, so WebCrypto only.
// Design: docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md, sections 2 to 6.

const { subtle } = globalThis.crypto;
const encoder = new TextEncoder();

// One label per purpose, so a hash or signature made for one thing can never be taken for another.
const LOGIN_INFO = "omni-login-v1";
const RECOVERY_INFO = "omni-recovery-sign-v1";
const SIGN_DOMAIN = "omni-device-sign-v1";
const COMMIT_DOMAIN = "omni-approval-commit-v1";
const CODE_DOMAIN = "omni-approval-code-v1";
const TRANSCRIPT_DOMAIN = "omni-channel-transcript-v1";
const PROOF_DOMAIN = "omni-channel-proof-v1";
const KEY_INFO_LOW_TO_HIGH = "omni-channel-key-v1 low-to-high";
const KEY_INFO_HIGH_TO_LOW = "omni-channel-key-v1 high-to-low";
const FRAME_AAD = encoder.encode("omni-channel-frame-v1");

const KEY_BYTES = 32;
const RANDOM_BYTES = 32;
const COUNTER_BYTES = 8;
const TAG_BYTES = 16;

export function toB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromB64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const params = { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) };
  return new Uint8Array(await subtle.deriveBits(params, key, length * 8));
}

/** A domain label and fields, each length-prefixed, so that no two different inputs encode the same. */
function framed(domain, ...fields) {
  const parts = [domain, ...fields].map((f) => (typeof f === "string" ? encoder.encode(f) : f));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const part of parts) {
    view.setUint32(at, part.length);
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Decodes base64 of an exact size, or throws an error starting with `label`. */
function sizedB64(text, length, label) {
  let bytes;
  try { bytes = fromB64(text); } catch { throw new Error(`${label}: not base64`); }
  if (bytes.length !== length) throw new Error(`${label}: expected ${length} bytes`);
  return bytes;
}

// --- scrypt (RFC 7914) ---

function salsa208(b) {
  let x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3], x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7];
  let x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11], x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15];
  let u;
  for (let i = 0; i < 4; i++) {
    u = x0 + x12 | 0; x4 ^= u << 7 | u >>> 25;
    u = x4 + x0 | 0; x8 ^= u << 9 | u >>> 23;
    u = x8 + x4 | 0; x12 ^= u << 13 | u >>> 19;
    u = x12 + x8 | 0; x0 ^= u << 18 | u >>> 14;
    u = x5 + x1 | 0; x9 ^= u << 7 | u >>> 25;
    u = x9 + x5 | 0; x13 ^= u << 9 | u >>> 23;
    u = x13 + x9 | 0; x1 ^= u << 13 | u >>> 19;
    u = x1 + x13 | 0; x5 ^= u << 18 | u >>> 14;
    u = x10 + x6 | 0; x14 ^= u << 7 | u >>> 25;
    u = x14 + x10 | 0; x2 ^= u << 9 | u >>> 23;
    u = x2 + x14 | 0; x6 ^= u << 13 | u >>> 19;
    u = x6 + x2 | 0; x10 ^= u << 18 | u >>> 14;
    u = x15 + x11 | 0; x3 ^= u << 7 | u >>> 25;
    u = x3 + x15 | 0; x7 ^= u << 9 | u >>> 23;
    u = x7 + x3 | 0; x11 ^= u << 13 | u >>> 19;
    u = x11 + x7 | 0; x15 ^= u << 18 | u >>> 14;
    u = x0 + x3 | 0; x1 ^= u << 7 | u >>> 25;
    u = x1 + x0 | 0; x2 ^= u << 9 | u >>> 23;
    u = x2 + x1 | 0; x3 ^= u << 13 | u >>> 19;
    u = x3 + x2 | 0; x0 ^= u << 18 | u >>> 14;
    u = x5 + x4 | 0; x6 ^= u << 7 | u >>> 25;
    u = x6 + x5 | 0; x7 ^= u << 9 | u >>> 23;
    u = x7 + x6 | 0; x4 ^= u << 13 | u >>> 19;
    u = x4 + x7 | 0; x5 ^= u << 18 | u >>> 14;
    u = x10 + x9 | 0; x11 ^= u << 7 | u >>> 25;
    u = x11 + x10 | 0; x8 ^= u << 9 | u >>> 23;
    u = x8 + x11 | 0; x9 ^= u << 13 | u >>> 19;
    u = x9 + x8 | 0; x10 ^= u << 18 | u >>> 14;
    u = x15 + x14 | 0; x12 ^= u << 7 | u >>> 25;
    u = x12 + x15 | 0; x13 ^= u << 9 | u >>> 23;
    u = x13 + x12 | 0; x14 ^= u << 13 | u >>> 19;
    u = x14 + x13 | 0; x15 ^= u << 18 | u >>> 14;
  }
  b[0] += x0; b[1] += x1; b[2] += x2; b[3] += x3; b[4] += x4; b[5] += x5; b[6] += x6; b[7] += x7;
  b[8] += x8; b[9] += x9; b[10] += x10; b[11] += x11; b[12] += x12; b[13] += x13; b[14] += x14; b[15] += x15;
}

/** scryptBlockMix in place on `block` (32r words), with `scratch` the same size and `x` 16 words. */
function blockMix(block, scratch, x, r) {
  const blocks = 2 * r;
  for (let k = 0; k < 16; k++) x[k] = block[(blocks - 1) * 16 + k];
  for (let i = 0; i < blocks; i++) {
    for (let k = 0; k < 16; k++) x[k] ^= block[i * 16 + k];
    salsa208(x);
    const to = (i % 2 === 0 ? i / 2 : r + (i - 1) / 2) * 16;
    for (let k = 0; k < 16; k++) scratch[to + k] = x[k];
  }
  block.set(scratch);
}

function roMix(block, memory, scratch, x, N, r) {
  const words = block.length;
  for (let i = 0; i < N; i++) {
    memory.set(block, i * words);
    blockMix(block, scratch, x, r);
  }
  for (let i = 0; i < N; i++) {
    const from = (block[words - 16] & (N - 1)) * words;
    for (let k = 0; k < words; k++) block[k] ^= memory[from + k];
    blockMix(block, scratch, x, r);
  }
}

export async function scrypt(password, salt, { N, r, p, dkLen }) {
  const isPositive = (n) => Number.isInteger(n) && n > 0;
  if (!isPositive(N) || N < 2 || N > 2 ** 31 || (N & (N - 1)) !== 0) throw new Error("scrypt: N must be a power of 2");
  if (!isPositive(r) || !isPositive(p) || r * p >= 2 ** 30) throw new Error("scrypt: bad r or p");
  if (!isPositive(dkLen)) throw new Error("scrypt: bad dkLen");

  const key = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const pbkdf2 = async (s, length) => new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: s, iterations: 1 }, key, length * 8));

  const laneBytes = 128 * r;
  const lanes = await pbkdf2(salt, p * laneBytes);
  const view = new DataView(lanes.buffer);
  const words = laneBytes / 4;
  const block = new Uint32Array(words), scratch = new Uint32Array(words), x = new Uint32Array(16);
  const memory = new Uint32Array(words * N);
  for (let lane = 0; lane < p; lane++) {
    const start = lane * laneBytes;
    for (let k = 0; k < words; k++) block[k] = view.getUint32(start + k * 4, true);
    roMix(block, memory, scratch, x, N, r);
    for (let k = 0; k < words; k++) view.setUint32(start + k * 4, block[k], true);
  }
  return pbkdf2(lanes, dkLen);
}

/** NFKC first: the same password typed on another platform can arrive as different code points. */
export async function loginKeyFrom(password, salt) {
  const stretched = await scrypt(encoder.encode(password.normalize("NFKC")), salt, { N: 2 ** 17, r: 8, p: 1, dkLen: KEY_BYTES });
  return hkdf(stretched, new Uint8Array(0), LOGIN_INFO, KEY_BYTES);
}

// --- device keys and signatures ---

/** `extractable` is for the desktop, which has to write its keys to a file. */
export async function newDeviceKeys({ extractable = false } = {}) {
  const [signKeys, boxKeys] = await Promise.all([
    subtle.generateKey("Ed25519", extractable, ["sign", "verify"]),
    subtle.generateKey("X25519", extractable, ["deriveBits"]),
  ]);
  const [signPub, boxPub] = await Promise.all([signKeys, boxKeys].map(async (pair) => toB64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)))));
  return { sign: signKeys, box: boxKeys, signPub, boxPub };
}

export async function sign(key, bytes) {
  return toB64(new Uint8Array(await subtle.sign("Ed25519", key, framed(SIGN_DOMAIN, bytes))));
}

/** False for a bad signature and for malformed input alike: both come from outside. */
export async function verify(b64pub, bytes, sig) {
  try {
    const key = await subtle.importKey("raw", sizedB64(b64pub, KEY_BYTES, "verify"), "Ed25519", false, ["verify"]);
    return await subtle.verify("Ed25519", key, fromB64(sig), framed(SIGN_DOMAIN, bytes));
  } catch {
    return false;
  }
}

// --- approving a new sign-in (spec section 4) ---
// The order is the security: the approver sends `commit`; the new device sends newApprovalRandom() only after
// the commit has arrived; only then the approver reveals `random`, which the new device checks with verifyReveal.

const commitTo = (random) => sha256(framed(COMMIT_DOMAIN, random));

export async function approverCommit() {
  const random = randomBytes(RANDOM_BYTES);
  return { commit: toB64(await commitTo(random)), random: toB64(random) };
}

export async function newApprovalRandom() {
  return toB64(randomBytes(RANDOM_BYTES));
}

export async function verifyReveal(commit, random) {
  try {
    return sameBytes(fromB64(commit), await commitTo(sizedB64(random, RANDOM_BYTES, "reveal")));
  } catch {
    return false;
  }
}

export async function approvalCode({ approverRandom, newRandom, approverPub, newPub, logHead }) {
  if (typeof logHead !== "string" || !logHead) throw new Error("approval: missing log head");
  const digest = await sha256(framed(
    CODE_DOMAIN,
    sizedB64(approverRandom, RANDOM_BYTES, "approval: approver random"),
    sizedB64(newRandom, RANDOM_BYTES, "approval: new device random"),
    sizedB64(approverPub, KEY_BYTES, "approval: approver key"),
    sizedB64(newPub, KEY_BYTES, "approval: new device key"),
    logHead,
  ));
  const value = new DataView(digest.buffer).getBigUint64(0);
  return String(value % 1_000_000n).padStart(6, "0");
}

// --- channel (spec section 6) ---
//
// Each side signs both fresh X25519 keys, so its signature cannot exist before it has seen the other side's hello.
// That takes two flights, in any order between the sides:
//   const hs = await startHandshake({device, peerPub, logHead});   send hs.hello
//   const channel = await hs.finish(peerHello);                    send channel.proof
//   await channel.confirm(peerProof);                              channel is now usable
// A single signed hello would let a hub replay an old one, stale log head included, and be believed.

function newChannel({ proof, peerProofOk, sendKey, recvKey, sendDirection, peerLogHead }) {
  const recvDirection = 1 - sendDirection;
  let confirmed = false, sendCount = 0n, recvCount = 0n, queue = Promise.resolve();

  const requireConfirmed = () => {
    if (!confirmed) throw new Error("channel: peer not confirmed");
  };
  // WebCrypto is async, so without a queue two opens of one frame could both pass the counter check.
  const inOrder = (step) => {
    const result = queue.then(step);
    queue = result.catch(() => {});
    return result;
  };
  const gcm = (direction, count) => {
    const iv = new Uint8Array(12);
    iv[0] = direction;
    new DataView(iv.buffer).setBigUint64(4, count);
    return { name: "AES-GCM", iv, additionalData: FRAME_AAD };
  };

  return {
    proof,
    async confirm(peerProof) {
      if (!await peerProofOk(peerProof)) throw new Error("channel: bad proof from peer");
      confirmed = true;
    },
    get peerLogHead() {
      requireConfirmed();
      return peerLogHead;
    },
    seal(bytes) {
      return inOrder(async () => {
        requireConfirmed();
        const count = sendCount++;
        const sealed = new Uint8Array(await subtle.encrypt(gcm(sendDirection, count), sendKey, bytes));
        const frame = new Uint8Array(COUNTER_BYTES + sealed.length);
        new DataView(frame.buffer).setBigUint64(0, count);
        frame.set(sealed, COUNTER_BYTES);
        return frame;
      });
    },
    open(frame) {
      return inOrder(async () => {
        requireConfirmed();
        if (frame.length < COUNTER_BYTES + TAG_BYTES) throw new Error("channel: frame too short");
        const count = new DataView(frame.buffer, frame.byteOffset, COUNTER_BYTES).getBigUint64(0);
        if (count !== recvCount) throw new Error("channel: frame out of order or replayed");
        let plain;
        try {
          plain = await subtle.decrypt(gcm(recvDirection, count), recvKey, frame.subarray(COUNTER_BYTES));
        } catch {
          throw new Error("channel: frame failed authentication");
        }
        recvCount++;
        return new Uint8Array(plain);
      });
    },
  };
}

export async function startHandshake({ device, peerPub, logHead }) {
  if (typeof logHead !== "string" || !logHead) throw new Error("handshake: missing log head");
  const myKey = fromB64(device.signPub);
  const peerKey = sizedB64(peerPub, KEY_BYTES, "handshake: peer key");
  if (sameBytes(myKey, peerKey)) throw new Error("handshake: a device cannot open a channel to itself");
  const ephemeral = await subtle.generateKey("X25519", false, ["deriveBits"]);
  const myShare = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));
  let finished = false;

  return {
    hello: { eph: toB64(myShare), logHead },
    async finish(peerHello) {
      // A second finish would restart the counters on the same keys, repeating nonces.
      if (finished) throw new Error("handshake: already finished");
      finished = true;
      const peerShare = sizedB64(peerHello?.eph, KEY_BYTES, "handshake: peer key share");
      const peerLogHead = peerHello.logHead;
      if (typeof peerLogHead !== "string" || !peerLogHead) throw new Error("handshake: peer sent no log head");

      let secret;
      try {
        const peerShareKey = await subtle.importKey("raw", peerShare, "X25519", false, []);
        secret = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peerShareKey }, ephemeral.privateKey, 256));
      } catch {
        throw new Error("handshake: unusable peer key share");
      }
      if (secret.every((byte) => byte === 0)) throw new Error("handshake: unusable peer key share");

      // Neither side has a fixed role, so the transcript and key order come from comparing the device keys.
      const iAmLow = compareBytes(myKey, peerKey) < 0;
      const [low, high] = iAmLow
        ? [[myKey, myShare, logHead], [peerKey, peerShare, peerLogHead]]
        : [[peerKey, peerShare, peerLogHead], [myKey, myShare, logHead]];
      const transcript = await sha256(framed(TRANSCRIPT_DOMAIN, low[0], high[0], low[1], high[1], low[2], high[2]));

      const aesKey = async (info, usage) => subtle.importKey("raw", await hkdf(secret, transcript, info, KEY_BYTES), "AES-GCM", false, [usage]);
      const [sendInfo, recvInfo] = iAmLow ? [KEY_INFO_LOW_TO_HIGH, KEY_INFO_HIGH_TO_LOW] : [KEY_INFO_HIGH_TO_LOW, KEY_INFO_LOW_TO_HIGH];
      const [sendKey, recvKey] = await Promise.all([aesKey(sendInfo, "encrypt"), aesKey(recvInfo, "decrypt")]);

      const proof = toB64(new Uint8Array(await subtle.sign("Ed25519", device.sign.privateKey, framed(PROOF_DOMAIN, myKey, transcript))));
      const peerVerifyKey = await subtle.importKey("raw", peerKey, "Ed25519", false, ["verify"]);
      const peerProofOk = async (peerProof) => {
        try {
          return await subtle.verify("Ed25519", peerVerifyKey, fromB64(peerProof), framed(PROOF_DOMAIN, peerKey, transcript));
        } catch {
          return false;
        }
      };
      return newChannel({ proof, peerProofOk, sendKey, recvKey, sendDirection: iAmLow ? 0 : 1, peerLogHead });
    },
  };
}

// --- recovery (spec section 5) ---

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O or U to misread
const CODE_LENGTH = 26;
const CODE_GROUPS = /^(.{5})(.{5})(.{5})(.{5})(.{6})$/;

export function newRecoveryCode() {
  let value = randomBytes(16).reduce((sum, byte) => sum << 8n | BigInt(byte), 0n);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code = CODE_ALPHABET[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return code.replace(CODE_GROUPS, "$1-$2-$3-$4-$5");
}

function parseRecoveryCode(code) {
  const text = code.replace(/[\s-]/g, "").toUpperCase();
  if (text.length !== CODE_LENGTH) throw new Error("recovery code: wrong length");
  let value = 0n;
  for (const char of text) {
    const digit = CODE_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("recovery code: invalid character");
    value = value << 5n | BigInt(digit);
  }
  if (value >> 128n) throw new Error("recovery code: out of range");
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

const ED25519_PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** WebCrypto cannot generate from a seed, so the seed goes in as PKCS8; the JWK export is the only way to get its public key. */
export async function recoveryKeysFrom(code) {
  const seed = await hkdf(parseRecoveryCode(code), new Uint8Array(0), RECOVERY_INFO, KEY_BYTES);
  const pkcs8 = new Uint8Array([...ED25519_PKCS8_PREFIX, ...seed]);
  const readable = await subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
  const { x } = await subtle.exportKey("jwk", readable);
  const publicKey = await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, "Ed25519", true, ["verify"]);
  const privateKey = await subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const signPub = toB64(new Uint8Array(await subtle.exportKey("raw", publicKey)));
  return { sign: { privateKey, publicKey }, signPub };
}
