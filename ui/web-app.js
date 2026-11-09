/* The screens of a client with no computer of its own: the web page at the hub (web.js) and the iPhone app (phone.js). Sign in, be
   approved by one of your devices, and then the same app as the desktop's, talking over channels this client holds itself. All the
   decisions are in page-account.js and log-trust.js. This draws them. Everything a device or the hub supplies is shown as text,
   through cleanName. What differs between the two is the caller's: where the keys are kept, which hub, and the words. */
import { el } from "./lib.js";
import { createPageTransport } from "./page-transport.js";
import { appMarkup, cleanName, machine, setChannelTransport, setMachine } from "./transport.js";
import { alertAdvice, alertTitle, signInSurface } from "./account.js";
import { forgetCachedModels } from "./model-cache.js";

const PHASE_NOTE = {
  denied: "A device on the account refused this sign-in.",
};

const groupCode = (code) => String(code ?? "").replace(/(\d{3})(\d{3})/, "$1 $2");

/**
 * Starts the client. `open()` gives the PageAccount, `supported()` whether this place can run it at all, and `words` what is said
 * here (see web.js for every key). `client` is what transport.js is told this is ("page" or "phone"). `forgotten()` runs after this
 * client's keys were deleted. `quietHook(quiet)` hands the caller a way to ask whether the screen is idle.
 */
export function startClient({ open, supported, words, guessName, client = "page", forgotten = () => {}, quietHook = () => {} }) {
  const shell = document.getElementById("webShell");
  let account = null;
  let appLoaded = false;
  let form = { email: "", name: "" };
  let formNote = "";
  let working = false;

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
      const text = el("div", "acct-banner-text");
      const title = alertTitle(a);
      if (title) text.appendChild(el("b", null, title));
      text.appendChild(el("span", null, ` ${a.message}${a.count > 1 ? ` (${a.count} times)` : ""} ${alertAdvice(a.kind)}`));
      b.appendChild(text);
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
      intro: words.signIn,
      form,
      nameLabel: words.nameLabel,
      error: formNote || s.hub?.lastError || PHASE_NOTE[s.phase] || "",
      onSubmit: async (_mode, values) => {
        working = true;
        form = { email: values.email, name: values.name };
        formNote = "";
        try {
          await account.signIn({ email: values.email, password: values.password, name: values.name });
        } catch (error) {
          formNote = error.code === "wrong-credentials" ? `${error.message} ${words.noAccount}` : error.message;
        } finally {
          working = false;
          render();
        }
      },
      footer: [el("p", "rm-note web-noaccount", words.noAccount), ...(words.serverShort ? [serverNotice()] : []), forgetRow(s)],
    });
  }

  function serverNotice() {
    const how = el("details", "how web-notice");
    how.append(el("summary", null, words.serverShort), el("p", null, words.serverNotice));
    return how;
  }

  function forgetRow(s) {
    const row = el("div", "web-leave");
    if (s.logVersion > 0 || s.device) {
      row.appendChild(button(words.forget, "small quiet", () => {
        if (!window.confirm(words.forgetConfirm)) return;
        forgetCachedModels();
        account.signOut({ forget: true }).then(() => { render(); forgotten(); });
      }));
    }
    return row;
  }

  /** The code and the wait. There is nothing to press here: the other device approves. Only the person starts again. */
  function waitingScreen(s) {
    const c = card(words.approveTitle);
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
      c.appendChild(el("p", "rm-note", words.approveHow));
      c.appendChild(el("div", "acct-code", groupCode(p.code)));
      c.appendChild(el("p", "rm-note", "If it shows a different code, do not approve there, and press The codes differ."));
      bar.appendChild(again("The codes differ", "quiet"));
    } else if (p.confirmed) {
      c.appendChild(el("p", "rm-note", "Waiting for your other device to approve."));
      bar.appendChild(again("Start again", "quiet"));
    } else {
      c.appendChild(el("p", "rm-note", words.waitingHint));
      if (!s.hub?.connected) c.appendChild(el("p", "rm-note err", s.hub?.lastError ?? "Connecting…"));
      else if (p.approverOnline === false) c.appendChild(el("p", "rm-note err web-noapprover", words.noApprover));
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
    else c.appendChild(el("p", "rm-note", words.noneReachable));
    for (const m of machines) {
      const refusing = m.link?.state === "refusing";
      const row = el("div", "machine-row web-machine");
      row.append(el("span", `machine-dot${m.online && !refusing ? " live" : ""}`), el("span", "machine-row-name", cleanName(m.name)), el("span", "machine-row-id", String(m.id).slice(0, 6)), el("span", "machine-row-state", !m.online ? "offline" : refusing ? words.refusing : ""));
      list.appendChild(row);
    }
    c.appendChild(list);
    if (!s.hub?.connected) c.appendChild(el("p", "rm-note err", s.hub?.lastError ?? "Connecting to the hub…"));
    const expires = s.device?.expiresAt;
    if (expires) c.appendChild(el("p", "rm-note", words.untilExpiry(new Date(expires).toLocaleDateString([], { dateStyle: "medium" }))));
    const leave = el("div", "web-leave");
    leave.appendChild(button("Sign out", "small quiet", () => { account.signOut().then(render); }));
    leave.appendChild(forgetRow(s));
    c.appendChild(leave);
    return c;
  }

  function damagedScreen(s) {
    const c = card(words.cannotGoOn);
    c.appendChild(el("p", "rm-note err", words.cannotGoOnText));
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
      await import("./app.js");
    } catch (error) {
      appLoaded = false;
      document.body.appendChild(el("p", "rm-note err web-failed", `The app did not start. ${error.message}`));
    }
  }

  async function boot() {
    if (!await supported()) {
      shell.textContent = "";
      const c = card(words.unsupportedTitle);
      c.appendChild(el("p", "rm-note", words.unsupportedText));
      shell.appendChild(c);
      return;
    }
    account = await open();
    // One transport per machine, each fixed to its own: the app shows them all at once. From here on, words are this client's too.
    const local = account.routes();
    setChannelTransport({ ...createPageTransport({ links: account.links, machine, local }), forMachine: (m) => createPageTransport({ links: account.links, machine: () => m, local }), client });
    account.on("status", (s) => {
      if (appLoaded) { if (s.phase !== "approved") location.reload(); return; }
      render();
    });
    account.on("devices", () => render());
    account.on("links", () => render());
    await account.start();
    render();
  }

  quietHook(() => !appLoaded && !working && !shell.contains(document.activeElement));
  boot().catch((error) => {
    shell.textContent = "";
    const c = card(words.couldNotStart);
    c.appendChild(el("p", "rm-note err", error.message));
    shell.appendChild(c);
  });
}

/** The slow login key, in a worker, so the screen keeps moving. */
export function signInKeysInWorker(password, salt) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./login-worker.js", import.meta.url), { type: "module" });
    const done = (fn, value) => { worker.terminate(); fn(value); };
    worker.onmessage = ({ data }) => (data.keys ? done(resolve, data.keys) : done(reject, new Error("could not derive the login key")));
    worker.onerror = () => done(reject, new Error("could not derive the login key"));
    worker.postMessage({ password, salt });
  });
}

/** Ed25519 and X25519 in WebCrypto: what every client's keys are. */
export async function hasDeviceCrypto() {
  try {
    await crypto.subtle.generateKey("Ed25519", false, ["sign"]);
    await crypto.subtle.generateKey("X25519", false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}
