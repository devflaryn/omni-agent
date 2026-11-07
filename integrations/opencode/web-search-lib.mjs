/**
 * Internet search for Omni's chats, through services that answer automated clients without a captcha (checked from
 * this host on 2026-11-07; DuckDuckGo, Bing, Brave's page, Startpage, Ecosia, Qwant, Mojeek and public SearXNG all
 * answered a script with a captcha or a 403, so none of them is used).
 *
 *   web       Exa (mcp.exa.ai, a search engine made for AI agents; keyless) → Brave Search API (only with
 *             BRAVE_API_KEY) → Marginalia (independent index; keyless)
 *   read      Exa's page reader → Jina Reader (r.jina.ai) → a plain fetch turned into text
 *   sources   wikipedia, hackernews (Algolia), github (repositories), stackoverflow (Stack Exchange), arxiv
 *
 * No package imports: it runs in OpenCode's Bun runtime and in Node (tests). `fetch` is injectable for tests.
 */

const EXA_MCP = "https://mcp.exa.ai/mcp";
const UA = "omni-agent/1.0";
const TIMEOUT_MS = 25000;
export const SOURCES = Object.freeze(["web", "wikipedia", "hackernews", "github", "stackoverflow", "arxiv"]);
const MAX_COUNT = 20;
const MAX_READ = 20000;

const clampCount = (n, dflt = 8) => Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(n)) || dflt));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** HTML → readable text (good enough for snippets and fallback page reads). */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t\f\v\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Results → the text a model reads. */
export function formatResults(results, { engine, query } = {}) {
  if (!results.length) return `No results for "${query}"${engine ? ` (${engine})` : ""}.`;
  const lines = results.map((r, i) => {
    const meta = [r.date, r.extra].filter(Boolean).join(" · ");
    return `${i + 1}. ${oneLine(r.title) || r.url}\n   ${r.url}${meta ? `\n   ${meta}` : ""}${r.snippet ? `\n   ${oneLine(r.snippet).slice(0, 500)}` : ""}`;
  });
  return `${engine ? `[${engine}] ` : ""}${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${lines.join("\n\n")}`;
}

function withTimeout(signal, ms = TIMEOUT_MS) {
  const t = AbortSignal.timeout(ms);
  return signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, t]) : signal || t;
}

async function getJson(fetchFn, url, { signal, headers = {} } = {}) {
  const r = await fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: withTimeout(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

/** One JSON-RPC tools/call on Exa's keyless MCP endpoint; its answer may come as JSON or as an SSE stream. */
export async function exaCall(name, args, { fetch: fetchFn = fetch, signal } = {}) {
  const r = await fetchFn(EXA_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: withTimeout(signal, 40000),
  });
  if (!r.ok) throw new Error(`Exa: HTTP ${r.status}`);
  const raw = await r.text();
  let msg = null;
  for (const chunk of [raw, ...raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5))]) {
    try { const j = JSON.parse(chunk); if (j && (j.result || j.error)) { msg = j; break; } } catch { /* next */ }
  }
  if (!msg) throw new Error("Exa: unreadable answer");
  if (msg.error) throw new Error(`Exa: ${msg.error.message || JSON.stringify(msg.error)}`);
  const text = (msg.result?.content || []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
  if (msg.result?.isError) throw new Error(`Exa: ${text || "error"}`);
  return text;
}

// ------------------------------------------------------------------ web engines

async function exaSearch(query, count, opts) {
  const text = await exaCall("web_search_exa", { query, numResults: count }, opts);
  if (!text) return { results: [], text: "" };
  return { results: null, text }; // Exa's own text already lists title / URL / highlights per hit
}

async function braveSearch(query, count, { fetch: fetchFn = fetch, signal, env = {} } = {}) {
  const key = env.BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const j = await getJson(fetchFn, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { signal, headers: { "x-subscription-token": key } });
  return { results: (j?.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description), date: x.age })) };
}

async function marginaliaSearch(query, count, { fetch: fetchFn = fetch, signal } = {}) {
  const j = await getJson(fetchFn, `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}?count=${count}`, { signal });
  return { results: (j?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description })) };
}

// ------------------------------------------------------------------ specialist sources

