/* The account, in the window: the machine switcher, Settings → Account, approval cards, the new device's code, the recovery
   code screen and the security banners. All of it is about this computer's account, whichever machine the window is on, so
   it talks to this computer's server only (transport's `local`).
   Everything a device or the hub supplies is shown as text, through cleanName: device names are hostile input. */
import { el, ago, copyText } from "./lib.js";
import { ORDINARY_DROP } from "./hub-socket.js";
import { checkPassword } from "./account-core.js";
import { cleanName, isRemote, local, machine, onPhone, onStillWaiting, setMachine, webPage } from "./transport.js";

const NOTICE_KEY = "omni.machineNotice";
const HUB_SEES = "The hub routes encrypted frames between your devices. It cannot read your actions, results, file contents, chat text or session titles, and it cannot forge an action. It can still see which devices are on the account, when they connect, IP addresses and the size and timing of frames, plus your email address and login verifiers. Someone who hacked the hub could try to guess your password offline; a correct guess only gets a pending sign-in, which one of your devices must still approve.";
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
  "approval-failed": "Nothing was approved. Press Start again on the new device, then Get a new code on the device already signed in.",
  "hub-says-removed": "This is the hub's claim, not a fact this computer could check. Sign in again to see.",
  "key-unavailable": "This computer's device key could not be opened. Local use still works.",
  "bad-anchor": "Try again later. If this repeats, the server may have been tampered with. Do not sign in on it until you know why.",
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
  "bad-anchor": "The server could not prove it holds your account",
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

/**
 * The one place these texts become a web page's. A page is not a computer, and has nothing that works on its own. As it stands on a
 * desktop or a phone.
 */
export function deviceWords(text) {
  if (!webPage()) return text;
  const what = onPhone() ? "phone" : "page";
  return String(text)
    .replace(/ It still works on its own\.| Local use still works\.| This computer works on its own as usual\.|, and this computer still works on its own/g, "")
    .replace("Check the hub address in this computer's settings.", onPhone() ? "The hub this app talks to is set when it is built." : "Check the address of this page.")
    .replace(/\bThis computer\b/g, `This ${what}`)
    .replace(/\bthis computer\b/g, `this ${what}`);
}

/** What to do about an alert. */
export const alertAdvice = (kind) => deviceWords(ALERT_ADVICE[kind] ?? "");

/** What a phase means to the person. */
export const phaseText = (phase) => deviceWords(PHASE_TEXT[phase] ?? phase);

/**
 * The banner's words when the hub is gone, naming why if the account knows. Only with no reason known does it promise a reconnect:
 * a page another tab has replaced will not reconnect at all.
 */
export function hubLostText(status) {
  const hub = status?.hub ?? {};
  const nothing = "Nothing you send now will arrive, and nothing is queued.";
  // The connection's own reason: a contested recovery code has its own banner, with its own words.
  const why = hub.connectionError;
  if (hub.gaveUp) return `${why ?? deviceWords("this computer has lost the hub.")} ${nothing}`;
  if (why && !ORDINARY_DROP.has(why)) return `${why} ${nothing}`;
  return deviceWords(`this computer has lost the hub. ${nothing}${hub.reconnecting ? " It reconnects by itself." : ""}`);
}

/** The banner's title, unless the message already opens with those words. */
export function alertTitle(alert) {
  const title = deviceWords(ALERT_TITLE[alert.kind] ?? "Security notice");
  return String(alert.message ?? "").startsWith(title) ? "" : title;
}

/**
 * When to ask the server for the stored code again, which decrypts it: only when something about it can have changed. The
 * log head is here because a code settles by a log being adopted, with no other field moving: without it, "I saved it" would
 * stay hidden after the hub confirmed.
 */
export const gateKey = (s) => JSON.stringify([s?.recoveryCodePending, s?.recoveryContested, s?.logHead]);

/** Whether the chosen machine's link is down, and whether this news means it just came back. Pure, so it can be tested. */
export function linkNews(wasDown, row, hubConnected) {
  const down = !hubConnected || !row || !row.online || row.link?.state === "offline" || row.link?.state === "stalled";
  return { down: down || (wasDown && row?.link?.state !== "open"), reconnected: wasDown && !down && row?.link?.state === "open" };
}

const groupCode = (code) => String(code ?? "").replace(/(\d{3})(\d{3})/, "$1 $2");

/** The one sentence on every approval: comparing is not forced, so it asks, calmly, for a glance. */
export const GLANCE = "Check that the new device shows the same code before you approve.";

/**
 * The two ways to approve, in the order to show them. What the new device says it is only orders and highlights them: either
 * one is a tap away, and a device that says it is a web page is never offered full control first.
 */
export function roleChoices(kind) {
  const app = { role: "full", label: "Approve as an app (full control)" };
  const page = { role: "client", label: "Approve as a web page (limited)" };
  const saysApp = kind === "desktop" || kind === "phone" || kind === "iphone";
  return saysApp ? [{ ...app, primary: true }, { ...page, primary: false }] : [{ ...page, primary: true }, { ...app, primary: false }];
}

/** Whether the window shows the first-run screen: never on a page, never when this computer's account is off, and never again once chosen. */
export function showWelcome(status, { available, closed, flow }) {
  if (webPage() || !available || !status || closed) return false;
  return !!status.firstRun || (!!flow && ["pending", "signed-out", "denied", "expired"].includes(status.phase));
}

