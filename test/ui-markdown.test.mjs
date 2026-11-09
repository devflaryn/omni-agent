import { test } from "node:test";
import assert from "node:assert/strict";
import { md, mdBlocks, closeOpen, safeHref, fenceLang } from "../ui/markdown.js";
import { md as libMd } from "../ui/lib.js";
import { readFileSync } from "node:fs";

const HOSTILE = `<img src=x onerror=alert(1)><script>alert(2)</script>"'&<svg/onload=alert(3)>`;
/** Every tag in the output is one the renderer makes, and no attribute is anything but the few it writes. */
function onlyOwnMarkup(html) {
  const tags = /<\/?([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*\/?>/gi;
  const allowed = new Set(["p", "br", "strong", "em", "del", "code", "pre", "a", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "div", "figure", "figcaption", "span", "button", "input"]);
  // No style attribute, ever: the hub serves this page under `style-src 'self'`, which blocks one (and logs a violation).
  const attrs = new Set(["class", "href", "target", "rel", "data-lang", "type", "disabled", "checked", "start", "title", "aria-label"]);
  let m;
  const stripped = html.replace(tags, (whole, tag, a) => {
    assert.ok(allowed.has(tag.toLowerCase()), `tag ${tag} in ${html}`);
    for (const at of a.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) {
      assert.ok(attrs.has(at[1].toLowerCase()), `attribute ${at[1]} in ${whole}`);
      if (at[1] === "href") assert.match(at[2], /^(https?:|mailto:|#)/i, whole);
    }
    return "";
  });
  assert.doesNotMatch(stripped, /[<>]/, `a stray bracket survived: ${stripped}`);
  void m;
}

// ------------------------------------------------------------------ injection
test("hostile text is text, in every construct", () => {
  const cases = [
    HOSTILE,
    `# ${HOSTILE}`,
    `> ${HOSTILE}`,
    `- ${HOSTILE}\n  - ${HOSTILE}`,
    `1. ${HOSTILE}`,
    `- [ ] ${HOSTILE}`,
    `| ${HOSTILE} | b |\n|---|---|\n| ${HOSTILE} | \`${HOSTILE}\` |`,
    `\`\`\`${HOSTILE}\n${HOSTILE}\n\`\`\``,
    `\`\`\`js" onclick="x\n1\n\`\`\``,
    `**${HOSTILE}** *${HOSTILE}* ~~${HOSTILE}~~ \`${HOSTILE}\``,
    `[${HOSTILE}](https://a.example/${HOSTILE})`,
    `<https://a.example/"onmouseover="alert(1)>`,
    `https://a.example/"><script>alert(1)</script>`,
    `![${HOSTILE}](https://a.example/x.png)`,
  ];
  for (const c of cases) {
    const out = md(c);
    onlyOwnMarkup(out);
    assert.doesNotMatch(out, /<(img|script|svg|iframe|style)\b/i, c);
    assert.doesNotMatch(out, /<[^>]*\son[a-z]+=/i, c);
  }
});

test("links: only http, https and mailto are links; anything else stays text", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<b>", "vbscript:x", "file:///C:/x", "//evil.example/x", "&#106;avascript:alert(1)"]) {
    const out = md(`[click](${href})`);
    assert.doesNotMatch(out, /<a /, `${href} → ${out}`);
    assert.match(out, /click/);
  }
  assert.equal(safeHref("https://example.com/a?b=1&c=2"), "https://example.com/a?b=1&c=2");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("https://a/\"x"), null, "a quote can never reach an attribute");
  const out = md("[docs](https://example.com/a?b=1&c=2)");
  assert.equal(out, '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
});

test("an attribute can never be broken out of", () => {
  assert.doesNotMatch(md('[click](https://example.com/"onmouseover="alert(1))'), /href="[^"]*"onmouseover/);
  assert.doesNotMatch(md("<img src=x onerror=alert(1)>"), /<img/);
  assert.doesNotMatch(md('```a"b<c\nx\n```'), /data-lang="a"b/);
});

test("the old import path still renders through the new renderer", () => {
  assert.equal(libMd("**hi** <b>"), md("**hi** <b>"));
});

// ------------------------------------------------------------------ constructs
test("paragraphs, soft breaks, emphasis, strikethrough", () => {
  assert.equal(md("**hi** <b>"), "<p><strong>hi</strong> &lt;b&gt;</p>");
  assert.equal(md("a *b* _c_ ~~d~~ __e__"), "<p>a <em>b</em> <em>c</em> <del>d</del> <strong>e</strong></p>");
  assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
  assert.equal(md("snake_case_name and 2 * 3 * 4"), "<p>snake_case_name and 2 * 3 * 4</p>");
  assert.equal(md("***both***"), "<p><em><strong>both</strong></em></p>");
  assert.equal(md("**unclosed and *nested*"), "<p>**unclosed and <em>nested</em></p>");
  assert.equal(md("**bold with `code` inside**"), "<p><strong>bold with <code>code</code> inside</strong></p>");
  assert.equal(md("\\*not emphasis\\*"), "<p>*not emphasis*</p>");
});

test("headings h1 to h6, and a run of # that is not a heading", () => {
  for (let n = 1; n <= 6; n++) assert.equal(md(`${"#".repeat(n)} Title ${n}`), `<h${n}>Title ${n}</h${n}>`);
  assert.equal(md("####### seven"), "<p>####### seven</p>");
  assert.equal(md("#hashtag"), "<p>#hashtag</p>");
  assert.equal(md("## Closing hashes ##"), "<h2>Closing hashes</h2>");
});

test("inline code keeps its text literal", () => {
  assert.equal(md("use `a **b** <c>` here"), "<p>use <code>a **b** &lt;c&gt;</code> here</p>");
  assert.equal(md("``code with ` tick``"), "<p><code>code with ` tick</code></p>");
});

test("fenced code: language label, copy button, escaped body, tildes too", () => {
  const out = md("```js\nlet a = 1 < 2\n```");
  assert.equal(out, '<figure class="code" data-lang="js"><figcaption><span class="code-lang">js</span><button class="code-copy" type="button" aria-label="Copy code">Copy</button></figcaption><pre><code data-lang="js">let a = 1 &lt; 2</code></pre></figure>');
  assert.match(md("~~~\nplain\n~~~"), /<figure class="code" data-lang=""><figcaption><span class="code-lang"><\/span>/);
  assert.match(md("```python title=x\nprint(1)\n```"), /data-lang="python"/, "only the first word names the language");
  assert.match(md("````\n```\ninner\n```\n````"), /<code data-lang="">```\ninner\n```<\/code>/, "a longer fence holds a shorter one");
  assert.match(md("  ```sh\n  ls\n  ```"), /<code data-lang="sh">ls<\/code>/, "an indented fence loses its indent");
  assert.match(md("```\nnever closed"), /<code data-lang="">never closed<\/code>/, "an unclosed fence runs to the end");
});

test("fence languages map onto the highlighter's", () => {
  assert.equal(fenceLang("javascript"), "js");
  assert.equal(fenceLang("TypeScript"), "ts");
  assert.equal(fenceLang("python"), "py");
  assert.equal(fenceLang("bash"), "sh");
  assert.equal(fenceLang("console"), "sh");
  assert.equal(fenceLang("powershell"), "ps1");
  assert.equal(fenceLang("c++"), "c");
  assert.equal(fenceLang("rust"), "rs");
  assert.equal(fenceLang("yml"), "yaml");
  assert.equal(fenceLang("jsonc"), "json");
  assert.equal(fenceLang("klingon"), "plain");
  assert.equal(fenceLang(""), "plain");
});

test("blockquotes, nested, holding other blocks", () => {
  assert.equal(md("> quoted *text*\n> more"), "<blockquote><p>quoted <em>text</em><br>more</p></blockquote>");
  assert.equal(md("> outer\n> > inner"), "<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>");
  assert.equal(md("> - a\n> - b"), "<blockquote><ul><li>a</li><li>b</li></ul></blockquote>");
  assert.equal(md("> lazy\ncontinuation"), "<blockquote><p>lazy<br>continuation</p></blockquote>");
});

test("lists: bullets, ordered with a start, nested, mixed, with paragraphs", () => {
  assert.equal(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(md("* a\n+ b"), "<ul><li>a</li></ul><ul><li>b</li></ul>", "a different bullet starts a new list");
  assert.equal(md("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(md("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(md("- a\n  - a1\n    - a1x\n  - a2\n- b"), "<ul><li>a<ul><li>a1<ul><li>a1x</li></ul></li><li>a2</li></ul></li><li>b</li></ul>");
  assert.equal(md("1. one\n   - sub\n2. two"), "<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>");
  assert.equal(md("- a\n\n- b"), "<ul><li><p>a</p></li><li><p>b</p></li></ul>", "a loose list keeps paragraphs");
  assert.equal(md("- item\n  continued"), "<ul><li>item<br>continued</li></ul>");
  assert.equal(md("- code:\n  ```js\n  x()\n  ```"), '<ul><li>code:<figure class="code" data-lang="js"><figcaption><span class="code-lang">js</span><button class="code-copy" type="button" aria-label="Copy code">Copy</button></figcaption><pre><code data-lang="js">x()</code></pre></figure></li></ul>');
  assert.equal(md("text\n- a"), "<p>text</p><ul><li>a</li></ul>", "a list can follow a line of text");
});

test("task lists", () => {
  assert.equal(md("- [ ] todo\n- [x] done\n- [X] Done"), '<ul class="tasks"><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li><li class="task"><input type="checkbox" disabled checked> Done</li></ul>');
  assert.equal(md("- [link](https://a.b)"), '<ul><li><a href="https://a.b" target="_blank" rel="noopener noreferrer">link</a></li></ul>');
});

test("tables with alignment, escaped pipes, a row of the wrong width", () => {
  const out = md("| a | b | c |\n| :-- | :-: | --: |\n| 1 | **2** | `3\\|4` |\n| only |");
  assert.equal(out, '<div class="md-table"><table><thead><tr><th class="al-l">a</th><th class="al-c">b</th><th class="al-r">c</th></tr></thead><tbody><tr><td class="al-l">1</td><td class="al-c"><strong>2</strong></td><td class="al-r"><code>3|4</code></td></tr><tr><td class="al-l">only</td><td class="al-c"></td><td class="al-r"></td></tr></tbody></table></div>');
  onlyOwnMarkup(out);
  // The classes do the aligning, and win over the plain cell rule wherever markdown is shown.
  const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");
  for (const [cls, align] of [["al-l", "left"], ["al-c", "center"], ["al-r", "right"]]) assert.match(css, new RegExp(`\\.md-table \\.${cls} \\{ text-align: ${align}; \\}`));
  assert.match(md("| | |\r\n|---|---|\r\n| **File** | x |\r\n"), /<td><strong>File<\/strong><\/td><td>x<\/td>/, "CRLF too");
  assert.equal(md("a | b\n--- | ---\n1 | 2"), "<div class=\"md-table\"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>", "outer pipes are optional");
  assert.equal(md("| not | a table |"), "<p>| not | a table |</p>");
});

test("links, autolinks and bare URLs", () => {
  assert.equal(md("<https://a.example/x>"), '<p><a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a></p>');
  assert.equal(md("see https://a.example/x."), '<p>see <a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a>.</p>');
  assert.equal(md("(https://a.example/x)"), '<p>(<a href="https://a.example/x" target="_blank" rel="noopener noreferrer">https://a.example/x</a>)</p>');
  assert.equal(md("[a (b)](https://a.example/p_(x))"), '<p><a href="https://a.example/p_(x)" target="_blank" rel="noopener noreferrer">a (b)</a></p>');
  assert.equal(md("![alt text](https://a.example/i.png)"), '<p><a href="https://a.example/i.png" target="_blank" rel="noopener noreferrer">alt text</a></p>', "an image is a link to it, never a load");
  assert.equal(md("`https://a.example`"), "<p><code>https://a.example</code></p>");
});

test("thematic breaks", () => {
  assert.equal(md("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
  assert.equal(md("***"), "<hr>");
  assert.equal(md("- - -"), "<hr>");
});

test("one element per top-level block, so a stream can patch only what changed", () => {
  const blocks = mdBlocks("# T\n\npara\n\n- a\n- b\n\n```\nx\n```\n\n> q");
  assert.deepEqual(blocks.map((b) => /^<(\w+)/.exec(b)[1]), ["h1", "p", "ul", "figure", "blockquote"]);
  assert.equal(blocks.join(""), md("# T\n\npara\n\n- a\n- b\n\n```\nx\n```\n\n> q"));
});

test("a long hostile input renders in linear time", () => {
  const t0 = performance.now();
  md(`${"*".repeat(20000)}${"[".repeat(20000)}${"`".repeat(20000)}${"_a".repeat(20000)}`);
  md(`${"> ".repeat(2000)}x`);
  md(`${"- ".repeat(2000)}x`);
  md(Array.from({ length: 300 }, (_, i) => `${" ".repeat(i * 2)}- x`).join("\n"));
  assert.ok(performance.now() - t0 < 1500, `took ${performance.now() - t0} ms`);
});

test("long runs of spaces in a heading or a table row, and runs of unclosed [, render in linear time", () => {
  // Each input took 6-12 s here when the grammar backtracked (quadratic); linear, each is a few milliseconds. The bound is
  // loose for a slow machine and still far below the old cost.
  const N = 60000, LIMIT = 1500;
  const timed = (what, fn) => { const t0 = performance.now(); fn(); const ms = performance.now() - t0; assert.ok(ms < LIMIT, `${what}: ${ms.toFixed(0)} ms`); };
  timed("table delimiter row", () => md(`a|b\n|-${" ".repeat(N)}x`));
  timed("table delimiter row, spaces between cells", () => md(`a|b\n|-${" ".repeat(N)}|${" ".repeat(N)}-`));
  timed("heading", () => md(`# a${" ".repeat(N)}x`));
  timed("heading, no text", () => md(`#${" ".repeat(N)}x`));
  timed("heading, closing hashes", () => md(`# a${" ".repeat(N)}#${" ".repeat(N)}x`));
  timed("a paragraph", () => md(`a${" ".repeat(N)}x`));
  timed("unclosed [ while streaming", () => closeOpen("[a".repeat(N / 2)));
  timed("unclosed [( while streaming", () => closeOpen("[a](".repeat(N / 4)));
  timed("a run of markers at the end of a stream", () => closeOpen(`${"*".repeat(N)}a`));
  timed("spaces before the end of a stream", () => closeOpen(`**a${" ".repeat(N)}b`));
  timed("emphasis openers and one long closer", () => md("*a _".repeat(N / 4) + "*".repeat(N / 4)));
  // The faster grammar reads the same.
  assert.equal(md("# a   x"), "<h1>a   x</h1>");
  assert.equal(md("#   "), "<h1></h1>");
  assert.equal(md("# #"), "<h1></h1>", "only a closing sequence: an empty heading");
  assert.equal(md("## a ## b"), "<h2>a ## b</h2>");
  assert.equal(md("## a #b"), "<h2>a #b</h2>");
  assert.equal(md("### a\t###\t"), "<h3>a</h3>");
  assert.equal(md("    # four spaces"), "<p># four spaces</p>");
  assert.match(md("a | b\n :-: | -: \nc | d"), /<th class="al-c">a<\/th><th class="al-r">b<\/th>/);
  assert.match(md("| a |\n|---|\n| b |"), /<tbody>/);
  for (const sep of ["| - | |", "|", "a|b", "| -- x |", "-:-|-", "    | - | - |"]) assert.doesNotMatch(md(`a | b\n${sep}`), /<table>/, sep);
});

// ------------------------------------------------------------------ streaming
test("closeOpen: a stream never shows raw syntax for what has not closed yet", () => {
  assert.equal(closeOpen("```js\nlet a"), "```js\nlet a\n```");
  assert.equal(closeOpen("text **bol"), "text **bol**");
  assert.equal(closeOpen("text **"), "text ");
  assert.equal(closeOpen("text `cod"), "text `cod`");
  assert.equal(closeOpen("a *it"), "a *it*");
  assert.equal(closeOpen("a ~~gone"), "a ~~gone~~");
  assert.equal(closeOpen("see [the do"), "see the do");
  assert.equal(closeOpen("see [the docs](https://exa"), "see the docs");
  assert.equal(closeOpen("intro\n\n##"), "intro\n\n");
  assert.equal(closeOpen("intro\n\n## Tit"), "intro\n\n## Tit");
  assert.equal(closeOpen("intro\n\n- "), "intro\n\n");
  assert.equal(closeOpen("intro\n\n1."), "intro\n\n");
  assert.equal(closeOpen("intro\n\n| a | b |"), "intro\n\n", "a table waits for its separator row");
  assert.equal(closeOpen("intro\n\n| a | b |\n| -"), "intro\n\n");
  assert.equal(closeOpen("| a | b |\n| --- | --- |\n| 1 |"), "| a | b |\n| --- | --- |\n| 1 |");
  assert.equal(closeOpen("done.\n"), "done.\n");
  // Inside an open fence nothing else is touched.
  assert.equal(closeOpen("```\n**x"), "```\n**x\n```");
  // A list bullet is not emphasis.
  assert.equal(closeOpen("* item"), "* item");
  assert.equal(closeOpen("2 * 3"), "2 * 3");
});

test("closeOpen: a chunk that ends on a space inside bold or italic text still closes it", () => {
  // A closer after a space is not right-flanking: "**1 s **" would show its asterisks. The marks go before the space.
  assert.equal(closeOpen("from **1 s "), "from **1 s** ");
  assert.equal(closeOpen("a *small and "), "a *small and* ");
  assert.equal(closeOpen("x ~~old and\t"), "x ~~old and~~\t");
  assert.equal(closeOpen("**bold `co "), "**bold `co `**", "an open code span still closes first");
  for (const s of ["from **1 s ", "**without ", "a *small and ", "**a _b c "]) assert.doesNotMatch(md(closeOpen(s)).replace(/<[^>]+>/g, ""), /[*_]/, s);
  // Word by word, the way a model streams it: no frame shows a raw marker.
  const text = "Each attempt doubles the wait, from **1 s up to a 30 s cap**, and `retryDelay` stays *small and simple* overall.";
  const words = text.match(/\S*\s?/g).filter(Boolean);
  let sofar = "";
  for (const w of words) {
    sofar += w;
    const shown = md(closeOpen(sofar)).replace(/<code>[\s\S]*?<\/code>/g, "").replace(/<[^>]+>/g, "");
    assert.doesNotMatch(shown, /\*/, `after ${JSON.stringify(sofar)}: ${shown}`);
  }
});

test("closeOpen: a link whose url has parentheses shows as its text until it closes", () => {
  assert.equal(closeOpen("see [docs](https://x/a_(b)"), "see docs");
  assert.equal(closeOpen("see [docs](https://x/a_(b"), "see docs");
  assert.equal(closeOpen("see [docs](https://x/a_(b))"), "see [docs](https://x/a_(b))", "a closed link is left alone");
  assert.equal(closeOpen("![pic](https://x/p"), "pic");
  assert.equal(closeOpen("a [x] b [c"), "a [x] b c");
});

test("what a stream renders is what the finished message renders, frame after frame", () => {
  const text = "## Why\n\nEach **failed** attempt `doubles` the wait.\n\n- a\n  - b\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> done";
  const final = md(text);
  for (let i = 1; i <= text.length; i++) {
    const html = md(closeOpen(text.slice(0, i)));
    assert.doesNotMatch(html.replace(/<code[^>]*>[\s\S]*?<\/code>/g, ""), /\*\*|(^|>)#{1,6} |\|\s*---/, `frame ${i}: ${html}`);
  }
  assert.equal(md(closeOpen(text)), final);
});