async function wikipedia(query, count, { fetch: f = fetch, signal, lang = "en" } = {}) {
  const j = await getJson(f, `https://${encodeURIComponent(lang)}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${count}&srsearch=${encodeURIComponent(query)}`, { signal });
  return (j?.query?.search || []).map((x) => ({
    title: x.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`, snippet: htmlToText(x.snippet), date: x.timestamp?.slice(0, 10),
  }));
}

async function hackernews(query, count, { fetch: f = fetch, signal } = {}) {
  const j = await getJson(f, `https://hn.algolia.com/api/v1/search?hitsPerPage=${count}&query=${encodeURIComponent(query)}`, { signal });
  return (j?.hits || []).map((x) => ({
    title: x.title || x.story_title || "(comment)",
    url: x.url || `https://news.ycombinator.com/item?id=${x.objectID}`,
    snippet: x.story_text || x.comment_text ? htmlToText(x.story_text || x.comment_text) : "",
    date: x.created_at?.slice(0, 10),
    extra: `${x.points ?? 0} points · ${x.num_comments ?? 0} comments · https://news.ycombinator.com/item?id=${x.objectID}`,
  }));
}

async function github(query, count, { fetch: f = fetch, signal, env = {} } = {}) {
  const headers = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
  const j = await getJson(f, `https://api.github.com/search/repositories?per_page=${count}&q=${encodeURIComponent(query)}`, { signal, headers: { accept: "application/vnd.github+json", ...headers } });
  return (j?.items || []).map((x) => ({
    title: x.full_name, url: x.html_url, snippet: x.description || "", date: x.pushed_at?.slice(0, 10),
    extra: `★${x.stargazers_count}${x.language ? ` · ${x.language}` : ""}${x.archived ? " · archived" : ""}`,
  }));
}

async function stackoverflow(query, count, { fetch: f = fetch, signal } = {}) {
  const j = await getJson(f, `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&filter=withbody&pagesize=${count}&q=${encodeURIComponent(query)}`, { signal });
  return (j?.items || []).map((x) => ({
    title: htmlToText(x.title), url: x.link, snippet: htmlToText(x.body).slice(0, 400), date: x.creation_date ? new Date(x.creation_date * 1000).toISOString().slice(0, 10) : "",
    extra: `score ${x.score} · ${x.answer_count} answers${x.is_answered ? " · answered" : ""} · ${(x.tags || []).join(", ")}`,
  }));
}

async function arxiv(query, count, { fetch: f = fetch, signal } = {}) {
  const r = await f(`https://export.arxiv.org/api/query?max_results=${count}&search_query=all:${encodeURIComponent(query)}`, { headers: { "user-agent": UA }, signal: withTimeout(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from export.arxiv.org`);
  const xml = await r.text();
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    title: htmlToText(tag(e, "title")), url: htmlToText(tag(e, "id")), snippet: htmlToText(tag(e, "summary")), date: tag(e, "published").slice(0, 10),
    extra: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].slice(0, 4).map((m) => m[1].trim()).join(", "),
  }));
}

const SOURCE_FNS = { wikipedia, hackernews, github, stackoverflow, arxiv };

/**
 * One search. `source` "web" (default) tries Exa, then Brave (with a key), then Marginalia, and says which one
 * answered and why the others did not. Returns { text, engine, results? }.
 */
export async function search({ query, source = "web", count, lang } = {}, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("query is empty");
  const n = clampCount(count);
  if (source && source !== "web") {
    const fn = SOURCE_FNS[source];
    if (!fn) throw new Error(`unknown source "${source}" (one of ${SOURCES.join(", ")})`);
    const results = await fn(q, n, { ...opts, lang });
    return { engine: source, results, text: formatResults(results, { engine: source, query: q }) };
  }
  const failed = [];
  const engines = [["exa", exaSearch], ["brave", braveSearch], ["marginalia", marginaliaSearch]];
  for (const [engine, fn] of engines) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      const r = await fn(q, n, opts);
      if (r === null) continue; // not configured
      if (r.text) return { engine, text: `[${engine}] results for "${q}":\n\n${r.text}`, failed };
      if (r.results?.length) return { engine, results: r.results, text: formatResults(r.results, { engine, query: q }), failed };
      failed.push(`${engine}: no results`);
    } catch (e) { failed.push(`${engine}: ${e?.message || e}`); }
  }
  return { engine: null, results: [], failed, text: `No web results for "${q}". Tried: ${failed.join("; ")}. Try another wording or a source (${SOURCES.slice(1).join(", ")}).` };
}

/** Reads pages as text: Exa's reader for all of them at once, then Jina Reader, then a plain fetch, per page. */
export async function readPages({ urls, maxChars } = {}, opts = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).map((u) => String(u ?? "").trim()).filter(Boolean))].slice(0, 10);
  if (!list.length) throw new Error("no url given");
  for (const u of list) { const p = new URL(u).protocol; if (p !== "http:" && p !== "https:") throw new Error(`not a web URL: ${u}`); }
  const max = Math.min(MAX_READ, Math.max(500, Math.floor(Number(maxChars)) || 8000));
  const { fetch: f = fetch, signal } = opts;
  try {
    const text = await exaCall("web_fetch_exa", { urls: list, maxCharacters: max }, opts);
    if (text && !/^error\b/i.test(text)) return { engine: "exa", text };
  } catch { /* fall back per page */ }
  const out = [];
  for (const u of list) {
    let body = "", via = "";
    try {
      const r = await f(`https://r.jina.ai/${u}`, { headers: { "user-agent": UA, accept: "text/plain" }, signal: withTimeout(signal, 40000) });
      if (r.ok) { body = await r.text(); via = "jina"; }
    } catch { /* plain fetch next */ }
    if (!body) {
      try {
        const r = await f(u, { headers: { "user-agent": UA }, redirect: "follow", signal: withTimeout(signal) });
        const type = r.headers.get("content-type") || "";
        const raw = await r.text();
        body = /html/i.test(type) ? htmlToText(raw) : raw;
        via = `direct, HTTP ${r.status}`;
      } catch (e) { body = `(could not read: ${e?.message || e})`; via = "failed"; }
    }
    out.push(`# ${u} (${via})\n\n${body.length > max ? `${body.slice(0, max)}\n… (${body.length - max} more characters)` : body}`);
  }
  return { engine: "fallback", text: out.join("\n\n---\n\n") };
}
