# Omni accounts and end-to-end remote control

Status: approved 2026-11-02. Marked **(my call)** where the user did not decide; everything else is what they asked for.

## Why

Today one PC serves its own UI through a blind TLS relay on the VPS (`72.62.59.232:4443`, `server/tunnel.mjs`, `relay/omni-relay.mjs`). There is one password per PC, every change waits for an Approve on that PC (`server/access.mjs`), and one machine cannot see another.

The user wants it to work like the Claude app: one account, used from the desktop app, a web page or an iPhone, reaching every computer signed in to that account. Their words: "the desktop app should be both able to handle the remote events and open new actions on the host pc as well".

## Goals

- **Accounts.** Register and sign in with an email and a password.
- **One app, both roles.** Each desktop app is a host for its own machine and a client for every other machine on the account. It has a machine switcher.
- **Other clients.** A web page and a native iPhone app. Both control machines like a desktop client does. The web page cannot approve or remove devices (see The web page).
- **What crosses the VPS.** Actions, results, images and folder data. No UI is served by a host to a remote client. Clients carry their own UI.
- **The VPS cannot read it.** Actions, results, file contents, chat text and session titles are encrypted between devices. The VPS cannot forge an action either.
- **New sign-ins need two things.** The password and approval from a device already signed in.
- **Signed in means full control.** An approved device needs no per-action approval. The current approval cards are removed.

## Non-goals

- Sharing a machine with other people, teams or roles.
- Reaching a machine that is offline, or queueing actions for it.
- Password reset by email. The VPS cannot do it without being able to read data (see Recovery).
- A Mac, Android or Windows phone app.
- App Store release.

## Anti-goals: failures even if everything else works

- A hacked VPS can run a command on a PC, or read a chat, through the desktop or iPhone app. The user accepted one exception, the web page (see The web page).
- A stolen password alone gets anyone anywhere.
- A device removed from the account keeps control, unless the hub is hacked as well (see What this does not stop).
- An action or event silently fails to reach the other side while the UI shows success.
- The local app gets slower or stops working when the VPS is down. Local use never depends on the VPS.

## The parts

```
 desktop A (host + client)                VPS: omni-hub                    desktop B (host + client)
 web page / iPhone (client)   ──wss──▶  accounts, device log, routing   ◀──wss──  outgoing only, no router setup
        └────────────── encrypted frames the hub cannot read ──────────────┘
```

### 1. The hub (`hub/`, on the VPS)

It holds: account records, login verifiers, device logs, pending sign-ins, and which device is online. It routes opaque frames between devices of the same account.