/** Why a window has no account, in the person's words. `code` is the server's: see WindowGate.refusalCode. */
export function noAccountText(code) {
  if (code === "no-window") return "This server was started without its window, so signing in is off here. Everything else works. To sign in, close Omni Agent and open it again.";
  if (code === "other-window") return "Another Omni window holds this computer's sign-in. Use that window, or close every Omni window and open Omni again. Everything else works here.";
  return "Signing in works only in the Omni window on this computer. Everything else works here.";
}

/**
 * The sign-in surface, the same on the desktop's first-run screen and on the web page. Plain words only.
 *   modes        which tabs: "signin", and on a desktop "create"
 *   mode         the one showing
 *   needsInvite  creating an account needs an invite code (false on the computer that holds the first account's token)
 *   form         {email, name, invite}, kept between redraws
 *   nameLabel    "Name for this computer" or "Name for this page"
 *   error, note  text to show
 *   onMode(mode), onSubmit(mode, values): a promise; it shows its own errors
 *   footer       nodes under the form
 */
export function signInSurface({ title, intro, modes = ["signin"], mode = "signin", needsInvite = true, form = {}, nameLabel, error = "", note = "", onMode, onSubmit, footer = [] }) {
  const card = el("section", "welcome-card");
  const brand = el("div", "welcome-brand brand");
  brand.append(el("span", "mark"), el("span", "word", "Omni Agent"));
  card.appendChild(brand);
  card.appendChild(el("h1", "welcome-title", title));
  if (intro) card.appendChild(el("p", "rm-note", intro));
  if (modes.length > 1) {
    const tabs = el("div", "welcome-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [key, label] of [["signin", "Sign in"], ["create", "Create an account"]].filter(([key]) => modes.includes(key))) {
      const b = el("button", `seg-btn${mode === key ? " active" : ""}`, label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(mode === key));
      b.onclick = () => onMode?.(key);
      tabs.appendChild(b);
    }
    card.appendChild(tabs);
  }
  const creating = mode === "create";
  const f = el("form", "rm-form welcome-form");
  f.onsubmit = (e) => e.preventDefault();
  const input = (label, { type = "text", value = "", autocomplete, key, placeholder }) => {
    const row = el("label", "acct-field");
    row.appendChild(el("span", null, label));
    const i = el("input");
    i.type = type;
    i.value = value;
    i.dataset.key = key;
    if (autocomplete) i.autocomplete = autocomplete;
    if (placeholder) i.placeholder = placeholder;
    i.spellcheck = false;
    row.appendChild(i);
    f.appendChild(row);
    return i;
  };
  const invite = creating && needsInvite ? input("Invite code", { value: form.invite ?? "", autocomplete: "off", key: "invite", placeholder: "XXXX-XXXX-XXXX-XXXX" }) : null;
  const email = input("Email", { type: "email", value: form.email ?? "", autocomplete: "username", key: "email" });
  const password = input("Password", { type: "password", autocomplete: creating ? "new-password" : "current-password", key: "password", placeholder: creating ? "12 characters or more" : "" });
  const repeat = creating ? input("Password again", { type: "password", autocomplete: "new-password", key: "repeat" }) : null;
  const name = input(nameLabel, { value: form.name ?? "", key: "name" });
  const out = el("p", "rm-note err");
  out.textContent = error;
  out.hidden = !error;
  const go = el("button", "btn primary welcome-go", creating ? "Create the account" : "Sign in");
  go.type = "button";
  go.onclick = async () => {
    out.hidden = true;
    const values = { email: email.value.trim(), password: password.value, repeat: repeat?.value, name: name.value.trim(), invite: invite?.value.trim() };
    if (creating && values.password !== values.repeat) { out.textContent = "The two passwords differ."; out.hidden = false; return; }
    if (creating) { try { checkPassword(values.password); } catch { out.textContent = "The password needs at least 12 characters."; out.hidden = false; return; } }
    if (creating && needsInvite && !values.invite) { out.textContent = "Type the invite code you were given."; out.hidden = false; return; }
    go.disabled = true;
    const was = go.textContent;
    go.textContent = creating ? "Creating…" : "Signing in…";
    try { await onSubmit(mode, values); } finally { go.disabled = false; go.textContent = was; }
  };
  f.appendChild(go);
  f.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
  card.append(f, out);
  if (note) card.appendChild(el("p", "rm-note", note));
  for (const node of footer) if (node) card.appendChild(node);
  return card;
}
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

export function explain(e) {
  if (e.code === "locked") return "Too many tries. The lock is temporary, so wait a while and try again.";
  if (e.code === "hub-unreachable") return deviceWords(`The hub cannot be reached. ${e.message} Nothing here changed, and this computer still works on its own.`);
  return e.message;
}

/**
 * `choose(id, name)` takes the window to a machine (null: this computer), and says whether it went; `onMachines(list, status)`
 * hears every change to the account's machines; `retry()` loads the focused machine again after it failed.
 */
