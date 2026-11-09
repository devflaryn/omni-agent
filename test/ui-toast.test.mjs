// Toasts are announced from a live region that is on the page before they arrive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withFakeDom } from "./helpers/fake-dom.mjs";
import { createToasts } from "../ui/toast.js";

test("the toast box is a polite live region from the start; a toast is text added to it, an error an alert", (t) => withFakeDom((doc) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const toast = createToasts(box);
  assert.equal(box.getAttribute("aria-live"), "polite", "live before the first toast, so screen readers watch it");
  const ok = toast("Copied");
  assert.equal(ok.getAttribute("role"), null, "a status role arriving already filled is often skipped; the box announces it");
  assert.equal(toast("Failed", true).getAttribute("role"), "alert");
  assert.match(readFileSync(new URL("../ui/index.html", import.meta.url), "utf8"), /<div id="toasts" aria-live="polite"><\/div>/);
  t.mock.timers.runAll();
}));
