/**
 * Omni Agent's OpenCode plugin: what the pi extensions (integrations/pi/omni-*.ts) gave a pi chat, for the chats Omni
 * runs on its own `opencode serve`.
 *
 *   plan                                  the planner (ui/plan.js): brainstorm → create → start/done …; its state
 *                                         rides in the tool results' metadata, where the goal hook reads it
 *   agent_* / job_* / claude_task         background agents and jobs on Omni's server (/api/agents); a finished
 *                                         one's report is prompted into the chat as `[omni-agent-result] …`
 *   memory_search / _recall / _save       the user's Omni vault (server/memory.mjs)
 *   graph_build / _query / _explain       the repo knowledge graph, through Omni's /api/graph routes
 *   omnidroid_wait_device                 a blocking wait on omnidroid's list_devices (when omnidroid is configured)
 *
 * and in front of the model: the context policy, the plan/agents guidelines, the graph and omnidroid notes (system
 * prompt), and the open plan's reminder at the tail of the context (never persisted). Agent tools called inside an
 * OpenCode `task` child session act for the root chat (its identity and its report delivery).
 *
 * Loaded by the shim Omni writes into its OpenCode config dir (integrations/opencode/shim.js → <configDir>/plugin/
 * omni.js), which hands in the plugin package's `tool`: this file imports no package, only Omni's own modules, and
 * runs in OpenCode's Bun runtime. Only Omni's own `opencode serve` loads it, so OMNI_AGENT_URL is normally set.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLAN_ACTIONS, PLAN_TOOL, applyPlanAction, asPlan, clearWaiting, emptyPlan, planReminder } from "../../ui/plan.js";
import { CONTEXT_GUIDANCE } from "../pi/omni-context-lib.mjs";
import {
  AgentsClient, CHUNK_SEC, MAX_REPORT, MAX_RESULT, agentReport, claim, claudeFooter, clip, confirmDelivered, describeAgent, elapsedOf, ensurePoller,
  fmtDuration, isFinished, kindLabel, omniBase, oneLine, pausePoller, pollerFor, resumeDelivery, statusLine, stopPollers, titleFor, unclaim, waitAgents, waitJob,
} from "../pi/omni-agents-lib.mjs";
import { McpHttpClient, McpStdioClient, waitDeviceVerdict } from "../pi/omni-mcp-lib.mjs";
import { Vault } from "../../server/memory.mjs";

/** A user message starting with this is a background agent's report (server/opencode-events.mjs shows it as one). */
export const AGENT_RESULT = "[omni-agent-result]";
const HOOK_PROMPT = /^\s*<omni-hook\b/;
const MAX_WAIT_SEC = 3600;
const MAX_LOG = 12000;
const MAX_CHARS = 12000;
const OMNIDROID = "omnidroid";
const waitMs = (sec, dflt = 600) => Math.min(MAX_WAIT_SEC, Math.max(1, Number(sec) || dflt)) * 1000;
const clipText = (s) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n… (${s.length - MAX_CHARS} more characters truncated)` : s);
const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };
const reply = (output, metadata = {}) => ({ output, metadata });

/** A user message's own text (no synthetic or ignored parts). */
const userText = (parts) => (parts || []).filter((p) => p?.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text || "").join("\n");
/** A message the user typed: not a goal-hook prompt, not an agent's report. */
const fromUser = (text) => !!String(text).trim() && !HOOK_PROMPT.test(text) && !String(text).trimStart().startsWith(AGENT_RESULT);

/**
 * The session's plan from its messages (`GET /session/:id/message`, oldest first): the last completed `plan` tool
 * part's metadata, its `waiting` cleared by a later message the user typed. Null when there is none.
 */
export function planFromMessages(messages) {
  let plan = null;
  for (const m of messages || []) {
    const role = m?.info?.role;
    if (role === "assistant") {
      for (const p of m.parts || []) {
        if (p?.type === "tool" && p.tool === PLAN_TOOL && p.state?.status === "completed") { const x = asPlan(p.state.metadata); if (x) plan = x; }
      }
    } else if (role === "user" && plan?.waiting && fromUser(userText(m.parts))) plan = clearWaiting(plan);
  }
  return plan;
}

const PLAN_DESCRIPTION = [
  "Your planner for any task that needs more than a few steps. Work in this order:",
  "1. brainstorm — before touching anything: understanding (the goal in your own words, scope), assumptions (unknowns you must check), approaches (at least two real options with trade-offs), chosen + rationale, success_criteria (how you will verify the whole goal is done). Explore the code/files first if you need to.",
  "2. create — milestones (meaningful checkpoints), each with small concrete steps; every step has done_when, a check that proves it worked.",
  "3. execute — start a step, do it, verify its check, then done with evidence (what you ran/saw). One step at a time. skip a step only with a reason.",
  "revise (with a reason) when you learn the plan is wrong — finished steps are kept. ask_user only for something only the user can provide (a choice, a credential, a risky confirmation). show prints the plan.",
  "The goal is finished when every step is done; the user's status box is updated at each milestone.",
].join("\n");

const PLAN_GUIDELINES = [
  "For any task that needs more than a few tool calls, use the plan tool before doing the work: brainstorm first, then create the plan, then execute it step by step, marking each step done with evidence.",
  "Skip the plan tool only for quick questions and one-step changes.",
  "Do not stop while the plan tool shows unfinished steps: continue with the next step, revise the plan, or use plan action ask_user when only the user can unblock you.",
];

const AGENT_GUIDELINES = [
  "Split big work: hand independent sub-investigations to background agents running in parallel (several agent_start calls, kind \"pi\") instead of doing them one after another in this chat — it keeps your context small and finishes sooner.",
  "Give big coding, refactoring or debugging jobs to a Claude Code agent: agent_start with kind \"claude\".",
  "Every agent_start task must be complete and self-contained: the goal, the relevant context (files, findings so far, ids), constraints, and exactly what to report back. The agent cannot see this chat and nobody answers its questions.",
  "After agent_start keep working on something else: each agent's report arrives by itself as an [omni-agent-result] message. Do not poll agent_status in a loop; call agent_wait only when nothing else is left to do until a report is in.",
  "Run anything that may take more than ~2 minutes (builds, device boots, downloads, long scans, test suites, waiting for a log line) with job_start, then job_wait {id, until} for the line or the exit — never `sleep`-poll in bash or block the chat on a long foreground command.",
  "A finished job's exit status and log tail arrive by themselves as a message; job_output reads its log at any time, job_kill stops it.",
];

const graphNote = (dir) => `Repo graph tools (graph_build / graph_query / graph_explain): A knowledge graph of ${dir} already exists. For questions about the structure of this repository (what talks to what, where something is used, what a module depends on), call graph_query first and graph_explain for one file or symbol; only read the source when you need the exact code. Call graph_build to refresh the graph after large changes.`;

const P = `${OMNIDROID}_`;
const OMNIDROID_NOTE = `omnidroid tools (${P}*) drive omnidroid -- real Android 15 running on its own Linux layer, arm64 translated, no VM -- through its MCP server. The tools are the omnidroid app's (it must be open, with \`mcp on\` set in it, or \`omnidroid serve\` running; an "is not reachable" error means it is not). Every omnidroid window on the computer shares that one pool: what the person launches you see too. Any APK: ${P}start_instance {apk, count} launches it as count instances and answers their ids at once -- each runs in a window of its own on one of the app's warm Androids, as an Android user of its own (the same APK file again shares an Android, another package goes in beside it, another build of a running package gets an Android of its own); \`options\` passes an installed plugin's options as on the command line (e.g. "--cookie <file or saved name> --place <id>": each instance signed in as that account, then the link opened; follow it in ${P}pool_log); ${P}wait_instance {instance_id} waits until it runs; ${P}screenshot {instance_id} and ${P}input {instance_id, action: tap|swipe|text|key} see and drive it; ${P}list_instances / ${P}list_devices show the state (a device is still "booting"? call ${P}wait_device to block until it is ready instead of polling ${P}list_devices in a loop); ${P}shell runs a command on an Android (root with uid 0); ${P}stop_instance closes one; ${P}web_pages / web_dom / web_click / web_type / web_eval / web_screenshot drive an instance's WebViews (sign-in pages, captchas). Native code: ${P}lab_load + ${P}call_function / ${P}intercept / ${P}read_mem / ${P}dump_module are a Frida-style debugger for one arm64 .so at the emulation layer (not attached to a live app; there is no frida-server here). RE workbench (reverse-engineer a .so and prove a rebuilt one matches): ${P}lab_load_apk (load a target + its siblings, report unresolved imports), ${P}lab_trace (call via an arg_spec of scalars/buffers), ${P}lab_corpus (a reproducible input corpus), ${P}lab_diff (differential-test original vs candidate over the corpus), ${P}lab_build (compile candidate C to an arm64 .so; needs an arm64 clang/NDK on the host). Read the omnidroid skill (devices, apps) or the omnidroid-frida skill (the lab + the workbench) before using them. Addresses are strings ("0x…"). The omni_* tools, if present, are the retired QEMU manager: only when asked for it by name.`;

