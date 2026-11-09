// The hub's data dir: JSON files written whole and renamed into place, so a crash leaves the old file or the new one.
//   secret         for the fake salts, created on first run
//   bootstrap      SHA-256 of the one-shot registration token, only until the first account exists
//   accounts.json  {version, accounts: [{id, email, salt, verifier: {salt, hash}, log, owner?}]}. `owner` marks the first account:
//                  a write moves an account to the end of this file, so the order says nothing.
//   sessions.json  {version, sessions: [{hash, accountId, signPub, name, kind, ip, createdAt, expiresAt, proven, approved}]}
//   invites.json   {version, invites: [{id, hash, createdBy, createdAt, expiresAt, usedAt}]}. Only the SHA-256 of a code, never the code.
//
// Anything damaged stops the hub. Starting empty would let anyone register the account again.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = 1;
const SECRET_BYTES = 32;
const BOOTSTRAP_HASH_BYTES = 32;
const SECRET_FILE = "secret", ACCOUNTS_FILE = "accounts.json", SESSIONS_FILE = "sessions.json", INVITES_FILE = "invites.json", BOOTSTRAP_FILE = "bootstrap";
const PRIVATE_FILE = 0o600, PRIVATE_DIR = 0o700;

export class StoreError extends Error {
  constructor(file, why) {
    // Never the parser's message: it quotes the file, and the file holds verifiers.
    super(`hub store: ${file} ${why}. Refusing to start: restore it from a backup, or move the data dir away to begin again`);
    this.name = "StoreError";
  }
}

function writeAtomic(path, text) {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", PRIVATE_FILE);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Makes the rename itself durable. Windows cannot open a directory like this, and does not need to. */
function syncDir(dir) {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort */ }
}

function readJson(dir, file, listName, valid) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch {
    throw new StoreError(file, "cannot be read as JSON");
  }
  if (data?.version !== VERSION) throw new StoreError(file, "has an unknown version");
  const list = data[listName];
  if (!Array.isArray(list) || !list.every(valid)) throw new StoreError(file, "has the wrong shape");
  return list;
}

const isText = (value) => typeof value === "string" && value.length > 0;
const isTime = (value) => Number.isSafeInteger(value);

const validAccount = (a) => isText(a?.id) && isText(a.email) && isText(a.salt) && isText(a.verifier?.salt) && isText(a.verifier?.hash) && Array.isArray(a.log) && a.log.length > 0;
const validSession = (s) => isText(s?.hash) && isText(s.id) && isText(s.accountId) && isText(s.signPub) && typeof s.name === "string" && typeof s.kind === "string" && typeof s.ip === "string"
  && isTime(s.createdAt) && isTime(s.expiresAt) && typeof s.proven === "boolean" && typeof s.approved === "boolean";

const validInvite = (i) => isText(i?.id) && isText(i.hash) && isText(i.createdBy) && isTime(i.createdAt) && isTime(i.expiresAt) && (i.usedAt === null || isTime(i.usedAt));

function readSecret(dir) {
  let secret;
  try {
    secret = Buffer.from(readFileSync(join(dir, SECRET_FILE), "utf8"), "hex");
  } catch {
    throw new StoreError(SECRET_FILE, "cannot be read");
  }
  if (secret.length !== SECRET_BYTES) throw new StoreError(SECRET_FILE, "has the wrong size");
  return secret;
}

/**
 * Opens the data dir, creating it on first run. Throws StoreError if anything in it is damaged or missing.
 * A write throws before memory changes, except deleteSession, where memory changes first: a session must end even on a full disk.
 */