- Node with built-ins only, as a systemd service like `omni-relay` with a throwaway user.
- Listens on 443, free today. nginx (80, 8081, 8082), the service on 8733 and SSH are not touched.
- Serves the web page and `wss://` at `https://tomcamp.tech/` with a Let's Encrypt certificate. The user wants this one VPS to host everything, with no outside service.
- Storage is a file or `node:sqlite` under `/var/lib/omni-hub` (builder's choice).
- **Registration closes after the first account (my call):** the hub is a personal service. A hub setting reopens it.
- **Email is a login name only (my call):** nothing is ever mailed, so no mail server. Addresses are not verified.

### 2. Signing in

The password never reaches the hub.

- The client runs scrypt on the password with a per-account salt from the hub, then HKDF to split it into a `loginKey`. The hub stores only a scrypt hash of `loginKey`.
- scrypt parameters **(my call)**: N=2^17, r=8, p=1. Password minimum 12 characters.
- Sign-in attempts are limited per account and per IP, as in the existing lockout in `server/access.mjs`.
- The same response is given for a wrong password and an unknown email, including a stable fake salt for unknown emails.

### 3. Device trust

- Every device makes its own keys on first run: Ed25519 to sign, X25519 to receive encrypted data. Private keys never leave it:
  - Desktop: a file readable only by the user under `~/.omni-agent/account/`, protected with DPAPI on Windows and Keychain on macOS where available.
  - Web: non-extractable WebCrypto keys in IndexedDB.
  - iPhone: wrapped by a Keychain key.
- There is **no shared account key**. Sharing one would let a removed device sign itself back in. Trust is a **device log**: an append-only list where each entry holds the hash of the entry before it and is signed by a device that is on the list at that point.
- Entry types: `create`, `add` (name, kind, role, both public keys), `remove`, `recover`.
- Each device records a **role**: `full` (desktop, iPhone: can approve and remove) or `client` (web: cannot sign entries). A `client` entry expires 30 days after it was added and the web page must be approved again **(my call)**.
- The hub stores the log and cannot change it. Every device replays it from the start and checks every signature and hash. A removed device's later signatures are invalid, because it is no longer on the list at that point.
- The hub accepts the first valid entry at each position. Devices also compare their log head inside every signed handshake (section 6). A device that sees a longer valid log adopts it. A device that sees two different entries at one position shows a security alert and refuses that channel.

### 4. Approving a new sign-in

1. The new device signs in with email and password. That gives only a **pending** session: it can wait for approval and nothing else.
2. Every online `full` device shows a card: device kind and name, IP address as seen by the hub. The person presses **Review** on one. The other cards then say it is being reviewed there. One review at a time **(my call)**.
3. The exchange, in this order. The order is what stops a hacked hub from trying values until the codes match:
   1. The approver sends a commitment: `H(approver_random)`.
   2. The new device, having received it, sends its own fresh random value.
   3. The approver reveals `approver_random`. The new device checks it against the commitment.
4. Both compute the 6-digit code from both random values, both devices' public keys and the log head. Anyone in the middle would have to fix their value before seeing the other side's, so they match by luck one time in a million, and each failed try is visible to the person.
5. The person checks the codes match, chooses what this device is, and approves. **The role is the person's choice, never the new device's claim:** it defaults to `client`, and `full` needs an explicit "This is my desktop or phone app", because a tampered page can claim to be anything. The approver appends a signed `add` entry. The new device verifies the log against the head that went into the code, so the hub cannot hand it a fake account. It adopts no log and acts on nothing before the person has confirmed the code, and never restarts an exchange on its own.
6. Pending sign-ins expire after 10 minutes. Denying one blocks that attempt.

If no `full` device is online, the page says so and waits. Recovery is the only other way in.

The password check happens on the hub, so "password and approval" protects against someone who stole the password. A hacked hub could show approval cards without a password, but it still cannot get past the person and the code **(my call)**.

### 5. Recovery

At registration the app shows a **recovery code once** (my call; 128 random bits, grouped for typing). A signing key derived from it is on the log as a special `recovery` device. The hub holds no secret for it. Every entry that introduces a recovery key also carries a signature by that new key, so nobody without the private key can build a log, fake or real, naming it. Before signing anything, a recovering device checks that the log's current recovery key is the one its code derives. Without this, a hacked hub could hand it a fake account built on the public key (found by the attack tests).

With email, password and the code, a new device appends a `recover` entry signed by that key, adding itself and replacing the recovery key with a new one, whose new code it shows once. The entry is in the log, so every device shows a prominent notice.

Without any `full` device or the recovery code, the account cannot be recovered and must be recreated. Each machine's data stays on that machine.

Changing the password needs a `full` device. It changes `loginKey` only and does not touch device keys, because nothing is encrypted with the password.

### 6. Connecting to a machine

- A client opens a channel to a machine through the hub. They run an X25519 handshake with fresh keys, each signing the transcript with its device key, and each checks the other is on the device log. The signed transcript includes each side's log head, so either side catches a hub hiding a newer log, as long as the two sides have seen different logs. Traffic uses AES-256-GCM with a counter per direction.
- Fresh keys per channel give forward secrecy. A replayed or reordered frame is rejected.
- A device removed from the log is cut off by every machine as soon as the machine sees the new log.
- **The hub can still see** which devices are on the account, when they connect, IP addresses and the size and timing of frames. This is stated in the app.

### 7. What travels: the app's own API

Omni's UI already talks to its server only through `api()` and the `/events` stream. The channel carries those:

- `{ id, method, path, body }` → `{ id, status, body }`, with large bodies in chunks.
- `/events` as a stream over the channel, with the existing seq, ring and `resync` behaviour unchanged.
- Files, images and archives (`/api/fs/raw`, `archive-entry`) as chunked responses turned into blob URLs on the client. Everything in `ui/` that uses a direct URL must go through one helper.

On the host, the channel feeds requests into the same route handler the local listener uses, with `req.omniAccountDevice` set rather than `omniHost`:

- Allowed: everything the person at the machine can do, including Settings (except below).
- **Never over a channel (my call):** the agents' own tool endpoints (`/api/missions/tool`, `/mcp`, `kg/load`, `/api/claude/task`), since acting as an agent is not a user request. Also `/api/shutdown`, so nobody strands a machine they cannot restart. Also the account key folder, which every file route must refuse, so one machine's device cannot copy another machine's keys.
- **Account actions on the local server (my call):** approving, removing a device or opening a channel to another machine needs a token handed only to the desktop window at launch, not just a loopback connection. Otherwise any agent on the machine could call those routes, since today a loopback request counts as the person at the machine.

Every remote action is written to a local audit log on the host, with the device name. Settings shows it **(my call)**.

### 8. The clients

- **Desktop.** `ui/` gets a transport layer: `local` (today's fetch and EventSource) or `channel`. A machine switcher in the top bar lists the account's machines with online state. The running desktop app's Settings has Account (sign in, devices, remove a device, change password, recovery) and approval cards appear anywhere in the app. Signing in is optional: an app not signed in works locally as today.
- **Web page.** The same `ui/` plus the crypto core, as static files. Needs Chrome 137+, Safari 17+ or Firefox 130+ for X25519 and Ed25519 in WebCrypto. Served by the hub (see The web page).
- **iPhone.** SwiftUI shell (sign-in, Keychain, notifications later) around a WKWebView showing the same `ui/` **bundled in the app, never loaded from a server** (my call). One UI and one crypto core to keep correct, instead of two. iOS 17+. It is built on the MacBook over SSH. Installing on a phone needs that phone connected and trusted.

### 9. Removing the old way

Once the new path has worked for a week of the user's real use: delete `server/tunnel.mjs`, the remote listener, `RemoteAuth`, `Approvals`, the approval UI, and `relay/`, and stop `omni-relay` on the VPS. Until then both run. **(my call: this avoids locking the user out during the change.)**

## The web page

The user chose to host the page on the VPS, so that one VPS manages everything. They were told the consequence, and it is recorded here so nobody assumes otherwise:

- **A hacked VPS can serve a changed page.** The next time the page is opened, it could capture the password and run actions on machines while that page is open and signed in. Installed apps do not have this problem, because their code is installed.
- **How far the limit goes:** the role limits what the page itself can do on the account, and it cannot write Omni's own files or `omni.config.json` through the file routes. It can still change settings that take effect, such as providers and MCP servers, which run commands. But a signed-in page can still tell an agent on a machine to run commands, and a command runs as the person. So a changed page, while open and signed in, can do real damage to a machine it reaches, up to reading that machine's keys. Treat the page as a convenience for trusted moments, and turn "Allow web page access" off on any machine this matters for.
- **The limits that remain:** the web page is approved as `client`, so it cannot approve or remove devices, or add an attacker's device to the account through the account's own controls. A changed page could claim to be a desktop, so `full` is only ever granted by the person's explicit choice on the approving device: choosing `full` for something opened in a browser would give that page full control. Its access ends when its 30 days run out or it is removed.
- **A switch on each machine (my call):** Settings has "Allow web page access", on by default. Turned off, that machine refuses `client` devices, so someone worried about the VPS can stay protected on desktop and iPhone.

## What this does not stop

Stated so nobody assumes otherwise:

- **A hacked hub working with a stolen device.** It can keep a removal from reaching a machine that no other device is talking to, so the stolen device stays in control there until the machine next talks to a device with the newer log. Refusing to act without proof of a fresh log would close this, but would lock a machine out whenever no other device is online. **My call: no lockout.** The first thing to do with a stolen device is sign out on the machine itself or stop its relay connection.
- **A hacked hub and a recovery.** With a real recovery code, including an old one the person still holds, a device can be shown an older real version of the log from that recovery key, so it may not know about a device removed since. The first channel to any device that has seen more corrects it, and the app tells the person to discard an old code once another device has confirmed the recovery.
- **An agent on the machine.** An agent with a shell runs as the same user. A hijacked agent could read the key file on systems where nothing but file permissions protects it, and DPAPI decrypts for any process of that user. The token and folder block above stop casual and accidental use, not a determined attacker with a shell. A separate key process would raise the bar and is not in this design.
- **The hub sees** which devices exist, when they connect, IP addresses and the size and timing of frames, plus email addresses and login verifiers. A hacked hub can try guessing passwords offline, which only gets it a pending session.

## Build order

Each step is usable and tested alone.

1. Crypto core (one JS module usable in Node, browser and WKWebView) and hub, with tests including a malicious hub.
2. Desktop as host and client, between two machines. The Windows PC and the Mac or Ubuntu machine make a real test.
3. Web page.
4. iPhone app.
5. Remove the old relay.

Tests must include a hub that: swaps keys during approval and tries many values after seeing the reveal; hands a new device a fake log; replays an old log, shows two different logs to two devices, or hides a newer one; replays, reorders or tampers with frames. Also a removed device that signs a new entry. Each must fail closed and be visible.

## Decided by the user

- **Web page and hub:** on the VPS, at `https://tomcamp.tech/` on port 443, free today. Other ports are not touched.
- **iPhone signing:** a free Apple ID. The app expires every 7 days and needs reinstalling, and there are no push notifications. The user accepts this.
- **Logo:** one small logo for the desktop app, web page and iPhone app.

## Left to the builder

File layout under `hub/`, the frame and log encoding, chunk sizes, storage engine, reconnect timing, UI placement beyond what is stated.
