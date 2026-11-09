/* The web page's side of its service worker (ui/sw.js): registers it, and acts on a new version taking over.

   The page asks for it only when the hub served the build, which is where /sw.js exists: from source there is nothing to register.
   A new version takes over at once. On a screen where nothing is being typed the page then loads again, on the new version; with the
   app open it stays as it is (the worker still serves its parts) and the next load is the new one. */
export function startServiceWorker({ quiet = () => true } = {}) {
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw || !/-[A-Za-z0-9]{8}\.js$/.test(import.meta.url)) return; // no worker support, or this is source, not the build
  const hadOne = !!sw.controller;
  sw.addEventListener("controllerchange", () => {
    if (hadOne && quiet()) location.reload();
  });
  sw.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => { /* the page works without it, from the network */ });
}