export function createAccount({ toast, openSettings, choose = (id, name) => setMachine(id, { name }), onMachines = () => {}, retry = () => {} }) {
  const $ = (s) => document.querySelector(s);
  const A = {
    available: null, why: "", status: null, pending: [], machines: [],
    fullChosen: new Set(), failures: new Map(), showing: null, codeHidden: false, forgetStep: false,
    form: { mode: "signin", email: "", name: "" }, formNote: "", hiddenWarnings: new Set(), machineDown: null, note: "",
    whyCode: null, autoReviewed: new Set(), reviewing: new Set(),
    welcome: { mode: "signin", form: { email: "", name: "", invite: "" }, error: "", flow: false, closed: false, busy: false },
  };
  let events = null;
  let tick = null;

  const call = (method, path, body) => local.api(method, `/api/account/${path}`, body);
  // A web page never approves or removes anything, whatever the log or the page itself may say of it. The log is the real limit.
  const fullDevice = () => !webPage() && A.status?.phase === "approved" && A.status?.device?.role === "full";
  /** A web page has no computer of its own: its way back is the list of machines. */
  const here = () => (webPage() ? "Your machines" : "This computer");
  const backText = () => (webPage() ? "All machines" : "Back to this computer");
  const hereWords = () => deviceWords("this computer");

  // ---------------------------------------------------------------------------------- loading and news
  async function refresh() {
    try {
      A.status = await call("GET", "status");
      A.available = true;
    } catch (e) {
      A.available = false;
      A.why = e.message;
      A.whyCode = e.code ?? null;
      A.status = null;
    }
    if (A.available) {
      const [approvals, machines] = await Promise.allSettled([call("GET", "approvals"), call("GET", "machines")]);
      if (approvals.status === "fulfilled") A.pending = approvals.value.pending;
      if (machines.status === "fulfilled") A.machines = machines.value.machines;
    }
    renderAll();
  }

  /** A link back up is good news, said once and quietly. Down stays red in the banner: pending actions will fail. */
  function noteLink() {
    const m = machine();
    if (!m || !A.status) return;
    const news = linkNews(A.linkDown, A.machines.find((x) => x.id === m.id), !!A.status.hub?.connected);
    A.linkDown = news.down;
    // Only a link that was up on this page comes back: one still opening as the page starts is not news.
    if (news.reconnected && A.linkWasUp) toast(`Reconnected to ${m.name}`);
    if (!news.down) A.linkWasUp = true;
  }

  function listen() {
    if (events || !A.available) return;
    events = local.eventSource("/api/account/events");
    const on = (name, fn) => events.addEventListener(name, (m) => { let data; try { data = JSON.parse(m.data); } catch { return; } fn(data); renderAll(); });
    on("status", (s) => { A.status = s; noteLink(); });
    on("approval", (list) => { A.pending = list; });
    on("links", (list) => { A.machines = list; noteLink(); });
    on("devices", () => { call("GET", "machines").then((r) => { A.machines = r.machines; renderAll(); }).catch(() => {}); if (settingsShown()) renderSettings(true); });
    on("alert", () => {});
    // After a drop the browser reconnects by itself, and the stream's first message is the status.
    events.onerror = () => { if (events?.readyState === 2) { events = null; setTimeout(() => { listen(); }, 5000); } };
  }

  async function init() {
    onStillWaiting((count) => { A.stillWaiting = count > 0; renderBanners(); });
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
    if (webPage()) return; // a page has no computer to come back to: its list says which machines are there
    const signedOut = !A.available || !A.status || A.status.phase !== "approved";
    const known = A.machines.find((x) => x.id === m.id);
    if (signedOut || !known) {
      if (choose(null, null, { whenClean: true })) toast(deviceWords(`This window was on ${m.name}, which ${signedOut ? "this computer can no longer reach without signing in" : "is no longer on the account"}. It is back on this computer.`), true);
    }
  }

  function renderAll() {
    onMachines(A.available && A.status?.phase === "approved" ? A.machines : [], A.status);
    renderMachine();
    renderBanners();
    renderCards();
    renderGate();
    renderWelcome();
    if (settingsShown()) renderSettings();
  }

  // ---------------------------------------------------------------------------------- the first run
  /** Over the app until the person chooses. Nothing on it waits for the hub: "Continue without an account" only writes here. */
  function renderWelcome() {
    let box = document.getElementById("accountWelcome");
    const W = A.welcome;
    const show = showWelcome(A.status, { available: A.available, closed: W.closed, flow: W.flow });
    if (!show) { if (box) box.hidden = true; return; }
    if (!box) {
      box = el("div", "modal welcome");
      box.id = "accountWelcome";
      document.body.appendChild(box);
    }
    box.hidden = false;
    // A half-typed password is not thrown away because some news arrived.
    const a = document.activeElement;
    if (W.busy || (box.contains(a) && a?.tagName === "INPUT")) return;
    const key = JSON.stringify([A.status.phase, A.status.pending?.code, A.status.pending?.failed, A.status.canCreateFirst, W.mode, W.error]);
    if (key === W.drawn && box.childElementCount) return;
    W.drawn = key;
    box.textContent = "";
    const s = A.status;
    if (s.phase === "pending") { box.appendChild(welcomeWaiting(s)); return; }
    const later = el("button", "btn quiet welcome-local", "Continue without an account");
    later.type = "button";
    later.onclick = () => acting(later, async () => {
      await call("POST", "welcome", { choice: "local" });
      W.closed = true;
      await refresh();
    }, null).catch((e) => { W.error = e.message; W.drawn = null; renderWelcome(); });
    const why = s.hub?.lastError && W.flow ? s.hub.lastError : "";
    box.appendChild(signInSurface({
      title: "Welcome to Omni Agent",
      intro: "Sign in to reach your other computers from here. Without an account, everything still works on this computer.",
      modes: ["signin", "create"],
      mode: W.mode,
      needsInvite: !s.canCreateFirst,
      form: W.form,
      nameLabel: "Name for this computer",
      error: W.error || why,
      note: W.mode === "create" ? (s.canCreateFirst ? "This computer can create the first account. You will get a recovery code to keep." : "You need an invite code from the person who runs your Omni server. You will get a recovery code to keep.") : "A new computer is approved from one you already use.",
      onMode: (mode) => { W.mode = mode; W.error = ""; W.drawn = null; renderWelcome(); },
      onSubmit: welcomeSubmit,
      footer: [el("div", "welcome-or"), later],
    }));
  }

  async function welcomeSubmit(mode, values) {
    const W = A.welcome;
    W.form = { email: values.email, name: values.name, invite: values.invite ?? "" };
    W.error = "";
    W.busy = true;
    const creds = { email: values.email, password: values.password, name: values.name || undefined };
    try {
      if (mode === "create") {
        await call("POST", "register", { ...creds, ...(values.invite ? { inviteCode: values.invite } : {}) });
        W.closed = true; // the recovery code's screen comes next, over everything
      } else {
        await call("POST", "sign-in", creds);
        W.flow = true;
      }
    } catch (e) {
      W.error = welcomeError(e);
    } finally {
      W.busy = false;
      W.drawn = null;
    }
    await refresh();
  }

  /** The hub's own words, with "hub" left out of the way in: on this screen it is Omni's sign-in server. */
  function welcomeError(e) {
    if (e.code === "hub-unreachable") return "Omni's sign-in server cannot be reached right now. Try again later, or continue without an account.";
    if (e.code === "locked") return "Too many tries. Wait a while, then try again.";
    return String(e.message ?? e).replace(/\bThe hub\b/g, "The server").replace(/\bthe hub\b/g, "the server");
  }

  function welcomeWaiting(s) {
    const W = A.welcome;
    const c = el("section", "welcome-card");
    const brand = el("div", "welcome-brand brand");
    brand.append(el("span", "mark"), el("span", "word", "Omni Agent"));
    c.appendChild(brand);
    const p = s.pending ?? {};
    c.appendChild(el("h1", "welcome-title", "Approve this computer"));
    if (p.failed) {
      c.appendChild(el("p", "rm-note err", "That try did not go through, so nothing was approved. Press Try again here, then look at your other device."));
    } else if (p.code) {
      c.appendChild(el("p", "rm-note", "A card has appeared on a computer where you are already signed in. Approve it there. It shows this same code."));
      c.appendChild(el("div", "acct-code", groupCode(p.code)));
    } else if (p.confirmed) {
      c.appendChild(el("p", "rm-note", "Waiting for your other device to approve."));
    } else {
      c.appendChild(el("p", "rm-note", "Open Omni on a computer where you are already signed in. A card appears there, and a code appears here."));
      if (!s.hub?.connected) c.appendChild(el("p", "rm-note", "Connecting…"));
    }
    const out = el("p", "rm-note err"); out.hidden = true;
    const bar = el("div", "ap-bar");
    if (p.failed || p.code) bar.appendChild(button(p.failed ? "Try again" : "The codes differ", p.failed ? "primary" : "quiet", (e) => acting(e.currentTarget, async () => { await call("POST", "restart-exchange"); await refresh(); }, out)));
    bar.appendChild(button("Do this later", "quiet", () => { W.closed = true; renderWelcome(); }));
    c.append(bar, out);
    return c;
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
      btn.title = deviceWords(`What you see and send here runs on ${m.name} (${shortId(m.id)})${webPage() ? "" : ", not on this computer"}. Choose another machine to start a chat there.`);
      $("#machineId").textContent = shortId(m.id);
      $("#machineId").hidden = false;
    } else {
      name.textContent = here();
      btn.title = "Choose a machine to start a chat on";
      $("#machineId").hidden = true;
    }
    $("#machineBack").hidden = !m || webPage();
    $("#machineBack").textContent = backText();
    if (!$("#machineMenu").hidden) renderMachineMenu();
  }

  function renderMachineMenu() {
    const menu = $("#machineMenu"), m = machine();
    menu.textContent = "";
    if (!webPage()) {
      const local_ = el("button", m ? "" : "on", here());
      local_.onclick = () => { menu.hidden = true; choose(null, null); };
      menu.appendChild(local_);
    }
    if (A.machines.length) menu.appendChild(el("div", "mh", webPage() ? "Start a chat on" : "Your other machines"));
    for (const x of A.machines) {
      const refusing = x.link?.state === "refusing";
      const row = el("button", `machine-row${m?.id === x.id ? " on" : ""}`);
      row.append(el("span", `machine-dot${x.online && !refusing ? " live" : ""}`), el("span", "machine-row-name", x.name), el("span", "machine-row-id", shortId(x.id)), el("span", "machine-row-state", !x.online ? "offline" : refusing ? "refuses web pages" : ""));
      row.disabled = !x.online || refusing;
      row.title = !x.online ? `${x.name} is offline` : refusing ? `${x.name} has Allow web page access off` : `Start a chat on ${x.name}`;
      row.onclick = () => { menu.hidden = true; choose(x.id, x.name); };
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
    for (const a of actions) if (a) row.appendChild(a);
    b.appendChild(row);
    return b;
  }
  const devicesLink = () => button("Devices", "small", () => openSettings());

  function linkBanner() {
    const m = machine();
    if (!m) return null;
    const back = () => (webPage() ? null : button(backText(), "small", () => choose(null, null)));
    if (A.machineDown) return banner("danger", `Could not load ${m.name}.`, A.machineDown, [button("Try again", "small", () => retry()), back()]);
    if (!A.status?.hub?.connected) return banner("danger", `${m.name} cannot be reached.`, hubLostText(A.status), [back()]);
    const x = A.machines.find((y) => y.id === m.id);
    if (!x) return null;
    if (!x.online || x.link.state === "offline") return banner("danger", `${x.name} is offline.`, "Nothing you send will reach it, and nothing is queued for later.", [back()]);
    if (x.link.state === "stalled") return banner("danger", `${x.name} has stopped answering.`, "Actions may fail. If it does not recover soon, whatever is waiting is rejected with its name on it.", [back()]);
    if (x.link.state === "refusing") return banner("danger", `${x.name} does not let web pages in.`, `Allow web page access is off on ${x.name}. Nothing is sent to it from this page.`, [back()]);
    return null;
  }

  function renderBanners() {
    const box = $("#accountBanners");
    box.textContent = "";
    const add = (b) => { if (b) box.appendChild(b); };
    add(linkBanner());
    if (A.stillWaiting && machine()) add(banner("", "", `Still waiting for ${machine().name}...`));
    const s = A.status;
    if (!s) { box.hidden = !box.childElementCount; return; }
    const alerts = s.alerts ?? [];
    alerts.forEach((a, i) => {
      const count = a.count > 1 ? ` (${a.count} times, last ${ago(a.lastAt)})` : ` (${ago(a.at)})`;
      const actions = [devicesLink()];
      if (i === alerts.length - 1) actions.push(button(alerts.length > 1 ? "I have read these" : "I have read this", "small quiet", () => { call("POST", "alerts/clear").then(refresh).catch((e) => toast(e.message, true)); }));
      add(banner("danger", alertTitle(a), `${a.message}${count} ${alertAdvice(a.kind)}`, actions));
    });
    if (s.recoveryContested && s.hub?.lastError) add(banner("danger", "A recovery code is in question.", s.hub.lastError, [devicesLink()]));
    if (s.recoveryUnconfirmed) add(banner("", "Keep your old recovery code for now.", deviceWords("This computer recovered the account. Keep the old code until another device confirms the recovery, then discard it."), [devicesLink()]));
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
    // The first-run screen shows the same code itself, over everything.
    const welcomeUp = showWelcome(s, { available: A.available, closed: A.welcome.closed, flow: A.welcome.flow });
    if (s?.phase === "pending" && !welcomeUp) box.appendChild(newDeviceCard(s));
    if (s && fullDevice()) for (const row of A.pending) if (!row.expiresAt || row.expiresAt > Date.now()) box.appendChild(approvalCard(row, s));
    box.hidden = !box.childElementCount;
    if (focused) box.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  /** On the new device: its code, and a start-again only a person can press. There is nothing to confirm here. */
  function newDeviceCard(s) {
    const c = el("section", "ap-card acct-card");
    c.setAttribute("role", "status");
    const head = el("div", "ap-head");
    head.appendChild(el("span", "ap-tag", deviceWords("This computer wants to join")));
    c.appendChild(head);
    const p = s.pending ?? {};
    const out = el("div", "rm-note err"); out.hidden = true;
    const again = (label = "Start again", cls = "") => button(label, cls, (e) => acting(e.currentTarget, async () => { await call("POST", "restart-exchange"); await refresh(); }, out));
    if (p.failed) {
      c.appendChild(el("div", "ap-title", "That try did not go through, so nothing was approved."));
      c.appendChild(el("p", "rm-note", "Press Start again here, then look at your other device. Each failed try is visible. If this keeps happening, someone may be interfering."));
      const bar = el("div", "ap-bar"); bar.appendChild(again("Start again", "primary")); c.append(bar, out);
      return c;
    }
    if (p.code) {
      c.appendChild(el("div", "ap-title", "Approve it on your other device"));
      c.appendChild(el("div", "acct-code", groupCode(p.code)));
      c.appendChild(el("p", "rm-note", "Your other device shows this same code. If it shows a different one, do not approve there, and press The codes differ."));
      const bar = el("div", "ap-bar"); bar.appendChild(again("The codes differ", "quiet")); c.append(bar, out);
      return c;
    }
    if (p.confirmed) {
      c.appendChild(el("div", "ap-title", "Waiting for your other device to approve."));
      const bar = el("div", "ap-bar"); bar.appendChild(again("Start again", "quiet")); c.append(bar, out);
      return c;
    }
    c.appendChild(el("div", "ap-title", "Waiting for one of your devices."));
    c.appendChild(el("p", "rm-note", "Open Omni on a device already signed in to this account. A card appears there, and a code appears here."));
    return c;
  }

  /** Starts the exchange by itself, once per sign-in, so that the code is on both screens before anyone presses anything. */
  function startReview(row) {
    A.reviewing.add(row.id);
    A.failures.delete(row.id);
    call("POST", "review", { id: row.id })
      .catch((err) => { A.failures.set(row.id, explain(err)); })
      .finally(() => { A.reviewing.delete(row.id); refresh(); });
  }

  /**
   * On a device already signed in. The name and kind are the new device's own claims, and are labelled as that. One tap approves,
   * and that tap is also the choice of what the device may do: the claim only decides which choice comes first.
   */
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
    fact("It says its name is", cleanName(review?.name ?? row.name));
    fact("It says it is a", cleanName(review?.kind ?? row.kind, 32, "unknown"));
    fact("From address", cleanName(row.ip, 64, "unknown"));
    c.appendChild(facts);
    const out = el("div", "rm-note err");
    const failure = A.failures.get(row.id);
    out.textContent = failure ?? "";
    out.hidden = !failure;
    const failed = (e) => { A.failures.set(row.id, explain(e)); renderCards(); };
    const denied = button("Deny", "quiet", (e) => { const b = e.currentTarget; b.disabled = true; call("POST", "deny", { id: row.id }).then(refresh).catch((err) => { b.disabled = false; failed(err); }); });
    const bar = el("div", "ap-bar");

    if (!review) {
      const elsewhere = row.reviewedBy ? cleanName(row.reviewedBy) : null;
      const canStart = !s.review && !elsewhere && row.online !== false;
      if (canStart && !A.autoReviewed.has(row.id) && document.visibilityState !== "hidden") {
        A.autoReviewed.add(row.id);
        startReview(row);
      }
      if (elsewhere) c.appendChild(el("p", "rm-note", `Being approved on ${elsewhere}.`));
      else if (row.online === false) c.appendChild(el("p", "rm-note", "That device is not online right now."));
      else if (A.reviewing.has(row.id)) c.appendChild(el("p", "rm-note", "Getting the code…"));
      if (failure && canStart) bar.append(denied, button("Try again", "primary", () => startReview(row)));
      else bar.appendChild(denied);
      c.append(bar, out);
      return c;
    }

    c.appendChild(el("div", "acct-code", groupCode(review.code)));
    c.appendChild(el("p", "rm-note acct-glance", GLANCE));
    const choices = el("div", "acct-approve");
    for (const choice of roleChoices(review.kind ?? row.kind)) {
      choices.appendChild(button(choice.label, choice.primary ? "primary" : "", (e) => {
        const b = e.currentTarget;
        for (const other of choices.querySelectorAll("button")) other.disabled = true;
        A.failures.delete(row.id);
        call("POST", "approve", { id: row.id, code: review.code, role: choice.role })
          .then(() => refresh())
          .catch((err) => {
            for (const other of choices.querySelectorAll("button")) other.disabled = false;
            b.disabled = false;
            failed(err.code === "log-conflict" ? new Error("Another device changed the device list at the same moment. Press Start again on the new device.") : err);
            refresh();
          });
      }));
    }
    c.appendChild(choices);
    c.appendChild(el("p", "rm-note", "Full control is for an Omni app you installed. A web page with it could add and remove devices."));
    bar.append(denied, button("Get a new code", "quiet", () => startReview(row)));
    c.append(bar, out);
    return c;
  }

  // --------------------------------------------------------------------------------- the recovery code
  async function renderGate() {
    const gate = $("#accountGate");
    const s = A.status;
    if (!s?.recoveryCodePending || A.codeHidden) { gate.hidden = true; if (!s?.recoveryCodePending) { A.showing = null; A.forgetStep = false; } return; }
    // `confirmed` is what lets the person go, so it is asked again when it can have changed, and not on every piece of news.
    const key = gateKey(s);
    if (!A.showing || (!A.showing.confirmed && key !== A.gateAsked)) {
      A.gateAsked = key;
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
        copyText(shown.recoveryCode).then(done).catch(() => { copied.textContent = "Could not copy. Select it and copy it by hand."; });
      });
      const row = el("div", "acct-gate-row"); row.append(copy, copied);
      box.appendChild(row);
    } else box.appendChild(el("p", "rm-note err", shown.error ?? "The stored code could not be opened on this computer."));
    box.appendChild(el("p", "rm-note", "With your password and this code you can get back in if you lose every device. It is shown only once, and no one can issue another. A forgotten code cannot be reset by email."));
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
        toast(A.status?.phase === "approved" ? "Recovery code saved. This computer no longer holds a copy." : "This computer no longer holds that code. You can sign in now.");
      }, out)));
    }
    box.append(bar, out);
    if (A.forgetStep) {
      const warn = el("div", "acct-forget");
      warn.appendChild(el("p", "rm-note err", FORGET_WARNING));
      warn.appendChild(el("p", "rm-note", "The code is still on the screen above. Write it down first."));
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
    for (const [mode, label] of [["signin", "Sign in"], ["register", "Create an account"], ["recover", "Recover"]]) {
      const b = el("button", `seg-btn${A.form.mode === mode ? " active" : ""}`, label);
      b.type = "button";
      b.onclick = () => { A.form.mode = mode; A.formNote = ""; renderSettings(true); };
      seg.appendChild(b);
    }
    sec.appendChild(seg);
    const mode = A.form.mode;
    const needsInvite = !A.status?.canCreateFirst;
    sec.appendChild(el("p", "rm-note", mode === "signin" ? "Optional. Your password alone does not get in. A device already on the account approves this one with one tap." : mode === "register" ? `${needsInvite ? "You need an invite code from the person who runs your Omni server. " : "This computer can create the first account. "}A forgotten password cannot be reset by email. Nothing is ever mailed, and the server never sees your password. You get a recovery code to keep.` : "For when you have lost every device. You need your email, password and recovery code. You get a new code, and every device is told."));
    const form = el("form", "rm-form");
    form.onsubmit = (e) => e.preventDefault();
    const invite = mode === "register" && needsInvite ? field(form, { label: "Invite code", autocomplete: "off", placeholder: "XXXX-XXXX-XXXX-XXXX", key: "invite" }) : null;
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
        if (invite && !invite.value.trim()) return refuse("Type the invite code you were given.");
        try { checkPassword(password.value); } catch { return refuse("The password needs at least 12 characters."); }
      }
      let done = false;
      try {
        if (mode === "register") {
          const r = await call("POST", "register", { ...creds, ...(invite ? { inviteCode: invite.value.trim() } : {}) });
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
        if (d.self) top.appendChild(el("span", "acct-self", hereWords()));
        main.appendChild(top);
        const role = d.role === "full" ? "full control" : "limited web page";
        main.appendChild(el("div", "acct-device-sub", [cleanName(d.kind, 32, "unknown"), role, shortId(d.id), d.addedAt ? `added ${when(d.addedAt)}` : "", d.expiresAt ? `ends ${when(d.expiresAt)}` : ""].filter(Boolean).join(", ")));
        row.appendChild(main);
        if (fullDevice()) {
          const rm = button("Remove", "small", (e) => {
            const name = cleanName(d.name);
            const text = d.self
              ? `Remove this computer, the one you are using, from the account?\n\nIt loses access to your other machines straight away, and they lose access to it. It needs a new approval to come back, and if it is your only full device you will need your recovery code.`
              : `Remove "${name}" from the account?\n\nIt is cut off from every machine as soon as each sees the new list.`;
            if (!window.confirm(text)) return;
            acting(e.currentTarget, async () => { await call("POST", "remove", { id: d.id }); await refresh(); renderSettings(true); }).catch((err) => toast(explain(err), true));
          });
          row.appendChild(rm);
        }
        list.appendChild(row);
      }
    }).catch((e) => { list.textContent = e.message; });
  }

  /** Only the hub's owner sees this: the hub says who that is, and anyone else's list is refused, which hides the section. */
  function invitesSection(wrap) {
    const sec = section(wrap, "Invite someone");
    sec.hidden = true;
    sec.appendChild(el("p", "rm-note", "An invite code lets one person create their own account on your Omni server. They see only their own computers, and you see only yours. A code works once, for 14 days."));
    const made = el("div", "acct-invite-made");
    const list = el("div", "acct-devices");
    const out = el("p", "rm-note err"); out.hidden = true;
    const load = () => call("GET", "invites").then(({ invites }) => {
      sec.hidden = false;
      list.textContent = "";
      const words = { live: "Open", used: "Used", expired: "Expired" };
      for (const i of invites) {
        const row = el("div", "acct-device");
        const main = el("div", "acct-device-main");
        main.appendChild(el("b", null, `${words[i.state] ?? "Unknown"} invite`));
        main.appendChild(el("div", "acct-device-sub", [i.createdAt ? `made ${when(i.createdAt)}` : "", i.state === "live" && i.expiresAt ? `ends ${when(i.expiresAt)}` : ""].filter(Boolean).join(", ")));
        row.appendChild(main);
        if (i.state === "live") row.appendChild(button("Revoke", "small", (e) => acting(e.currentTarget, async () => { await call("POST", "invites/revoke", { id: i.id }); made.textContent = ""; await load(); }, out)));
        list.appendChild(row);
      }
    }).catch((e) => { if (e.status === 403) sec.remove(); else { sec.hidden = false; out.textContent = explain(e); out.hidden = false; } });
    const make = button("Make an invite code", "primary", (e) => acting(e.currentTarget, async () => {
      const { code } = await call("POST", "invites", {});
      made.textContent = "";
      made.appendChild(el("div", "acct-recovery mono", code));
      const copied = el("span", "rm-note", "Give this code to the person you invite. It is shown only once.");
      const copy = button("Copy", "small", () => {
        copyText(code).then(() => { copied.textContent = "Copied."; }).catch(() => { copied.textContent = "Could not copy. Select it and copy it by hand."; });
      });
      const row = el("div", "acct-gate-row"); row.append(copy, copied);
      made.appendChild(row);
      await load();
    }, out));
    sec.append(make, made, list, out);
    load();
  }

  function passwordSection(wrap) {
    const sec = section(wrap, "Change the password");
    sec.appendChild(el("p", "rm-note", "It changes how you sign in. No device needs approving again."));
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
    sec.appendChild(el("p", "rm-note", "With your password, your recovery code gets you back in if you lose every device. Once you say you saved it, this computer keeps no copy and cannot show it again."));
    if (s.recoveryUnconfirmed) sec.appendChild(el("p", "rm-note err", "Keep your old recovery code until another device confirms this recovery, then discard it."));
    if (s.recoveryContested && s.hub?.lastError) sec.appendChild(el("p", "rm-note err", s.hub.lastError));
    if (s.recoveryCodePending) sec.appendChild(button("Show the waiting code", "", () => { A.codeHidden = false; renderGate(); renderBanners(); }));
    if (s.recoveries?.length) {
      sec.appendChild(el("p", "rm-note", "This account has been recovered before."));
      for (const r of s.recoveries) sec.appendChild(el("div", "acct-device-sub", `${when(r.addedAt)}, by ${cleanName(r.name)} (${cleanName(r.kind, 32, "unknown")}, ${shortId(r.signPub)})`));
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
      const sec = section(wrap, "Signing in is off in this window");
      sec.appendChild(el("p", "rm-note", noAccountText(A.whyCode)));
      return;
    }
    const s = A.status;
    if (!s) { wrap.appendChild(el("p", "rm-note", "Loading…")); return; }

    const phone = onPhone();
    const thisDevice = section(wrap, phone ? "This phone" : webPage() ? "This page" : "This device");
    thisDevice.appendChild(el("p", "rm-note", phaseText(s.phase)));
    if (s.email) thisDevice.appendChild(el("div", "acct-device-sub", cleanName(s.email, 254)));
    const role = phone ? (s.device?.role === "full" ? "full control" : s.device?.role === "client" ? "limited" : "not on an account") : webPage() || s.device?.role === "client" ? "limited web page" : s.device?.role === "full" ? "full control" : "not on an account";
    if (s.device) thisDevice.appendChild(el("div", "acct-device-sub", `${cleanName(s.device.name)}, ${cleanName(s.device.kind, 32, "unknown")}, ${role}, ${shortId(s.device.id)}`));
    thisDevice.appendChild(el("div", "acct-device-sub", `Hub ${cleanName(s.hub?.url, 200)}, ${s.hub?.connected ? "connected" : "not connected"}`));
    if (phone) thisDevice.appendChild(el("p", "rm-note", "This phone cannot approve or remove devices, or change the password. Use a desktop app for that."));
    else if (webPage()) thisDevice.appendChild(el("p", "rm-note", "This page cannot approve or remove anything. Use a desktop or phone app for that."));
    if (s.hub?.lastError) thisDevice.appendChild(el("p", "rm-note err", s.hub.lastError));
    if (A.note) thisDevice.appendChild(el("p", "rm-note", A.note));

    const signedOutLike = ["signed-out", "denied", "expired"].includes(s.phase);
    if (signedOutLike) signInSection(wrap);
    if (["approved", "recovering"].includes(s.phase)) devicesSection(wrap);
    if (fullDevice()) invitesSection(wrap);
    if (fullDevice()) passwordSection(wrap);
    if (webPage()) { if (s.recoveries?.length) recoverySection(wrap, s); }
    else if (s.phase !== "signed-out" || s.recoveries?.length || s.recoveryCodePending) recoverySection(wrap, s);
    if (!webPage() && s.phase === "approved") webAccessSection(wrap, s);
    if (!webPage() && s.phase === "approved") auditSection(wrap);

    const leave = section(wrap, "Leave");
    if (s.phase === "removed") leave.appendChild(el("p", "rm-note", "To join the account again, forget this device, then sign in as new."));
    const row = el("div", "acct-gate-row");
    if (s.signedIn) row.appendChild(button("Sign out", "", (e) => {
      if (!window.confirm(phone ? "Sign out on this phone?\n\nIt stays on the device list, and signing in again needs no new approval." : webPage() ? "Sign out on this page?\n\nIt stays on the device list until its 30 days run out." : "Sign out on this computer?\n\nOther machines lose it until you sign in again. It stays on the device list.")) return;
      acting(e.currentTarget, async () => { await call("POST", "sign-out", {}); await refresh(); renderSettings(true); }).catch((err) => toast(explain(err), true));
    }));
    row.appendChild(button(phone ? "Forget this phone" : webPage() ? "Forget this page" : "Forget this device", "quiet", (e) => {
      const warn = s.recoveryCodePending ? FORGET_WARNING : "This deletes this device's identity and its copy of the device list. It would have to be approved again as a new device.";
      if (s.recoveryCodePending) { A.codeHidden = false; A.forgetStep = true; renderGate(); return; }
      if (!window.confirm(`Forget this device?\n\n${warn}`)) return;
      acting(e.currentTarget, async () => { await call("POST", "sign-out", { forget: true }); await refresh(); renderSettings(true); }).catch((err) => toast(explain(err), true));
    }));
    leave.appendChild(row);

    // The hub's limits, in full, one tap away: a fact sheet, not a paragraph in the main path.
    const hub = el("details", "how rm-sec");
    hub.append(el("summary", null, "What the hub can and cannot see"), el("p", null, HUB_SEES));
    wrap.appendChild(hub);
  }

  return {
    init,
    openMenu() { const menu = $("#machineMenu"); if (menu.hidden) renderMachineMenu(); menu.hidden = !menu.hidden; },
    renderSettings: () => renderSettings(true),
    /** The chosen machine could not give the page its first state. */
    machineDown(message) { A.machineDown = message; renderBanners(); },
    machineUp() { A.machineDown = null; renderBanners(); },
    /** The window went to another machine: the pill, the menu and the banners follow it. */
    refocus() { A.machineDown = null; A.linkDown = false; A.linkWasUp = false; renderMachine(); renderBanners(); noteLink(); },
    /** This computer's name on the account, if it has one. */
    get selfName() { return A.status?.device?.name ?? null; },
    get isRemote() { return isRemote(); },
  };
}
