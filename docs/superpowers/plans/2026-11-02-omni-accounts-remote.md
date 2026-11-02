# Omni accounts and end-to-end remote control: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One account (email and password, new sign-ins approved by a signed-in device) reaches every signed-in computer from the desktop app, a web page or an iPhone app, with a VPS that routes traffic it cannot read.

**Architecture:** A hub on the VPS holds accounts and tamper-evident device logs and routes opaque frames over WebSockets. One JS crypto core (`ui/account-core.js`) runs in Node, browsers and WKWebView. A desktop's Node server keeps the keys and the hub connection: as host it feeds channel requests into the existing `handle()`; as client it proxies `/remote/<device>/...`, so the UI only prefixes paths. Web and iPhone run the core in the page.

**Tech Stack:** Node built-ins only (hub on Node 20, desktop on Node 24), WebCrypto (Ed25519, X25519, AES-GCM, HKDF, PBKDF2), own scrypt, vanilla JS UI, pywebview, SwiftUI + WKWebView (Xcode 27.1 on the MacBook).

**Spec:** `docs/superpowers/specs/2026-11-02-omni-accounts-remote-design.md`

## Global Constraints

- No npm dependencies anywhere. The hub must run on Node 20.19 (no `node:sqlite`, no global `WebSocket` server).
- scrypt N=2^17, r=8, p=1. Password minimum 12 characters. Recovery code 128 random bits.
- Pending sign-ins expire after 10 minutes. `client` devices expire 30 days after being added. Approval code is 6 digits.
- Hub: `https://tomcamp.tech/` port 443 only. nginx on 80, 8081, 8082, the service on 8733, SSH and `omni-relay` on 4443 keep working throughout.
- SSH: VPS `root@72.62.59.232` with `~/.omni-agent/relay/known_hosts` pinned. MacBook `macbookair@192.168.0.27` with `HostKeyAlias=192.168.0.36` (its address changes; find it again by checking the host key). Never use a password.
- The old relay and `server/access.mjs` stay until the user has used the new path for a week. Removing them is a later request, not part of this plan.
- Work on `feat/mission-orchestrator`. `main` holds another session's uncommitted work: merge with the backup patch and stash pattern, and **do not drop the stash until `git diff --name-only --diff-filter=U` is empty**.
- Local use never depends on the hub: no account, or the hub down, changes nothing for the person at the machine.
- Every failure of a security check is visible in the UI and fails closed.

## Review Focus

1. A machine goes offline or the hub restarts mid-request: the pending action rejects within 30 s with a message naming the machine, and never looks successful. Test in Task 7.
2. A 200 MB file or a video opened on a remote machine: chunks flow with backpressure, memory stays bounded, and over 200 MB in the web page offers a download instead of a blob. Test in Task 7.
3. A laptop sleeps or a phone changes network: the channel re-handshakes on its own and events catch up through the existing seq and `resync`. Test in Task 7.
4. Two devices approve or remove at the same moment: the hub keeps the first entry, the second device refreshes its log and says what happened. Test in Task 4.
5. Hub unreachable at startup, or a wrong clock on a device: the desktop starts as fast as today, and an expired `client` device is judged by the host's clock. Tests in Tasks 6 and 3.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `ui/logo.svg`, `ui/icon-*.png`, `desktop/omni.ico`, `scripts/make-icons.mjs` | The logo and generated sizes |
| `ui/account-core.js` | Crypto: scrypt, key derivation, device keys, approval exchange, channel handshake, frames |
| `ui/device-log.js` | The device log: append, verify, roles, expiry, forks |
| `hub/server.mjs`, `hub/ws.mjs`, `hub/store.mjs`, `hub/omni-hub.service`, `hub/deploy.sh` | The VPS service |
| `server/account.mjs` | Desktop: keys on disk, hub connection, sign-in, approvals, log |
| `server/channel-host.mjs` | Desktop as host: channel requests into `handle()`, gates, audit log |
| `server/channel-client.mjs` | Desktop as client: `/remote/<device>/...` proxy |
| `ui/transport.js`, `ui/account.js`, `ui/web.html` | UI: which machine, account settings, approval cards, web entry page |
| `ios/` | The iPhone app |

## Task 1: The logo

