/* The web page at the hub: sign in, be approved by one of your devices, choose a machine, and then the same app as the desktop's,
   talking over a channel this page holds itself. All the decisions are in page-account.js and log-trust.js. This draws them.
   Everything a device or the hub supplies is shown as text, through cleanName. */
import { el } from "./lib.js";
import { PageAccount } from "./page-account.js";
import { openPageStore } from "./page-store.js";
import { createPageTransport } from "./page-transport.js";
import { appMarkup, cleanName, machine, setChannelTransport, setMachine } from "./transport.js";
import { alertAdvice, alertTitle, signInSurface } from "./account.js";
import { forgetCachedModels } from "./model-cache.js";
import { startServiceWorker } from "./web-sw.js";

const SERVER_NOTICE = "This page comes from the server it connects to. If that server were hacked, it could serve a changed page, which could capture your password and, while open and signed in, run commands on your machines as you, up to reading a machine's keys. Use it for trusted moments. For anything sensitive, prefer the installed apps, and turn Allow web page access off on any machine where this matters.";
const NO_ACCOUNT = "To create an account, use the Omni desktop app on your computer. This page cannot create or recover one.";
const LOG_TEXT = "Your password alone does not get in: one of your computers approves this page with one tap. The page can then use your computers for 30 days.";
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

function signInScreen(s) {
  if (!form.name) form.name = guessName();
  return signInSurface({
    title: "Sign in",
    intro: LOG_TEXT,
    form,
    nameLabel: "Name for this page",
    error: formNote || s.hub?.lastError || PHASE_NOTE[s.phase] || "",
    onSubmit: async (_mode, values) => {
      working = true;
      form = { email: values.email, name: values.name };
      formNote = "";
      try {
        await account.signIn({ email: values.email, password: values.password, name: values.name });
      } catch (error) {
        formNote = error.code === "wrong-credentials" ? `${error.message} ${NO_ACCOUNT}` : error.message;
      } finally {
        working = false;
        render();
      }
    },
    footer: [el("p", "rm-note web-noaccount", NO_ACCOUNT), el("p", "rm-note web-notice", SERVER_NOTICE), forgetRow(s)],
  });
}

function forgetRow(s) {
  const row = el("div", "web-leave");
  if (s.logVersion > 0 || s.device) {
    row.appendChild(button("Forget this page", "small quiet", () => {
      if (!window.confirm("Forget this page?\n\nThis deletes its keys and its copy of the device list from this browser. It would have to be approved again as a new device.")) return;
      forgetCachedModels();
      account.signOut({ forget: true }).then(render);
    }));
  }
  return row;
}

const groupCode = (code) => String(code ?? "").replace(/(\d{3})(\d{3})/, "$1 $2");

/** The code and the wait. There is nothing to press here: the other device approves. Only the person starts again. */
function waitingScreen(s) {
  const c = card("Approve this page");
  const p = s.pending ?? {};
  const out = el("p", "rm-note err");
  out.hidden = true;
  const attempt = (work) => { try { work(); } catch (error) { out.textContent = error.message; out.hidden = false; } };
  const again = (label, cls) => button(label, cls, () => attempt(() => account.restartExchange()));
  const bar = el("div", "ap-bar");
  if (p.failed) {
    c.appendChild(el("p", "rm-note err", "That try did not go through, so nothing was approved. Press Start again here, then look at your other device. If this keeps happening, someone may be interfering."));
    bar.appendChild(again("Start again", "primary"));
  } else if (p.code) {
    c.appendChild(el("p", "rm-note", "On one of your computers, a card has appeared. Approve it there. It shows this same code:"));
    c.appendChild(el("div", "acct-code", groupCode(p.code)));
    c.appendChild(el("p", "rm-note", "If it shows a different code, do not approve there, and press The codes differ."));
    bar.appendChild(again("The codes differ", "quiet"));
  } else if (p.confirmed) {
    c.appendChild(el("p", "rm-note", "Waiting for your other device to approve."));
    bar.appendChild(again("Start again", "quiet"));
  } else {
    c.appendChild(el("p", "rm-note", "Open Omni on a computer signed in to this account. A card appears there, and a code appears here."));
    if (!s.hub?.connected) c.appendChild(el("p", "rm-note err", s.hub?.lastError ?? "Connecting…"));
    else if (p.approverOnline === false) c.appendChild(el("p", "rm-note err web-noapprover", "None of your computers is online right now, so nothing can approve this page. Open Omni on one and this page goes on from here. It waits for 10 minutes."));
  }
  c.append(bar, out);
  const leave = el("div", "web-leave");
  leave.appendChild(button("Cancel this sign-in", "small quiet", () => { account.signOut().then(render); }));
  c.appendChild(leave);
  return c;
}

function machineScreen(s) {
  // Shown only while none of the account's machines can be used: the app opens by itself as soon as one can.
  const c = card("Your machines");
  const list = el("div", "web-machines");
  const machines = account.links.machines();
  if (!machines.length) list.appendChild(el("p", "rm-note", "There are no desktop machines on this account yet."));
  else c.appendChild(el("p", "rm-note", "None of your machines can be reached right now. This page opens as soon as one can."));
  for (const m of machines) {
    const refusing = m.link?.state === "refusing";
    const row = el("div", "machine-row web-machine");
    row.append(el("span", `machine-dot${m.online && !refusing ? " live" : ""}`), el("span", "machine-row-name", cleanName(m.name)), el("span", "machine-row-id", String(m.id).slice(0, 6)), el("span", "machine-row-state", !m.online ? "offline" : refusing ? "does not let web pages in" : ""));
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
  if (s.phase === "approved") {
    // The app shows every machine on the account; it opens on the one chosen last, or the first that answers.
    const machines = account.links.machines();
    const usable = (m) => m.online && m.link?.state !== "refusing";
    const chosen = machine();
    const start = machines.find((m) => m.id === chosen?.id && usable(m)) ?? machines.find(usable);
    if (start) { setMachine(start.id, { name: start.name }); loadApp(); return; }
    if (chosen) setMachine(null); // a machine since gone from the account
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

function signInKeysInWorker(password, salt) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./login-worker.js", import.meta.url), { type: "module" });
    const done = (fn, value) => { worker.terminate(); fn(value); };
    worker.onmessage = ({ data }) => (data.keys ? done(resolve, data.keys) : done(reject, new Error("could not derive the login key")));
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
  account = new PageAccount({ store, hubUrl: location.origin, hubOrigin: location.origin, name: guessName(), deriveKeys: signInKeysInWorker });
  // One transport per machine, each fixed to its own: the app shows them all at once. From here on, words are this page's too.
  const local = account.routes();
  setChannelTransport({ ...createPageTransport({ links: account.links, machine, local }), forMachine: (m) => createPageTransport({ links: account.links, machine: () => m, local }) });
  account.on("status", (s) => {
    if (appLoaded) { if (s.phase !== "approved") location.reload(); return; }
    render();
  });
  account.on("devices", () => render());
  account.on("links", () => render());
  await account.start();
  render();
}

startServiceWorker({ quiet: () => !appLoaded && !working && !shell.contains(document.activeElement) });
boot().catch((error) => {
  shell.textContent = "";
  const c = card("This page could not start");
  c.appendChild(el("p", "rm-note err", error.message));
  shell.appendChild(c);
});
