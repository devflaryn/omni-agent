/* The account, in the window: the machine switcher, Settings → Account, approval cards, the new device's code, the recovery
   code screen and the security banners. All of it is about this computer's account, whichever machine the window is on, so
   it talks to this computer's server only (transport's `local`).
   Everything a device or the hub supplies is shown as text, through cleanName: device names are hostile input. */
import { el, ago } from "./lib.js";
import { checkPassword } from "./account-core.js";
import { cleanName, isRemote, local, machine, setMachine } from "./transport.js";

const NOTICE_KEY = "omni.machineNotice";
const HUB_SEES = "The hub routes encrypted frames between your devices. It cannot read your actions, results, file contents, chat text or session titles, and it cannot forge an action. It can still see which devices are on the account, when they connect, IP addresses and the size and timing of frames, plus your email address and login verifiers. Using a hacked hub to guess your password offline only gets a pending sign-in, which one of your devices must still approve.";
const FORGET_WARNING = "This deletes the recovery code held on this computer and this device's identity. If that code is the live one and you have not written it down, the account may become unrecoverable.";

/** What to do about each alert. The server's own text says what happened. */
const ALERT_ADVICE = {
  rollback: "Check your devices. Do not approve or remove anything until another device has confirmed the list.",
  fork: "Do not approve anything. Check your devices from another computer, and remove any you do not recognise.",
  "different-account": "Do not approve anything. Check the hub address in this computer's settings.",
  "fake-log": "Do not type your recovery code again here. Check your devices from another computer.",
  "log-unreconciled": "Check your devices, and try again once both machines are online.",
  recovered: "If this was not you, remove the device it added, and use your recovery code on a device you trust.",
  removed: "This computer no longer has access to the account's other machines. It still works on its own. If this was not you, sign in again from a device you trust and check the list.",
  "refused-by-device": "Check your devices. If you removed this computer on purpose there is nothing to do.",
  "bad-log": "Nothing was changed. If this repeats, check your devices from another computer.",
  "channel-failure": "The channel was closed and a new one will be opened. If this repeats, someone may be interfering with the connection.",
  "approval-failed": "Nothing was approved. Press Start again on the new device, then Review on the device already signed in.",
  "hub-says-removed": "This is the hub's claim, not a fact this computer could check. Sign in again to see.",
  "key-unavailable": "This computer's device key could not be opened. Local use still works.",
};
const ALERT_TITLE = {
  rollback: "The hub showed an older device list",
  fork: "Two different device lists exist",
  "different-account": "The hub showed a different account",
  "fake-log": "The hub showed a false device list",
  "log-unreconciled": "Two of your devices disagree about the device list",
  recovered: "The account was recovered with a recovery code",
  removed: "This computer was removed from the account",
  "refused-by-device": "One of your devices refused this computer",
  "bad-log": "The hub sent a device list that does not check out",
  "channel-failure": "A frame on a channel failed its check",
  "approval-failed": "An approval exchange failed",
  "hub-says-removed": "The hub says this device was removed",
  "key-unavailable": "The device key cannot be used",
};
const PHASE_TEXT = {
  "signed-out": "Not signed in. This computer works on its own as usual.",
  pending: "Waiting for approval from one of your signed-in devices.",
  recovering: "Finishing a recovery. It settles when the hub answers.",
  approved: "Signed in.",
  denied: "A device on the account refused this sign-in.",
  expired: "This sign-in expired before it was approved. Sign in again.",
  removed: "This device has been removed from the account.",
  "key-unavailable": "This computer's device key cannot be opened.",
  "log-damaged": "The device list on this computer is damaged.",
};

