// Settings → Appearance: the theme is a radiogroup that keeps the focus on the chosen option and moves with the arrow keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withFakeDom } from "./helpers/fake-dom.mjs";
import { renderThemeChoice } from "../ui/appearance.js";

function fakeTheme(start = "dark") { let v = start; const sets = []; return { sets, get: () => v, set: (x) => { v = x; sets.push(x); } }; }
const radios = (body) => body.querySelectorAll("button");
const checked = (body) => radios(body).filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.theme);

test("choosing a theme keeps the focus on the option chosen, and marks it checked", () => withFakeDom((doc) => {
  const body = doc.createElement("div");
  doc.body.appendChild(body);
  const theme = fakeTheme("dark");
  renderThemeChoice(body, theme);
  const light = radios(body).find((b) => b.dataset.theme === "light");
  light.focus();
  light.click();
  assert.deepEqual(theme.sets, ["light"]);
  assert.equal(doc.activeElement, light, "the button pressed is still there, and still focused");
  assert.ok(light.isConnected);
  assert.deepEqual(checked(body), ["light"]);
  assert.ok(light.classList.contains("active"));
  assert.equal(radios(body).filter((b) => b.classList.contains("active")).length, 1);
}));

test("arrow keys move between the options and choose, wrapping; only the chosen one is in the Tab order", () => withFakeDom((doc) => {
  const body = doc.createElement("div");
  doc.body.appendChild(body);
  const theme = fakeTheme("dark");
  renderThemeChoice(body, theme);
  const group = body.querySelector(".dlg-tabs");
  assert.equal(group.getAttribute("role"), "radiogroup");
  assert.deepEqual(radios(body).map((b) => b.tabIndex), [0, -1, -1], "roving tabindex: Tab lands on the checked option");
  radios(body)[0].focus();
  const steps = [["ArrowRight", "light"], ["ArrowDown", "system"], ["ArrowRight", "dark"], ["ArrowLeft", "system"], ["ArrowUp", "light"], ["Home", "dark"], ["End", "system"]];
  for (const [key, want] of steps) {
    const ev = doc.key(key);
    assert.ok(ev.defaultPrevented, `${key} does not scroll the dialog`);
    assert.equal(doc.activeElement.dataset.theme, want, `${key} focuses ${want}`);
    assert.equal(theme.get(), want, `${key} chooses ${want}`);
    assert.deepEqual(checked(body), [want]);
    assert.deepEqual(radios(body).map((b) => b.tabIndex), radios(body).map((b) => (b.dataset.theme === want ? 0 : -1)));
  }
  assert.equal(doc.key("Tab").defaultPrevented, false, "Tab leaves the group as usual");
}));
