/**
 * Where the iPhone app keeps what it must keep: the iOS Keychain, on this device only, reached through the shell's `keystore` bridge.
 * The same store as page-store.js, for the same keys, and nothing goes in the web view's own storage, which iOS may clear and which
 * would break the refusal of a rollback.
 *
 * The private keys cross as bytes only twice: when they are made, and once per page load, to be imported. What this page holds after
 * that is a CryptoKey it cannot export. The shell answers the read of `keys` once per page load, so code running later cannot ask.
 *
 * `bridge` has get(name) (text, or null if there is none), put(name, text) and remove(name), all promises. A Keychain that cannot
 * answer rejects, and that stays an error here: if it read as "no keys", new ones would replace the device's identity.
 */
import { fromB64, newDeviceKeys, toB64 } from "./account-core.js";

const NAMES = new Set(["keys", "session", "log", "state", "alerts"]);

function checked(name) {
  if (!NAMES.has(name)) throw new Error(`the Keychain store keeps nothing called ${name}`);
  return name;
}

async function exportedKey(key) {
  return toB64(new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", key)));
}

async function imported({ sign, box, signPub, boxPub }) {
  const { subtle } = globalThis.crypto;
  const [signKey, boxKey] = await Promise.all([
    subtle.importKey("pkcs8", fromB64(sign), "Ed25519", false, ["sign"]),
    subtle.importKey("pkcs8", fromB64(box), "X25519", false, ["deriveBits"]),
  ]);
  return { sign: { privateKey: signKey }, box: { privateKey: boxKey }, signPub, boxPub };
}

export function keychainStore(bridge) {
  let held; // undefined until asked: the keys this page holds, or null for none
  return {
    protection: "keychain",

    /** New keys, kept before anything can use them. The extractable pair ends with this call. */
    async makeKeys() {
      const made = await newDeviceKeys({ extractable: true });
      const secret = { sign: await exportedKey(made.sign.privateKey), box: await exportedKey(made.box.privateKey), signPub: made.signPub, boxPub: made.boxPub };
      await bridge.put("keys", JSON.stringify(secret));
      held = await imported(secret);
      return held;
    },

    async get(name) {
      checked(name);
      if (name === "keys" && held !== undefined) return held;
      const text = await bridge.get(name);
      const value = text === null || text === undefined ? null : JSON.parse(text);
      if (name !== "keys") return value;
      held = value === null ? null : await imported(value);
      return held;
    },

    async set(name, value) {
      checked(name);
      if (name === "keys") throw new Error("keys are made here, and are never handed in");
      await bridge.put(name, JSON.stringify(value));
    },

    async delete(name) {
      checked(name);
      await bridge.remove(name);
      if (name === "keys") held = null;
    },

    async clear() {
      for (const name of NAMES) await bridge.remove(name);
      held = null;
    },
  };
}
