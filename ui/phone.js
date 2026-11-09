/* The iPhone app's start, bundled in the app and never served by the hub. What is its own: the Keychain and the way to the hub, both
   by the shell's bridges; its words; and a haptic tap when it is approved. The screens are web-app.js, shared with the web page.

   It is a client: it hosts nothing, and it approves, removes and recovers nothing (page-account.js has no way to). It is approved as
   `full`, so it does not run out after 30 days. It cannot create an account: that is done in the desktop app. */
import { keychainStore } from "./keychain-store.js";
import { PageAccount } from "./page-account.js";
import { nativeFetch, nativeWebSocket } from "./phone-net.js";
import { hasDeviceCrypto, signInKeysInWorker, startClient } from "./web-app.js";

/** One of the shell's script message handlers, as a promise. A reply of {error} stays a failure. */
function bridgeTo(name) {
  const handler = globalThis.webkit?.messageHandlers?.[name];
  if (!handler) return null;
  return {
    async ask(message) {
      const reply = await handler.postMessage(message);
      if (reply?.error) throw new Error(reply.error);
      return reply?.value ?? null;
    },
  };
}

const keystore = bridgeTo("keystore");
const shell = bridgeTo("shell");
const net = bridgeTo("net");
let deviceName = "iPhone";

startClient({
  client: "phone",
  guessName: () => deviceName,
  supported: async () => !!(keystore && shell && net) && hasDeviceCrypto(),
  open: async () => {
    const hubUrl = await shell.ask({ op: "hub" });
    deviceName = (await shell.ask({ op: "deviceName" })) || deviceName;
    const account = new PageAccount({
      store: keychainStore({
        get: (name) => keystore.ask({ op: "get", name }),
        put: (name, value) => keystore.ask({ op: "put", name, value }),
        remove: (name) => keystore.ask({ op: "remove", name }),
      }),
      hubUrl,
      hubOrigin: new URL(hubUrl).origin,
      name: deviceName,
      kind: "iphone",
      self: "phone",
      deriveKeys: signInKeysInWorker,
      fetchImpl: nativeFetch(net, hubUrl),
      WebSocketImpl: nativeWebSocket(net, hubUrl),
    });
    let phase = null;
    account.on("status", (s) => {
      if (phase === "pending" && s.phase === "approved") shell.ask({ op: "haptic", kind: "success" }).catch(() => {});
      phase = s.phase;
    });
    return account;
  },
  // The Keychain takes new keys only on a fresh page load (ios/OmniAgent/Keystore.swift), so forgetting loads the page again.
  forgotten: () => location.reload(),
  words: {
    signIn: "Your password alone does not get in. One of your computers approves this phone with one tap.",
    nameLabel: "Name for this phone",
    noAccount: "Accounts are made in the Omni desktop app. This phone cannot create or recover one.",
    forget: "Forget this phone",
    forgetConfirm: "Forget this phone?\n\nThis deletes its keys and its copy of the device list from the Keychain. It would have to be approved again as a new device.",
    approveTitle: "Approve this phone",
    approveHow: "Approve it on one of your computers with Approve as an app (full control). The card there shows this same code.",
    waitingHint: "Open Omni on a computer signed in to this account. A card appears there, and a code appears here.",
    noApprover: "None of your computers is online right now, so nothing can approve this phone. Open Omni on one and this goes on from here. It waits for 10 minutes.",
    noneReachable: "None of your machines can be reached right now. The app opens as soon as one can.",
    refusing: "does not answer this phone",
    untilExpiry: (date) => `This phone was approved as limited, so it can act on your machines until ${date}. For full control, remove it on a computer, forget it here, and approve it again with Approve as an app (full control).`,
    cannotGoOn: "This phone cannot go on",
    cannotGoOnText: "The device list kept on this phone failed its checks. Nothing was changed.",
    unsupportedTitle: "This phone cannot run Omni",
    unsupportedText: "Omni needs iOS 17 or later.",
    couldNotStart: "Omni could not start",
  },
});
