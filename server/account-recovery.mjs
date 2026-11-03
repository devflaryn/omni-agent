/**
 * The life of a one-time recovery code, and of the log entry that makes it live. Everything about it is here and in one
 * record, `recovery-code.json`, written atomically: code, candidate log and state cannot get out of step, so there is no
 * moment a kill could leave one without the other.
 *
 *   state            has code  has candidate  what it means
 *   none             no        no             nothing in hand
 *   in-doubt         yes       yes            on its way to the hub, or may have reached it. It may not work yet
 *   contested        yes       yes            a hub contradicted it, or it stayed unsettled too long. The person may decide
 *   saved-unsettled  no        yes            the person saved the code while unsettled. It may still settle later
 *   saved-contested  no        yes            saved, and a hub has contradicted it since. Shown, so it is no silent end
 *   live             yes       no             a log from the hub holds it. It works, until the person says they saved it
 *
 * Why it may sit on disk: anyone who can read this store already holds this full device's keys. Why it must: a kill at any
 * moment must not lose it, and nothing can issue another.
 *
 * The rule the table holds to: nothing a hub says can delete a code that may be live, and no caller can write over one.
 * Only three things delete one: the person saying they saved it, a send that never left this computer, and a hub reply
 * showing that nothing was created. `forgotten` is the person's own explicit exit. `prepare` is allowed from `none`
 * alone; where a code is held, the same code may be sent again on a new candidate (`resent`), and nothing else may.
 * `replaced` exists only where the person has saved the code.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const RECOVERY_CODE_FILE = "recovery-code.json";

/** event -> next state, per state. An event not listed changes nothing; `prepare` and `resent` not listed are refused. */
export const TRANSITIONS = Object.freeze({
  none: { prepare: "in-doubt", forgotten: "none" },
  "in-doubt": {
    resent: "in-doubt",       // the same code on a new candidate: a retry, or a recover re-based after a conflict
    settled: "live",          // a log from the hub holds the candidate
    contradicted: "contested",
    nothingCreated: "none",   // never left this computer, or the hub's reply shows nothing was created
    signedOut: "in-doubt",
    saved: "saved-unsettled", // allowed only once too long unsettled: see mayDiscard
    forgotten: "none",
  },
  contested: {
    resent: "in-doubt",
    settled: "live",
    contradicted: "contested",
    nothingCreated: "none",
    signedOut: "in-doubt",    // nothing is contesting it now that no hub is being asked
    saved: "saved-unsettled",
    forgotten: "none",
  },
  "saved-unsettled": { settled: "none", contradicted: "saved-contested", replaced: "none", forgotten: "none" },
  "saved-contested": { settled: "none", contradicted: "saved-contested", signedOut: "saved-unsettled", replaced: "none", forgotten: "none" },
  live: { saved: "none", forgotten: "none" }, // never sent again: it is on the hub's log already
});

const HAS_CODE = new Set(["in-doubt", "contested", "live"]);
const HAS_CANDIDATE = new Set(["in-doubt", "contested", "saved-unsettled", "saved-contested"]);
const CONTRADICTED = new Set(["contested", "saved-contested"]);

export class RecoveryStore {
  state = "none";
  #since = 0;
  #kind = null;
  #email = null;
  #entries = null;
  #queue = Promise.resolve();

  /** writeSecret(name, publicFields, bytes), readSecret(record), writeFile(name, text), warn(text), now(), unsettledMs */
  constructor(io) { this.io = io; this.file = join(io.dir, RECOVERY_CODE_FILE); }