/** omnidroid's MCP entry in Omni's opencode.json (`<OPENCODE_CONFIG_DIR>/opencode.json`), when it is on. */
function omnidroidEntry(env) {
  const dir = env.OPENCODE_CONFIG_DIR;
  if (!dir) return null;
  try {
    const e = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"))?.mcp?.[OMNIDROID];
    return e && e.enabled !== false && (e.url || (Array.isArray(e.command) && e.command[0])) ? e : null;
  } catch { return null; }
}

/** A client of omnidroid's MCP server: the app's own HTTP endpoint when omni-mcp only bridges to it (`--connect <url>`), else omni-mcp itself. */
function omnidroidClient(entry, env) {
  if (entry.type === "remote" || entry.url) return new McpHttpClient({ name: OMNIDROID, url: entry.url, headers: entry.headers });
  const [command, ...args] = entry.command;
  const i = args.indexOf("--connect");
  if (i >= 0 && /^https?:\/\//.test(args[i + 1] || "")) return new McpHttpClient({ name: OMNIDROID, url: args[i + 1] });
  const environment = Object.fromEntries(Object.entries(entry.environment || {}).map(([k, v]) => [k, String(v).replace(/\{env:([A-Za-z_]\w*)\}/g, (_m, n) => env[n] ?? "")]));
  return new McpStdioClient({ name: "omni-mcp", command, args, env: environment, cwd: entry.cwd });
}

/** The SDK's `{ data, error }` answer → its data; an error answer throws. */
async function sdk(call) {
  const r = await call;
  if (r && typeof r === "object" && ("data" in r || "error" in r)) {
    if (r.error) throw new Error(typeof r.error === "string" ? r.error : r.error?.data?.message || r.error?.message || JSON.stringify(r.error));
    return r.data;
  }
  return r;
}

/**
 * `createOmniPlugin({ tool, root })` → the OpenCode plugin (`async (input) => hooks`). `tool` is @opencode-ai/plugin's
 * (its `tool.schema` is zod); `root` is Omni's repo (the vault's default home). `env` is for tests.
 */
export function createOmniPlugin({ tool, root, env = process.env } = {}) {
  const z = tool.schema;
  return async function OmniPlugin(input = {}) {
    const oc = input.client;
    const directory = input.directory || process.cwd();
    const owner = {};
    const agents = new AgentsClient({ base: omniBase(undefined, env), chunkSec: CHUNK_SEC });
    const base = agents.base;
    const log = (message, level = "warn") => { try { Promise.resolve(oc?.app?.log?.({ body: { service: "omni", level, message: String(message) } })).catch(() => {}); } catch { /* no log */ } };

    // ------------------------------------------------------------ the session
    const messagesOf = async (sid) => { const d = await sdk(oc.session.messages({ path: { id: sid } })); return Array.isArray(d) ? d : []; };

    /** Plans by session id; one missing is rebuilt from the session's messages (OpenCode restarts reload the plugin). */
    const plans = new Map();
    const loading = new Map();
    function planFor(sid) {
      if (plans.has(sid)) return Promise.resolve(plans.get(sid));
      if (!loading.has(sid)) {
        loading.set(sid, messagesOf(sid).then(
          (msgs) => { if (!plans.has(sid)) plans.set(sid, planFromMessages(msgs) || emptyPlan()); return plans.get(sid); },
          (e) => { log(`plan: could not read session ${sid}: ${e?.message || e}`); return plans.get(sid) || emptyPlan(); },
        ).finally(() => loading.delete(sid)));
      }
      return loading.get(sid);
    }

    /** What the chat's own prompts carry (model, agent, persona system, tool allowlist), from its newest user message. */
    async function promptDefaults(sid) {
      const msgs = await messagesOf(sid).catch(() => []);
      const info = [...msgs].reverse().find((m) => m?.info?.role === "user")?.info;
      if (!info) return {};
      const out = {};
      if (info.model?.providerID && info.model?.modelID) out.model = { providerID: info.model.providerID, modelID: info.model.modelID };
      if (info.agent) out.agent = info.agent;
      if (info.system) out.system = info.system;
      if (info.tools && typeof info.tools === "object") out.tools = info.tools;
      const variant = info.variant ?? info.model?.variant;
      if (variant) out.variant = variant;
      return out;
    }

    // ------------------------------------------------------------ agent report delivery
    /**
     * A finished agent's report goes into its chat as a user message `[omni-agent-result] …` (it wakes an idle chat; a
     * busy one gets it in its run). Acked as delivered once OpenCode took it; one it refused is left undelivered.
     */
    function deliver(sid, rec) {
      (async () => {
        const body = { ...(await promptDefaults(sid)), parts: [{ type: "text", text: `${AGENT_RESULT} ${agentReport(rec, { max: MAX_REPORT })}` }] };
        await sdk(oc.session.promptAsync({ path: { id: sid }, body }));
      })().then(() => {
        confirmDelivered(rec.id);
        agents.delivered(rec.id).catch(() => { /* the server acks it when the report shows up in the chat */ });
      }, (e) => {
        confirmDelivered(rec.id);
        unclaim(rec);
        pollerFor(sid)?.stop();
        log(`could not post agent ${rec.id}'s report into session ${sid}: ${e?.message || e}`);
      });
    }
    const pollerOpts = (sid) => ({ client: agents, parentSessionId: sid, pi: owner, owner, log: (m) => log(m), isIdle: () => true, deliver: (rec) => deliver(sid, rec) });
    const deliverTo = (sid) => ensurePoller(pollerOpts(sid));
    /** Delivery survives an OpenCode restart: the first time a session shows up, its outstanding agents are picked up again. */
    const seen = new Set();
    function resume(sid) {
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      resumeDelivery(pollerOpts(sid)).catch(() => { /* Omni not reachable: nothing to resume */ });
    }
    /** A report the model already sees in a tool result must not arrive again as a message. → false when it already did. */
    const delivered = async (rec) => { const fresh = claim(rec); try { await agents.delivered(rec.id); } catch { /* the poller acks it later */ } return fresh; };
    const stop = async (id, sid) => {
      const release = pausePoller(sid);
      try {
        const rec = await agents.cancel(id);
        const fresh = await delivered(rec);
        return { rec, ended: fresh && rec.status !== "cancelled" };
      } finally { release(); }
    };
    /**
     * The chat a session belongs to: OpenCode's `task` tool runs subagents in child sessions (`parentID`), and an agent
     * started there belongs to the chat the user sees — its depth, its report, the goal keeper's wait. Cached once known.
     */
    const roots = new Map();
    async function rootOf(sid) {
      if (!sid || roots.has(sid)) return roots.get(sid) || sid;
      let cur = sid;
      const walked = new Set([sid]);
      for (let i = 0; i < 16; i++) {
        let parent;
        try { parent = (await sdk(oc.session.get({ path: { id: cur } })))?.parentID || null; } catch { return cur; } // not cached: try again next time
        if (!parent || walked.has(parent)) break;
        walked.add(parent);
        cur = parent;
      }
      roots.set(sid, cur);
      return cur;
    }
    /** Who asks Omni: the root chat's sid and session id (the server derives the depth from them). */
    const identity = async (ctx) => { const root = await rootOf(ctx.sessionID); return { parentSid: `pi:${root}`, parentSessionId: root }; };
    /** The model this tool call runs on, for a pi agent that inherits it. */
    async function currentModel(ctx) {
      try {
        const info = (await sdk(oc.session.message({ path: { id: ctx.sessionID, messageID: ctx.messageID } })))?.info;
        return info?.providerID && info?.modelID ? { provider: info.providerID, id: info.modelID } : null;
      } catch { return null; }
    }
    const progress = (ctx, title) => { try { ctx?.metadata?.({ title }); } catch { /* not supported */ } };

    // ------------------------------------------------------------ memory, graph, omnidroid
    let vault = null;
    const theVault = () => (vault ??= new Vault(env.OMNI_VAULT || join(root || directory, "vault")).ensure());

    async function graphCall(path, body) {
      let r;
      try {
        r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch (e) {
        return { __error: `Omni Agent is not running on ${base} (${e?.message || e}). Start it, then retry.` };
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) return { __error: `${j.error || r.status}` };
      return j;
    }

    const droidEntry = omnidroidEntry(env);
    let droid = null;
    const droidClient = () => (droid ??= omnidroidClient(droidEntry, env));

    // ------------------------------------------------------------ tools
    const Step = z.object({
      title: z.string().optional().describe("One concrete action, e.g. 'add the retry loop to fetchUser in src/api.ts'"),
      done_when: z.string().optional().describe("The check that proves this step worked, e.g. 'npm test passes', 'the log shows 200'"),
    }).passthrough();
    const Milestone = z.object({
      title: z.string().optional().describe("A meaningful checkpoint, e.g. 'Parser handles all fixtures'"),
      steps: z.array(Step).optional().describe("2-6 small steps that reach the milestone, each with a done_when check"),
    }).passthrough();

    const tools = {};
    tools[PLAN_TOOL] = tool({
      description: PLAN_DESCRIPTION,
      // Optional fields, extra properties allowed: the state machine tolerates near-miss shapes and answers a readable
      // refusal; a strict schema would reject those calls before the model could see why (omni-plan.ts).
      args: {
        action: z.enum(PLAN_ACTIONS),
        understanding: z.string().optional().describe("brainstorm: the goal in your own words, what is in and out of scope"),
        assumptions: z.array(z.string()).optional().describe("brainstorm: assumptions and unknowns to check"),
        approaches: z.array(z.object({ name: z.string(), tradeoffs: z.string() }).passthrough()).optional().describe("brainstorm: at least two different approaches with their trade-offs"),
        chosen: z.string().optional().describe("brainstorm: the approach you take"),
        rationale: z.string().optional().describe("brainstorm: why that approach"),
        success_criteria: z.array(z.string()).optional().describe("brainstorm: how you will verify the whole goal is done"),
        milestones: z.array(Milestone).optional().describe("create / revise: the milestones (for revise: only the remaining work)"),
        step: z.string().optional().describe("start / done / skip: the step id, e.g. '1.2'"),
        evidence: z.string().optional().describe("done: what you ran or saw that proves the step's check passed"),
        reason: z.string().optional().describe("skip / revise: why"),
        question: z.string().optional().describe("ask_user: the question only the user can answer"),
      },
      async execute(args, ctx) {
        const sid = ctx.sessionID;
        // Load first, then read, apply and store with no await in between: OpenCode runs a step's tool calls at once,
        // and two plan calls applied to the same base would lose one of them.
        await planFor(sid);
        const r = applyPlanAction(plans.get(sid) || emptyPlan(), args);
        if (r.ok) plans.set(sid, r.plan);
        return { title: `plan ${args.action ?? ""}${args.step ? ` ${args.step}` : ""}`, output: r.text, metadata: { plan: r.plan, events: r.events, ok: r.ok, action: args.action } };
      },
    });

    tools.agent_start = tool({
      description: [
        "Start a background agent on a self-contained task. Returns at once — it does not block you.",
        "kind \"pi\" (default): another agent like you with the same tools — for an independent sub-investigation, a search or scan, a device test loop.",
        "kind \"claude\": Claude Code, a strong agentic coding model — for a big coding job, a multi-file refactor, tricky debugging.",
        "Each agent is its own chat in Omni (shown under this one). It works alone and nobody answers its questions, so the task must carry everything: the goal, the context it needs (paths, findings, ids), constraints, and what to report back.",
        "Its final report arrives in this chat as an [omni-agent-result] message when it finishes. agent_status shows progress, agent_wait waits for a report, agent_message sends it more instructions, agent_cancel stops it.",
        "`agent` names an Omni agent persona (e.g. scout, re-analyst, droid-operator).",
      ].join(" "),
      args: {
        task: z.string().describe("The complete, self-contained task: goal, context (paths, findings, ids), constraints, what to report back"),
        kind: z.enum(["pi", "claude"]).optional().describe("pi (default): another agent like you; claude: Claude Code"),
        agent: z.string().optional().describe("Agent persona name (kind pi), e.g. scout"),
        title: z.string().optional().describe("Short title for the agent's chat (default: the start of the task)"),
        cwd: z.string().optional().describe("Working directory (default: the current one)"),
        model: z.string().optional().describe("Model id (default: this chat's model for pi, Claude Code's default for claude)"),
        thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional().describe("Thinking level (kind pi); moved to the nearest one the model has"),
      },
      async execute(args, ctx) {
        const me = await identity(ctx);
        const kind = args.kind === "claude" ? "claude" : "pi";
        // A pi agent runs on this chat's model unless told otherwise (a persona may pin its own).
        const inherit = kind === "pi" && !args.model && !args.agent ? await currentModel(ctx) : null;
        const rec = await agents.start({
          kind, task: args.task, title: args.title || titleFor(args.task), cwd: args.cwd || ctx.directory || directory, agent: args.agent,
          model: args.model || inherit?.id, provider: inherit?.provider,
          thinking: kind === "pi" ? args.thinking : undefined,
          // A pi agent gets the vault memory pack in its system prompt (the server composes it).
          memory: kind === "pi" ? true : undefined,
          ...me,
        });
        deliverTo(me.parentSessionId);
        const queued = rec.status === "queued" ? " It is queued until a slot frees (the agent limit is reached)." : "";
        return reply(
          `Started ${kind} agent ${rec.id} "${rec.title || titleFor(args.task)}" — it runs in the background; its report arrives as a message when it finishes.${queued} Keep working. agent_wait / agent_status to check, agent_message to steer it, agent_cancel to stop it.`,
          { id: rec.id, kind, status: rec.status },
        );
      },
    });

    tools.agent_status = tool({
      description: "Show this chat's background agents and jobs (status, run time, title, last activity), or one of them in detail (with `id`: its task, recent activity, and a preview of its result once finished).",
      args: { id: z.string().optional().describe("An agent or job id (a-…); omit for all of this chat's") },
      async execute(args, ctx) {
        if (args.id) {
          const rec = await agents.get(args.id);
          return reply(describeAgent(rec), { id: rec.id, status: rec.status });
        }
        const list = await agents.list({ parentSessionId: await rootOf(ctx.sessionID) });
        if (!list.length) return reply("No background agents or jobs in this chat.", { agents: [] });
        const now = Date.now();
        const active = list.filter((a) => !isFinished(a)).length;
        const shown = list.slice(0, 30).map((a) => statusLine(a, now) + (isFinished(a) && a.resultText ? `\n    → ${oneLine(a.resultText, 160)}` : "")).join("\n");
        return reply(
          `${list.length} background agent${list.length === 1 ? "" : "s"}/job${list.length === 1 ? "" : "s"}, ${active} active:\n${shown}${list.length > 30 ? `\n… ${list.length - 30} older` : ""}`,
          { agents: list.map((a) => ({ id: a.id, kind: a.kind, status: a.status })) },
        );
      },
    });

    tools.agent_wait = tool({
      description: "Wait until one of the given background agents (or, without ids, any of this chat's) finishes, and return its report; agents whose report you already got are skipped. Gives up after timeoutSeconds (default 600, max 3600) and leaves them running. Usually you do not need this: reports arrive as messages by themselves — use it only when nothing else is left to do until a result is in.",
      args: {
        ids: z.array(z.string()).optional().describe("Agent ids to wait for (default: any of this chat's)"),
        timeoutSeconds: z.number().optional().describe("Give up after this many seconds (default 600, max 3600)"),
      },
      async execute(args, ctx) {
        const sid = await rootOf(ctx.sessionID);
        const ids = (args.ids || []).map(String).filter(Boolean);
        const timeoutMs = waitMs(args.timeoutSeconds);
        const release = pausePoller(sid);
        let r;
        const seenIds = new Set();
        try {
          r = await waitAgents(agents, {
            ids, parentSessionId: ids.length ? undefined : sid, undeliveredOnly: true, timeoutMs, signal: ctx.abort,
            onChunk: ({ pending, elapsedMs }) => progress(ctx, `Waiting (${fmtDuration(elapsedMs)}) for ${pending.map((a) => a.id).join(", ")}`),
          });
          for (const rec of r.finished) if (!(await delivered(rec))) seenIds.add(rec.id);
        } finally { release(); }
        if (r.aborted) return reply("Stopped waiting. The agents keep running; their reports arrive as messages.", { aborted: true });
        if (r.empty) {
          if (!ids.length) return reply("No background agent of this chat is running, and every finished one has been reported.", { finished: [] });
          const recs = await Promise.all(ids.map((id) => agents.get(id).catch(() => null)));
          const known = recs.filter(Boolean), unknown = ids.filter((_, i) => !recs[i]);
          const lines = [
            known.length ? `Nothing to wait for: already finished and reported (agent_status <id> shows a result again):\n${known.map((a) => statusLine(a)).join("\n")}` : "Nothing to wait for.",
            unknown.length ? `No such agent: ${unknown.join(", ")}` : "",
          ].filter(Boolean);
          return reply(lines.join("\n"), { finished: [], reported: known.map((a) => a.id), unknown });
        }
        const now = Date.now();
        const still = r.pending.length ? `\n\nStill running:\n${r.pending.map((a) => statusLine(a, now)).join("\n")}` : "";
        if (r.timedOut) return reply(`No agent finished within ${fmtDuration(timeoutMs)}.${still}\nThey keep running; each report arrives as a message when it finishes (or agent_wait again).`, { timedOut: true, pending: r.pending.map((a) => a.id) });
        const report = (rec) => (seenIds.has(rec.id) ? `${statusLine(rec, now)}\n(its report already arrived as a message)` : agentReport(rec, { resultMax: MAX_RESULT }));
        return reply(r.finished.map(report).join("\n\n---\n\n") + still, { finished: r.finished.map((a) => ({ id: a.id, status: a.status })), pending: r.pending.map((a) => a.id) });
      },
    });

    tools.agent_message = tool({
      description: "Send a background agent more instructions. A running agent gets it after its current step (Claude Code at once); a finished one is resumed on its own session with the message and reports again when done.",
      args: {
        id: z.string().describe("The agent id (a-…)"),
        message: z.string().describe("The instruction or answer to send"),
      },
      async execute(args, ctx) {
        const r = await agents.message(args.id, args.message);
        if (!r.ok) return reply(`Agent ${args.id} did not take the message.`, { ok: false });
        deliverTo(await rootOf(ctx.sessionID));
        const how = {
          steer: "it receives it in its current run",
          followUp: "it receives it when its current step ends",
          resumed: "it had finished and is running again with your message",
          restarted: "it had stopped and was restarted on its session with your message",
        };
        return reply(`Message delivered to agent ${args.id}: ${how[r.how] || r.how}. Its next report arrives as a message.`, { ok: true, how: r.how });
      },
    });

    tools.agent_cancel = tool({
      description: "Stop a background agent (and its process tree). Its partial result is kept in Omni.",
      args: { id: z.string().describe("The agent id (a-…)") },
      async execute(args, ctx) {
        const { rec, ended } = await stop(args.id, await rootOf(ctx.sessionID));
        if (ended) return reply(`${kindLabel(rec.kind).replace(/^./, (c) => c.toUpperCase())} ${rec.id} had already ended, so nothing was stopped. Its report:\n\n${agentReport(rec, { resultMax: MAX_RESULT })}`, { id: rec.id, status: rec.status });
        return reply(`Stopped ${kindLabel(rec.kind)} ${rec.id} "${rec.title || ""}" (${rec.status}).`, { id: rec.id, status: rec.status });
      },
    });

    tools.job_start = tool({
      description: "Run a shell command as a background job (bash -lc, its output goes to a log). Returns at once. For anything that may take more than ~2 minutes: builds, device boots, downloads, long scans, test suites, waiting for a log line — never sleep-poll in bash. job_wait waits for a log line or the exit, job_output reads the log, job_kill stops it; the exit and log tail also arrive as a message when it ends.",
      args: {
        command: z.string().describe("The shell command (run with bash -lc)"),
        cwd: z.string().optional().describe("Working directory (default: the current one)"),
        title: z.string().optional().describe("Short title (default: the command)"),
        timeoutMinutes: z.number().optional().describe("Kill it after this many minutes (default 120)"),
      },
      async execute(args, ctx) {
        const me = await identity(ctx);
        const rec = await agents.start({
          kind: "shell", command: args.command, cwd: args.cwd || ctx.directory || directory, title: args.title || titleFor(args.command),
          timeoutMinutes: Math.max(1, Number(args.timeoutMinutes) || 120), ...me,
        });
        deliverTo(me.parentSessionId);
        return reply(
          `Started job ${rec.id} "${rec.title || titleFor(args.command)}" in the background. job_wait {id: "${rec.id}", until: "<regex>"} waits for a log line or its exit; job_output shows the log; job_kill stops it. Its exit and log tail arrive as a message when it ends.`,
          { id: rec.id, status: rec.status },
        );
      },
    });

    tools.job_wait = tool({
      description: "Wait until a background job's log matches `until` (a regular expression, e.g. \"BUILD SUCCESSFUL|error:\") or the job ends; returns whether it matched, the job's status and the log tail. Gives up after timeoutSeconds (default 600, max 3600) and leaves the job running.",
      args: {
        id: z.string().describe("The job id (a-…)"),
        until: z.string().optional().describe("Regular expression to wait for in the log (default: wait for the exit)"),
        timeoutSeconds: z.number().optional().describe("Give up after this many seconds (default 600, max 3600)"),
      },
      async execute(args, ctx) {
        const timeoutMs = waitMs(args.timeoutSeconds);
        const release = pausePoller(await rootOf(ctx.sessionID));
        let r;
        let rec = null;
        try {
          r = await waitJob(agents, {
            id: args.id, until: args.until, timeoutMs, signal: ctx.abort,
            onChunk: ({ status, elapsedMs }) => progress(ctx, `Waiting (${fmtDuration(elapsedMs)}) for job ${args.id}${args.until ? ` to log /${args.until}/` : " to end"} — ${status || "running"}`),
          });
          if (isFinished(r)) {
            try { rec = await agents.get(args.id); } catch { rec = null; }
            await delivered(rec || { id: args.id });
          }
        } finally { release(); }
        const tail = r.tail ? `\n\n--- log tail ---\n${clip(r.tail, MAX_LOG)}` : "";
        if (r.aborted) return reply(`Stopped waiting; job ${args.id} keeps running.${tail}`, { id: args.id, aborted: true });
        const exit = rec?.exitCode != null ? ` (exit ${rec.exitCode})` : "";
        const el = rec && elapsedOf(rec) ? ` after ${elapsedOf(rec)}` : "";
        const head = r.matched
          ? `Job ${args.id}: the log matched /${args.until}/ (${isFinished(r) ? `it ended: ${r.status}${exit}` : "still running"}).`
          : isFinished(r) ? `Job ${args.id} ended: ${r.status}${exit}${el}.`
            : `Job ${args.id} is still running after ${fmtDuration(timeoutMs)}${args.until ? `; /${args.until}/ has not appeared` : ""}. Its exit arrives as a message (or job_wait again).`;
        return reply(head + tail, { id: args.id, matched: r.matched, status: r.status, timedOut: !!r.timedOut, exitCode: rec?.exitCode ?? null });
      },
    });

    tools.job_output = tool({
      description: "Show a background job's status and the last lines of its log.",
      args: {
        id: z.string().describe("The job id (a-…)"),
        tail: z.number().optional().describe("How many log lines (default 80)"),
      },
      async execute(args) {
        const tail = Math.max(1, Math.floor(Number(args.tail) || 80));
        const [rec, text] = await Promise.all([agents.get(args.id), agents.log(args.id, tail)]);
        return reply(`${statusLine(rec)}\n--- last ${tail} lines ---\n${clip(text, MAX_LOG) || "(no output yet)"}`, { id: rec.id, status: rec.status });
      },
    });

    tools.job_kill = tool({
      description: "Stop a background job and its whole process tree.",
      args: { id: z.string().describe("The job id (a-…)") },
      async execute(args, ctx) {
        const { rec, ended } = await stop(args.id, await rootOf(ctx.sessionID));
        if (ended) return reply(`Job ${rec.id} had already ended, so nothing was stopped. Its report:\n\n${agentReport(rec, { resultMax: MAX_LOG })}`, { id: rec.id, status: rec.status, exitCode: rec.exitCode ?? null });
        return reply(`Stopped job ${rec.id} "${rec.title || ""}" (${rec.status}).`, { id: rec.id, status: rec.status });
      },
    });

    tools.claude_task = tool({
      description: "Delegate a self-contained task to Claude Code (a strong agentic coding model with full access to the working directory) and wait for its answer. Use it for larger coding jobs, multi-file refactors, debugging, or anything you want a second, more capable agent to do end to end. Describe the task fully: goal, constraints, what to report back. Runs in the current working directory unless `cwd` is given. Returns Claude's final answer and a session id; pass that id as `resume` to continue the same Claude conversation with a follow-up. If it takes longer than timeoutMinutes, Claude keeps running and its answer arrives later as a message. To keep working while Claude runs, use agent_start with kind \"claude\" instead.",
      args: {
        task: z.string().describe("The complete task description for Claude Code"),
        cwd: z.string().optional().describe("Working directory (default: the current one)"),
        model: z.string().optional().describe("Claude model id, e.g. claude-opus-5, claude-sonnet-5 (default: Claude Code's default)"),
        resume: z.string().optional().describe("A session id returned by a previous claude_task, to continue that conversation"),
        timeoutMinutes: z.number().optional().describe("Stop waiting after this many minutes (default 15); Claude keeps running and its answer arrives as a message"),
      },
      async execute(args, ctx) {
        const me = await identity(ctx);
        const sid = me.parentSessionId;
        const minutes = Number(args.timeoutMinutes) > 0 ? Number(args.timeoutMinutes) : 15;
        let rec;
        try {
          rec = await agents.start({
            kind: "claude", task: args.task, cwd: args.cwd || ctx.directory || directory, model: args.model, resume: args.resume,
            // memory: the vault memory pack in Claude's system prompt (the server composes it).
            title: `Task from pi: ${args.task.replace(/\s+/g, " ").slice(0, 60)}`, memory: true, ...me,
          });
        } catch (e) {
          if (e?.unreachable) return reply(e.message, { error: true });
          return reply(`claude_task failed: ${e?.message || e}`, { error: true });
        }
        // This chat's poller is held until the answer (or the cancel) is claimed and acked, so it never posts it too.
        const release = pausePoller(sid);
        let r;
        try {
          try {
            r = await waitAgents(agents, {
              ids: [rec.id], timeoutMs: minutes * 60000, signal: ctx.abort,
              onChunk: ({ elapsedMs }) => progress(ctx, `Claude Code is working (${fmtDuration(elapsedMs)}) — agent ${rec.id}`),
            });
          } catch (e) {
            r = { lost: e?.message || String(e) };
          }
          if (r.aborted) {
            // The run was stopped: stop Claude too, and its "cancelled" report need not come back.
            let status = "cancelled";
            try { const c = await agents.cancel(rec.id); status = c?.status || status; claim(c || rec); await agents.delivered(rec.id); } catch { /* best effort */ }
            return reply(`claude_task stopped; Claude Code agent ${rec.id} was ${status}.`, { id: rec.id, sid: rec.sid, sessionId: rec.sessionId, cancelled: true });
          }
          const f = r.finished?.[0];
          if (f) {
            claim(f);
            try { await agents.delivered(f.id); } catch { /* the poller acks it later */ }
            const text = clip(String(f.resultText || ""), MAX_RESULT);
            const footer = f.status === "done" || f.status === "error"
              ? claudeFooter(f)
              : `[Claude Code agent ${f.id} ended: ${f.status}${f.error ? ` — ${f.error}` : ""} · session ${f.sessionId || "?"} — pass resume="${f.sessionId || ""}" to continue]`;
            return reply(`${text || "(no answer text)"}\n\n${footer}`, { id: f.id, sid: f.sid, sessionId: f.sessionId, cost: f.cost, turns: f.turns, isError: f.status !== "done", timedOut: false });
          }
        } finally { release(); }
        // Still running (or contact lost): report what there is, leave Claude running, deliver its answer later.
        let cur = rec;
        try { cur = (await agents.get(rec.id)) || rec; } catch { /* keep what start returned */ }
        deliverTo(sid);
        const activity = cur.activity?.length ? `Recent activity:\n${cur.activity.map((l) => `- ${l}`).join("\n")}` : "(no output yet)";
        const sofar = cur.resultText ? `\n\nSo far:\n${clip(String(cur.resultText), MAX_RESULT)}` : "";
        const why = r.lost ? `claude_task lost contact with Omni Agent while waiting (${r.lost})` : `Claude Code did not finish within ${fmtDuration(minutes * 60000)}`;
        return reply(
          `${activity}${sofar}\n\n[${why}; it is still running in Omni as agent ${rec.id} (session ${cur.sessionId || "?"}). Its answer arrives as a message when it finishes — or agent_status / agent_wait ${rec.id}; agent_cancel ${rec.id} stops it.]`,
          { id: rec.id, sid: cur.sid, sessionId: cur.sessionId, timedOut: true },
        );
      },
    });

    tools.memory_search = tool({
      description: "Search the user's durable memory vault (Obsidian notes managed by Omni Agent). Returns the best-matching notes with a short preview. Use before re-deriving something the user may already have written down (offsets, quirks, decisions, preferences).",
      args: {
        query: z.string().describe("Keywords to search for"),
        limit: z.number().optional().describe("Max hits (default 8)"),
      },
      async execute(args) {
        const hits = await theVault().search(args.query, { limit: args.limit ?? 8 });
        const text = hits.length ? hits.map((h) => `- ${h.name} [${h.type || "note"}] (${h.path}): ${h.description || h.preview}`).join("\n") : "No matching notes.";
        return reply(text, { count: hits.length });
      },
    });

    tools.memory_recall = tool({
      description: "Return a compact, token-budgeted pack of the notes most relevant to a topic, ready to reason over. Cheaper than reading notes one by one.",
      args: {
        topic: z.string().describe("What you are working on or need to remember"),
        budgetTokens: z.number().optional().describe("Approximate token budget (default 800)"),
      },
      async execute(args) {
        const pack = await theVault().pack(args.topic, { budgetTokens: args.budgetTokens ?? 800 });
        return reply(pack || "Nothing relevant in memory.");
      },
    });

    tools.memory_save = tool({
      description: "Save one durable fact to the user's memory vault as a note. Use for things worth remembering across sessions: a resolved offset, a working hook, a host quirk, a user preference or decision. One fact per note; link related notes with [[name]].",
      args: {
        name: z.string().describe("Short name, e.g. 'roblox 2.3.4 jni offsets'"),
        description: z.string().describe("One line used to decide relevance later"),
        type: z.string().optional().describe("user | feedback | project | reference (default project)"),
        body: z.string().describe("The fact itself, markdown. Include why and how to apply."),
        tags: z.array(z.string()).optional(),
      },
      async execute(args, ctx) {
        const r = await theVault().save({ name: args.name, description: args.description, type: args.type ?? "project", body: args.body, tags: args.tags ?? [], source: `opencode:${ctx.directory || directory}` });
        return reply(`${r.created ? "Saved" : "Updated"} ${r.path}`, r);
      },
    });

    tools.graph_build = tool({
      description: "Build (or refresh) a knowledge graph of a code repository: every source file becomes a node linked to the files it imports or calls, clustered into communities. Runs the local `graphify` (AST extraction, no model call, a few seconds) and writes the result into the Omni vault. Do this once for a repo before graph_query / graph_explain. Returns node/edge/community counts.",
      args: { dir: z.string().optional().describe("Repository directory to graph (default: the current working directory)") },
      async execute(args, ctx) {
        const j = await graphCall("/api/graph/build", { dir: args.dir || ctx.directory || directory });
        if (j.__error) return reply(`graph_build failed: ${j.__error}`, { error: true });
        return reply(clipText(`Built graph for ${j.dir}: ${j.nodes} nodes, ${j.links} links → vault/${j.vault} (${j.notes} notes). Query it with graph_query.`), { nodes: j.nodes, links: j.links, dir: j.dir });
      },
    });

    tools.graph_query = tool({
      description: "Ask a question of a repository's knowledge graph and get a token-budgeted answer assembled from the most relevant nodes and their links — a cheap way to understand structure (\"what talks to the auth module?\", \"where is X used?\") without reading the whole codebase. The graph must have been built first with graph_build (same dir). Set dfs for a depth-first traversal instead of the default best-connected slice.",
      args: {
        question: z.string().describe("The question to ask about the repository's structure"),
        dir: z.string().optional().describe("Repository directory whose graph to query (default: the current working directory)"),
        budget: z.number().optional().describe("Approximate token budget for the answer (default 900)"),
        dfs: z.boolean().optional().describe("Depth-first traversal from the best match instead of the best-connected slice"),
      },
      async execute(args, ctx) {
        const dir = args.dir || ctx.directory || directory;
        const j = await graphCall("/api/graph/query", { dir, question: args.question, budget: args.budget, dfs: !!args.dfs });
        if (j.__error) return reply(`graph_query failed: ${j.__error}.${/no graph/i.test(j.__error) ? " Run graph_build on this directory first." : ""}`, { error: true });
        return reply(clipText(String(j.answer || "(the graph returned no answer)")), { dir });
      },
    });

    tools.graph_explain = tool({
      description: "Explain one node of a repository's knowledge graph: what a given file (or symbol) imports, what it calls, and what calls it. The graph must have been built first with graph_build (same dir).",
      args: {
        node: z.string().describe("The node to explain — a file path or symbol name as it appears in the graph"),
        dir: z.string().optional().describe("Repository directory whose graph to use (default: the current working directory)"),
      },
      async execute(args, ctx) {
        const dir = args.dir || ctx.directory || directory;
        const j = await graphCall("/api/graph/explain", { dir, node: args.node });
        if (j.__error) return reply(`graph_explain failed: ${j.__error}.${/no graph/i.test(j.__error) ? " Run graph_build on this directory first." : ""}`, { error: true });
        return reply(clipText(String(j.answer || `(nothing recorded for ${args.node})`)), { dir, node: args.node });
      },
    });

    if (droidEntry) {
      const pollMs = Math.max(50, Number(env.OMNI_WAIT_DEVICE_POLL_MS) || 3000);
      const sleep = (ms, signal) => new Promise((done) => {
        const t = setTimeout(done, ms);
        signal?.addEventListener?.("abort", () => { clearTimeout(t); done(); }, { once: true });
      });
      tools[`${P}wait_device`] = tool({
        description: `Wait until a warm Android is ready (booted), at most \`timeout\` seconds (default 300). Blocks server-side by polling list_devices for you — use it after warm_device, or whenever a device is still "booting", instead of calling ${P}list_devices in a loop. Answers the final devices snapshot. (omnidroid MCP helper, synthesized by omni-agent.)`,
        args: {
          device: z.number().optional().describe("the device id to wait for (omit: wait until none is still booting)"),
          timeout: z.number().optional().describe("seconds to wait (default 300)"),
        },
        async execute(args, ctx) {
          const target = args.device != null ? Number(args.device) : null;
          const deadline = Date.now() + Math.max(1, Number(args.timeout) || 300) * 1000;
          const t0 = Date.now();
          const waited = () => Math.round((Date.now() - t0) / 1000);
          const c = droidClient();
          for (;;) {
            if (ctx.abort?.aborted) return reply(`wait_device aborted after ${waited()}s`, { tool: "wait_device", ready: false, aborted: true });
            await c.start();
            const { text } = await c.callTool("list_devices", {}, 600000, ctx.abort);
            const v = waitDeviceVerdict(text, target);
            let result;
            try { result = JSON.parse(text); } catch { result = text; }
            if (v.done) return reply(`ready after ${waited()}s:\n${pretty(text)}`, { tool: "wait_device", ready: true, waitedMs: Date.now() - t0, result });
            if (Date.now() >= deadline) return reply(`still not ready after ${waited()}s (booting: ${v.booting.join(", ") || "none"}):\n${pretty(text)}`, { tool: "wait_device", ready: false, waitedMs: Date.now() - t0, result });
            progress(ctx, `waiting for ${target != null ? `device ${target}` : "the devices"} (${waited()}s)`);
            await sleep(pollMs, ctx.abort);
          }
        },
      });
    }

    // ------------------------------------------------------------ hooks
    const notes = () => {
      const out = [CONTEXT_GUIDANCE, `## Planning\n${PLAN_GUIDELINES.map((l) => `- ${l}`).join("\n")}`, `## Background agents and jobs\n${AGENT_GUIDELINES.map((l) => `- ${l}`).join("\n")}`];
      if (existsSync(join(directory, "graphify-out", "graph.json"))) out.push(graphNote(resolve(directory)));
      if (droidEntry) out.push(OMNIDROID_NOTE);
      return out.join("\n\n");
    };

    return {
      tool: tools,

      "experimental.chat.system.transform": async (inp, output) => {
        resume(inp?.sessionID);
        if (Array.isArray(output?.system)) output.system.push(notes());
      },

      // The open plan's reminder at the tail of the context, for this call only (as omni-plan.ts did): everything in
      // front of it stays byte-identical, so the prompt cache is kept. A user message at the end gets it as an extra
      // part (a copy in the array slot); after an assistant/tool step a synthetic user message carries it. Nothing is
      // stored, so the reminder is never persisted and always current.
      "experimental.chat.messages.transform": async (_inp, output) => {
        const msgs = output?.messages;
        if (!Array.isArray(msgs) || !msgs.length) return;
        const sid = msgs.find((m) => m?.info?.sessionID)?.info?.sessionID;
        if (!sid) return;
        try {
          const note = planReminder(await planFor(sid));
          if (!note) return;
          const last = msgs[msgs.length - 1];
          if (last?.info?.role === "user") {
            const part = { id: `${last.parts?.at(-1)?.id || last.info.id}:plan-reminder`, sessionID: sid, messageID: last.info.id, type: "text", text: `\n${note}`, synthetic: true };
            msgs[msgs.length - 1] = { ...last, parts: [...(last.parts || []), part] };
            return;
          }
          // The shape of the chat's own user messages (agent, model …), so OpenCode's conversion takes it like one.
          const user = [...msgs].reverse().find((m) => m?.info?.role === "user")?.info;
          const id = `${last?.info?.id || "msg"}:plan-reminder`;
          const model = user?.model || (last?.info?.providerID ? { providerID: last.info.providerID, modelID: last.info.modelID } : undefined);
          const { summary: _summary, ...shape } = user || { agent: last?.info?.agent || "build" };
          const info = { ...shape, id, sessionID: sid, role: "user", time: { created: Date.now() }, ...(model ? { model } : {}) };
          msgs.push({ info, parts: [{ id: `${id}:text`, sessionID: sid, messageID: id, type: "text", text: note, synthetic: true }] });
        } catch (e) { log(`plan reminder: ${e?.message || e}`); }
      },

      // A message the user typed answers an ask_user (the goal hook's prompts and agent reports do not).
      "chat.message": async (inp, output) => {
        const sid = inp?.sessionID || output?.message?.sessionID;
        if (!sid) return;
        resume(sid);
        const p = plans.get(sid);
        if (p?.waiting && fromUser(userText(output?.parts))) plans.set(sid, clearWaiting(p));
      },

      dispose: async () => {
        stopPollers(owner);
        try { droid?.close(); } catch { /* gone */ }
        droid = null;
      },
    };
  };
}
