/**
 * What a device believes about the log and about an approval: one file for the desktop, the web page and the iPhone app, so a
 * rule cannot hold on one and not another. Nothing from the hub is believed. Who is on the account comes only from a log this
 * device replayed itself, starting from one it already holds, or for a new device from the head that went into the code.
 */
import { newDeviceExchange, sign } from "./account-core.js";
import { LogError, compareLogs } from "./device-log.js";
import { encodeOuter } from "./channel-frames.js";
import { AccountError } from "./account-error.js";

export const CLAIM_DOMAIN = "omni-approval-claim-v1";
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------------- alerts

export const ALERT_TEXT = Object.freeze({
  rollback: "The hub offered an older copy of the device list than this computer already has. It was refused: someone may be hiding a removal.",
  fork: "The hub showed a device list that differs from this computer's at the same position. It was refused: the hub may be showing different lists to different devices.",
  "different-account": "The hub showed the device list of a different account. It was refused.",
  "bad-log": "A device list failed its signature checks and was refused.",
  "fake-log": "This computer was told it was approved, but the device list does not follow the approval code you confirmed. It was refused, and this computer stays out of the account.",
  "log-unreconciled": "Another device has a device list this computer cannot get from the hub. The channel was refused: the hub may be hiding a change.",
  removed: "This device is no longer on the account.",
  recovered: "A device recovered this account with the recovery code. If that was not you, your recovery code is out and that device has full control.",
  "channel-failure": "An encrypted channel failed its check and was closed. A frame was changed, lost or replayed on the way.",
  "approval-failed": "An approval exchange failed its check and was abandoned. No code from it is shown.",
  "refused-by-device": "A device on your account refused this computer, so the two hold different device lists. The hub may be hiding a change from one of them, or this computer may have been removed.",
  "hub-says-removed": "The hub says this device was removed from the account. This computer's own device list does not show that, so do not forget this device on the hub's word alone: check under Settings → Account → Devices on another device first.",
  "key-unavailable": "This computer's account keys could not be opened. Nothing was changed. To start over, sign out and forget this device.",
});

/**
 * What the person must not miss: these are never pushed out by others. Every other kind can be raised by a hub at will
 * from public data, so each is one row with a count, whatever it is about.
 */
const LASTING_ALERTS = new Set(["fork", "rollback", "fake-log", "different-account", "recovered", "removed", "log-unreconciled", "refused-by-device"]);
/** A hub can make different-account or fake-log rows for ever by building new logs, so past this they count on the last row. */
const MAX_ROWS_PER_KIND = 8;

/** The new list, and the new row if this alert is news rather than a repeat of one the person has. */
export function addAlert(alerts, kind, detail, now, text = ALERT_TEXT) {
  const key = LASTING_ALERTS.has(kind) ? `${kind}|${detail ?? ""}` : kind;
  const sameKind = alerts.filter((a) => a.kind === kind);
  const repeat = sameKind.find((a) => a.key === key) ?? (sameKind.length >= MAX_ROWS_PER_KIND ? sameKind.at(-1) : null);
  if (repeat) {
    repeat.count = (repeat.count ?? 1) + 1;
    repeat.lastAt = now;
    return { alerts, fresh: null };
  }
  const alert = { kind, message: text[kind] ?? kind, at: now, lastAt: now, count: 1, key };
  return { alerts: [...alerts, alert], fresh: alert };
}

// ---------------------------------------------------------------------------------- a log from outside

const VERDICT_ALERT = { "a-newer": "rollback", fork: "fork", "different-account": "different-account" };

/**
 * A log from outside against the one held here, which is never replaced by anything but a longer log of the same chain.
 * Returns {verdict: same | adopted | rollback | fork | different-account | bad-log, verified, alert: [kind, detail] | null}.
 * `adopted` means the caller may keep it: nothing has been kept yet.
 */
export async function judgeLog(held, entries, { now, verifyLog }) {
  let verified;
  try {
    verified = await verifyLog(entries, { now });
  } catch (error) {
    if (!(error instanceof LogError)) throw error;
    return { verdict: "bad-log", verified: null, alert: ["bad-log", error.message] };
  }
  const verdict = await compareLogs(held, entries);
  if (verdict === "same") return { verdict: "same", verified, alert: null };
  if (verdict === "b-newer") return { verdict: "adopted", verified, alert: null };
  const kind = VERDICT_ALERT[verdict];
  return { verdict: kind, verified, alert: [kind, String(verdict === "different-account" ? verified.accountId : verified.head)] };
}

