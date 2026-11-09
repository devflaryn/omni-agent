import { AccountError } from "./account-error.mjs";

const need = (value, what) => {
  if (typeof value !== "string" || !value || value.length > 4096) throw new AccountError(400, "bad-request", `${what} is required`);
  return value;
};

/** Every /api/account route. The caller has already checked the window cookie and the Origin. Answers, or throws AccountError. */
export async function handleAccountRoutes(req, res, { p, q, account, links, send, readBody, streams }) {
  const post = req.method === "POST";
  const get = req.method === "GET";
  const body = post ? await readBody(req) : {};
  await account.start();
  switch (p) {
    case "/api/account/status": if (get) return send(res, 200, await account.refreshStatus()); break;
    case "/api/account/welcome":
      if (post) return send(res, 200, await account.chooseWelcome(body.choice));
      break;
    case "/api/account/invites":
      if (get) return send(res, 200, await account.invites());
      if (post) return send(res, 200, await account.createInvite());
      break;
    case "/api/account/invites/revoke":
      if (post) return send(res, 200, await account.revokeInvite(need(body.id, "id")));
      break;
    case "/api/account/register":
      if (post) return send(res, 200, await account.register({ email: need(body.email, "email"), password: need(body.password, "password"), name: body.name, inviteCode: body.inviteCode }));
      break;
    case "/api/account/sign-in":
      if (post) return send(res, 200, await account.signIn({ email: need(body.email, "email"), password: need(body.password, "password"), name: body.name }));
      break;
    case "/api/account/restart-exchange":
      if (post) return send(res, 200, account.restartExchange());
      break;
    case "/api/account/sign-out":
      if (post) return send(res, 200, await account.signOut({ forget: body.forget === true }));
      break;
    case "/api/account/devices": if (get) return send(res, 200, { devices: account.devices() }); break;
    case "/api/account/machines": if (get) return send(res, 200, { machines: links.machines() }); break;
    case "/api/account/approvals":
      if (get) return send(res, 200, { pending: account.pendingSignIns(), review: account.status().review });
      break;
    case "/api/account/review":
      if (post) return send(res, 200, await account.review(need(body.id, "id")));
      break;
    case "/api/account/approve":
      if (post) return send(res, 200, await account.approve(need(body.id, "id"), { code: body.code, role: body.role }));
      break;
    case "/api/account/deny":
      if (post) return send(res, 200, await account.deny(need(body.id, "id")));
      break;
    case "/api/account/remove":
      if (post) return send(res, 200, await account.remove(need(body.id, "id")));
      break;
    case "/api/account/password":
      if (post) return send(res, 200, await account.changePassword({ current: body.current, next: body.next }));
      break;
    case "/api/account/recover":
      if (post) return send(res, 200, await account.recover({ email: need(body.email, "email"), password: need(body.password, "password"), recoveryCode: need(body.recoveryCode, "recoveryCode"), name: body.name }));
      break;
    case "/api/account/recovery-code/show":
      if (post) return send(res, 200, await account.showRecoveryCode());
      break;
    case "/api/account/recovery-code/saved":
      if (post) return send(res, 200, await account.recoveryCodeSaved());
      break;
    case "/api/account/settings":
      if (get) return send(res, 200, account.settings());
      if (post) return send(res, 200, await account.setSettings({ allowWebAccess: body.allowWebAccess }));
      break;
    case "/api/account/audit":
      if (get) return send(res, 200, { lines: await account.auditLines(q.get("limit")) });
      break;
    case "/api/account/alerts/clear":
      if (post) { await account.clearAlerts(); return send(res, 200, { ok: true }); }
      break;
    case "/api/account/events":
      if (get) return accountEvents(req, res, account, links, streams);
      break;
    default:
  }
  return send(res, 404, { error: "unknown account route" });
}

/** The window's own stream of account events. Not /events, which also goes to other devices. */
function accountEvents(req, res, account, links, streams) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const push = (name) => (data) => { try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* it went */ } };
  const listeners = Object.fromEntries(["approval", "devices", "alert", "status"].map((name) => [name, push(name)]));
  for (const [name, listener] of Object.entries(listeners)) account.on(name, listener);
  const onLinks = push("links");
  links.on("links", onLinks);
  listeners.status(account.status());
  const beat = setInterval(() => { try { res.write(": ka\n\n"); } catch { /* */ } }, 20_000);
  beat.unref?.();
  streams.add(res);
  req.on("close", () => {
    clearInterval(beat);
    streams.delete(res);
    links.off("links", onLinks);
    for (const [name, listener] of Object.entries(listeners)) account.off(name, listener);
  });
}