export function openStore(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  // A crash mid-write leaves a temp file, and the real file untouched.
  for (const name of readdirSync(dir)) if (name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });

  const present = [SECRET_FILE, ACCOUNTS_FILE, SESSIONS_FILE].filter((file) => existsSync(join(dir, file)));
  if (present.length === 0) {
    writeAtomic(join(dir, SECRET_FILE), randomBytes(SECRET_BYTES).toString("hex"));
    writeAtomic(join(dir, ACCOUNTS_FILE), JSON.stringify({ version: VERSION, accounts: [] }));
    writeAtomic(join(dir, SESSIONS_FILE), JSON.stringify({ version: VERSION, sessions: [] }));
    syncDir(dir);
  }
  // A hub from before invites has none of these yet.
  if (!existsSync(join(dir, INVITES_FILE))) writeAtomic(join(dir, INVITES_FILE), JSON.stringify({ version: VERSION, invites: [] }));
  const accountList = readJson(dir, ACCOUNTS_FILE, "accounts", validAccount);
  const sessionList = readJson(dir, SESSIONS_FILE, "sessions", validSession);
  const inviteList = readJson(dir, INVITES_FILE, "invites", validInvite);
  const secret = readSecret(dir);

  const accounts = new Map(accountList.map((a) => [a.id, a]));
  const byEmail = new Map(accountList.map((a) => [a.email, a]));
  const sessions = new Map(sessionList.map((s) => [s.hash, s]));
  const invites = new Map(inviteList.map((i) => [i.hash, i]));
  if (accounts.size !== accountList.length || byEmail.size !== accountList.length) throw new StoreError(ACCOUNTS_FILE, "has duplicate accounts");
  if (sessionList.some((s) => !accounts.has(s.accountId))) throw new StoreError(SESSIONS_FILE, "names an account that does not exist");

  // Left behind only by a crash between the first registration and its deletion. It opens nothing by then.
  const bootstrapPath = join(dir, BOOTSTRAP_FILE);
  let bootstrapHash = null;
  if (accounts.size > 0) rmSync(bootstrapPath, { force: true });
  else if (existsSync(bootstrapPath)) {
    bootstrapHash = Buffer.from(readFileSync(bootstrapPath, "utf8"), "hex");
    if (bootstrapHash.length !== BOOTSTRAP_HASH_BYTES) throw new StoreError(BOOTSTRAP_FILE, "has the wrong size");
  }

  const writeAccounts = (list) => {
    writeAtomic(join(dir, ACCOUNTS_FILE), JSON.stringify({ version: VERSION, accounts: list }));
    syncDir(dir);
  };
  const writeSessions = (list) => {
    writeAtomic(join(dir, SESSIONS_FILE), JSON.stringify({ version: VERSION, sessions: list }));
    syncDir(dir);
  };
  const writeInvites = (list) => {
    writeAtomic(join(dir, INVITES_FILE), JSON.stringify({ version: VERSION, invites: list }));
    syncDir(dir);
  };

  return {
    secret,
    accounts,
    byEmail,
    sessions,
    invites,
    /** The first account's id. A hub with one account from before this field was kept: that one is the first. */
    get ownerId() {
      const marked = [...accounts.values()].find((a) => a.owner === true);
      if (marked) return marked.id;
      return accounts.size === 1 ? accounts.keys().next().value : null;
    },
    get bootstrapHash() { return bootstrapHash; },
    setBootstrapHash(hash) {
      writeAtomic(bootstrapPath, hash.toString("hex"));
      syncDir(dir);
      bootstrapHash = hash;
    },
    clearBootstrap() {
      bootstrapHash = null;
      rmSync(bootstrapPath, { force: true });
      syncDir(dir);
    },
    /** Adds or replaces an account, by its id. */
    putAccount(account) {
      writeAccounts([...accounts.values()].filter((a) => a.id !== account.id).concat(account));
      accounts.set(account.id, account);
      byEmail.set(account.email, account);
    },
    putSession(session) {
      writeSessions([...sessions.values()].filter((s) => s.hash !== session.hash).concat(session));
      sessions.set(session.hash, session);
    },
    deleteSession(hash) {
      sessions.delete(hash);
      writeSessions([...sessions.values()]);
    },
    /** Adds or replaces an invite, by its hash. */
    putInvite(invite) {
      writeInvites([...invites.values()].filter((i) => i.hash !== invite.hash).concat(invite));
      invites.set(invite.hash, invite);
    },
    deleteInvites(hashes) {
      writeInvites([...invites.values()].filter((i) => !hashes.includes(i.hash)));
      for (const hash of hashes) invites.delete(hash);
    },
  };
}
