# Omni accounts and remote control

One account reaches every computer signed in to it, from the desktop app, a web page or (once built) an iPhone app. Your actions travel encrypted between your own devices. The **hub** is the program on the VPS that holds the account and passes the encrypted frames along. It runs at `https://tomcamp.tech/`.

Signing in is optional. An app not signed in works on its own computer as before, and local use never depends on the VPS.

**State of things on 2026-11-03:**

- The hub is live. When it was last deployed (Task 8) no account was on it, so your first registration and first sign-in will be the first real ones over the live connection.
- The old relay is still running. See [Removing the old relay](#removing-the-old-relay). That needs doing.
- The iPhone app is not built yet. See [The iPhone app](#the-iphone-app).
- The web page has only been run in Chrome. Nothing has been run on Safari, Firefox or a real phone.

## First use: creating the account

Do this once, in the desktop app, on the PC that holds the file `~/.omni-agent/account/bootstrap-token`. That token is what lets the hub accept its first account. On any other computer the hub answers that it is closed to registration. Registering deletes the token file.

1. Open Omni with its desktop launcher (**Omni Agent.cmd** or **Omni Agent.command**). A server started with `start.cmd` or `start.sh`, or a launcher reusing a server that was already running, gets no account access, and Settings says "This needs the desktop app". If you see that, close Omni fully and open it with the launcher.
2. Open **Settings → Account**, and choose **Create the account**.
3. Fill in **Email**, **Password**, **Password again** and **Name for this computer**, then press **Create the account**.
4. The **Save your recovery code** screen appears. Copy the code and put it somewhere safe, away from this computer. Press **I saved it**.

**The password.** At least 12 characters. It never reaches the hub.

**The email.** It is a login name only. It is not verified and nothing is ever mailed.

**There is no email reset.** A forgotten password cannot be reset by anyone, because the hub never sees it and changing it needs the current one.

- Devices already signed in keep working.
- You cannot add a device, change the password or recover, since all three need the password. The way out is [recreating the account](#if-you-have-nothing-left).

**The recovery code.** With your password, it gets you back in if you lose every device.

- Once you press **I saved it**, Omni no longer holds a copy and cannot show it again.
- **Not now** hides the screen for this session. The code stays in the protected store on this computer, a banner says "A recovery code is waiting to be saved", and the screen returns at every start.
- **If you lose the code** while you still have devices, the account goes on working. Nothing can issue another from a signed-in device. You are then one lost device away from having to recreate the account, because without any `full` device or the recovery code the account cannot be recovered. Each machine's data stays on that machine either way.

## Adding a device

On the new device, sign in: **Settings → Account → Sign in** in the desktop app, or the [web page](#the-web-page). That gives only a pending session. It can wait for approval and nothing else.

On every online `full` device, a **New sign-in** card appears anywhere in the app. It shows:

- **It says its name is**, **It says it is a**: the new device's own claims, not facts.
- **Address the hub saw**: the IP address as the hub reports it.
- The time it expires. A pending sign-in lasts 10 minutes.

If no `full` device is online, the new device waits. A recovery code is the only other way in.

Then:

1. Press **Review** on one device. Other cards then say it is being reviewed there. One review runs at a time.
2. Both screens show a 6-digit code. **Compare them digit by digit.** Someone in the middle would have to fix their value before seeing yours, so they match by luck one time in a million.
3. Choose what this device is, with the tick box **This is my desktop or phone app**:
   - **Off (the default): a limited web page,** role `client`. It can control machines for 30 days, then must be approved again. It cannot approve or remove devices.
   - **On: full control,** role `full`. It can approve and remove devices and change the password, and it does not expire. A device is listed as a machine only if it is `full` and says it is a desktop.
   - **The choice is yours, not the new device's.** A changed page can claim to be anything. Choosing `full` for something opened in a browser gives that page full control. Tick it only for an app you installed.
   - **A desktop approved with the box off** is not listed as a machine. To fix it, remove it, press **Forget this device** on it, and add it again.
4. If the codes match, press **The codes match: approve** here and **This matches** on the new device. The new device accepts nothing until you press **This matches**.
5. If the codes differ, do not approve. Press **Start again** on the new device, then **Review** on the other. Each failed try is visible, and the app never restarts an exchange by itself. If this keeps happening, someone may be interfering.

**Deny** blocks that attempt. The new device says "A device on the account refused this sign-in." and can try again. Deny anything you did not start. If the attempt was not you, assume your password is out, and change it under **Settings → Account → Change the password**.

An approved device needs no per-action approval. Signed in means full control.

## Choosing a machine

Each desktop app is a host for its own machine and a client for your others. The machine must have Omni running, signed in and online. Nothing is queued for a machine that is offline.

The machine button is in the top bar. It shows **This computer** until you pick another. Its menu lists **Your other machines**, each with a dot for online, its name and a 6-character id. Offline ones cannot be chosen. **Devices and account** opens Settings.

You can tell you are acting on another machine by these:

- The top bar turns over to inverse colours, and shows **On *name*** with the short id. Two machines can share a name, and only the id tells them apart.
- The window title and the composer's caption name the machine, and delete confirmations do too.
- **Back to this computer** appears in the top bar.

Switching reloads the window, so no chat, path or half-typed message carries over from the last machine. A half-typed message is lost.

While on another machine, Settings' Models, MCP servers and Long runs are that machine's. Account and Remote are always this computer's.

**If the link has trouble, a banner says so:**

- "*name* is offline. Nothing you send will reach it, and nothing is queued for later."
- "*name* has stopped answering." A request waiting on it is then rejected by name, about 25 seconds into the silence, saying it may or may not have run there.
- "Still waiting for *name*..." The link is alive and the route is slow, as with a long prompt. It waits as long as the route takes.

**Never allowed from another device:** the agents' own tool endpoints (`/mcp`, `/api/missions/tool`, `kg/load`, `/api/claude/task`), `/api/shutdown`, account actions, the old `/api/remote` routes, and every file route into the account folder.

## The web page

Open **`https://tomcamp.tech/`** by that link, and bookmark it. Include the `https://`. HSTS is deliberately off, because a browser would apply it to the name on every port and break the sites on ports 80, 8081 and 8082. So a typed `tomcamp.tech` goes to the site on port 80, not to the hub.

It needs Chrome 137+, Safari 17+ or Firefox 130+, with site data allowed.

1. Enter **Email**, **Password** and **Name for this page**, and press **Sign in**.
2. "Waiting for approval" appears. Approve it from a desktop app as in [Adding a device](#adding-a-device), leaving the box off.
3. Press **This matches** on the page once the codes agree.
4. Under **Choose a machine**, pick one. The same app then runs on that machine. **All machines** goes back.

What differs from the desktop:

- It cannot create an account or recover one. It cannot approve or remove devices or change the password.
- It ends after 30 days and must be approved again. The machine list shows the date.
- **Sign out** leaves it on the device list until its 30 days run out. **Forget this page** deletes its keys from this browser, and it would have to be approved again. To cut it off from elsewhere, remove it on a `full` device.
- Images, video and audio open in the page. HTML, PDF and anything over 200 MB are offered as a download instead, because a far machine's file must not run in the page.
- Downloads without a save dialog (Safari, Firefox, phones) are refused above 2 GiB.
- A second tab takes over from the first, and the first says so.

### The web page's risk

The page comes from the VPS. You chose this so that one VPS manages everything. In the design's words:

> **A hacked VPS can serve a changed page.** The next time the page is opened, it could capture the password and run actions on machines while that page is open and signed in. Installed apps do not have this problem, because their code is installed.

> **How far the limit goes:** the role limits what the page itself can do on the account, and it cannot write Omni's own files or `omni.config.json` through the file routes. It can still change settings that take effect, such as providers and MCP servers, which run commands. But a signed-in page can still tell an agent on a machine to run commands, and a command runs as the person. So a changed page, while open and signed in, can do real damage to a machine it reaches, up to reading that machine's keys. Treat the page as a convenience for trusted moments, and turn "Allow web page access" off on any machine this matters for.

> **The limits that remain:** the web page is approved as `client`, so it cannot approve or remove devices, or add an attacker's device to the account through the account's own controls. A changed page could claim to be a desktop, so `full` is only ever granted by the person's explicit choice on the approving device: choosing `full` for something opened in a browser would give that page full control. Its access ends when its 30 days run out or it is removed.

**Allow web page access** is in **Settings → Account** on each machine, as the tick box "Let limited web pages control this computer". It is on by default. Turned off, that machine refuses `client` devices and closes any web page connected to it at that moment. Only your desktop and phone apps can then reach it. If its saved settings are damaged, it turns off and says so, until you choose again.

## The iPhone app

> **TO FILL IN when the app is built.** `ios/build.sh` does not exist yet. Nothing here has been run, and the app cannot be installed today. The exact build, install and reinstall steps belong here. Until then, the lines below are what was decided, not a description of something working.

- SwiftUI shell around the same `ui/`, bundled in the app and never loaded from a server. iOS 17+.
- Built on the MacBook over SSH. Installing needs the phone connected and trusted.
- Signed with a free Apple ID, so **the app expires every 7 days and must be reinstalled**. No push notifications. No App Store.
- **Trusting the developer:** iOS normally refuses to open an app signed this way until you allow it, under Settings → General → VPN & Device Management. To be confirmed against the real install.
- Approved as `full`: tick **This is my desktop or phone app** when approving it.
- It cannot create an account or recover one. Do those on a desktop.

## What the VPS can and cannot see

Settings shows this too:

> The hub routes encrypted frames between your devices. It cannot read your actions, results, file contents, chat text or session titles, and it cannot forge an action. It can still see which devices are on the account, when they connect, IP addresses and the size and timing of frames, plus your email address and login verifiers. Someone who hacked the hub could try to guess your password offline; a correct guess only gets a pending sign-in, which one of your devices must still approve.

The hub never receives your password or recovery code. It stores the device list and cannot forge an entry in it. The web page is the exception to "cannot read", [as above](#the-web-pages-risk).

## What this does not stop

In the design's words:

> **A hacked hub working with a stolen device.** It can keep a removal from reaching a machine that no other device is talking to, so the stolen device stays in control there until the machine next talks to a device with the newer log. Refusing to act without proof of a fresh log would close this, but would lock a machine out whenever no other device is online. **My call: no lockout.** The first thing to do with a stolen device is sign out on the machine itself or stop its relay connection.

> **A hacked hub and a recovery.** With a real recovery code, including an old one the person still holds, a device can be shown an older real version of the log from that recovery key, so it may not know about a device removed since. The first channel to any device that has seen more corrects it, and the app tells the person to discard an old code once another device has confirmed the recovery.

> **An agent on the machine.** An agent with a shell runs as the same user. A hijacked agent could read the key file on systems where nothing but file permissions protects it, and DPAPI decrypts for any process of that user. The token and folder block above stop casual and accidental use, not a determined attacker with a shell. A separate key process would raise the bar and is not in this design.

> **The hub sees** which devices exist, when they connect, IP addresses and the size and timing of frames, plus email addresses and login verifiers. A hacked hub can try guessing passwords offline, which only gets it a pending session.

Also:

- **Someone using a device you left unlocked.** Omni has no lock of its own. A `full` device can approve and remove devices, including yours.
- **A hub refusing service.** It can drop connections, block an approval until you press **Start again**, or keep a recovery code "in question". It gains no access by doing so.
- **Signing out does not end the session on the hub.** The hub has no logout, so the session lasts until it expires (180 days, renewed each time the device connects). It is useless without the device's key.

## A stolen device

Order matters: removal first, because a changed password does not cut off a device already on the account.

1. **On another `full` device, go to Settings → Account → Devices and press Remove beside it.** Each machine cuts it off as soon as it sees the new list. It can never come back on that key.
2. **No other `full` device, or the thief removed yours?** Go to [Recovery](#recovery), then do step 1 from the recovered computer.
3. **If you think the hub may be hacked too,** go to each machine that matters and press **Sign out** under **Settings → Account → Leave**, or close Omni there. A removal can be hidden only from a machine no other device is talking to. Alternatively, connect to each machine from a device with the new list: the two compare lists, and the machine then refuses the removed device. Signing out leaves the machine on the device list, and it needs only the password to sign back in.
4. **Change the password** under **Settings → Account → Change the password**, if it could have been saved on or read from that device. No other device needs approving again.
5. **Read what it did:** on each machine, **Settings → Account → What other devices did here**. See [the audit log](#the-audit-log).
6. **If your recovery code was with the stolen device,** the code and your password together make a new `full` device. Changing the password closes that off for as long as the thief lacks the new one. A signed-in device cannot replace the code. The only way to replace it is to run a [recovery](#recovery) from a computer not yet on the account, which also adds that computer.

**A stolen device holding only a web page:** remove it the same way. Otherwise it ends by itself at its 30 days.

## Security alerts

Alerts stay as red banners until you press **I have read this**. Each line is the banner's title, what it means, and what to do. On a web page, "this computer" reads "this page".

- **The hub showed an older device list.** Someone may be hiding a removal, and it was refused. Do not approve or remove anything until another device has confirmed the list.
- **Two different device lists exist.** The hub may be showing different lists to different devices, and this one was refused. Do not approve anything. Check your devices from another computer, and remove any you do not recognise.
- **The hub showed a different account.** It was refused. Do not approve anything. Check the hub address (`account.hub` in `omni.config.json`, `https://tomcamp.tech` by default).
- **The hub showed a false device list.** This computer was told it was approved, but the list does not follow the code you confirmed, so it stays out. Do not type your recovery code here again. Check your devices from another computer.
- **Two of your devices disagree about the device list.** The hub may be hiding a change, and the channel was refused. Check your devices, and try again once both machines are online.
- **The account was recovered with a recovery code.** If that was not you, your recovery code is out and that device has full control. Remove the device it added, and use your recovery code on a device you trust.
- **This computer was removed from the account.** The device list shows it. It still works on its own. If this was not you, sign in again from a device you trust and check the list.
- **One of your devices refused this computer.** The two hold different lists: the hub may be hiding a change, or this computer was removed. Check your devices. If you removed this computer on purpose there is nothing to do.
- **The hub sent a device list that does not check out.** It failed its signatures and nothing changed. If this repeats, check your devices from another computer.
- **A frame on a channel failed its check.** A frame was changed, lost or replayed, and the channel was closed. A new one is opened. If this repeats, someone may be interfering.
- **An approval exchange failed.** Nothing was approved. Press **Start again** on the new device, then **Review** on the device already signed in.
- **The hub says this device was removed.** This is the hub's claim, not a fact this computer could check. Do not forget the device on that word alone. Sign in again to see.
- **The device key cannot be used.** Local use still works. To start over, sign out and forget this device.

Other banners, which are not attacks by themselves:

- **Keep your old recovery code for now.** See [Recovery](#recovery).
- **A recovery code is in question.** The hub's answers do not fit that code, or it has stayed unconfirmed for over 10 minutes. Keep every recovery code you have.
- **A recovery code is waiting to be saved.** Press **Show it**, then save it.
- **"This computer's keys ... are protected by file permissions alone".** DPAPI or Keychain was not available, so any program running as you can read the keys, and any recovery code not yet saved.

## Recovery

Use this only if you have lost every `full` device, or to replace a code that is out. You need your **email, password and recovery code**. Recovery is done in the desktop app. No other device's approval is needed.

1. Use a computer with the Omni desktop app. If it was ever removed from this account, first press **Forget this device** under **Settings → Account → Leave**.
2. Open **Settings → Account → Recover**. The form shows only while this computer is signed out, so press **Sign out** first if it is waiting for approval.
3. Fill in **Email**, **Password**, **Recovery code** and **Name for this computer**, and press **Recover**.
4. **Save your recovery code** shows the replacement. Save it and press **I saved it**. If it says the hub has not confirmed the code yet, keep both codes. **I saved it** appears once this settles, or after 10 minutes unconfirmed.
5. **Keep the old code.** The banner **Keep your old recovery code for now** stays until another device confirms the recovery, by a channel to a device that holds this recovery, or by a later change to the list that this computer did not sign. A hacked hub could have shown this computer an older version of the list. The new code would then be valid only on that false branch, and the old code would still be the live one on the real list.
6. Every other device shows **The account was recovered with a recovery code**. Settings' **Recovery** section lists each recovery.
7. Under **Devices**, remove every device you have lost or do not recognise.
8. Add your other devices as in [Adding a device](#adding-a-device).
9. **When the banner has gone, destroy the old code.** If every old device really is gone, the first device you add clears the banner once a channel opens between them. That is weak proof, since it learned the list from this computer.

If it goes wrong:

- **"This computer was already on the account, so the code you typed was not checked and not used."** No recovery was needed, and the code is still good.
- **"This computer holds a recovery code you have not saved yet."** Save that one first. It may be the live one.
- **Stuck on a code that never settles.** **Give up on this…** then **Delete it and forget this device** is the way out. It deletes the code held here and this device's identity. Write the code down first: if it is the live one, the account may become unrecoverable.

### If you have nothing left

Without any `full` device or a working recovery code, or without the password, the account must be recreated. Each machine's data stays on that machine. **These steps have not been run.** They delete the account on the hub:

```
# On the VPS
systemctl stop omni-hub
rm /var/lib/private/omni-hub/accounts.json /var/lib/private/omni-hub/sessions.json
systemctl start omni-hub
```

A hub starting with no account takes up the token in `/etc/omni-hub/bootstrap.env` again. Then, in this order:

1. On every desktop, press **Forget this device**, since a computer holding the old list cannot register.
2. Put the token back on the PC, without printing it:

   ```
   ssh root@72.62.59.232 "sed -n 's/^OMNI_HUB_BOOTSTRAP_TOKEN=//p' /etc/omni-hub/bootstrap.env" > ~/.omni-agent/account/bootstrap-token
   ```

3. [Create the account](#first-use-creating-the-account) again on the PC, and add the other devices as new.

## Operating it

### The audit log

Each host writes one line per request from another device, refused ones included, to `~/.omni-agent/account/audit.jsonl`: time, device id, device name, method, path. It never holds a body. The query is dropped, except `root` and `path` on file routes. At 5 MB it moves to `audit.1.jsonl`, replacing the older one.

**Settings → Account → What other devices did here** shows the newest 200. It is always that computer's own log, so read it at each machine. A web page does not show it.

### The account folder on each desktop

`~/.omni-agent/account/`. A server on another port uses `account-<port>`.

| File | Holds |
|---|---|
| `keys.json` | Private keys, protected by DPAPI or Keychain, or by file permissions alone with a warning |
| `recovery-code.json` | A recovery code not yet saved, protected the same way |
| `state.json`, `log.json` | Email, name and phase; the longest device list verified so far |
| `settings.json` | Allow web page access |
| `alerts.json` | Alerts |
| `audit.jsonl`, `audit.1.jsonl` | The audit log |

File routes refuse this folder, locally and over a channel. To point a desktop at another hub, set `account.hub` in `omni.config.json`.

### The hub

- **Check it:** `curl https://tomcamp.tech/api/health` should answer 200. On the VPS: `systemctl status omni-hub`, `journalctl -u omni-hub`.
- **Sign-in limits:** over 15 minutes, 5 failures for one account and address, 50 for one account, or 20 from one address lock further tries. The lock is temporary.
- **Sessions:** 180 days, renewed each time a device connects. Past that, the device signs in again.
- **Registration is closed** after the first account. To open it to further accounts, add `OMNI_HUB_ALLOW_SIGNUP=1` on an `Environment=` line in `hub/omni-hub.service`, and deploy.
- **HSTS stays off** (`OMNI_HUB_HSTS_MAX_AGE` is unset), for the reason [above](#the-web-page). A browser keeps the rule for the whole max-age, so a mistake could not be undone from the server. Serving the hub on its own subdomain would be the clean fix.

### `hub/deploy.sh`

Run it after any change to `hub/` or to a file the page serves. Run `bash hub/deploy.sh` from the top of the repository, in Git Bash on the PC. It can be run again safely.

- It replaces `/opt/omni-hub/` with an explicit list of files, installs the unit, and restarts `omni-hub`. Devices reconnect by themselves. The hub's data is not touched.
- It creates `/etc/omni-hub/bootstrap.env` only if missing, and never prints it.
- It does not touch nginx or certbot.
- It logs in as `root@72.62.59.232`, with the VPS host key pinned in `~/.omni-agent/relay/known_hosts`. Override with `OMNI_VPS`, `OMNI_KNOWN_HOSTS` and `OMNI_SSH`.
- A new file in the web page must be added to both `hub/static.mjs` and the list in `hub/deploy.sh`. A test holds them equal.

### The certificate

Let's Encrypt, for `tomcamp.tech`, expiring 2027-01-31. `certbot.timer` on the VPS renews it. Renewal is answered over nginx's port 80 from `/var/www/acme/`, and `renew_hook = systemctl restart omni-hub` makes the hub read the new one.

- **Check:** `certbot renew --dry-run --cert-name tomcamp.tech` on the VPS. A dry run does not run the hook.
- **Not yet seen:** a real renewal running the hook. After the first one, look at the certificate's date with `certbot certificates` and at what the hub serves: `echo | openssl s_client -connect tomcamp.tech:443 -servername tomcamp.tech 2>/dev/null | openssl x509 -noout -enddate`. If they differ, run `systemctl restart omni-hub`.

### Everything changed on the VPS, and how to undo it

Nothing else on the VPS was changed. Comparisons before and after showed only `listen *:443` as new, and nginx on 80, 8081 and 8082, the service on 8733 and `omni-relay` answered the same.

| Change | Undo |
|---|---|
| `/etc/systemd/system/omni-hub.service`, enabled, on 443 | `systemctl disable --now omni-hub; rm /etc/systemd/system/omni-hub.service; systemctl daemon-reload` |
| `/opt/omni-hub/`, code and web page, root-owned | `rm -rf /opt/omni-hub`. To go back one version instead, run `hub/deploy.sh` from the earlier commit |
| `/etc/omni-hub/bootstrap.env`, 0600 in a 0700 root directory | `rm -rf /etc/omni-hub` |
| `/var/lib/private/omni-hub/`, with a `/var/lib/omni-hub` link. **This is the account and its device list** | `rm -rf /var/lib/private/omni-hub /var/lib/omni-hub` |
| Certificate for `tomcamp.tech`, using the existing Let's Encrypt account with no email | `certbot delete --cert-name tomcamp.tech` |
| `/etc/nginx/conf.d/sites.conf`: one `location /.well-known/acme-challenge/` in the port-80 default server. Backup at `/root/sites.conf.bak-20261102` | `cp /root/sites.conf.bak-20261102 /etc/nginx/conf.d/sites.conf; nginx -t && systemctl reload nginx` |
| `/var/www/acme/`, the webroot | `rm -rf /var/www/acme`, after the line above |

To remove everything, work from the top of this table down. The certificate cannot renew without the last two, so remove those only together with it.

## Removing the old relay

**To do later, after a week of real use. You have not asked for this yet, but it does need doing.** Until it is done, the old way stays open: the relay on the VPS still reaches this PC's old password page at `https://72.62.59.232:4443/`. Anyone with that password and one Approve on the host (or a device approved there in the last 180 days) can view your chats and files read-only and ask for changes. The launcher's `--lan` also keeps the same page on this PC's port 4443. The old way is described in the README under its own heading.

These steps come from `relay/setup-vps.sh`, the README and the design. They have not been run.

**Before you start,** check all of these:

- You have used accounts for a week and do not rely on port 4443.
- You have your recovery code, and ideally a second `full` device.
- You have a way onto the VPS other than Omni. SSH as root is not affected by these steps.

**1. Stop the tunnel on the PC.** Remove the `"relay"` key from `omni.config.json`, and restart Omni.

**2. Remove the relay from the VPS.** `systemctl cat omni-relay` first shows where its unit really is.

```
systemctl disable --now omni-relay
rm /etc/systemd/system/omni-relay.service
systemctl daemon-reload
rm -rf /opt/omni-relay
rm /etc/ssh/sshd_config.d/90-omni-tunnel.conf
sshd -t && systemctl reload ssh
pkill -u omni-tunnel; userdel -r omni-tunnel
```

**3. Check.** The first line should print nothing, and the others should answer as they did before:

```
ss -tlnp | grep -E ':(4443|14443)\b'
curl https://tomcamp.tech/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://tomcamp.tech/
curl -s -o /dev/null -w '%{http_code}\n' http://tomcamp.tech:8081/
curl -s -o /dev/null -w '%{http_code}\n' http://tomcamp.tech:8082/
curl -s -o /dev/null -w '%{http_code}\n' http://tomcamp.tech:8733/
```

From a PC behind WARP, a closed port looks like a timeout rather than "refused", so judge 4443 by `ss` on the VPS. Then sign in from a second device, to prove accounts still work.

**4. Remove the code, in a branch, then run the tests:**

- Delete `server/tunnel.mjs`, `relay/`, `ui/login.html`, `ui/remote.js`, `test/remote.test.mjs`. Then correct what `test/stream.test.mjs` and `test/ui-transport.test.mjs` say about them.
- In `server/access.mjs`, delete `RemoteAuth`, `Approvals` and the helpers only they use.
- In `server/index.mjs`, delete the remote listener, the relay listener, the login routes, `/api/remote/*` and the approval routes. Keep the local listener and the channel path. `isHostRequest` and `classify` need rereading once the remote listener is gone.
- In `server/config.mjs`, delete `lan`, `remote*`, `tls*`, `relay` and `relayConfig`. `server/tls.mjs` goes too, if nothing else uses it.
- In `ui/app.js`, `ui/index.html` and `ui/settings.js`, delete `createRemote`, the approval cards, the Read-only chip and the **Settings → Remote** tab. In `ui/web.js`, delete the line that hides `tabRemote`.
- In `desktop/omni_desktop.pyw`, stop passing `--lan`, and update `test/desktop.test.mjs`.
- Delete `scripts/allow-lan.cmd` and `scripts/allow-lan.sh`, and the `--lan` lines in the README.
- Take `remote.js` out of `hub/static.mjs` and `hub/deploy.sh`, then run `hub/deploy.sh`.
- In the README, delete the section "The old way: password and VPS relay", and in this file, delete this section.

**5. Clean up on the PC.**

- Delete `~/.omni-agent/relay/id_ed25519` and `id_ed25519.pub`, `~/.omni-agent/remote-auth.json`, and `~/.omni-agent/tls/`.
- **Keep `~/.omni-agent/relay/known_hosts`.** `hub/deploy.sh` uses it.
- If you ran `scripts\allow-lan.cmd`: `netsh advfirewall firewall delete rule name="Omni Agent"`.
- If you forwarded port 4443 on your router, remove that.
