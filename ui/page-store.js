/**
 * Where the web page keeps what it must keep, under these keys:
 *   keys     { sign: {privateKey}, box: {privateKey}, signPub, boxPub }: non-extractable CryptoKeys, stored as objects, so the
 *            private bytes are never in a form this page's code could read
 *   session  the hub's token, useless without proving the key
 *   log      the highest log this page has verified. What refuses a rollback across a reload
 *   state    { email, name, phase, exchange, knownRecoveries }. No secrets
 *   alerts   what the person has been warned of
 * A store has get, set, delete and clear, all promises. get gives null for nothing there.
 */
const DB_NAME = "omni-page";
const STORE = "kv";

const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export async function openPageStore(indexedDB = globalThis.indexedDB) {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => { open.result.createObjectStore(STORE); };
  const db = await request(open);
  const run = (mode, work) => {
    const tx = db.transaction(STORE, mode);
    return request(work(tx.objectStore(STORE)));
  };
  return {
    async get(key) { return (await run("readonly", (s) => s.get(key))) ?? null; },
    async set(key, value) { await run("readwrite", (s) => s.put(value, key)); },
    async delete(key) { await run("readwrite", (s) => s.delete(key)); },
    async clear() { await run("readwrite", (s) => s.clear()); },
  };
}

/** For tests, and for nothing else: a page whose log does not survive a reload could not refuse a rollback. */
export function memoryStore() {
  const data = new Map();
  return {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async clear() { data.clear(); },
  };
}