/**
 * The log a device gets on being approved. It must verify, name this device in the add right after the head in the code,
 * signed by the key in the code, and not contradict any log this device held before. Without this, a hub could hand a new
 * device a made-up account. Returns {verified} or {alert: [kind, detail]}.
 */
export async function checkApprovedLog(entries, { me, exchange, held, now, verifyLog }) {
  let verified;
  try {
    verified = await verifyLog(entries, { now });
  } catch (error) {
    if (!(error instanceof LogError)) throw error;
    return { alert: ["fake-log", "invalid"] };
  }
  const added = entries.findIndex((entry) => entry.type === "add" && entry.body.signPub === me);
  const follows = added > 0 && entries[added].prev === exchange.head && entries[added].signer === exchange.from;
  if (!follows || !verified.devices.has(me)) return { alert: ["fake-log", String(verified.head)] };
  if (held) {
    const verdict = await compareLogs(held, entries);
    if (verdict !== "b-newer" && verdict !== "same") return { alert: [VERDICT_ALERT[verdict], String(verified.head)] };
  }
  return { verified };
}

// ---------------------------------------------------------------------------------- approval: the new device

const claimBytes = (claim, head, approverPub) => encoder.encode(JSON.stringify([CLAIM_DOMAIN, claim.name, claim.kind, claim.boxPub, approverPub, head]));

/** The new device's claim is signed to the approver and the head, so a hub cannot swap its box key. */
export const signedClaimBytes = claimBytes;

/**
 * The new device's side of an approval. The order is the security, and only the person starts another exchange: otherwise a
 * hub could keep trying values until the codes matched, and could replace one already confirmed.
 *   device()  {keys, name, kind} of this device
 *   send(to, opaque), changed(), alert(kind, detail), persist()
 */
export class NewDeviceApproval {
  attempts = 0;
  failed = false;
  current = null; // { from, core, head, code, confirmed }
  #accept = true;

  constructor({ device, send, changed, alert, persist }) {
    Object.assign(this, { device, send, changed, alert, persist });
  }

  /** A new sign-in. */
  reset() {
    this.attempts = 0;
    this.failed = false;
    this.#accept = true;
    this.current = null;
  }

  /** After a restart: confirmed before it, and the code itself was not kept. */
  resume({ from, head }) {
    this.#accept = false;
    this.current = { from, head, code: null, core: null, confirmed: true };
  }

  /** What may be kept across a restart: never the code. */
  get saved() { return this.current?.confirmed ? { head: this.current.head, from: this.current.from } : null; }

  async onMessage(from, outer) {
    if (outer.t === "commit") return this.#onCommit(from, outer);
    if (outer.t === "reveal" && this.current?.from === from && this.current.core) return this.#onReveal(outer);
    return undefined;
  }

  async #onCommit(from, { commit, logHead }) {
    if (!this.#accept) return;
    this.#accept = false;
    this.attempts++;
    this.changed();
    const { keys, name, kind } = this.device();
    let core;
    try {
      core = await newDeviceExchange({ approverPub: from, newPub: keys.signPub, logHead });
      core.receiveCommit(commit);
    } catch {
      this.#fail();
      return;
    }
    this.current = { from, core, head: logHead, code: null, confirmed: false };
    const random = core.releaseRandom();
    const claim = { name, kind, boxPub: keys.boxPub };
    const sig = await sign(keys.sign.privateKey, claimBytes(claim, logHead, from));
    this.send(from, encodeOuter({ t: "random", random, claim, sig }));
  }

  async #onReveal({ random }) {
    const exchange = this.current;
    try {
      await exchange.core.receiveReveal(random);
      exchange.code = await exchange.core.code();
      exchange.core = null;
      this.changed();
    } catch {
      this.#fail();
    }
  }

  /** It ends here, visibly. No code from it is ever shown, and nothing starts again until the person says so. */
  #fail() {
    this.current = null;
    this.failed = true;
    this.alert("approval-failed", String(this.attempts));
    this.changed();
  }

  /** The person's button: after a failed exchange, or a code that did not match. Forgets any code held. */
  restart() {
    this.current = null;
    this.failed = false;
    this.#accept = true;
    this.persist();
    this.changed();
  }

  /**
   * The person at this device checked that the code here matches the approving device's. Without this step, a hacked hub could
   * play the approver on its own and hand this device a made-up account whose devices it then controls: the log would follow
   * the head of an exchange that was real, just not with any device of the person's.
   */
  confirm(code) {
    if (!this.current?.code) throw new AccountError(409, "no-code", "There is no code to confirm yet.");
    if (code !== this.current.code) throw new AccountError(400, "wrong-code", "That is not the code shown on this computer.");
    this.current.confirmed = true;
    this.persist();
    this.changed();
  }
}
