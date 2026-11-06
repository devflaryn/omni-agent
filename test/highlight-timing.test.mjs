// A far machine's file is opened in the editor as it comes: no language's rules may be slower than linear on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HIGHLIGHT_BUDGET_MS, LANGUAGES, highlight, tokenize } from "../ui/highlight.js";

const FULL = 600 * 1024; // the editor's HL_MAX
const FULL_BOUND_MS = 15_000; // generous, for a loaded machine: a quadratic rule takes many minutes here
const TENTH_BOUND_MS = 3_000; // tried first, so that a quadratic rule fails in seconds rather than holding the suite
const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

// Repeats of what a rule might start on and then reject at the end of a long run.
const UNITS = [
  "a a ", "a", " ", "\t", "\n", "\r\n", " \n", "a\n", "a:", "a: ", "a =", "=", "a.", ".a", "a-", "-a", "1", "1_", "1.", "1-", "0x", "0xg", "1e", "1e1", "_", "/", "a/", "L/", "L", "\\", "\\\n",
  "\"", "'", "`", "\"a", "'a", "`a", "\"\\", "\"a\" ", "\"a\" :", "[", "[[", "]", "[a", "[a](", "![", "(", "{", "}", "<", "<a", "<a ", "</", "<!", "<!-", "<?", ">", "> ", "&", "&a", "#", "# ", "#[", "#![", "!", "!!", "!a", "*", "**", "*a", "_a", "%", "%a", "%a:", "@", "@a", "@\"", "$", "$a", "${", "$(", "$[", ":", "::", ":a", ";", ",", "|", "|-", "~", "?", "--", "--[", "--[=", "---", "...", "/*", "//", "'''", "\"\"\"", "```", "```a", "r#", "r\"", "<#", "=begin", "[=", "[=[", "<script>", "<script></script>", "<style></style>", "<a b=\"", "<a b='", "&#", "v1", "p1a", ".a-", "a a: ", "a  ", "a\t", "- ", "- a", "@@", "+", "+++ ",
];
// One long token, then something that rejects it.
const LONG = [(n) => `${"1".repeat(n)}a1`, (n) => `${"a".repeat(n)}:x`, (n) => `a${" ".repeat(n)}b`, (n) => `${"-".repeat(n)}a`, (n) => `0x${"f".repeat(n)}g`, (n) => `1e${"1".repeat(n)}a1`, (n) => `.${"1".repeat(n)}a1`, (n) => `${"1".repeat(200)}a1 `.repeat(Math.ceil(n / 203))];
const INPUTS = [...UNITS.map((unit) => (size) => fill(unit, size)), ...LONG];
const timed = (src, lang) => {
  const start = performance.now();
  const tokens = tokenize(src, lang);
  const ms = performance.now() - start;
  assert.equal(tokens.reduce((n, t) => n + t[1].length, 0), src.length, `${lang}: the tokens cover the text`);
  return ms;
};

// Every language on every input small, which shows up a rule that is not linear, then at full size on what was slowest for it.
// All of them at full size would take many minutes even when linear.
test("every language takes a 600 KB file in linear time, on every input tried", () => {
  const worst = [];
  for (const lang of LANGUAGES) {
    let slowest = null;
    for (const input of INPUTS) {
      const ms = timed(input(10 * 1024), lang);
      if (!slowest || ms > slowest.ms) slowest = { ms, input };
    }
    const name = JSON.stringify(slowest.input(20));
    const tenth = timed(slowest.input(FULL / 10), lang);
    assert.ok(tenth < TENTH_BOUND_MS, `${lang} on ${name}: ${Math.round(tenth)} ms at 60 KB`);
    const full = timed(slowest.input(FULL), lang);
    assert.ok(full < FULL_BOUND_MS, `${lang} on ${name}: ${Math.round(full)} ms at 600 KB`);
    worst.push([full, lang, name]);
  }
  worst.sort((a, b) => b[0] - a[0]);
  console.log("slowest at 600 KB:", worst.slice(0, 4).map(([ms, lang, s]) => `${lang} ${s} ${Math.round(ms)} ms`).join("; "));
});

test("the report's case: 160 KB of `a a a` as yaml, and the ini key rule", () => {
  for (const lang of ["yaml", "ini", "toml"]) {
    const start = performance.now();
    tokenize("a ".repeat(80 * 1024), lang);
    assert.ok(performance.now() - start < 5000, lang);
  }
});

test("past its budget the rest of a file is plain: never a frozen window, and the text is all there", () => {
  const src = "a b: \"c\" # d\n".repeat(50_000);
  const start = performance.now();
  const cut = highlight(src, "yaml", 5);
  assert.ok(performance.now() - start < 2000, "stops soon after the budget");
  assert.ok(cut.includes("<span"), "what it reached is coloured");
  assert.equal(cut.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").length, src.length);
  const plain = tokenize(src, "yaml", performance.now() - 1);
  assert.equal(plain.reduce((n, t) => n + t[1].length, 0), src.length);
  assert.ok(plain.length < 200, `it stopped: ${plain.length} tokens`);
  assert.equal(plain.at(-1)[0], null, "and the rest is plain");
  const html = tokenize("<a b='c'></a>\n".repeat(5000), "html", performance.now() - 1);
  assert.equal(html.reduce((n, t) => n + t[1].length, 0), 14 * 5000, "html too");
  assert.ok(html.length < 500, `html stopped too: ${html.length} tokens`);
  assert.ok(HIGHLIGHT_BUDGET_MS <= 1000);
});

test("an ordinary file comes out as it always did", () => {
  const cls = (src, lang) => tokenize(src, lang).filter(([c]) => c).map(([c, t]) => `${c}:${t}`);
  assert.deepEqual(cls("name: x\n- item: 1\nport : 80\nurl: http://a:1\n", "yaml").filter((t) => t.startsWith("prop")), ["prop:name", "prop:- item", "prop:port ", "prop:url"]);
  assert.deepEqual(cls("[core]\nname = x\n; note\n", "ini"), ["type:[core]", "prop:name ", "punct:=", "com:; note"]);
  assert.deepEqual(cls("a.b = 1\n[t]\n", "toml").slice(0, 2), ["prop:a.b", "punct:="]);
  assert.ok(cls("const n = 0x1F + 1.5e3 + 2_000n + .5;", "js").filter((t) => t.startsWith("num")).length === 4);
  assert.ok(cls("> quote\n- item\n[a](b) <t>\n```\ncode\n```\n", "md").some((t) => t.startsWith("com:>")));
  assert.deepEqual(cls("A=1 ${B} $(c)\n", "sh").filter((t) => t.startsWith("var")), ["var:A", "var:${B}", "var:$("]);
  assert.ok(cls("x: y\n\tcmd $(A)\nB := 1\n", "make").some((t) => t === "fn:x"));
  assert.ok(cls(".method Lcom/a/B;\n", "smali").includes("type:Lcom/a/B;"));
});
