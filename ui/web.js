/* The web page at the hub: sign in, be approved by one of your devices, choose a machine, and then the same app as the desktop's,
   talking over a channel this page holds itself. All the decisions are in page-account.js and log-trust.js. This draws them.
   Everything a device or the hub supplies is shown as text, through cleanName. */
import { el } from "./lib.js";
import { PageAccount } from "./page-account.js";
import { openPageStore } from "./page-store.js";
import { createPageTransport } from "./page-transport.js";
import { appMarkup, cleanName, machine, setChannelTransport, setMachine } from "./transport.js";
import { alertAdvice, alertTitle } from "./account.js";

const SERVER_NOTICE = "This page comes from the server it connects to. If that server were hacked, it could serve a changed page, which could capture your password and, while open and signed in, run commands on your machines as you, up to reading a machine's keys. Use it for trusted moments. For anything sensitive, prefer the installed apps, and turn Allow web page access off on any machine where this matters.";
const NO_ACCOUNT = "An account is created in the Omni desktop app, on your computer. This page cannot create one, and it has no recovery: a web page signs no changes to your account.";
const LOG_TEXT = "Your password alone does not get in: one of your devices must also approve this page, with a code you compare. It can then control your machines for 30 days, and cannot approve or remove devices.";
const PHASE_NOTE = {
  denied: "A device on the account refused this sign-in.",
};

const shell = document.getElementById("webShell");
let account = null;
let appLoaded = false;
let form = { email: "", name: "" };
let formNote = "";
let working = false;

const guessName = () => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const place = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `Web page: ${browser}${place ? ` on ${place}` : ""}`;
};

function button(label, cls, onclick) {
  const b = el("button", `btn${cls ? ` ${cls}` : ""}`, label);
  b.type = "button";
  b.onclick = onclick;
  return b;
}

function card(title) {
  const c = el("section", "web-card");
  const head = el("div", "web-brand brand");
  head.append(el("span", "mark"), el("span", "word", "Omni Agent"));
  c.appendChild(head);
  if (title) c.appendChild(el("h1", "web-title", title));
  return c;
}

/** What has gone wrong, which the person must not miss. It stays until they say they have read it. */
function alertBanners(s) {
  const box = el("div", "web-alerts");
  const alerts = s.alerts ?? [];
  alerts.forEach((a, i) => {
    const b = el("div", "acct-banner danger");
    b.setAttribute("role", "alert");
    const words = el("div", "acct-banner-text");
    const title = alertTitle(a);
    if (title) words.appendChild(el("b", null, title));
    words.appendChild(el("span", null, ` ${a.message}${a.count > 1 ? ` (${a.count} times)` : ""} ${alertAdvice(a.kind)}`));
    b.appendChild(words);
    if (i === alerts.length - 1) {
      const row = el("div", "acct-banner-actions");
      row.appendChild(button(alerts.length > 1 ? "I have read these" : "I have read this", "small quiet", () => { account.clearAlerts(); }));
      b.appendChild(row);
    }
    box.appendChild(b);
  });
  return box;
}

function field(parent, { label, type = "text", value = "", autocomplete, key }) {
  const row = el("label", "acct-field");
  row.appendChild(el("span", null, label));
  const input = el("input");
  input.type = type;
  input.value = value;
  input.dataset.key = key;
  if (autocomplete) input.autocomplete = autocomplete;
  input.spellcheck = false;
  row.appendChild(input);
  parent.appendChild(row);
  return input;
}

function signInScreen(s) {
  const c = card("Sign in");
  const why = s.hub?.lastError ?? PHASE_NOTE[s.phase];
  if (why) c.appendChild(el("p", "rm-note err", why));
  c.appendChild(el("p", "rm-note", LOG_TEXT));
  const f = el("form", "rm-form");
  f.onsubmit = (e) => e.preventDefault();
  const email = field(f, { label: "Email", type: "email", value: form.email, autocomplete: "username", key: "email" });
  const password = field(f, { label: "Password", type: "password", autocomplete: "current-password", key: "password" });
  const name = field(f, { label: "Name for this page", value: form.name || guessName(), key: "name" });
  const out = el("p", "rm-note err");
  out.textContent = formNote;
  out.hidden = !formNote;
  const go = button("Sign in", "primary", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Signing in…";
    working = true;
    form = { email: email.value.trim(), name: name.value.trim() };
    formNote = "";
    out.hidden = true;
    try {
      await account.signIn({ email: form.email, password: password.value, name: form.name });
    } catch (error) {
      formNote = error.code === "wrong-credentials" ? `${error.message} ${NO_ACCOUNT}` : error.message;
    } finally {
      working = false;
      password.value = "";
      render();
    }
  });
  f.appendChild(go);
  f.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
  c.append(f, out);
  c.appendChild(el("p", "rm-note web-noaccount", NO_ACCOUNT));
  c.appendChild(el("p", "rm-note web-notice", SERVER_NOTICE));
  c.appendChild(forgetRow(s));
  return c;
}

