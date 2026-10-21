/* Remote access, both sides of it.
   The host (this computer's own window): approval cards for every change a remote browser asks for, and
   Settings → Remote (password, address, who is signed in). A remote browser: a read-only chip and Sign out. */
import { el, fmtDuration } from "./lib.js";

export function createRemote({ api, toast }) {
  const $ = (s) => document.querySelector(s);
  let role = "host";
  let pending = [];
  let tick = null;
  const baseTitle = document.title;

  // ------------------------------------------------------------- remote browser
  function initViewer() {
    const chip = $("#accessChip");
    chip.hidden = false;
    chip.innerHTML = "";
    chip.appendChild(el("span", "ac-dot"));
    chip.appendChild(el("span", "ac-lbl", "Read-only"));
    chip.title = "You are signed in remotely. Anything you send or change waits until the host approves it on that computer.";
    const out = el("button", "ac-out", "Sign out");
    out.onclick = async () => { try { await api("/api/remote/logout", {}); } catch { /* */ } location.replace("/"); };
    chip.appendChild(out);
    $("#tabRemote").hidden = true;
  }

  // ----------------------------------------------------------------- host: cards
  function setApprovals(list) {
    const before = new Set(pending.map((a) => a.id));
    pending = Array.isArray(list) ? list : [];
    render();
    const fresh = pending.filter((a) => !before.has(a.id));
    if (fresh.length && document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("Omni Agent: approval needed", { body: fresh[0].title }); } catch { /* */ }
    }
  }

  function render() {
    const box = $("#approvals");
    box.innerHTML = "";
    document.title = pending.length ? `(${pending.length}) Approve? · ${baseTitle}` : baseTitle;
    clearInterval(tick); tick = null;
    if (!pending.length) { box.hidden = true; return; }
    box.hidden = false;
    for (const a of pending) box.appendChild(card(a));
    tick = setInterval(() => { for (const c of box.querySelectorAll(".ap-left")) { const left = Number(c.dataset.exp) - Date.now(); c.textContent = left > 0 ? `${fmtDuration(left)} left` : "expiring"; } }, 1000);
  }

  function card(a) {
    const c = el("section", "ap-card");
    c.setAttribute("role", "alertdialog");
    c.setAttribute("aria-label", `Remote request: ${a.title}`);
    const head = el("div", "ap-head");
    head.appendChild(el("span", "ap-tag", "Remote request"));
    head.appendChild(el("span", "ap-from", `from ${a.ip}`));
    const left = el("span", "ap-left", "");
    left.dataset.exp = String(a.expiresAt);
    head.appendChild(left);
    c.appendChild(head);
    c.appendChild(el("div", "ap-title", a.title));
    if (a.text) c.appendChild(el("div", "ap-text", a.text));
    let route = a.path;
    try { route = decodeURIComponent(a.path); } catch { /* keep it encoded */ }
    const detail = a.detail && typeof a.detail === "object" && Object.keys(a.detail).length ? a.detail : null;
    if (detail) {
      const d = el("details", "ap-detail");
      d.appendChild(el("summary", null, `Details · ${a.method} ${route}`));
      d.appendChild(el("pre", null, JSON.stringify(detail, null, 2)));
      c.appendChild(d);
    } else c.appendChild(el("div", "ap-route mono", `${a.method} ${route}`));
    const bar = el("div", "ap-bar");
    const deny = el("button", "btn", "Deny");
    const ok = el("button", "btn primary", "Approve");
    const decide = async (approve) => {
      deny.disabled = ok.disabled = true;
      try { await api(`/api/remote/approvals/${encodeURIComponent(a.id)}`, { approve }); toast(approve ? "Approved" : "Denied"); }
      catch (e) { toast(e.message, true); deny.disabled = ok.disabled = false; }
    };
    deny.onclick = () => decide(false);
    ok.onclick = () => decide(true);
    bar.appendChild(deny); bar.appendChild(ok);
    c.appendChild(bar);
    return c;
  }

  // ------------------------------------------------------- host: Settings → Remote
  async function loadSettings() {
    const body = $("#remoteBody");
    let st;
    try { st = await api("/api/remote/status"); } catch (e) { body.textContent = e.message; return; }
    body.innerHTML = "";
    const wrap = el("div", "rm-wrap");

    const sec = (title) => { const s = el("section", "rm-sec"); s.appendChild(el("h3", null, title)); wrap.appendChild(s); return s; };

    const where = sec("Address");
    if (!st.enabled) where.appendChild(el("p", "rm-note", "Remote access is off. Start Omni with --remote (the desktop launcher does), or set \"remote\": true in omni.config.json, then restart."));
    else if (!st.listening) where.appendChild(el("p", "rm-note err", `The remote listener did not start: ${st.error || "unknown error"}`));
    else {
      for (const u of st.urls) where.appendChild(el("div", "rm-url mono", u));
      if (!st.relay) where.appendChild(el("p", "rm-note", `From another network: forward TCP ${st.port} on your router to this computer, then open ${st.https ? "https" : "http"}://<your public IP>:${st.port}/ there.`));
      if (st.https) where.appendChild(el("p", "rm-note", `HTTPS${st.selfSigned ? " with a self-signed certificate: the browser warns once. Check that it shows this SHA-256 fingerprint before you type the password:" : ". Certificate SHA-256:"}`));
      else where.appendChild(el("p", "rm-note err", "Plain HTTP: the password and everything you see cross the network readable. Install openssl, or set tlsCert/tlsKey, and restart."));
      if (st.fingerprint) where.appendChild(el("div", "rm-fp mono", st.fingerprint));
    }

    if (st.relay) {
      const net = sec("From anywhere (through your VPS)");
      net.appendChild(el("div", "rm-url mono", st.relay.url));
      const t = st.relay.tunnel;
      const state = !st.relay.listening ? `off: ${st.relay.error || "not started"}` : !t ? "tunnel not started" : t.state === "up" ? "connected" : t.state === "connecting" ? "connecting…" : `down${t.lastError ? `: ${t.lastError}` : ""}`;
      net.appendChild(el("p", `rm-note${t?.state === "up" ? "" : " err"}`, `Tunnel: ${state}`));
      net.appendChild(el("p", "rm-note", "No router setup needed: this PC keeps an outgoing SSH connection to the VPS, and the VPS passes visitors through still encrypted. It can't read the traffic."));
    }

    const pw = sec(st.hasPassword ? "Change the password" : "Set a password");
    if (!st.hasPassword) pw.appendChild(el("p", "rm-note err", "No password yet: remote browsers cannot sign in until you set one."));
    const form = el("form", "rm-form");
    form.onsubmit = (e) => e.preventDefault();
    const p1 = el("input"); p1.type = "password"; p1.placeholder = "New password (12+ characters)"; p1.autocomplete = "new-password";
    const p2 = el("input"); p2.type = "password"; p2.placeholder = "Repeat it"; p2.autocomplete = "new-password";
    const save = el("button", "btn primary", st.hasPassword ? "Change password" : "Set password");
    save.onclick = async () => {
      if (p1.value !== p2.value) return toast("The two passwords differ", true);
      try { await api("/api/remote/password", { password: p1.value }); toast("Password saved; remote browsers were signed out"); loadSettings(); }
      catch (e) { toast(e.message, true); }
    };
    form.appendChild(p1); form.appendChild(p2); form.appendChild(save);
    pw.appendChild(form);

    const who = sec(`Signed in remotely (${st.sessions.length})`);
    if (!st.sessions.length) who.appendChild(el("p", "rm-note", "Nobody."));
    for (const s of st.sessions) {
      const row = el("div", "rm-sess");
      row.appendChild(el("span", "mono", s.ip));
      row.appendChild(el("span", "rm-ua", s.userAgent || ""));
      row.appendChild(el("span", "rm-seen", `active ${fmtDuration(Date.now() - s.lastSeen)} ago`));
      who.appendChild(row);
    }
    if (st.sessions.length) {
      const out = el("button", "btn", "Sign everyone out");
      out.onclick = async () => { try { await api("/api/remote/sessions", null, "DELETE"); toast("Remote browsers signed out"); loadSettings(); } catch (e) { toast(e.message, true); } };
      who.appendChild(out);
    }
    const devs = sec(`Approved devices (${st.devices?.length || 0})`);
    devs.appendChild(el("p", "rm-note", st.deviceApproval ? "A device you haven't approved needs your Approve here once, even with the right password. Removing a device signs every remote browser out." : "Device approval is off (remoteDeviceApproval: false): the password alone signs any device in."));
    for (const d of st.devices || []) {
      const row = el("div", "rm-sess");
      row.appendChild(el("span", "mono", d.ip || ""));
      row.appendChild(el("span", "rm-ua", d.label || "unknown browser"));
      const rm = el("button", "btn small", "Remove");
      rm.onclick = async () => { try { await api(`/api/remote/devices/${encodeURIComponent(d.id)}`, null, "DELETE"); toast("Device removed"); loadSettings(); } catch (e) { toast(e.message, true); } };
      row.appendChild(rm);
      devs.appendChild(row);
    }

    if ("Notification" in window && Notification.permission === "default") {
      const n = el("button", "btn quiet", "Notify me when a request waits");
      n.onclick = () => Notification.requestPermission().then(() => loadSettings());
      who.appendChild(n);
    }
    body.appendChild(wrap);
  }

  function init(access) {
    role = access?.role === "remote" ? "remote" : "host";
    if (role === "remote") initViewer();
  }

  return { init, setApprovals, loadSettings, get role() { return role; } };
}
