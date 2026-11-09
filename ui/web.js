/* The web page at the hub: sign in, be approved by one of your devices, choose a machine, and then the same app as the desktop's,
   talking over a channel this page holds itself. The screens are web-app.js, shared with the iPhone app. What is the page's own is
   here: its keys in this browser, the hub it came from, its service worker, and its words. */
import { PageAccount } from "./page-account.js";
import { openPageStore } from "./page-store.js";
import { startServiceWorker } from "./web-sw.js";
import { hasDeviceCrypto, signInKeysInWorker, startClient } from "./web-app.js";

/** The security facts of a web page, short on the card; the whole of it one tap away. Shortened, never dropped. */
const SERVER_SHORT = "A hacked server could change this page. For anything sensitive, use the installed apps.";
const SERVER_NOTICE = "This page comes from the server it connects to. If that server were hacked, it could serve a changed page, which could capture your password and, while open and signed in, run commands on your machines as you, up to reading a machine's keys. Use it for trusted moments. For anything sensitive, prefer the installed apps, and turn Allow web page access off on any machine where this matters.";
const NO_ACCOUNT = "New accounts are made in the Omni desktop app. This page cannot create or recover one.";
const LOG_TEXT = "Your password alone does not get in. One of your computers approves this page with one tap, and then it can use your computers for 30 days.";

const guessName = () => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const place = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${place ? ` on ${place}` : ""} (web page)`;
};

let quiet = () => false;
startServiceWorker({ quiet: () => quiet() });

startClient({
  guessName,
  quietHook: (q) => { quiet = q; },
  supported: async () => (await hasDeviceCrypto()) && !!globalThis.indexedDB,
  open: async () => {
    const store = await openPageStore();
    return new PageAccount({ store, hubUrl: location.origin, hubOrigin: location.origin, name: guessName(), deriveKeys: signInKeysInWorker });
  },
  words: {
    signIn: LOG_TEXT,
    nameLabel: "Name for this page",
    noAccount: NO_ACCOUNT,
    serverShort: SERVER_SHORT,
    serverNotice: SERVER_NOTICE,
    forget: "Forget this page",
    forgetConfirm: "Forget this page?\n\nThis deletes its keys and its copy of the device list from this browser. It would have to be approved again as a new device.",
    approveTitle: "Approve this page",
    approveHow: "Approve it on one of your computers. The card there shows this same code.",
    waitingHint: "Open Omni on a computer signed in to this account. A card appears there, and a code appears here.",
    noApprover: "None of your computers is online right now, so nothing can approve this page. Open Omni on one and this page goes on from here. It waits for 10 minutes.",
    noneReachable: "None of your machines can be reached right now. This page opens as soon as one can.",
    refusing: "does not let web pages in",
    untilExpiry: (date) => `This page can act on your machines until ${date}. After that it must be approved again. It cannot approve or remove devices.`,
    cannotGoOn: "This page cannot go on",
    cannotGoOnText: "The device list kept in this browser failed its checks. Nothing was changed.",
    unsupportedTitle: "This browser cannot run this page",
    unsupportedText: "It needs Chrome 137 or later, Safari 17 or later, or Firefox 130 or later, with site data allowed. The page keeps its keys in this browser, where they cannot be copied out.",
    couldNotStart: "This page could not start",
  },
});