function forgetRow(s) {
  const row = el("div", "web-leave");
  if (s.logVersion > 0 || s.device) {
    row.appendChild(button("Forget this page", "small quiet", () => {
      if (!window.confirm("Forget this page?\n\nThis deletes its keys and its copy of the device list from this browser. It would have to be approved again as a new device.")) return;
      account.signOut({ forget: true }).then(render);
    }));
  }
  return row;
}

const groupCode = (code) => String(code ?? "").replace(/(\d{3})(\d{3})/, "$1 $2");

/** The code and the wait. Nothing is adopted before the person presses This matches, and only the person starts again. */
function waitingScreen(s) {
  const c = card("Waiting for approval");
  const p = s.pending ?? {};
  const out = el("p", "rm-note err");
  out.hidden = true;
  const attempt = (work) => { try { work(); } catch (error) { out.textContent = error.message; out.hidden = false; } };
  const again = () => button("Start again", "", () => attempt(() => account.restartExchange()));
  const bar = el("div", "ap-bar");
  if (p.failed) {
    c.appendChild(el("p", "rm-note err", "That exchange failed, so nothing was accepted. Press Start again here, then Review on the other device. Each failed try is visible: if this keeps happening, someone may be interfering."));
    bar.appendChild(again());
  } else if (p.confirmed) {
    c.appendChild(el("p", "rm-note", "Codes confirmed. Waiting for the other device to approve. This page accepts nothing until the approval comes back and checks out against the code."));
    bar.appendChild(again());
  } else if (p.code) {
    c.appendChild(el("p", "rm-note", "Compare this code with the other screen."));
    c.appendChild(el("div", "acct-code", groupCode(p.code)));
    c.appendChild(el("p", "rm-note", "Press This matches only if the other device shows exactly these six digits. If they differ, someone may be in the middle: press Start again, and do not approve there."));
    bar.append(again(), button("This matches", "primary", () => attempt(() => account.confirmCode(p.code))));
  } else {
    c.appendChild(el("p", "rm-note", "Open Omni on a desktop or phone app signed in to this account. A card appears there: press Review, and a code appears here and there."));
    if (!s.hub?.connected) c.appendChild(el("p", "rm-note err", s.hub?.lastError ?? "Connecting to the hub…"));
    else if (p.approverOnline === false) c.appendChild(el("p", "rm-note err web-noapprover", "None of your desktop or phone apps is online right now, so nothing can approve this page. Open one and this page goes on from here. It waits for 10 minutes."));
  }
  c.append(bar, out);
  const leave = el("div", "web-leave");
  leave.appendChild(button("Cancel this sign-in", "small quiet", () => { account.signOut().then(render); }));
  c.appendChild(leave);
  return c;
}

function machineScreen(s) {
  const c = card("Choose a machine");
  const list = el("div", "web-machines");
  const machines = account.links.machines();
  if (!machines.length) list.appendChild(el("p", "rm-note", "There are no desktop machines on this account yet."));
  for (const m of machines) {
    const row = el("button", "machine-row web-machine");
    row.type = "button";
    row.append(el("span", `machine-dot${m.online ? " live" : ""}`), el("span", "machine-row-name", cleanName(m.name)), el("span", "machine-row-id", String(m.id).slice(0, 6)), el("span", "machine-row-state", m.online ? "" : "offline"));
    row.disabled = !m.online;
    row.title = m.online ? `Act on ${cleanName(m.name)}` : `${cleanName(m.name)} is offline`;
    row.onclick = () => setMachine(m.id, { name: m.name });
    list.appendChild(row);
  }
  c.appendChild(list);
  if (!s.hub?.connected) c.appendChild(el("p", "rm-note err", s.hub?.lastError ?? "Connecting to the hub…"));
  const expires = s.device?.expiresAt;
  if (expires) c.appendChild(el("p", "rm-note", `This page can act on your machines until ${new Date(expires).toLocaleDateString([], { dateStyle: "medium" })}. After that it must be approved again. It cannot approve or remove devices.`));
  const leave = el("div", "web-leave");
  leave.appendChild(button("Sign out", "small quiet", () => { account.signOut().then(render); }));
  leave.appendChild(forgetRow(s));
  c.appendChild(leave);
  return c;
}

