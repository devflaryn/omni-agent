import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { highlight, languageFor, tokenize } from "../ui/highlight.js";
import { detectIndent } from "../ui/editor.js";
import { hexDump, absPath } from "../ui/filepane.js";
import { iconFor } from "../ui/fileicons.js";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("the highlighter's tokens cover the text exactly, in every language (the overlay must line up with the textarea)", () => {
  const samples = {
    js: read("server/files.mjs"), css: read("ui/styles.css"), html: read("ui/index.html"), md: read("README.md"), json: read("package.json"),
    py: 'def f(x):\n  """doc\n  string"""\n  return f"{x}" # c\n@dec\nclass A: pass',
    rs: "fn main<'a>() { let s: &'a str = \"x\"; println!(\"{}\", 'c'); }",
    sh: "echo $HOME # hi\nif [ -f x ]; then a=1; fi", yaml: "a: 1\nb: \"x\" # c\n- item", ps1: "<# block #>\n$x = Get-Item -Path \"C:\\\\\" # c",
    smali: ".method public foo()V\n    const/4 v0, 0x1\n.end method", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n", sql: "SELECT * FROM t WHERE a = 'x' -- c",
    unterminated: "const s = \"never closed\n/* nor this",
  };
  for (const [lang, src] of Object.entries(samples)) {
    const l = lang === "unterminated" ? "js" : lang;
    assert.equal(tokenize(src, l).map((t) => t[1]).join(""), src, lang);
  }
});

test("highlight escapes HTML and colours by kind", () => {
  assert.equal(highlight("<b>", "plain"), "&lt;b&gt;");
  const h = highlight("const a = foo(1); // <hi>", "js");
  assert.match(h, /<span class="t-kw">const<\/span>/);
  assert.match(h, /<span class="t-fn">foo<\/span>/);
  assert.match(h, /<span class="t-com">\/\/ &lt;hi&gt;<\/span>/);
  assert.match(highlight("<a href=\"x\">t</a>", "html"), /<span class="t-attr">href<\/span>/);
  assert.match(highlight("diff --git a b\n-x\n+y", "diff"), /t-del">-x<.*t-ins">\+y</s);
});

test("languageFor picks a language from the name", () => {
  assert.deepEqual(["a.tsx", "Dockerfile", "x.unknown", ".gitignore", "Makefile", "b.smali", "c.PS1", "d.mjs", "e.yml"].map(languageFor), ["ts", "docker", "plain", "sh", "make", "smali", "ps1", "js", "yaml"]);
});

test("detectIndent follows the file: tabs, 2 or 4 spaces", () => {
  assert.equal(detectIndent("a\n\tb\n\tc\n"), "\t");
  assert.equal(detectIndent("a\n  b\n    c\n"), "  ");
  assert.equal(detectIndent("a\n    b\n        c\n"), "    ");
  assert.equal(detectIndent("no indent"), "  ");
});

test("hexDump: offset, 16 bytes, printable characters", () => {
  const d = hexDump(new Uint8Array([0x4d, 0x5a, 0x90, 0, 0x41, 0x0a]), 0x10);
  assert.equal(d, `00000010  4d 5a 90 00 41 0a ${" ".repeat(3 * 10 + 1)} MZ..A.\n`);
});

test("absPath joins with the root's own separator; icons by file family", () => {
  assert.equal(absPath("C:\\x\\proj", "src/a.js"), "C:\\x\\proj\\src\\a.js");
  assert.equal(absPath("/home/u/proj/", "src/a.js"), "/home/u/proj/src/a.js");
  assert.deepEqual(iconFor("app.apk"), ["archive", "apk"]);
  assert.deepEqual(iconFor("clip.MP4"), ["video", "media"]);
  assert.deepEqual(iconFor("package.json"), ["data", "npm"]);
});
