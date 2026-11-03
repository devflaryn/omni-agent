// What the web page is made of: nothing in ui/ may need what its CSP forbids, or what the iPhone's web view lacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const uiDir = new URL("../ui/", import.meta.url);
const uiSource = (f) => readFileSync(new URL(f, uiDir), "utf8");

test("no direct URL can reach a frame or a window: no UI file frames or navigates to a file's bytes", () => {
  for (const f of readdirSync(uiDir).filter((x) => x.endsWith(".js"))) {
    const src = uiSource(f);
    assert.doesNotMatch(src, /createElement\(["']iframe|el\(["']iframe|srcdoc|\.showModal\(\s*rawUrl/i, `${f} frames something`);
    assert.doesNotMatch(src, /window\.open\(/, `${f} opens a window`);
    assert.doesNotMatch(src, /location\.(href|assign|replace)\s*(=|\()\s*(?!["'`]\/["'`])/, `${f} navigates by a computed URL`);
  }
});

test("the app's HTML has no inline script, handler or style, and no remote anything: all would die under the page's CSP", () => {
  for (const f of ["web.html", "index.html"]) {
    const html = uiSource(f);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: inline handler`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${f}: inline style`);
    assert.doesNotMatch(html, /<style\b/i, `${f}: style block`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, `${f}: inline script`);
    assert.doesNotMatch(html, /(src|href)=["'](https?:)?\/\//i, `${f}: remote resource`);
  }
  for (const f of readdirSync(uiDir).filter((x) => x.endsWith(".css"))) {
    assert.doesNotMatch(uiSource(f), /@import|url\(["']?(https?:)?\/\//, `${f}: remote resource`);
  }
  for (const f of readdirSync(uiDir).filter((x) => x.endsWith(".js"))) {
    const src = uiSource(f);
    assert.doesNotMatch(src, /\bnew Function\(|[^.\w]eval\(/, `${f}: eval`);
    assert.doesNotMatch(src, /setAttribute\(["']style/, `${f}: a style attribute, which the CSP blocks`);
    assert.doesNotMatch(src, /(innerHTML|insertAdjacentHTML)[^;\n]*style=/, `${f}: a style attribute in HTML, which the CSP blocks`);
    assert.doesNotMatch(src, /(innerHTML|insertAdjacentHTML)[^;\n]*\son[a-z]+=/, `${f}: an inline handler in HTML, which the CSP blocks`);
  }
});

test("the shared modules touch nothing Node-only, so the iPhone app can load them too", () => {
  for (const f of ["emitter.js", "account-error.js", "channel-set.js", "channel-client.js", "machine-links.js", "hub-socket.js", "log-trust.js", "page-account.js", "page-store.js", "page-transport.js", "page-files.js"]) {
    const src = uiSource(f);
    assert.doesNotMatch(src, /from "node:|require\(|process\.|\bBuffer\.from\((?!.*NodeBuffer)/, f);
  }
});
