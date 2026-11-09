// The keyboard layer in a (fake) page: the shortcut sheet keeps the focus, a modal owns the keyboard, focus comes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withFakeDom } from "./helpers/fake-dom.mjs";
import { installKeys, openPalette, openShortcuts, layerOpen, shortcutFor } from "../ui/keys.js";

/** A page with a composer and a button behind whatever opens, and the keys installed with spies. */
function page(doc) {
  const composer = doc.createElement("textarea");
  const menu = doc.createElement("button");
  menu.id = "btnChatMenu";
  doc.body.append(composer, menu);
  const calls = [];
  const spy = (name) => () => calls.push(name);
  installKeys({ palette: () => openPalette(() => [{ title: "Keyboard shortcuts", group: "Actions", run: () => openShortcuts() }]), "new-chat": spy("new-chat"), stop: spy("stop"), files: spy("files"), history: spy("history"), shortcuts: () => openShortcuts(), "focus-composer": () => composer.focus() }, { mac: false });
  return { composer, menu, calls };
}
const inSheet = (doc) => !!doc.querySelector(".kbd-sheet")?.contains(doc.activeElement);

test("the shortcut sheet keeps Tab and Shift+Tab inside itself", () => withFakeDom((doc) => {
  const { composer } = page(doc);
  composer.focus();
  openShortcuts({ mac: false });
  assert.ok(layerOpen());
  for (const shift of [false, false, false, true, true]) {
    const ev = doc.key("Tab", { shiftKey: shift });
    assert.ok(ev.defaultPrevented, "Tab never reaches the page behind");
    assert.ok(inSheet(doc), `focus stays in the sheet: ${doc.activeElement.tagName}#${doc.activeElement.id}.${doc.activeElement.className}`);
  }
  doc.key("Escape");
  assert.equal(layerOpen(), false);
  assert.equal(doc.activeElement, composer, "Esc gives the focus back to where it was");
}));

test("the sheet opened from the palette gives the focus back to where it was before the palette", () => withFakeDom((doc) => {
  const { composer } = page(doc);
  composer.focus();
  doc.key("k", { ctrlKey: true });
  assert.ok(doc.querySelector(".pal"), "the palette opened");
  doc.key("Enter"); // its only row: Keyboard shortcuts
  assert.ok(doc.querySelector(".kbd-sheet"), "the sheet replaced it");
  doc.querySelector(".kbd-close").click();
  assert.equal(layerOpen(), false);
  assert.equal(doc.activeElement, composer);
}));

test("a modal owns the keyboard: no global shortcut acts behind Settings, the account gate or a dialog", () => withFakeDom((doc) => {
  const { composer, calls } = page(doc);
  for (const make of [
    () => { const m = doc.createElement("div"); m.id = "settings"; m.className = "modal"; return m; },
    () => { const m = doc.createElement("div"); m.className = "modal acct-gate"; return m; },
    () => Object.assign(doc.createElement("div"), { className: "ms-dlg-wrap" }),
    () => Object.assign(doc.createElement("div"), { className: "lightbox" }),
  ]) {
    const modal = make();
    const inside = doc.createElement("button");
    modal.appendChild(inside);
    doc.body.appendChild(modal);
    inside.focus();
    calls.length = 0;
    doc.key("/");
    assert.equal(doc.activeElement, inside, `"/" never moves the focus behind ${modal.className}`);
    doc.key("?", { shiftKey: true });
    doc.key("k", { ctrlKey: true });
    assert.equal(layerOpen(), false, `nothing opens over ${modal.className}`);
    for (const [k, mods] of [["b", { ctrlKey: true }], ["\\", { ctrlKey: true }], ["O", { ctrlKey: true, shiftKey: true }], [".", { ctrlKey: true }]]) {
      const ev = doc.key(k, mods);
      assert.equal(ev.defaultPrevented, true, `Ctrl+${k} keeps the browser's own meaning away too`);
    }
    assert.deepEqual(calls, [], `no shortcut acted behind ${modal.className}`);
    // Closed (hidden, or gone), the shortcuts are back.
    if (modal.classList.contains("modal")) modal.hidden = true; else modal.remove();
    doc.body.focus();
    doc.key("/");
    assert.equal(doc.activeElement, composer, "with the modal closed, / reaches the composer again");
    modal.remove();
  }
}));

test("Ctrl+B in the file editor stays the editor's", () => {
  const ev = (o) => ({ key: "b", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(shortcutFor(ev({ target: { tagName: "TEXTAREA", className: "ce-ta", classList: { contains: (c) => c === "ce-ta" } } })), null);
  assert.equal(shortcutFor(ev({ target: { tagName: "TEXTAREA", className: "", classList: { contains: () => false } } })), "files", "the composer keeps it");
});