**Files:** Create `ui/logo.svg`, `scripts/make-icons.mjs`, `ui/icon-192.png`, `ui/icon-512.png`, `desktop/omni.ico`, `ios/OmniAgent/Assets.xcassets/AppIcon.appiconset/`. Modify `ui/index.html` (favicon), `desktop/omni_desktop.pyw` (window icon).

- [ ] Draw `ui/logo.svg`: legible at 16 px, no text, follows `DESIGN.md`. Show it to the user.
- [ ] `scripts/make-icons.mjs` rasterises it with headless Chrome: PNG 16, 32, 48, 180, 192, 256, 512, 1024 (1024 opaque for iOS), and writes the ICO.
- [ ] Commit.

## Task 2: Crypto core

**Files:** Create `ui/account-core.js`, `test/account-core.test.mjs`.

**Interfaces, produced:**
- `scrypt(password: Uint8Array, salt: Uint8Array, {N, r, p, dkLen}) → Promise<Uint8Array>`
- `loginKeyFrom(password: string, salt: Uint8Array) → Promise<Uint8Array>` (scrypt, then HKDF, info `omni-login-v1`)
- `newDeviceKeys() → Promise<{sign: CryptoKeyPair, box: CryptoKeyPair, signPub: b64, boxPub: b64}>`; `sign(key, bytes)`, `verify(b64pub, bytes, sig)`
- Approval: `approverCommit() → {commit, random}`; `verifyReveal(commit, random) → bool`; `approvalCode({approverRandom, newRandom, approverPub, newPub, logHead}) → "NNNNNN"`
- Channel: `startHandshake({device, peerPub, logHead}) → {hello, finish(peerHello) → Channel}`, where `Channel` has `seal(bytes) → frame`, `open(frame) → bytes` and throws on a replay, reorder or tamper; `Channel.peerLogHead`

- [ ] Write failing tests: RFC 7914 vectors and a match with `node:crypto` scrypt; sign and verify; a code that changes when any input changes; a full handshake; `open` throwing on a replayed, reordered or altered frame; a handshake failing when `peerPub` is wrong or the transcript was changed.
- [ ] Run: `node --test test/account-core.test.mjs`. Expected: FAIL, module missing.
- [ ] Implement with WebCrypto only, and no Node imports, so the same file loads in a browser. AES-256-GCM with a per-direction counter as nonce. Handshake: X25519 with fresh keys, each side signs the transcript, including its log head.
- [ ] Run the tests. Expected: PASS. Also load the file in headless Chrome and repeat the round trip, including a timed N=2^17 scrypt.
- [ ] Commit.

## Task 3: Device log

**Files:** Create `ui/device-log.js`, `test/device-log.test.mjs`.

**Interfaces, consumed:** `sign`, `verify` from Task 2. **Produced:**
- `createLog({device, recovery}) → log`; `append(log, entry, signerKeys) → log`
- `verifyLog(entries, {now}) → {devices: Map, head, version}`; throws `LogError` naming the bad entry
- `compareLogs(a, b) → "same" | "a-newer" | "b-newer" | "fork"`
- Entry types `create`, `add` `{name, kind, role, signPub, boxPub}`, `remove`, `recover`. Roles `full`, `client`, `recovery`.

- [ ] Write failing tests: a valid chain; a bad signature or hash rejected; a removed device's later entry rejected; a `client` device cannot sign any entry; `client` expiry at 30 days by the verifier's clock (Review Focus 5); `recovery` can sign only `recover`; a `recover` entry replaces the recovery key; a fork detected.
- [ ] Run, implement, run. Expected: PASS.
- [ ] Commit.

## Task 4: Hub

**Files:** Create `hub/server.mjs`, `hub/ws.mjs`, `hub/store.mjs`, `test/hub.test.mjs`.

