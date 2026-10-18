/* Providers dialog, MCP servers tab: the servers pi connects to (mcpServers in ~/.pi/agent/omni-agent.json), through the server. */
import { el } from "./lib.js";

/** KEY=value (env) or Name: value (headers) lines ↔ an object. Blank lines and # comments are skipped. */
export function parsePairs(text, sep) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
export const formatPairs = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${sep === ":" ? " " : ""}${v}`).join("\n");

/**
 * A pasted README snippet → [name, entry]. Accepts `{ "mcpServers": { name: {...} } }`, `{ name: {...} }`
 * or a bare `{ "command": ... }` / `{ "url": ... }` entry (then the name is left empty).
 */
export function parsePastedServer(text) {
  let j;
  // READMEs often show a fragment: `"github": { ... }` without the outer braces.
  try { j = JSON.parse(text); } catch { try { j = JSON.parse(`{${text}}`); } catch { throw new Error("that is not JSON"); } }
  if (j?.mcpServers && typeof j.mcpServers === "object") j = j.mcpServers;
  else if (j?.servers && typeof j.servers === "object") j = j.servers; // VS Code's mcp.json
  if (j && (j.command || j.url)) return ["", j];
  const first = j && typeof j === "object" ? Object.entries(j).find(([, v]) => v && typeof v === "object" && (v.command || v.url)) : null;
  if (!first) throw new Error("no server with a command or url in it");
  return first;
}

export function createMcpSettings({ api, toast, onChanged }) {
  const $ = (s) => document.querySelector(s);
  const list = $("#mcpList"), form = $("#mcpForm");
  const f = {
    title: $("#mfTitle"), name: $("#mfName"), type: $("#mfType"), command: $("#mfCommand"), args: $("#mfArgs"), env: $("#mfEnv"), cwd: $("#mfCwd"),
    url: $("#mfUrl"), headers: $("#mfHeaders"), timeout: $("#mfTimeout"), enabled: $("#mfEnabled"), out: $("#mfTestOut"),
    save: $("#mfSave"), test: $("#mfTest"), del: $("#mfDelete"), file: $("#mcpFile"),
    pasteBox: $("#mfPasteBox"), paste: $("#mfPaste"), pasteFill: $("#mfPasteFill"), pasteHint: $("#mfPasteHint"),
    stdio: form.querySelector(".mf-stdio"), http: form.querySelector(".mf-http"),
  };
  let servers = [];
  let editing = null; // server name being edited, or null for a new one
  const tested = new Map(); // name → "12 tools" | "failed", from this dialog's Test button

  async function load() {
    let r;
    try { r = await api("/api/mcp"); } catch (e) { toast(e.message, true); return; }
    servers = r.servers || [];
    f.file.textContent = r.file || "";
    if (editing && servers.some((s) => s.name === editing)) edit(editing);
    else if (servers.length) edit(servers[0].name);
    else startNew();
  }
  function summary(s) {
    const where = s.type === "http" ? (() => { try { return new URL(s.url).host; } catch { return s.url; } })() : [s.command, ...s.args].join(" ");
    return [s.type, where, s.disabled ? "off" : tested.get(s.name)].filter(Boolean).join(" · ");
  }
  function renderList() {
    list.innerHTML = "";
    for (const s of servers) {
      const b = el("button", `prov${s.name === editing ? " active" : ""}${s.disabled ? " off" : ""}`);
      b.type = "button";
      b.append(el("span", "pn", s.name), el("span", "pm", summary(s)));
      b.onclick = () => edit(s.name);
      list.appendChild(b);
    }
    const add = el("button", "prov add", "+ Add MCP server");
    add.type = "button";
    add.onclick = startNew;
    list.appendChild(add);
  }
  function showType() {
    const http = f.type.value === "http";
    f.http.hidden = !http; f.stdio.hidden = http;
  }
  function clearOut() { f.out.hidden = true; f.out.textContent = ""; f.out.classList.remove("err"); }
  function fill(s) {
    f.type.value = s.type === "http" ? "http" : "stdio";
    f.command.value = s.command || ""; f.args.value = (s.args || []).join("\n"); f.env.value = formatPairs(s.env, "=");
    f.cwd.value = s.cwd || ""; f.url.value = s.url || ""; f.headers.value = formatPairs(s.headers, ":");
    f.timeout.value = s.timeoutSec || ""; f.enabled.checked = !s.disabled;
    showType();
  }
  function startNew() {
    editing = null;
    f.title.textContent = "New MCP server";
    f.name.value = "";
    fill({ type: "stdio", args: [] });
    f.del.hidden = true;
    clearOut();
    renderList();
  }
  function edit(name) {
    const s = servers.find((x) => x.name === name); if (!s) return;
    editing = name;
    f.title.textContent = name;
    f.name.value = name;
    fill(s);
    f.del.hidden = false;
    clearOut();
    renderList();
  }
  function body() {
    const b = { type: f.type.value, timeoutSec: f.timeout.value ? Number(f.timeout.value) : null, disabled: !f.enabled.checked };
    if (b.type === "http") Object.assign(b, { url: f.url.value.trim(), headers: parsePairs(f.headers.value, ":") });
    else Object.assign(b, { command: f.command.value.trim(), args: f.args.value.split(/\r?\n/).map((a) => a.trim()).filter(Boolean), env: parsePairs(f.env.value, "="), cwd: f.cwd.value.trim() });
    return b;
  }
  async function save() {
    const name = f.name.value.trim();
    if (!name) { toast("give the server a name", true); f.name.focus(); return; }
    f.save.disabled = true;
    try {
      const r = await api(`/api/mcp/${encodeURIComponent(name)}`, { ...body(), ...(editing && editing !== name ? { rename: editing } : {}) }, "PUT");
      if (editing && editing !== name) tested.delete(editing);
      toast(r.restarted ? `Saved ${name} · pi restarted to connect` : `Saved ${name} · pi connects on its next start`);
      editing = name;
      await load();
      onChanged?.();
    } catch (e) { toast(e.message, true); }
    finally { f.save.disabled = false; }
  }
  async function test() {
    f.test.disabled = true;
    f.out.hidden = false; f.out.classList.remove("err"); f.out.textContent = "Connecting…";
    const name = f.name.value.trim() || editing || "test";
    try {
      const r = await api("/api/mcp-test", { name, ...body(), ...(editing && editing !== name ? { rename: editing } : {}) }, "POST");
      f.out.textContent = "";
      if (!r.ok) {
        f.out.classList.add("err");
        f.out.textContent = r.error;
        if (editing) tested.set(editing, "failed");
      } else {
        f.out.append(el("div", null, `Connected${r.server ? ` to ${r.server}` : ""} · ${r.tools.length} tool${r.tools.length === 1 ? "" : "s"}`));
        const ul = el("ul");
        for (const t of r.tools) {
          const li = el("li");
          li.append(el("code", null, t.name));
          if (t.description) li.append(el("span", "d", ` — ${t.description}`));
          ul.appendChild(li);
        }
        if (r.tools.length) f.out.appendChild(ul);
        if (editing) tested.set(editing, `${r.tools.length} tools`);
      }
      renderList();
    } catch (e) { f.out.classList.add("err"); f.out.textContent = e.message; }
    finally { f.test.disabled = false; }
  }
  async function remove() {
    if (!editing || !window.confirm(`Remove MCP server "${editing}"? pi restarts without its tools.`)) return;
    try { await api(`/api/mcp/${encodeURIComponent(editing)}`, null, "DELETE"); toast(`Removed ${editing}`); tested.delete(editing); editing = null; await load(); onChanged?.(); }
    catch (e) { toast(e.message, true); }
  }
  function fillFromPaste() {
    try {
      const [name, s] = parsePastedServer(f.paste.value);
      const type = String(s.type || (s.url ? "http" : "stdio")).toLowerCase();
      fill({ type: type === "stdio" ? "stdio" : "http", command: s.command, args: (s.args || []).map(String), env: s.env, cwd: s.cwd, url: s.url, headers: s.headers, timeoutSec: s.timeoutSec, disabled: s.disabled });
      if (name && !editing) f.name.value = name;
      f.pasteHint.textContent = type === "sse" ? "SSE servers are not supported; this one may also accept http on the same URL" : "Filled. Check it, then Save.";
      f.paste.value = "";
      f.pasteBox.open = false;
    } catch (e) { f.pasteHint.textContent = e.message; }
  }

  f.type.addEventListener("change", showType);
  f.save.onclick = save;
  f.test.onclick = test;
  f.del.onclick = remove;
  f.pasteFill.onclick = fillFromPaste;
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); save(); } });
  return { load };
}