const groupCode = (code) => String(code ?? "").replace(/(\d{3})(\d{3})/, "$1 $2");
const shortId = (id) => String(id ?? "").slice(0, 6);
const when = (at) => (at ? new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function button(label, cls, onclick) {
  const b = el("button", `btn${cls ? ` ${cls}` : ""}`, label);
  b.type = "button";
  b.onclick = onclick;
  return b;
}

/** Runs `work` with the button off, and shows what went wrong where the person is looking. */
async function acting(b, work, out) {
  if (b) b.disabled = true;
  try { await work(); }
  catch (e) { if (out) { out.textContent = explain(e); out.hidden = false; } else throw e; }
  finally { if (b) b.disabled = false; }
}

function explain(e) {
  if (e.code === "locked") return "Too many tries. This lock is temporary: wait a while, then try again.";
  if (e.code === "hub-unreachable") return `The hub cannot be reached: ${e.message} Nothing here changed, and this computer still works on its own.`;
  return e.message;
}

export function createAccount({ toast, openSettings }) {
  const $ = (s) => document.querySelector(s);
  const A = {
    available: null, why: "", status: null, pending: [], machines: [],
    fullChosen: new Set(), failures: new Map(), showing: null, codeHidden: false, forgetStep: false,
    form: { mode: "signin", email: "", name: "" }, formNote: "", hiddenWarnings: new Set(), machineDown: null, note: "",
  };
  let events = null;
  let tick = null;

  const call = (method, path, body) => local.api(method, `/api/account/${path}`, body);
  const fullDevice = () => A.status?.phase === "approved" && A.status?.device?.role === "full";

  // ---------------------------------------------------------------------------------- loading and news
  async function refresh() {
    try {
      A.status = await call("GET", "status");
      A.available = true;
    } catch (e) {
      A.available = false;
      A.why = e.message;
      A.status = null;
    }
    if (A.available) {
      const [approvals, machines] = await Promise.allSettled([call("GET", "approvals"), call("GET", "machines")]);
      if (approvals.status === "fulfilled") A.pending = approvals.value.pending;
      if (machines.status === "fulfilled") A.machines = machines.value.machines;
    }
    renderAll();
  }

  function listen() {
    if (events || !A.available) return;
    events = local.eventSource("/api/account/events");
    const on = (name, fn) => events.addEventListener(name, (m) => { let data; try { data = JSON.parse(m.data); } catch { return; } fn(data); renderAll(); });
    on("status", (s) => { A.status = s; });
    on("approval", (list) => { A.pending = list; });
    on("links", (list) => { A.machines = list; });
    on("devices", () => { call("GET", "machines").then((r) => { A.machines = r.machines; renderAll(); }).catch(() => {}); if (settingsShown()) renderSettings(true); });
    on("alert", () => {});
    // After a drop the browser reconnects by itself, and the stream's first message is the status.
    events.onerror = () => { if (events?.readyState === 2) { events = null; setTimeout(() => { listen(); }, 5000); } };
  }

  async function init() {
    await refresh();
    listen();
    clearInterval(tick);
    tick = setInterval(renderCards, 15_000);
    let notice = null;
    try { notice = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); } catch { /* */ }
    if (notice) toast(notice, true);
    checkChosenMachine();
  }

  /** A window left on a machine that has since gone from the account, or an account signed out, comes back here. */
  function checkChosenMachine() {
    const m = machine();
    if (!m) return;
    const signedOut = !A.available || !A.status || A.status.phase !== "approved";
    const known = A.machines.find((x) => x.id === m.id);
    if (signedOut || !known) {
      try { sessionStorage.setItem(NOTICE_KEY, `This window was on ${m.name}, which ${signedOut ? "this computer can no longer reach without signing in" : "is no longer on the account"}. It is back on this computer.`); } catch { /* */ }
      setMachine(null);
      return;
    }
    if (known.name !== m.name) { setMachine(m.id, { name: known.name }); renderMachine(); }
  }

  function renderAll() {
    renderMachine();
    renderBanners();
    renderCards();
    renderGate();
    if (settingsShown()) renderSettings();
  }

  // ---------------------------------------------------------------------------------- machine switcher
  function renderMachine() {
    const m = machine();
    const wrap = $("#machineWrap"), btn = $("#machineBtn"), name = $("#machineName");
    document.body.classList.toggle("on-remote", !!m);
    const usable = A.status?.phase === "approved" && A.machines.length > 0;
    wrap.hidden = !m && !usable;
    if (m) {
      name.textContent = `On ${m.name}`;
      btn.title = `Everything in this window, chats and commands included, runs on ${m.name} (${shortId(m.id)}), not on this computer.`;
      $("#machineId").textContent = shortId(m.id);
      $("#machineId").hidden = false;
    } else {
      name.textContent = "This computer";
      btn.title = "Choose which of your machines this window acts on";
      $("#machineId").hidden = true;
    }
    $("#machineBack").hidden = !m;
    if (!$("#machineMenu").hidden) renderMachineMenu();
    const sub = $("#settingsMachine");
    if (sub) { sub.hidden = !m; sub.textContent = m ? `Models, MCP servers and Long runs here are ${m.name}'s. Account and Remote are always this computer's.` : ""; }
  }

  function renderMachineMenu() {
    const menu = $("#machineMenu"), m = machine();
    menu.textContent = "";
    const local_ = el("button", m ? "" : "on", "This computer");
    local_.onclick = () => { menu.hidden = true; setMachine(null); };
    menu.appendChild(local_);
    if (A.machines.length) menu.appendChild(el("div", "mh", "Your other machines"));
    for (const x of A.machines) {
      const row = el("button", `machine-row${m?.id === x.id ? " on" : ""}`);
      row.append(el("span", `machine-dot${x.online ? " live" : ""}`), el("span", "machine-row-name", x.name), el("span", "machine-row-id", shortId(x.id)), el("span", "machine-row-state", x.online ? "" : "offline"));
      row.disabled = !x.online;
      row.title = x.online ? `Act on ${x.name}` : `${x.name} is offline`;
      row.onclick = () => { menu.hidden = true; setMachine(x.id, { name: x.name }); };
      menu.appendChild(row);
    }
    const manage = el("button", "manage", "Devices and account");
    manage.onclick = () => { menu.hidden = true; openSettings(); };
    menu.appendChild(manage);
  }

  // ------------------------------------------------------------------------------------------- banners
  function banner(cls, title, text, actions = []) {
    const b = el("div", `acct-banner ${cls}`);
    b.setAttribute("role", cls.includes("danger") ? "alert" : "status");
    const words = el("div", "acct-banner-text");
    if (title) words.appendChild(el("b", null, title));
    if (text) words.appendChild(el("span", null, ` ${text}`));
    b.appendChild(words);
    const row = el("div", "acct-banner-actions");
    for (const a of actions) row.appendChild(a);
    b.appendChild(row);
    return b;
  }
  const devicesLink = () => button("Devices", "small", () => openSettings());

  function linkBanner() {
    const m = machine();
    if (!m) return null;
    const back = () => button("Back to this computer", "small", () => setMachine(null));
    if (A.machineDown) return banner("danger", `Could not load ${m.name}.`, A.machineDown, [button("Try again", "small", () => location.reload()), back()]);
    if (!A.status?.hub?.connected) return banner("danger", `${m.name} cannot be reached:`, "this computer has lost the hub. Nothing you send now will arrive, and nothing is queued. It reconnects by itself.", [back()]);
    const x = A.machines.find((y) => y.id === m.id);
    if (!x) return null;
    if (!x.online || x.link.state === "offline") return banner("danger", `${x.name} is offline.`, "Nothing you send will reach it, and nothing is queued for later.", [back()]);
    if (x.link.state === "stalled") return banner("danger", `${x.name} has stopped answering.`, "Actions may fail. If it does not recover soon, whatever is waiting is rejected with its name on it.", [back()]);
    return null;
  }

  function renderBanners() {
    const box = $("#accountBanners");
    box.textContent = "";
    const add = (b) => { if (b) box.appendChild(b); };
    add(linkBanner());
    const s = A.status;
    if (!s) { box.hidden = !box.childElementCount; return; }
    const alerts = s.alerts ?? [];
    alerts.forEach((a, i) => {
      const count = a.count > 1 ? ` (${a.count} times, last ${ago(a.lastAt)})` : ` (${ago(a.at)})`;
      const actions = [devicesLink()];
      if (i === alerts.length - 1) actions.push(button(alerts.length > 1 ? "I have read these" : "I have read this", "small quiet", () => { call("POST", "alerts/clear").then(refresh).catch((e) => toast(e.message, true)); }));
      add(banner("danger", ALERT_TITLE[a.kind] ?? "Security notice", `${a.message}${count} ${ALERT_ADVICE[a.kind] ?? ""}`, actions));
    });
    if (s.recoveryContested && s.hub?.lastError) add(banner("danger", "A recovery code is in question.", s.hub.lastError, [devicesLink()]));
    if (s.recoveryUnconfirmed) add(banner("", "Keep your old recovery code for now.", "This computer recovered the account. Keep the old code until another device confirms the recovery, then discard it.", [devicesLink()]));
    if (s.recoveryCodePending && A.codeHidden) add(banner("danger", "A recovery code is waiting to be saved.", "It is the only copy.", [button("Show it", "small primary", () => { A.codeHidden = false; renderGate(); renderBanners(); })]));
    for (const w of s.warnings ?? []) {
      if (A.hiddenWarnings.has(w)) continue;
      add(banner("", "", w, [button("Hide", "small quiet", () => { A.hiddenWarnings.add(w); renderBanners(); })]));
    }
    box.hidden = !box.childElementCount;
  }

  // --------------------------------------------------------------------------------------------- cards
  function renderCards() {
    const box = $("#accountCards");
    const focused = box.contains(document.activeElement) ? document.activeElement?.dataset?.key : null;
    box.textContent = "";
    const s = A.status;
    if (s?.phase === "pending") box.appendChild(newDeviceCard(s));
    if (s && fullDevice()) for (const row of A.pending) if (!row.expiresAt || row.expiresAt > Date.now()) box.appendChild(approvalCard(row, s));
    box.hidden = !box.childElementCount;
    if (focused) box.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  /** On the new device: its code, a confirm step, and a start-again only a person can press. Nothing is adopted before that. */
  function newDeviceCard(s) {
    const c = el("section", "ap-card acct-card");
    c.setAttribute("role", "status");
    const head = el("div", "ap-head");
    head.appendChild(el("span", "ap-tag", "This computer wants to join"));
    c.appendChild(head);
    const p = s.pending ?? {};
    const out = el("div", "rm-note err"); out.hidden = true;
    const again = () => button("Start again", "", (e) => acting(e.currentTarget, async () => { await call("POST", "restart-exchange"); await refresh(); }, out));
    if (p.failed) {
      c.appendChild(el("div", "ap-title", "That exchange failed, so nothing was accepted."));
      c.appendChild(el("p", "rm-note", "Press Start again here, then Review on the other device. Each failed try is visible: if this keeps happening, someone may be interfering."));
      const bar = el("div", "ap-bar"); bar.appendChild(again()); c.append(bar, out);
      return c;
    }
    if (p.confirmed) {
      c.appendChild(el("div", "ap-title", "Codes confirmed. Waiting for the other device to approve."));
      c.appendChild(el("p", "rm-note", "This computer accepts nothing until the approval comes back and checks out against the code."));
      const bar = el("div", "ap-bar"); bar.appendChild(again()); c.append(bar, out);
      return c;
    }
    if (!p.code) {
      c.appendChild(el("div", "ap-title", "Waiting for one of your devices to press Review."));
      c.appendChild(el("p", "rm-note", "Open Omni on a device already signed in to this account. A card appears there. If none is online, this waits; a recovery code is the only other way in."));
      return c;
    }
    c.appendChild(el("div", "ap-title", "Compare this code with the other screen."));
    c.appendChild(el("div", "acct-code", groupCode(p.code)));
    c.appendChild(el("p", "rm-note", "Press This matches only if the other device shows exactly these six digits. If they differ, someone may be in the middle: press Start again, and do not approve there."));
    const bar = el("div", "ap-bar");
    const yes = button("This matches", "primary", (e) => acting(e.currentTarget, async () => { await call("POST", "confirm-code", { code: p.code }); await refresh(); }, out));
    bar.append(again(), yes);
    c.append(bar, out);
    return c;
  }

  /** On a device already signed in. The name and kind are the new device's own claims, and are labelled as that. */
  function approvalCard(row, s) {
    const c = el("section", "ap-card acct-card");
    c.setAttribute("role", "alertdialog");
    c.setAttribute("aria-label", "A new device wants to join your account");
    const review = s.review?.id === row.id ? s.review : null;
    const head = el("div", "ap-head");
    head.appendChild(el("span", "ap-tag", "New sign-in"));
    if (row.expiresAt) head.appendChild(el("span", "ap-left", `expires ${new Date(row.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`));
    c.appendChild(head);
    const facts = el("dl", "acct-facts");
    const fact = (k, v) => { facts.append(el("dt", null, k), el("dd", null, v)); };
    fact("It says its name is", cleanName(row.name));
    fact("It says it is a", cleanName(row.kind, 32));
    fact("Address the hub saw", cleanName(row.ip, 64));
    c.appendChild(facts);
    const out = el("div", "rm-note err");
    const failure = A.failures.get(row.id);
    out.textContent = failure ?? "";
    out.hidden = !failure;
    const failed = (e) => { A.failures.set(row.id, explain(e)); renderCards(); };
    const denied = button("Deny", "", (e) => { const b = e.currentTarget; b.disabled = true; call("POST", "deny", { id: row.id }).then(refresh).catch((err) => { b.disabled = false; failed(err); }); });
    const bar = el("div", "ap-bar");

    if (!review) {
      const elsewhere = row.reviewedBy ? cleanName(row.reviewedBy) : null;
      if (elsewhere) c.appendChild(el("p", "rm-note", `Being reviewed on ${elsewhere}.`));
      if (row.online === false) c.appendChild(el("p", "rm-note", "That device is not online right now."));
      const start = button("Review", "primary", (e) => { const b = e.currentTarget; b.disabled = true; A.failures.delete(row.id); call("POST", "review", { id: row.id }).then(refresh).catch((err) => { b.disabled = false; failed(err); }); });
      start.disabled = !!s.review || !!elsewhere;
      bar.append(denied, start);
      c.append(bar, out);
      return c;
    }

    c.appendChild(el("div", "ap-title", "Does the new device show this code?"));
    c.appendChild(el("div", "acct-code", groupCode(review.code)));
    const choice = el("label", "acct-choice");
    const box = el("input"); box.type = "checkbox"; box.dataset.key = `full-${row.id}`; box.checked = A.fullChosen.has(row.id);
    const warn = el("p", "rm-note err", "Only for an app you installed. Choosing this for something opened in a browser gives that page full control: it could approve and remove devices.");
    warn.hidden = !box.checked;
    box.onchange = () => { if (box.checked) A.fullChosen.add(row.id); else A.fullChosen.delete(row.id); warn.hidden = !box.checked; };
    choice.append(box, el("span", null, "This is my desktop or phone app"));
    c.appendChild(choice);
    c.appendChild(warn);
    c.appendChild(el("p", "rm-note", "Left off, this is a limited web page: it can control machines for 30 days, and cannot approve or remove devices."));
    const yes = button("The codes match: approve", "primary", (e) => {
      const b = e.currentTarget; b.disabled = true; A.failures.delete(row.id);
      call("POST", "approve", { id: row.id, code: review.code, role: box.checked ? "full" : "client" })
        .then(() => { A.fullChosen.delete(row.id); toast("Device approved"); return refresh(); })
        .catch((err) => {
          b.disabled = false;
          failed(err.code === "log-conflict" ? new Error("Another device changed the device list at the same moment. Press Start again on the new device, then review again.") : err);
          refresh();
        });
    });
    bar.append(denied, yes);
    c.append(bar, out);
    return c;
  }

  // --------------------------------------------------------------------------------- the recovery code
  async function renderGate() {
    const gate = $("#accountGate");
    const s = A.status;
    if (!s?.recoveryCodePending || A.codeHidden) { gate.hidden = true; if (!s?.recoveryCodePending) { A.showing = null; A.forgetStep = false; } return; }
    // Asked each time while it is in doubt: `confirmed` is what lets the person go.
    if (!A.showing || !A.showing.confirmed) {
      try { A.showing = await call("POST", "recovery-code/show"); }
      catch (e) {
        if (e.status === 404) { A.showing = null; gate.hidden = true; return; }
        A.showing = { recoveryCode: null, confirmed: false, error: e.message };
      }
    }
    drawGate();
  }

  function drawGate() {
    const gate = $("#accountGate"), s = A.status, shown = A.showing;
    if (!shown || !s?.recoveryCodePending) return;
    gate.hidden = false;
    const box = $("#accountGateBox");
    box.textContent = "";
    box.appendChild(el("h2", "acct-gate-title", "Save your recovery code"));
    box.appendChild(el("p", "acct-only", "This is the only copy."));
    if (shown.recoveryCode) {
      box.appendChild(el("div", "acct-recovery mono", shown.recoveryCode));
      const copied = el("span", "rm-note");
      const copy = button("Copy", "", () => {
        const done = () => { copied.textContent = "Copied. Now put it somewhere safe, away from this computer."; };
        (navigator.clipboard?.writeText(shown.recoveryCode) ?? Promise.reject()).then(done).catch(() => { copied.textContent = "Could not copy: select it and copy by hand."; });
      });
      const row = el("div", "acct-gate-row"); row.append(copy, copied);
      box.appendChild(row);
    } else box.appendChild(el("p", "rm-note err", shown.error ?? "The stored code could not be opened on this computer."));
    box.appendChild(el("p", "rm-note", "With your password and this code you can get back in if you lose every device. Omni will not show it again, and nothing can issue another: a forgotten code cannot be reset by email."));
    if (s.recoveryUnconfirmed) box.appendChild(el("p", "rm-note", "You just recovered the account. Keep your old code too until another device confirms this recovery, then discard the old one."));
    const contested = !!s.recoveryContested;
    if (contested) box.appendChild(el("p", "rm-note err", s.hub?.lastError ?? "This computer cannot tell whether this code counts. Keep every recovery code you have."));
    else if (!shown.confirmed) box.appendChild(el("p", "rm-note err", "The hub has not confirmed this code yet, so it may not count yet. Keep every code you have. You can say you saved it once this settles."));

    const out = el("div", "rm-note err"); out.hidden = true;
    const bar = el("div", "ap-bar");
    bar.appendChild(button("Not now", "quiet", () => { A.codeHidden = true; gate.hidden = true; renderBanners(); }));
    if (!shown.confirmed && !A.forgetStep) bar.appendChild(button("Give up on this…", "quiet", () => { A.forgetStep = true; drawGate(); }));
    if (shown.confirmed || contested) {
      bar.appendChild(button("I saved it", "primary", (e) => acting(e.currentTarget, async () => {
        await call("POST", "recovery-code/saved");
        A.showing = null;
        await refresh();
        toast(A.status?.phase === "approved" ? "Recovery code saved. Omni no longer holds a copy." : "Omni no longer holds that code. You can sign in now.");
      }, out)));
    }
    box.append(bar, out);
    if (A.forgetStep) {
      const warn = el("div", "acct-forget");
      warn.appendChild(el("p", "rm-note err", FORGET_WARNING));
      warn.appendChild(el("p", "rm-note", "The code is still on the screen above: write it down first."));
      const row = el("div", "ap-bar");
      row.append(button("Keep it", "", () => { A.forgetStep = false; drawGate(); }), button("Delete it and forget this device", "danger", (e) => acting(e.currentTarget, async () => {
        await call("POST", "sign-out", { forget: true });
        A.showing = null; A.forgetStep = false;
        await refresh();
      }, out)));
      warn.appendChild(row);
      box.appendChild(warn);
    }
  }

  // --------------------------------------------------------------------------------- Settings → Account
  const settingsShown = () => { const b = $("#accountBody"); return b && !b.hidden && !$("#settings").hidden; };

  function section(wrap, title) {
    const s = el("section", "rm-sec");
    s.appendChild(el("h3", null, title));
    wrap.appendChild(s);
    return s;
  }
  function field(form, { label, type = "text", value = "", autocomplete, placeholder, key }) {
    const row = el("label", "acct-field");
    row.appendChild(el("span", null, label));
    const input = el("input");
    input.type = type;
    input.value = value;
    if (autocomplete) input.autocomplete = autocomplete;
    if (placeholder) input.placeholder = placeholder;
    if (key) input.dataset.key = key;
    input.spellcheck = false;
    row.appendChild(input);
    form.appendChild(row);
    return input;
  }

  function signInSection(wrap) {
    const sec = section(wrap, "Sign in");
    const seg = el("div", "dlg-tabs");
    for (const [mode, label] of [["signin", "Sign in"], ["register", "Create the account"], ["recover", "Recover"]]) {
      const b = el("button", `seg-btn${A.form.mode === mode ? " active" : ""}`, label);
      b.type = "button";
      b.onclick = () => { A.form.mode = mode; A.formNote = ""; renderSettings(true); };
      seg.appendChild(b);
    }
    sec.appendChild(seg);
    const mode = A.form.mode;
    sec.appendChild(el("p", "rm-note", mode === "signin" ? "Signing in is optional. Your password alone does not get in: a device already on the account must also approve this one, with a code you compare." : mode === "register" ? "For the first device. A forgotten password cannot be reset by email: nothing is ever mailed, and the hub never sees your password. You will get a recovery code to keep." : "If you have lost every device. You need your email, password and recovery code. You will get a new code, and every device is told."));
    const form = el("form", "rm-form");
    form.onsubmit = (e) => e.preventDefault();
    const email = field(form, { label: "Email", type: "email", value: A.form.email, autocomplete: "username", key: "email" });
    const password = field(form, { label: "Password", type: "password", autocomplete: mode === "register" ? "new-password" : "current-password", placeholder: mode === "register" ? "12 characters or more" : "", key: "password" });
    const repeat = mode === "register" ? field(form, { label: "Password again", type: "password", autocomplete: "new-password", key: "repeat" }) : null;
    const code = mode === "recover" ? field(form, { label: "Recovery code", autocomplete: "off", key: "code" }) : null;
    const name = field(form, { label: "Name for this computer", value: A.form.name || A.status?.device?.name || "", key: "name" });
    const out = el("p", "rm-note err"); out.textContent = A.formNote; out.hidden = !A.formNote;
    const go = button(mode === "signin" ? "Sign in" : mode === "register" ? "Create the account" : "Recover", "primary", (e) => acting(e.currentTarget, async () => {
      A.form.email = email.value.trim(); A.form.name = name.value.trim();
      A.formNote = ""; out.hidden = true;
      const creds = { email: A.form.email, password: password.value, name: A.form.name || undefined };
      const refuse = (text) => { A.formNote = text; out.textContent = text; out.hidden = false; };
      if (mode === "register") {
        if (password.value !== repeat.value) return refuse("The two passwords differ.");
        try { checkPassword(password.value); } catch { return refuse("The password needs at least 12 characters."); }
      }
      let done = false;
      try {
        if (mode === "register") {
          const r = await call("POST", "register", creds);
          A.note = r.resumed ? "This computer finished the earlier registration." : r.signedIn === false ? "The account exists, but signing in after it failed. Save the code, then sign in." : "";
        } else if (mode === "signin") {
          await call("POST", "sign-in", creds);
        } else {
          const r = await call("POST", "recover", { ...creds, recoveryCode: code.value.trim() });
          if (r.alreadyOnLog) A.note = r.codeUsed === false ? "This computer was already on the account, so the code you typed was not checked and not used. Keep it." : "This computer was already on the account.";
          else if (r.confirmed === false) A.note = "Recovery sent, but the hub has not confirmed it. Keep both codes, the old and the new, until it settles.";
          else A.note = "Recovered. Keep your old code until another device confirms this recovery, then discard it.";
        }
        done = true;
      } catch (error) {
        refuse(explain(error));
      }
      // Whichever way it went: a failed registration may still hold a code that has to be shown.
      await refresh();
      if (done) renderSettings(true);
      return undefined;
    }));
    form.appendChild(go);
    form.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
    sec.append(form, out);
  }

  function devicesSection(wrap) {
    const sec = section(wrap, "Devices");
    const list = el("div", "acct-devices");
    list.appendChild(el("p", "rm-note", "Loading…"));
    sec.appendChild(list);
    call("GET", "devices").then(({ devices }) => {
      list.textContent = "";
      for (const d of devices) {
        const row = el("div", "acct-device");
        const main = el("div", "acct-device-main");
        const top = el("div");
        top.append(el("span", `machine-dot${d.online || d.self ? " live" : ""}`), el("b", null, cleanName(d.name)));
        if (d.self) top.appendChild(el("span", "acct-self", "this computer"));
        main.appendChild(top);
        const role = d.role === "full" ? "full control" : "limited web page";
        main.appendChild(el("div", "acct-device-sub", [cleanName(d.kind, 32), role, shortId(d.id), d.addedAt ? `added ${when(d.addedAt)}` : "", d.expiresAt ? `ends ${when(d.expiresAt)}` : ""].filter(Boolean).join(" · ")));
        row.appendChild(main);
        if (fullDevice()) {
          const rm = button("Remove", "small", (e) => {
            const name = cleanName(d.name);
            const text = d.self
              ? `Remove THIS computer from the account?\n\nIt loses access to your other machines straight away, and they lose access to it. It needs a new approval to come back, and if it is your only full device you will need your recovery code.`
              : `Remove "${name}" from the account?\n\nIt is cut off from every machine as soon as each sees the new list.`;
            if (!window.confirm(text)) return;
            acting(e.currentTarget, async () => { await call("POST", "remove", { id: d.id }); toast(`${name} removed`); await refresh(); renderSettings(true); }).catch((err) => toast(explain(err), true));
          });
          row.appendChild(rm);
        }
        list.appendChild(row);
      }
    }).catch((e) => { list.textContent = e.message; });
  }

  function passwordSection(wrap) {
    const sec = section(wrap, "Change the password");
    sec.appendChild(el("p", "rm-note", "It changes how you sign in, and nothing else: no device has to be approved again."));
    const form = el("form", "rm-form");
    form.onsubmit = (e) => e.preventDefault();
    const current = field(form, { label: "Current password", type: "password", autocomplete: "current-password", key: "pw-current" });
    const next = field(form, { label: "New password", type: "password", autocomplete: "new-password", placeholder: "12 characters or more", key: "pw-next" });
    const again = field(form, { label: "New password again", type: "password", autocomplete: "new-password", key: "pw-again" });
    const out = el("p", "rm-note err"); out.hidden = true;
    form.appendChild(button("Change password", "primary", (e) => acting(e.currentTarget, async () => {
      if (next.value !== again.value) throw new Error("The two passwords differ.");
      try { checkPassword(next.value); } catch { throw new Error("The password needs at least 12 characters."); }
      await call("POST", "password", { current: current.value, next: next.value });
      current.value = next.value = again.value = ""; out.hidden = true;
      toast("Password changed");
    }, out)));
    sec.append(form, out);
  }

  function recoverySection(wrap, s) {
    const sec = section(wrap, "Recovery");
    sec.appendChild(el("p", "rm-note", "Your recovery code, with your password, gets you back in if you lose every device. Omni does not keep it once you say you saved it, and cannot show it again."));
    if (s.recoveryUnconfirmed) sec.appendChild(el("p", "rm-note err", "Keep your old recovery code until another device confirms this recovery, then discard it."));
    if (s.recoveryContested && s.hub?.lastError) sec.appendChild(el("p", "rm-note err", s.hub.lastError));
    if (s.recoveryCodePending) sec.appendChild(button("Show the waiting code", "", () => { A.codeHidden = false; renderGate(); renderBanners(); }));
    if (s.recoveries?.length) {
      sec.appendChild(el("p", "rm-note", "This account has been recovered:"));
      for (const r of s.recoveries) sec.appendChild(el("div", "acct-device-sub", `${when(r.addedAt)} · ${cleanName(r.name)} · ${cleanName(r.kind, 32)} · ${shortId(r.signPub)}`));
    }
  }

  function webAccessSection(wrap, s) {
    const sec = section(wrap, "Allow web page access");
    const row = el("label", "acct-choice");
    const box = el("input"); box.type = "checkbox"; box.checked = !!s.allowWebAccess; box.dataset.key = "web-access";
    box.onchange = () => { const want = box.checked; box.disabled = true; call("POST", "settings", { allowWebAccess: want }).then(refresh).catch((e) => { box.checked = !want; toast(explain(e), true); }).finally(() => { box.disabled = false; }); };
    row.append(box, el("span", null, "Let limited web pages control this computer"));
    sec.appendChild(row);
    sec.appendChild(el("p", "rm-note", "The web page comes from the hub, so a hacked hub could change it. Turned off, this computer refuses web pages, and only your desktop and phone apps can reach it."));
  }

  function auditSection(wrap) {
    const sec = section(wrap, "What other devices did here");
    const list = el("div", "acct-audit");
    list.appendChild(el("p", "rm-note", "Loading…"));
    const load = () => call("GET", "audit?limit=200").then(({ lines }) => {
      list.textContent = "";
      if (!lines.length) list.appendChild(el("p", "rm-note", "Nothing yet."));
      for (const l of lines) {
        const row = el("div", "acct-audit-row");
        row.append(el("span", "acct-audit-when", when(l.at)), el("span", "acct-audit-who", cleanName(l.deviceName)), el("span", "acct-audit-method mono", cleanName(l.method, 8)), el("span", "acct-audit-path mono", cleanName(l.path, 300)));
        list.appendChild(row);
      }
    }).catch((e) => { list.textContent = e.message; });
    load();
    sec.append(list, button("Refresh", "small", load));
  }

  function renderSettings(force = false) {
    const body = $("#accountBody");
    // A password half typed is not thrown away because some news arrived, and news that changes nothing here redraws nothing.
    const a = document.activeElement;
    const typing = (body.contains(a) && a?.tagName === "INPUT" && a.type !== "checkbox") || [...body.querySelectorAll('input[type="password"]')].some((i) => i.value);
    const s0 = A.status;
    const key = JSON.stringify([A.available, s0?.phase, s0?.email, s0?.device?.role, s0?.hub?.connected, s0?.hub?.lastError, s0?.allowWebAccess, s0?.recoveries?.length, s0?.recoveryUnconfirmed, s0?.recoveryContested, s0?.recoveryCodePending, A.note]);
    if (!force && (typing || key === A.settingsKey)) return;
    A.settingsKey = key;
    body.textContent = "";
    const wrap = el("div", "rm-wrap");
    body.appendChild(wrap);
    if (A.available === false) {
      const sec = section(wrap, "This needs the desktop app");
      sec.appendChild(el("p", "rm-note", "Accounts, approvals and your other machines work only in the Omni desktop window, because only it holds this computer's account token. Everything else here works as usual."));
      sec.appendChild(el("p", "rm-note", A.why));
      return;
    }
    const s = A.status;
    if (!s) { wrap.appendChild(el("p", "rm-note", "Loading…")); return; }

    const here = section(wrap, "This device");
    here.appendChild(el("p", "rm-note", PHASE_TEXT[s.phase] ?? s.phase));
    if (s.email) here.appendChild(el("div", "acct-device-sub", cleanName(s.email, 254)));
    if (s.device) here.appendChild(el("div", "acct-device-sub", `${cleanName(s.device.name)} · ${cleanName(s.device.kind, 32)} · ${s.device.role === "full" ? "full control" : s.device.role === "client" ? "limited web page" : "not on an account"} · ${shortId(s.device.id)}`));
    here.appendChild(el("div", "acct-device-sub", `Hub: ${cleanName(s.hub?.url, 200)} · ${s.hub?.connected ? "connected" : "not connected"}`));
    if (s.hub?.lastError) here.appendChild(el("p", "rm-note err", s.hub.lastError));
    if (A.note) here.appendChild(el("p", "rm-note", A.note));

    const signedOutLike = ["signed-out", "denied", "expired"].includes(s.phase);
    if (signedOutLike) signInSection(wrap);
    if (["approved", "recovering"].includes(s.phase)) devicesSection(wrap);
    if (fullDevice()) passwordSection(wrap);
    if (s.phase !== "signed-out" || s.recoveries?.length || s.recoveryCodePending) recoverySection(wrap, s);
    if (s.phase === "approved") webAccessSection(wrap, s);
    if (s.phase === "approved") auditSection(wrap);

    const leave = section(wrap, "Leave");
    if (s.phase === "removed") leave.appendChild(el("p", "rm-note", "To join the account again, forget this device, then sign in as new."));
    const row = el("div", "acct-gate-row");
    if (s.signedIn) row.appendChild(button("Sign out", "", (e) => {
      if (!window.confirm("Sign out on this computer?\n\nOther machines lose it until you sign in again. It stays on the device list.")) return;
      acting(e.currentTarget, async () => { await call("POST", "sign-out", {}); await refresh(); renderSettings(true); }).catch((err) => toast(explain(err), true));
    }));
    row.appendChild(button("Forget this device", "quiet", (e) => {
      const warn = s.recoveryCodePending ? FORGET_WARNING : "This deletes this device's identity and its copy of the device list. It would have to be approved again as a new device.";
      if (s.recoveryCodePending) { A.codeHidden = false; A.forgetStep = true; renderGate(); return; }
      if (!window.confirm(`Forget this device?\n\n${warn}`)) return;
      acting(e.currentTarget, async () => { await call("POST", "sign-out", { forget: true }); await refresh(); renderSettings(true); }).catch((err) => toast(explain(err), true));
    }));
    leave.appendChild(row);

    const hub = section(wrap, "What the hub can and cannot see");
    hub.appendChild(el("p", "rm-note", HUB_SEES));
  }

  return {
    init,
    openMenu() { const menu = $("#machineMenu"); if (menu.hidden) renderMachineMenu(); menu.hidden = !menu.hidden; },
    renderSettings: () => renderSettings(true),
    /** The chosen machine could not give the page its first state. */
    machineDown(message) { A.machineDown = message; renderBanners(); },
    machineUp() { A.machineDown = null; renderBanners(); },
    get isRemote() { return isRemote(); },
  };
}