**Interfaces, produced (WebSocket JSON messages at `/ws`, HTTP at `/api`):**
- `POST /api/register {email, salt, verifierInput, firstLogEntry}`, refused after the first account unless `allowSignup`
- `POST /api/salt {email}` → the salt; a stable fake derived from a hub secret for an unknown email
- `POST /api/login {email, loginKey, signPub}` → `{session, state: "approved" | "pending"}`; same 401 for a wrong password and an unknown email; 5 failures per account and IP in 15 minutes lock
- WS: `log.get`, `log.append {prevHead, entry}` (first valid wins, otherwise `log.conflict` with the current log), `presence`, `pending.list`, `approval.msg {to, opaque}`, `channel.msg {to, opaque}`
- The hub never parses `opaque`. A session cannot route until its `signPub` is on the log, except to approval messages.
- `hub/store.mjs`: JSON files under a data dir, written atomically. `hub/ws.mjs`: RFC 6455 server, about 150 lines, with max frame size and ping.

- [ ] Write failing tests with real sockets on an ephemeral port: register, then registration closed; login verifier stored, password never; a fake salt that stays stable; lockout; a pending session cannot route `channel.msg`; two simultaneous `log.append`, where the second gets `log.conflict` (Review Focus 4); pending expires at 10 minutes (injected clock); frames only reach devices of the same account; WS over-limit frames close the socket.
- [ ] Run, implement, run. Expected: PASS. Run the hub under Node 20 too, on the VPS or with a downloaded binary, before deploying.
- [ ] Commit.

## Task 5: Malicious hub suite, and deployment

**Files:** Create `test/hub-attacks.test.mjs`, `hub/omni-hub.service`, `hub/deploy.sh`.

- [ ] Write the tests with a scripted hub between two real clients, each failing closed and visibly: a key swap during approval, including trying many values after seeing the reveal; a fake log handed to a new device; a replayed old log; two different logs for two devices (`fork`); a hidden newer log, caught through the handshake's log head; replayed, reordered or altered frames; a removed device signing a new entry.
- [ ] Run. Expected: PASS. A failure here is a protocol bug: fix the core, and do not weaken the test.
- [ ] Read `/etc/nginx/conf.d/sites.conf`, then add only a `/.well-known/acme-challenge/` location to the port 80 server. `nginx -t` before reload, and keep a backup of the file. `certbot certonly --webroot -d tomcamp.tech`, with a deploy hook that restarts the hub.
- [ ] `hub/deploy.sh`: copy to `/opt/omni-hub`, a `DynamicUser` systemd service with `CAP_NET_BIND_SERVICE`, state in `/var/lib/omni-hub`, certificates readable through `LoadCredential`.
- [ ] Verify: `curl https://tomcamp.tech/api/health` from the PC is 200 with a valid certificate. The pages on 80, 8081, 8082 and 8733 respond as they did before, and `omni-relay` is active.
- [ ] Commit.

## Task 6: Desktop account and host side

**Files:** Create `server/account.mjs`, `server/channel-host.mjs`, `test/account.test.mjs`, `test/channel-host.test.mjs`. Modify `server/index.mjs` (route channel requests into `handle`, `req.omniChannel`), `server/access.mjs` (gate), `desktop/omni_desktop.pyw` (window token).

**Interfaces, consumed:** Tasks 2 to 4. **Produced:**
- `class Account({dir, hubUrl, log})`: `register`, `signIn`, `signOut`, `status()`, `devices()`, `approve(id)`, `deny(id)`, `remove(id)`, `changePassword`, `recover`; `openChannel(deviceId) → Channel`; emits `approval`, `devices`, `alert`
- `channelAllowed(method, path) → bool` in `server/access.mjs`
- `serveChannel(channel, handle, {device, audit})`: builds request and response objects on streams, and calls the same `handle()` as the local listener
- Window token: `omni_desktop.pyw` generates it and passes it by env `OMNI_WINDOW_TOKEN` and in the first URL. The server swaps it for an HttpOnly, SameSite=Strict cookie `omni_window` and redirects. `/api/account/*` and `/remote/*` require that cookie.
- Audit: `~/.omni-agent/account/audit.jsonl`, each `{at, device, deviceName, method, path}`, no bodies.

- [ ] Write failing tests: keys stored with 0600 and DPAPI on Windows; channel requests reach `handle` and SSE streams flow; refused over a channel: `/api/missions/tool`, `/mcp`, `/api/claude/task`, `kg/load`, `/api/shutdown`; `/api/fs/*` refuses the account folder for both channel and local requests; `/api/account/*` without the cookie is 403 even from loopback; a `client` device refused when "Allow web page access" is off; a removed device's open channel is closed; audit lines written; a server with an unreachable hub starts as fast as without an account (Review Focus 5).
- [ ] Run, implement, run. Expected: PASS, and the whole existing suite too.
- [ ] Commit.

