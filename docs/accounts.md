# Omni accounts and remote control

One account reaches every computer signed in to it, from the desktop app, a web page or the iPhone app. Your actions travel encrypted between your own devices. The **hub** is the program on the VPS that holds the account and passes the encrypted frames along. It runs at `https://tomcamp.tech/`.

Signing in is optional. An app not signed in works on its own computer as before, and local use never depends on the VPS.

Each account belongs to one person and sees only its own computers. The first account is the hub's **owner**, and other people join with an [invite code](#inviting-someone) from the owner.

**State of things on 2026-11-03:**

- The hub is live. When it was last deployed (Task 8) no account was on it, so your first registration and first sign-in will be the first real ones over the live connection.
- The old relay is still running. See [Removing the old relay](#removing-the-old-relay). That needs doing.
- The iPhone app is built and installed on the owner's iPhone (2026-11-10), but has not signed in to the real hub yet. See [The iPhone app](#the-iphone-app).
- The web page has only been run in Chrome. Nothing has been run on Safari, Firefox or a real phone.

## First use: creating the account

Do this once, in the desktop app, on the PC that holds the file `~/.omni-agent/account/bootstrap-token`. That token is what lets the hub accept its first account, with no invite code. On any other computer creating an account needs an [invite code](#inviting-someone). Registering deletes the token file.

1. Open Omni with its desktop launcher (**Omni Agent.cmd** on Windows; **Omni Agent.app** or **Omni Agent.command** on a Mac).
2. The first time, Omni shows **Welcome to Omni Agent**, with **Sign in**, **Create an account** and **Continue without an account**. Choose **Create an account**. On the PC with the token there is no invite code field. (Later, or if you chose to continue without an account, it is under **Settings → Account → Create an account**.)
3. Fill in **Email**, **Password**, **Password again** and **Name for this computer**, then press **Create the account**.
4. The **Save your recovery code** screen appears. Copy the code and put it somewhere safe, away from this computer. Press **I saved it**.

**Continue without an account** is remembered on that computer, and the welcome screen does not come back. Nothing on it waits for the VPS.

**If Settings → Account says "Signing in is off in this window"**, the window cannot reach this computer's account, and everything else still works:

- "Omni was started without its window": the server was started with `start.cmd` or `start.sh`, or by a launcher that found such a server already running. Close Omni, then open it with the launcher.
- "Another Omni window holds this computer's sign-in": a launcher found an Omni server that another launcher started, and opened a second window on it, or this is a browser tab. Use the first window, or close every Omni window and open Omni again.

The welcome screen is not shown in such a window.

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

On the new device, sign in: on the welcome screen or under **Settings → Account → Sign in** in the desktop app, or on the [web page](#the-web-page). That gives only a pending session. It can wait for approval and nothing else.

On every online `full` device, a **New sign-in** card appears anywhere in the app. It shows:

- **It says its name is**, **It says it is a**: the new device's own claims, not facts.
- **From address**: the IP address as the hub reports it.
- The time it expires. A pending sign-in lasts 10 minutes.

If no `full` device is online, the new device waits. A recovery code is the only other way in.

Then:

1. The card fetches a 6-digit code by itself. The same code appears on the new device. On the other devices' cards it says the sign-in is being approved there. One sign-in is approved at a time.
2. The card says: "Check that the new device shows the same code before you approve." Glance at the new device.
3. Press one of the two buttons. That one tap approves the device, and chooses what it may do:
   - **Approve as an app (full control)**, role `full`. It can approve and remove devices and change the password (the iPhone app cannot yet, see [The iPhone app](#the-iphone-app)), and it does not expire. A device is listed as a machine only if it is `full` and says it is a desktop.
   - **Approve as a web page (limited)**, role `client`. It can control machines for 30 days, then must be approved again. It cannot approve or remove devices.
   - **The choice is yours, not the new device's.** What the device says it is only decides which button comes first and is highlighted: a device that says it is a web page gets the limited button first. A changed page can claim to be a desktop, so choosing full control for something opened in a browser gives that page full control. Choose it only for an Omni app you installed.
   - **A desktop approved as a web page** is not listed as a machine. To fix it, remove it, press **Forget this device** on it, and add it again.
4. Nothing is pressed on the new device. It joins as soon as the approval arrives and checks out.
5. If the codes differ, do not approve. Press **The codes differ** on the new device, then **Get a new code** on the card. Each failed try is visible, and the app never restarts an exchange by itself. If this keeps happening, someone may be interfering.

**Deny** blocks that attempt. The new device says "A device on the account refused this sign-in." and can try again. Deny anything you did not start. If the attempt was not you, assume your password is out, and change it under **Settings → Account → Change the password**.

An approved device needs no per-action approval. Signed in means full control.

### What one tap checks, and the limit you accepted

Before any button appears, and whether or not you look at the code, these checks run and refuse on any failure:

- **The order of the exchange.** The approving device commits to its random value before it sees the new device's, and reveals it only after. So nobody in the middle can try values until the two codes match. A reveal that does not fit the commitment ends the exchange, shows no code, and raises an alert.
- **Signatures.** The new device's name, kind and encryption key are signed with its own key, bound to the approver and to the device list the code was made from. A hub that swaps any of them is caught before the reveal.
- **The device list the new device adopts.** It must verify from the start, add this device right after the list that went into the code, be signed by the device that made the code, and not contradict any list this device held.
- **The account itself.** At sign-in the hub must show a value that only someone with the password can have made, naming the account. The new device checks it against the password before it does anything else, and from then on it joins only that account. This is what stops a hacked hub playing the approver itself and handing a new device a made-up account, now that nobody confirms anything on the new device. The value is made from the password with the same slow derivation as the login key, by a different label, and the hub never receives what makes it.

**The limit, accepted on 2026-11-09:** comparing the code is no longer forced. A hacked hub can show your device a card for a device of its own while you are signing in somewhere else, and every check above passes, because your device really is talking to a device with that key. Only the code gives it away: the card shows a code your new device does not. **If you approve without glancing at the code, a hacked hub's device can get in**, with the role you chose. A stolen password alone still gets nowhere, because nothing is added without your tap. `test/account.test.mjs` has a test named "ACCEPTED LIMIT" that shows this attack working.

## Inviting someone

Other people can have their own accounts on your hub, each seeing only their own computers. Creating an account needs an invite code from the hub's owner.

- **Making one:** on a `full` device of the owner's account, **Settings → Account → Invite someone → Make an invite code**. The code is shown once. Press **Copy** and pass it on. Omni does not keep it and cannot show it again.
- **What it does:** it lets one person create one account, once, within 14 days. They type it under **Create an account**, in any case, with or without the dashes.
- **The list** under **Invite someone** shows each invite as Open, Used or Expired, with dates, never the code. **Revoke** ends an open one at once. Used and expired ones drop off the list 30 days later.
- **Only the owner** sees **Invite someone**. The hub decides who that is: the account created with the bootstrap token. Another account's devices, a web page and a sign-in still waiting for approval are all refused.
- **Nothing crosses between accounts.** Frames, device lists, presence, pending sign-ins and invites stay on their own account, and a device of one account cannot reach a device of another. To the sender, another account's device looks exactly like no device at all.

## Choosing a machine

Each desktop app is a host for its own machine and a client for your others. A machine must have Omni running, signed in and online. Nothing is queued for a machine that is offline.

**Every machine is in one window.** The chats drawer lists the chats of every machine on your account, grouped under each machine's name, with **This computer** first. A few recent chats show per machine; **All chats on *name*** shows the rest of that machine's. The chips above the list show one machine alone. Two machines with the same name carry their 6-character id, so they are never confused.

- An **offline** machine shows as offline, with no chats. Nothing is asked of it until it is back.
- A machine that **does not let web pages in** (its **Allow web page access** is off) shows that on the web page, with no chats. It is not broken.
- A machine that **stops answering** says "not answering" beside its name. Its chats stay on show.
- Each machine's recent chats load on their own, so a slow machine does not hold up the others. Full chat histories load only for the chat you open.
- New chats and chats at work show up live from every machine.

**Opening a chat on any machine** takes the window there. Nothing reloads. A half-typed message stays with its chat, on its machine, and is there when you come back to it. Files with unsaved changes are the one thing asked about first, because the file pane belongs to the machine you are on.

**Starting a chat:** on Home, pick the **Machine**, then its **Working directory**. The machine button in the top bar does the same: its menu lists your machines with a dot for online and the short id. Offline ones cannot be picked. **Devices and account** opens Settings.

You can always tell which machine an action runs on:

- On another machine the top bar turns over to inverse colours and shows **On *name*** with the short id. **Back to this computer** appears beside it.
- The composer's caption starts with **On *name*** (or **On this computer**), the window title names the machine, and every delete, stop or remove confirmation names it.
- The file tree's path starts with the machine's name.

**Per machine:** Settings' Models, MCP servers and Long runs have their own machine picker; they open on the machine you are on. Missions has one too. Account and Remote are always this computer's. The Memory, Graph and Tokens tabs follow the machine you are on.

**If the link has trouble, a banner says so:**

- "*name* is offline. Nothing you send will reach it, and nothing is queued for later." The composer says so too, and does not send.
- "*name* does not let web pages in." On the web page only: turn **Allow web page access** on at that machine to use it there.
- "*name* has stopped answering." A request waiting on it is then rejected by name, about 25 seconds into the silence, saying it may or may not have run there.
- "Still waiting for *name*..." The link is alive and the route is slow, as with a long prompt. It waits as long as the route takes.

**Never allowed from another device:** the agents' own tool endpoints (`/mcp`, `/api/missions/tool`, `kg/load`, `/api/claude/task`), `/api/shutdown`, account actions, the old `/api/remote` routes, and every file route into the account folder.

## The web page

Open **`https://tomcamp.tech/`** by that link, and bookmark it. Include the `https://`. HSTS is deliberately off, because a browser would apply it to the name on every port and break the sites on ports 80, 8081 and 8082. So a typed `tomcamp.tech` goes to the site on port 80, not to the hub.

It needs Chrome 137+, Safari 17+ or Firefox 130+, with site data allowed.

1. Enter **Email**, **Password** and **Name for this page**, and press **Sign in**. It is the same sign-in as the desktop's welcome screen, without **Create an account**.
2. "Approve this page" appears, with a code once a desktop's card has fetched it. Approve it from a desktop app as in [Adding a device](#adding-a-device), with **Approve as a web page (limited)**, which comes first for a page.
3. The app opens on your first online machine, with every machine in the chats drawer, as on a desktop. If none can be reached, the page lists them and opens by itself once one can.

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

> **The limits that remain:** the web page is approved as `client`, so it cannot approve or remove devices, or add an attacker's device to the account through the account's own controls. A changed page could claim to be a desktop, so `full` is only ever granted by the person's own tap on the approving device: choosing full control for something opened in a browser would give that page full control. Its access ends when its 30 days run out or it is removed.

> **What the page keeps in the browser to load fast:** a service worker holds the page's own files, the ones the build lists, each checked against the hash the build recorded, so a repeat visit paints without the hub. It never holds what passes through the page: no API answer, chat text, key or file from a machine (those go over the channel, which it cannot see, and it caches nothing but at install). What this changes for a hacked hub: nothing about what a changed page can do, and nothing about how soon it arrives, since the browser checks the hub for a new worker on every visit. What is new is the way back: once the hub is clean, the first visit after can still show the changed page, from its cache, before the clean worker replaces it, and a page that stays open stays as it was. A worker planted under another name is told by the clean hub to remove itself and its caches. To be sure after an incident, clear the site's data in the browser, which removes the worker and its files.

**Allow web page access** is in **Settings → Account** on each machine, as the tick box "Let limited web pages control this computer". It is on by default. Turned off, that machine refuses `client` devices and closes any web page connected to it at that moment. Only your desktop and phone apps can then reach it. If its saved settings are damaged, it turns off and says so, until you choose again.

## The iPhone app

A SwiftUI shell (`ios/`) around the same built UI as the desktop and the web page (`dist/ui`). The page and its code are inside the app, never loaded from a server, so a hacked hub cannot change them. iOS 17 or later. No App Store, no push notifications.

**What it is on the account:**

- A client. It hosts nothing: the phone is never listed as a machine.
- Approved as `full`: on the desktop's card press **Approve as an app (full control)**, which comes first for a phone. It then does not run out after 30 days.
- It cannot create an account or recover one, and in this version it cannot approve or remove devices or change the password either, though `full` would allow it. Do those on a desktop. **Settings → Account** on the phone says so.
- Its keys and its copy of the device list are in the iOS Keychain, on this phone only (never in iCloud or a backup that restores elsewhere). **Forget this phone** deletes them.
- It talks to `https://tomcamp.tech` and nowhere else. The page's own policy forbids every connection; the app's native side carries the two sign-in calls and the hub's socket to that one address, with the system's normal certificate checks.

**Using it:**

1. Open **Omni Agent** on the phone. Enter **Email**, **Password** and **Name for this phone**, and press **Sign in**. Deriving the login key takes a few seconds on an iPhone 11.
2. "Approve this phone" appears with a 6-digit code. On a desktop, the **New sign-in** card shows the same code. Check it, and press **Approve as an app (full control)**. The phone gives a short tap when it is in.
3. The app opens on your first online machine, with every machine's chats in the drawer, as on a desktop.

### Installing it, and the 7-day reinstall

It is signed with the owner's free Apple ID (team `ZSGGNXRGCM`, bundle id `tech.tomcamp.omniagent`), so **iOS stops opening it 7 days after it was signed**. Its keys stay in the Keychain across a reinstall, so a reinstalled app is still signed in: nothing needs approving again.

Once, on the Mac:

- Xcode (27.1, `/Applications/Xcode-27.1.0.app`) must have the Apple ID signed in: **Xcode → Settings → Accounts → +  → Apple ID**. Without it the build says "No Accounts" and no new 7-day profile can be made. (On 2026-11-10 Xcode had no account signed in; the profile from the first test builds, which expires 2026-11-10 21:16 UTC, was used.)
- Someone must be logged in at the Mac. The app is signed in that login session, where the keychain is open, so nothing asks for a password over SSH.

Once, on the iPhone (already done on 2026-11-10):

- **Settings → Privacy & Security → Developer Mode** on, then restart.
- After the first install: **Settings → General → VPN & Device Management → Apple Development: beratbadem00@gmail.com → Trust**.

**Every 7 days** (or whenever the app stops opening), with the iPhone plugged into the Mac and unlocked, from the repository on the PC in Git Bash:

```
OMNI_MAC_SSH_OPTS="-o HostName=192.168.0.35 -o HostKeyAlias=192.168.0.30" bash ios/build.sh
```

The Mac's address drifts: use the address it has now (`OMNI_MAC_SSH` names the ssh host, `macbook` by default). It builds the UI, sends the committed HEAD to the Mac as a git bundle, builds a release in `~/omni-ios-build`, installs it with `devicectl` and opens it. If it says "Installed, but iOS did not open it", unlock the phone and open the app by hand.

Other modes: `bash ios/build.sh test` runs the unit tests (Keychain bridge, the page's addresses, the hub link) on a throwaway simulator; `sim` builds for the simulator; `debug-device` installs a debug build.

### Trying it against a test hub

A debug build, and only a debug build, can be pointed at another hub. A release build always uses `https://tomcamp.tech`; the code for anything else is not compiled into it.

1. On the Mac, from a checkout: `node ios/scratch-hub.mjs --dir <a new empty folder> --host <the Mac's address> --approve`. It makes a throwaway CA, a hub at `https://<address>:4790`, and a scratch desktop (its own HOME, no model credentials) with an account and two made-up chats, and prints the launch arguments.
2. `bash ios/build.sh debug-device`, then: `xcrun devicectl device process launch --device <UDID> tech.tomcamp.omniagent -- -OmniHub https://<address>:4790 -OmniHubCA <the printed CA>`.
3. The app trusts that one CA for that one hub. iOS asks once to allow access to the local network: allow it. Sign in with the printed email and password; `--approve` approves the phone as `full` after 8 seconds.

A debug build keeps its Keychain items apart from a release build's, so a test never leaves a release build holding a test hub's keys. Stop the scratch hub with Ctrl+C and delete its folder. Reinstall the release build afterwards.

**Tested on 2026-11-10:** on the owner's iPhone 11 (debug build, scratch hub on the Mac) a sign-in was approved as `full` and the scratch machine's chats appeared and opened. The same ran in the simulator (iPhone 17, iOS 27.0), with the code checked on both sides, Settings → Account and the light theme. The release build is installed on the phone. Nothing has signed in to the real hub from the app yet.

## What the VPS can and cannot see

Settings shows this too:

> The hub routes encrypted frames between your devices. It cannot read your actions, results, file contents, chat text or session titles, and it cannot forge an action. It can still see which devices are on the account, when they connect, IP addresses and the size and timing of frames, plus your email address and login verifiers. Someone who hacked the hub could try to guess your password offline; a correct guess only gets a pending sign-in, which one of your devices must still approve.

The hub also keeps, per account, the value that vouches for the account at sign-in (see [What one tap checks](#what-one-tap-checks-and-the-limit-you-accepted)), and the hashes of invite codes. Like the verifier, the vouching value can be used to check password guesses offline. The hub never receives your password or recovery code. It stores the device list and cannot forge an entry in it. The web page is the exception to "cannot read", [as above](#the-web-pages-risk).

## What this does not stop

In the design's words:

> **A hacked hub working with a stolen device.** It can keep a removal from reaching a machine that no other device is talking to, so the stolen device stays in control there until the machine next talks to a device with the newer log. Refusing to act without proof of a fresh log would close this, but would lock a machine out whenever no other device is online. **My call: no lockout.** The first thing to do with a stolen device is sign out on the machine itself or stop its relay connection.

> **A hacked hub and a recovery.** With a real recovery code, including an old one the person still holds, a device can be shown an older real version of the log from that recovery key, so it may not know about a device removed since. The first channel to any device that has seen more corrects it, and the app tells the person to discard an old code once another device has confirmed the recovery.

> **An agent on the machine.** An agent with a shell runs as the same user. A hijacked agent could read the key file on systems where nothing but file permissions protects it, and DPAPI decrypts for any process of that user. The token and folder block above stop casual and accidental use, not a determined attacker with a shell. A separate key process would raise the bar and is not in this design.

> **The hub sees** which devices exist, when they connect, IP addresses and the size and timing of frames, plus email addresses and login verifiers. A hacked hub can try guessing passwords offline, which only gets it a pending session.

Also:

- **Someone using a device you left unlocked.** Omni has no lock of its own. A `full` device can approve and remove devices, including yours.
- **A hub refusing service.** It can drop connections, block an approval until you press **Start again**, or keep a recovery code "in question". It gains no access by doing so.
- **Approving without a glance at the code**, on a hacked hub. See [the limit you accepted](#what-one-tap-checks-and-the-limit-you-accepted).
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
- **The hub showed a false device list.** This computer was told it was approved, but the list does not follow the code it was shown, or is not the account the password vouched for, so it stays out. Do not type your recovery code here again. Check your devices from another computer.
- **The server could not prove it holds your account.** At sign-in, the hub could not show the value only your password makes. This computer did not sign in and nothing changed. Try again later. If it repeats, the hub may have been tampered with: do not sign in on it until you know why.
- **Two of your devices disagree about the device list.** The hub may be hiding a change, and the channel was refused. Check your devices, and try again once both machines are online.
- **The account was recovered with a recovery code.** If that was not you, your recovery code is out and that device has full control. Remove the device it added, and use your recovery code on a device you trust.
- **This computer was removed from the account.** The device list shows it. It still works on its own. If this was not you, sign in again from a device you trust and check the list.
- **One of your devices refused this computer.** The two hold different lists: the hub may be hiding a change, or this computer was removed. Check your devices. If you removed this computer on purpose there is nothing to do.
- **The hub sent a device list that does not check out.** It failed its signatures and nothing changed. If this repeats, check your devices from another computer.
- **A frame on a channel failed its check.** A frame was changed, lost or replayed, and the channel was closed. A new one is opened. If this repeats, someone may be interfering.
- **An approval exchange failed.** Nothing was approved. Press **Start again** on the new device, then **Get a new code** on the device already signed in.
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
- **Sign-up limits:** 10 tries at an invite code per address per hour, right or wrong. Then "Too many tries from this address". A refused try does not spend the code.
- **Limits per account,** so one account cannot use up the VPS: 24 devices, 1024 entries in its device list, 32 connections at once, 5 sign-ins waiting. A recovery is never refused by the device limits: it is the last way back in. The hub holds at most 1000 accounts and 20 open invites.
- **Sessions:** 180 days, renewed each time a device connects. Past that, the device signs in again.
- **Registration needs an invite** after the first account. There is no setting that opens it to anyone: `OMNI_HUB_ALLOW_SIGNUP` is gone, and the hub ignores it. See [Inviting someone](#inviting-someone).
- **The data dir** also holds `invites.json`, the hashes of invite codes, never the codes. Each account records whether it is the owner (`owner: true`), because the order of `accounts.json` changes on every write. A hub with a single account from before this field treats that one as the owner. Accounts created before 2026-11-09 have no vouching value, so a new device cannot sign in to one: change the password on a `full` device of that account, which stores one. The hub had no accounts then.
- **HSTS stays off** (`OMNI_HUB_HSTS_MAX_AGE` is unset), for the reason [above](#the-web-page). A browser keeps the rule for the whole max-age, so a mistake could not be undone from the server. Serving the hub on its own subdomain would be the clean fix.

### `hub/deploy.sh`

Run it after any change to `hub/` or to a file the page serves. Run `bash hub/deploy.sh` from the top of the repository, in Git Bash on the PC. It can be run again safely.

- It replaces `/opt/omni-hub/` with an explicit list of files, installs the unit, and restarts `omni-hub`. Devices reconnect by themselves. The hub's data is not touched.
- It creates `/etc/omni-hub/bootstrap.env` only if missing, and never prints it.
- It does not touch nginx or certbot.
- It logs in as `root@72.62.59.232`, with the VPS host key pinned in `~/.omni-agent/relay/known_hosts`. Override with `OMNI_VPS`, `OMNI_KNOWN_HOSTS` and `OMNI_SSH`.
- The page's files are the build's (`dist/ui`, see the README's "The UI build"). Deploy first checks that the build is what `ui/` makes and stops if not, then copies exactly the files `dist/ui/build.json` lists. A new file in `ui/` needs no list: the build follows the imports.

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
- Run `npm run build`, commit `dist/ui`, then run `hub/deploy.sh`. The build drops `remote.js` by itself once nothing imports it.
- In the README, delete the section "The old way: password and VPS relay", and in this file, delete this section.

**5. Clean up on the PC.**

- Delete `~/.omni-agent/relay/id_ed25519` and `id_ed25519.pub`, `~/.omni-agent/remote-auth.json`, and `~/.omni-agent/tls/`.
- **Keep `~/.omni-agent/relay/known_hosts`.** `hub/deploy.sh` uses it.
- If you ran `scripts\allow-lan.cmd`: `netsh advfirewall firewall delete rule name="Omni Agent"`.
- If you forwarded port 4443 on your router, remove that.