  get email() { return this.#email; }

  /** There is a code the person has not said they saved. */
  get pending() { return HAS_CODE.has(this.state); }

  /** { kind, email, entries } of a log that has not settled, or null. */
  get candidate() { return HAS_CANDIDATE.has(this.state) ? { kind: this.#kind, email: this.#email, entries: this.#entries } : null; }

  /** It works: a log from the hub holds it. */
  get confirmed() { return this.state === "live"; }

  /** A hub's answer has contradicted this code, or the recovery it was made by. */
  get contradicted() { return CONTRADICTED.has(this.state); }

  /** Nothing has been heard either way for too long. */
  get unsettledTooLong() { return this.state === "in-doubt" && this.io.now() - this.#since >= this.io.unsettledMs; }

  /** The person is told to keep every code they have, and may say they saved this one. */
  get contested() { return this.contradicted || this.unsettledTooLong; }

  /** Whether saying "I saved it" is allowed now. While nothing at all is known it stays, but not for ever. */
  get mayDiscard() { return this.state === "live" || this.contested; }

  async load() {
    let record;
    try {
      record = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") this.io.warn("A stored recovery code could not be read. Omni will not delete it: it is in the account folder.");
      return;
    }
    if (!Object.hasOwn(TRANSITIONS, record?.state) || (HAS_CANDIDATE.has(record.state) && !Array.isArray(record.entries))) {
      this.io.warn("A stored recovery code could not be read. Omni will not delete it: it is in the account folder.");
      return;
    }
    this.state = record.state;
    this.#since = Number(record.since) || this.io.now();
    this.#kind = record.kind ?? null;
    this.#email = record.email ?? null;
    this.#entries = record.entries ?? null;
  }

  /**
   * Before the hub call that could make it live, as one write. If this throws, nothing has changed on disk or here, and
   * nothing may be sent. From `none` it is a new code. Where a code is held it must be that same code, of the same kind,
   * being sent again on a new candidate: a code that may be live is never written over, whoever asks.
   */
  prepare(args) { return this.#serial(() => this.#prepare(args)); }

  /** Applies an event from the table. A failed write only leaves the older state on disk, which settles again next time. */
  apply(event) { return this.#serial(() => this.#apply(event)); }

  /** One change at a time, in order: each reads the record the one before it wrote, so disk and memory cannot cross. */
  #serial(work) {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #prepare({ kind, email, code, entries }) {
    const event = this.state === "none" ? "prepare" : "resent";
    if (TRANSITIONS[this.state][event] === undefined) throw new Error(`a recovery code is held (${this.state}) and may be live: only the person may discard it`);
    if (event === "resent") {
      let held = null;
      try { held = await this.code(); } catch { /* cannot be read, so cannot be shown to be the same */ }
      if (held === null || held !== code || this.#kind !== kind) throw new Error(`a recovery code is held (${this.state}) and may be live: only the same code may be sent again`);
    }
    const since = this.io.now();
    await this.io.writeSecret(RECOVERY_CODE_FILE, { state: "in-doubt", since, kind, email, entries }, Buffer.from(code));
    this.state = "in-doubt";
    this.#since = since;
    this.#kind = kind;
    this.#email = email;
    this.#entries = entries;
  }

  async #apply(event) {
    if (event === "prepare" || event === "resent") throw new Error("prepare() carries the code");
    const next = TRANSITIONS[this.state][event];
    if (next === undefined) return false;
    const before = this.state;
    this.state = next;
    if (event === "signedOut") this.#since = this.io.now();
    if (!HAS_CANDIDATE.has(next)) this.#entries = null;
    if (next === before && event !== "signedOut") return true;
    try {
      if (next === "none") {
        this.#kind = null;
        this.#email = null;
        await fs.rm(this.file, { force: true });
      } else {
        const record = JSON.parse(await fs.readFile(this.file, "utf8"));
        Object.assign(record, { state: next, since: this.#since, entries: this.#entries });
        if (!HAS_CODE.has(next)) record.data = "";
        await this.io.writeFile(RECOVERY_CODE_FILE, JSON.stringify(record));
      }
    } catch {
      this.io.warn("The stored recovery code's state could not be saved. It will be worked out again the next time Omni starts.");
    }
    return true;
  }

  /** The code itself. Throws if it cannot be opened on this computer. */
  async code() {
    const record = JSON.parse(await fs.readFile(this.file, "utf8"));
    return Buffer.from(await this.io.readSecret(record)).toString();
  }
}
