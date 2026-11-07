import { test } from "node:test";
import assert from "node:assert/strict";
import { exaCall, formatResults, htmlToText, readPages, search } from "../integrations/opencode/web-search-lib.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (body) => new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } });
/** A fetch that answers by host; an unknown host throws like a network error. */
const fakeFetch = (routes, calls = []) => async (url, init) => {
  const u = new URL(url);
  calls.push(u.host);
  const h = routes[u.host];
  if (!h) throw new Error(`network down: ${u.host}`);
  return h(u, init);
};

test("exaCall reads an SSE answer and a plain JSON answer", async () => {
  const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: A\nURL: https://a" }] } };
  assert.equal(await exaCall("web_search_exa", { query: "x" }, { fetch: fakeFetch({ "mcp.exa.ai": () => sse(ok) }) }), "Title: A\nURL: https://a");
  assert.equal(await exaCall("web_search_exa", { query: "x" }, { fetch: fakeFetch({ "mcp.exa.ai": () => json(ok) }) }), "Title: A\nURL: https://a");
  await assert.rejects(exaCall("x", {}, { fetch: fakeFetch({ "mcp.exa.ai": () => json({ error: { message: "rate limited" } }) }) }), /rate limited/);
});

test("web search uses Exa first", async () => {
  const calls = [];
  const f = fakeFetch({ "mcp.exa.ai": () => sse({ result: { content: [{ type: "text", text: "Title: Tokio\nURL: https://tokio.rs" }] } }) }, calls);
  const r = await search({ query: "tokio" }, { fetch: f });
  assert.equal(r.engine, "exa");
  assert.match(r.text, /https:\/\/tokio\.rs/);
  assert.deepEqual(calls, ["mcp.exa.ai"]);
});

test("web search falls back to Brave (with a key) and then Marginalia, and says why", async () => {
  const marg = { "api.marginalia.nu": () => json({ results: [{ url: "https://m.example", title: "M", description: "from marginalia" }] }) };
  const r = await search({ query: "tokio", count: 2 }, { fetch: fakeFetch({ "mcp.exa.ai": () => json({}, 503), ...marg }) });
  assert.equal(r.engine, "marginalia");
  assert.match(r.text, /https:\/\/m\.example/);
  assert.match(r.failed.join(), /exa: Exa: HTTP 503/);

  const calls = [];
  const brave = { "api.search.brave.com": (_u, init) => { assert.equal(init.headers["x-subscription-token"], "k"); return json({ web: { results: [{ title: "B", url: "https://b.example", description: "<b>bold</b>" }] } }); } };
  const r2 = await search({ query: "tokio" }, { fetch: fakeFetch({ ...brave, ...marg }, calls), env: { BRAVE_API_KEY: "k" } });
  assert.equal(r2.engine, "brave");
  assert.match(r2.text, /bold/);
  assert.doesNotMatch(r2.text, /<b>/);
  assert.ok(!calls.includes("api.marginalia.nu"));
});

test("web search with every engine down answers with what was tried instead of throwing", async () => {
  const r = await search({ query: "tokio" }, { fetch: fakeFetch({}) });
  assert.equal(r.engine, null);
  assert.match(r.text, /No web results.*exa:.*marginalia:/s);
});

test("sources: wikipedia, github, hackernews, stackoverflow, arxiv", async () => {
  const f = fakeFetch({
    "en.wikipedia.org": () => json({ query: { search: [{ title: "Tokio (software)", snippet: "<span>Tokio</span> is", timestamp: "2026-10-29T00:00:00Z" }] } }),
    "api.github.com": () => json({ items: [{ full_name: "tokio-rs/tokio", html_url: "https://github.com/tokio-rs/tokio", description: "runtime", stargazers_count: 30000, language: "Rust" }] }),
    "hn.algolia.com": () => json({ hits: [{ objectID: "1", title: "Tokio 1.0", points: 10, num_comments: 2 }] }),
    "api.stackexchange.com": () => json({ items: [{ title: "How &amp; why", link: "https://so/q/1", body: "<p>body</p>", score: 3, answer_count: 1, tags: ["rust"] }] }),
    "export.arxiv.org": () => new Response("<feed><entry><id>http://arxiv.org/abs/1</id><title>Paper</title><summary>Abs</summary><published>2026-01-02T00:00:00Z</published><author><name>A. B</name></author></entry></feed>"),
  });
  assert.match((await search({ query: "tokio", source: "wikipedia" }, { fetch: f })).text, /wiki\/Tokio_\(software\).*Tokio is/s);
  assert.match((await search({ query: "tokio", source: "github" }, { fetch: f })).text, /tokio-rs\/tokio.*★30000 · Rust/s);
  assert.match((await search({ query: "tokio", source: "hackernews" }, { fetch: f })).text, /news\.ycombinator\.com\/item\?id=1/);
  assert.match((await search({ query: "tokio", source: "stackoverflow" }, { fetch: f })).text, /How & why.*body/s);
  assert.match((await search({ query: "x", source: "arxiv" }, { fetch: f })).text, /Paper.*abs\/1.*A\. B.*Abs/s);
  await assert.rejects(search({ query: "x", source: "google" }, { fetch: f }), /unknown source/);
  await assert.rejects(search({ query: "  " }, { fetch: f }), /empty/);
});

test("readPages falls back from Exa to Jina, then to a direct fetch", async () => {
  const viaJina = await readPages({ urls: ["https://a.example/x"] }, { fetch: fakeFetch({ "mcp.exa.ai": () => json({}, 500), "r.jina.ai": (u) => { assert.equal(u.pathname, "/https://a.example/x"); return new Response("Markdown A"); } }) });
  assert.match(viaJina.text, /a\.example\/x \(jina\)\n\nMarkdown A/);
  const direct = await readPages({ urls: "https://a.example/" }, { fetch: fakeFetch({ "a.example": () => new Response("<html><script>x()</script><p>Hello</p></html>", { headers: { "content-type": "text/html" } }) }) });
  assert.match(direct.text, /direct, HTTP 200\)\n\nHello$/);
  await assert.rejects(readPages({ urls: ["file:///etc/passwd"] }), /not a web URL/);
});

test("htmlToText and formatResults", () => {
  assert.equal(htmlToText("<style>a{}</style><p>a &amp; b</p><p>c&#39;d</p>"), "a & b\nc'd");
  assert.match(formatResults([], { query: "q", engine: "e" }), /No results for "q" \(e\)/);
});