function damagedScreen(s) {
  const c = card("This page cannot go on");
  c.appendChild(el("p", "rm-note err", "The device list kept in this browser failed its checks. Nothing was changed."));
  c.appendChild(forgetRow(s));
  return c;
}

function render() {
  if (appLoaded || working) return;
  const s = account.status();
  const typing = shell.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";
  if (typing && ["signed-out", "denied", "expired", "removed"].includes(s.phase)) return;
  const chosen = machine();
  if (s.phase === "approved" && chosen) {
    if (account.links.machines().some((m) => m.id === chosen.id)) { loadApp(); return; }
    setMachine(null, { reload: false }); // a machine since gone from the account
  }
  shell.textContent = "";
  shell.appendChild(alertBanners(s));
  const screen = s.phase === "approved" ? machineScreen : s.phase === "pending" ? waitingScreen : s.phase === "log-damaged" ? damagedScreen : signInScreen;
  shell.appendChild(screen(s));
}

/** The app itself, on the chosen machine. It sees the same transport API as on a desktop. */
async function loadApp() {
  appLoaded = true;
  try {
    const parsed = new DOMParser().parseFromString(await appMarkup(), "text/html");
    shell.remove();
    document.body.classList.remove("web-shell");
    document.body.classList.add("web-page");
    for (const node of [...parsed.body.children]) if (node.tagName !== "SCRIPT") document.body.appendChild(document.adoptNode(node));
    document.getElementById("tabRemote").hidden = true; // the old relay's settings are a computer's own
    document.getElementById("subAccount").textContent = "This page's place on your account: your devices, and how to leave. It cannot approve or remove anything: for that, use a desktop or phone app.";
    await import("./app.js");
  } catch (error) {
    appLoaded = false;
    document.body.appendChild(el("p", "rm-note err web-failed", `The app could not start: ${error.message}`));
  }
}

async function supported() {
  try {
    await crypto.subtle.generateKey("Ed25519", false, ["sign"]);
    await crypto.subtle.generateKey("X25519", false, ["deriveBits"]);
    return !!globalThis.indexedDB;
  } catch {
    return false;
  }
}

function loginKeyInWorker(password, salt) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./login-worker.js", import.meta.url), { type: "module" });
    const done = (fn, value) => { worker.terminate(); fn(value); };
    worker.onmessage = ({ data }) => (data.key ? done(resolve, data.key) : done(reject, new Error("could not derive the login key")));
    worker.onerror = () => done(reject, new Error("could not derive the login key"));
    worker.postMessage({ password, salt });
  });
}

async function boot() {
  if (!await supported()) {
    shell.textContent = "";
    const c = card("This browser cannot run this page");
    c.appendChild(el("p", "rm-note", "It needs Chrome 137 or later, Safari 17 or later, or Firefox 130 or later, with site data allowed: the page keeps its keys in this browser, where they cannot be copied out."));
    shell.appendChild(c);
    return;
  }
  const store = await openPageStore();
  account = new PageAccount({ store, hubUrl: location.origin, hubOrigin: location.origin, name: guessName(), deriveLoginKey: loginKeyInWorker });
  setChannelTransport(createPageTransport({ links: account.links, machine, local: account.routes() })); // from here on, words are this page's too
  account.on("status", (s) => {
    if (appLoaded) { if (s.phase !== "approved") location.reload(); return; }
    render();
  });
  account.on("devices", () => render());
  await account.start();
  render();
}

boot().catch((error) => {
  shell.textContent = "";
  const c = card("This page could not start");
  c.appendChild(el("p", "rm-note err", error.message));
  shell.appendChild(c);
});