## Task 7: Desktop as client, and the real two-machine test

**Files:** Create `server/channel-client.mjs`, `ui/transport.js`, `ui/account.js`, `test/channel-client.test.mjs`, `test/ui-transport.test.mjs`. Modify `ui/app.js` (`api`, `createStream`), `ui/filepane.js`, `ui/explorer.js` (direct URLs through one helper), `ui/index.html`, `ui/styles.css`.

**Interfaces, produced:**
- `/remote/<deviceId>/<path>` proxies any local path through `openChannel`
- `ui/transport.js`: `setMachine(id | null)`, `api(method, path, body)`, `eventSource(url) → EventSource-like`, `rawUrl(path) → Promise<url>`. Modes: `local` (prefix empty), `proxied` (prefix `/remote/<id>`), `channel` (Task 8).
- `ui/account.js`: machine switcher in the top bar, Settings → Account, approval cards with the code, the security alert, the "Allow web page access" switch, the audit list

- [ ] Write failing tests: a request and an event stream through two real `Account`s and a real hub; a machine dropped mid-request rejects within 30 s naming it (Review Focus 1); hub restart and reconnection, with events caught up through `resync` (Review Focus 3); a 200 MB response under a memory bound through backpressure (Review Focus 2); `setMachine` clears the open chat and reloads state.
- [ ] Run, implement, run. Expected: PASS.
- [ ] Real test: the Windows PC and the Ubuntu machine (`berat@192.168.0.38`) against the deployed hub. Register, approve the second with the code, start a chat on the other machine from each side, open an image, remove one, confirm it is cut off.
- [ ] Merge into `main` with the pattern above, and restart the desktop app when the user has closed it.
- [ ] Commit.

## Task 8: Web page

**Files:** Create `ui/web.html`, `ui/web.js`, `test/ui-web.test.mjs`. Modify `ui/transport.js` (`channel` mode, `rawUrl` into a blob, over 200 MB offers a download), `hub/server.mjs` (serves the static files with HSTS and a strict CSP).

- [ ] Write failing tests: frames over a fake hub drive `api` and `eventSource`; the core's keys are non-extractable; a `client` device has no approve or remove controls; sign-in shows the code and waits.
- [ ] Run, implement, run. Expected: PASS.
- [ ] Deploy. In real Chrome: sign in at `https://tomcamp.tech/`, approve on the desktop, run a chat, then a phone-width check.
- [ ] Commit.

## Task 9: iPhone app

**Files:** Create `ios/OmniAgent/` (SwiftUI app, `WKWebView`, Keychain bridge), `ios/build.sh`. All building runs on the MacBook with `DEVELOPER_DIR=/Applications/Xcode-27.1.0.app/Contents/Developer`, since `xcode-select` needs sudo. Check free space first: 13 GB.

- [ ] Spike in the simulator: does `crypto.subtle` with Ed25519 and X25519 work on a `WKURLSchemeHandler` page? If not, serve the bundled files from a loopback `NWListener` (127.0.0.1 is a secure context). Record the result in the file header.
- [ ] Build the shell: bundled `ui/`, Keychain bridge `keystore.get/put`, `full` role, approval cards work.
- [ ] Simulator test: sign in, approve from the desktop, approve a new web sign-in from the phone, control a machine.
- [ ] Device: with the iPhone 11 unlocked and on the same network, `xcodebuild` with the free team and `devicectl device install app`. Tell the user how to trust the developer on the phone, and that it expires in 7 days. `ios/build.sh` is the reinstall.
- [ ] Commit.

## Task 10: Docs and hand-over

**Files:** Modify `README.md`, `DESIGN.md` if needed. Create `docs/accounts.md`.

- [ ] Document: how to sign in, what the VPS can and cannot see, the web page risk, what to do with a stolen device, recovery, reinstalling the iPhone app, and how to remove the old relay after the week.
- [ ] Run the full suite in the worktree (move `omni.config.json` aside). Expected: all pass, apart from the known timing test, which must pass alone.
- [ ] Commit, and merge with the pattern above.
