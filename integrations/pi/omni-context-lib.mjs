/**
 * Context policy shared by the omni-context pi extension and the server's goal hook (server/hook.mjs).
 * Pure functions only — no pi, no fs — so both sides and the tests import the same logic.
 *
 * Why it exists: on long runs the model ended its turn believing its context was "nearly exhausted"
 * (handoff prompts "for a fresh session") at 375k–907k tokens while pi, with a 1M window declared, never
 * compacted. pi compacts automatically and the run continues from the summary, so a stop like that is
 * never a reason to end the work: the goal hook compacts and re-engages instead, and the model is told
 * up front that context is managed for it.
 */

/** Static system-prompt guidance (cache-stable: identical on every call). */
export const CONTEXT_GUIDANCE = [
  "## Context is managed for you",
  "Your conversation is compacted automatically when it grows large: older turns are replaced by a summary and you carry on from it in the same session.",
  "- Never end your turn, stop working, write a handoff, or suggest a fresh/new session because of context size, token budget, or how long the session has run. Those are never reasons to stop.",
  "- Keep working until the task is done. Stop only when it is complete, or when you need something only the user can provide (a choice, a credential, a confirmation).",
  "- Keep durable facts (paths, offsets, results, decisions) in files or your plan, so they survive compaction.",
].join("\n");

/** The model claiming it ran out of context / budget / session, or handing the work to a fresh session. */
const CONTEXT_CLAIMS = [
  /\bcontext(?: window)?(?: is| has| was)?(?: now)? (?:nearly |almost |essentially |basically |practically |pretty much |close to |about to be |getting )?(?:exhausted|full|spent|used up|running (?:out|low)|maxed|at (?:its |the )?limit)/i,
  /\b(?:ran|run|running|am running|i'm running|i am running) (?:out|low) (?:of|on) (?:context|tokens?|(?:the |my )?(?:token |context |response )?budget|room)/i,
  /\bout of (?:context|context window|token budget)\b/i,
  /\b(?:context|token) (?:budget|limit|window) (?:is |has been |was )?(?:nearly |almost |essentially )?(?:reached|exhausted|spent|hit|full|used up)/i,
  /\b(?:remaining|left(?:over)?) (?:working )?context\b(?![- ](?:menus?|objects?|switch(?:es)?|providers?|managers?)\b)/i,
  /\b(?:context|session)(?:'s)? (?:is |has )?(?:grown |getting |become )?too (?:long|large|big)\b/i,
  /\bthis session(?:'s)? (?:context|budget) (?:is |has been )?(?:nearly |almost |essentially )?(?:spent|exhausted|full|used up|gone)/i,
  /\bbefore (?:the |my )?context (?:runs out|fills up|is exhausted)/i,
  /\b(?:with|given) (?:the |my )?(?:limited|remaining|little) (?:context|token budget)\b(?! (?:in|of|from)\b)/i,
];
/** The same belief as it shows up in the model's own reasoning ("I'm at the very end of my token budget"). */
const THINK_CLAIMS = [
  /\b(?:nearly|almost|essentially|basically|practically|virtually) out of (?:context|budget|tokens|token budget|room)\b/i,
  /\b(?:at|near|reached|hit|hitting|approaching) (?:the )?(?:very |absolute |practical |hard )?(?:end|limit|edge) of (?:my |the |this turn's |this session's |practical )?(?:context|budget|token budget|context budget|context window)\b/i,
  /\b(?:end|limit) of (?:my |the )?(?:practical )?context\b/i,
  /\bat the budget limit\b|\b(?:my |the )?(?:token |context )?budget (?:is )?(?:nearly |almost |essentially )?(?:exhausted|spent|gone|used up)\b/i,
  /\b(?:very little|no|little|not much) (?:context|budget|room) (?:left|remaining)\b|\bhave (?:very little|little|almost no|no) context\b/i,
  /\bcontext (?:is )?(?:very high|nearly gone|almost gone|getting (?:very )?(?:high|large|long))\b|\bgiven (?:the )?context limits?\b/i,
  /\bgiven the session'?s length\b/i,
];
/** A handoff for another session: the point of the reply is that someone else carries on. */
const HANDOFF = [
  /\bhand-?off (?:prompt|note|file|document|doc|text|brief|written|saved)\b/i,
  /\b(?:prompt|brief|text|instructions?) (?:for|to paste into|to start) (?:a |the )?(?:fresh|new|next) (?:session|chat|conversation|agent)\b/i,
  /\bpaste (?:this|it|the following)? ?(?:in)?to (?:a |the )?(?:fresh|new|next) (?:session|chat|conversation)\b/i,
];
/**
 * Weaker handoff wording that is also ordinary product talk ("the + button starts a new chat", "the next
 * session of the game"): it only counts together with a cue, in the same sentence, that the work is being
 * put down for later ("…start a new chat; for now the old chat stays pinned" is still product talk).
 */
const WEAK_HANDOFF = [
  /\b(?:in|continue in|start|open|use) a (?:fresh|new) (?:session|chat|conversation)\b/i,
  /\bnext session\b/i,
];
const PUT_DOWN = /\b(?:pick (?:this|it|things) (?:back )?up|picks? up (?:from|where)|(?:i|we|you) left off|carry on (?:from|with)|continue (?:from|there|this|the work|with (?:the )?(?:next|remaining))|resume (?:from|there|this|the work)|where (?:i|we) (?:left|stopped)|stop(?:ping)? (?:here|now|for now)|for now|wrap(?:ping)? (?:this |it )?up|paus(?:e|ing) (?:here|now)|hand(?:ing)? (?:it|this|the work) (?:over|off)|remaining (?:work|steps|items|tasks))\b/i;
/** The WEAK_HANDOFF pattern that matches in a sentence that also has a PUT_DOWN cue, or undefined. */
function weakHandoff(t) {
  for (const sentence of t.split(/[.!?;]+(?=\s|$)|\n/)) {
    if (!PUT_DOWN.test(sentence)) continue;
    const re = WEAK_HANDOFF.find((r) => r.test(sentence));
    if (re) return re;
  }
  return undefined;
}
/** Stopping "for this session" without any real blocker. */
const SESSION_STOP = [
  /\b(?:i(?:'ve| have)|we(?:'ve| have)) (?:reached|hit) the end of what i can (?:do|verify|finish)(?: \w+)? in this session\b/i,
  /\b(?:i(?: have to| must| need to| will|'ll| am going to|'m going to) stop here|stopping here)\b[^.]{0,120}\b(?:context|session|budget|tokens?)\b/i,
];
/** Typographic apostrophes (’) read as plain ones, so "I’m running out of context" matches like "I'm …". */
const plain = (s) => String(s || "").replace(/[‘’ʼ]/g, "'");
/**
 * How the user asks for a handoff. This repo's own work is about prompts, so "Make the prompt builder …",
 * "I want the system prompt to …" or "Update the handoff detection" are ordinary requests, not handoffs:
 *   - ASK_HANDOFF: a request verb whose object is a handoff (document) — "write a handoff", "give me a
 *     short handoff note", "I need a handoff for tomorrow"; never "the handoff detection/logic".
 *   - ASK_SESSION_TEXT: a request verb whose object is a prompt/brief/text, tied to another session or to
 *     picking the work up later ("… I can paste into a new chat", "… for tomorrow").
 *   - SESSION_TEXT: "a prompt for a fresh session" (not "the system prompt for a new chat", not "the
 *     prompt for the next agent call").
 *   - ASK_PASTE: "what should I paste into the next chat?"
 */
const ASK_HANDOFF = /\b(?:(?:write|give|make|prepare|create|draft|generate|send|produce|leave|do|put together)(?: (?:me|us|up|out|down))*|(?:need|want)(?: you to (?:write|make|prepare|draft|give me))?)(?: (?:a|an|the|another|one|some|your|my|me|quick|short|brief|new|fresh|full|final|proper|detailed|good|clear|concise|complete|written|real))* hand-?(?:off|over)(?:[- ](?:prompts?|notes?|files?|docs?|documents?|texts?|briefs?|summary|summaries|messages?|reports?|md))?(?=\s*(?:$|[.,;:!?)]|(?:for|so|to|that|i|we|before|and|with|in|please|now|tomorrow|which|if|when|once)\b))/i;
const ASK_SESSION_TEXT = /\b(?:write|give|make|prepare|create|draft|generate|send|produce|leave|put together)(?: (?:me|us|up|out|down))*(?: (?:a|an|the|another|one|some|your|my|quick|short|new|fresh|full|final|detailed|good|clear|concise|complete))* (?:[\w-]+ )?(?:prompt|brief|continuation|text)\b(?! (?:builder|cache|caching|prefix|template|tokens?|format|logic|code|function|handler|size|length|field|box|input)\b)[^.?!\n]{0,60}(?:\b(?:new|fresh|next|other|another|second|separate) (?:session|chat|conversation|agent|thread|window)\b(?![- ](?:calls?|runs?|steps?|turns?|loops?|requests?|responses?|ids?|tokens?|cookies?)\b)|\b(?:paste|tomorrow)\b|\bpick (?:it|this|things|the work) (?:back )?up\b|\bcarry on\b|\bresume\b|\bcontinue (?:later|tomorrow|from|where|in)\b)/i;
const SESSION_TEXT = /(?<!\b(?:system|user|developer|base) )\b(?:prompt|text|message|brief) (?:for|to (?:paste|give|send)(?: (?:in|into|to))?) (?:a |the |another )?(?:new|fresh|next|other|another) (?:session|chat|conversation|agent)\b(?![- ](?:calls?|runs?|steps?|turns?|loops?|requests?|responses?|ids?|tokens?|cookies?)\b)/i;
const ASK_PASTE = /\bwhat (?:should i |do i |to |can i )?(?:paste|send|type|say)\b[^.?!\n]{0,40}\b(?:chat|session|agent)\b/i;
/**
 * The user explicitly asked for a handoff / a prompt for another session: writing one is the task, not a
 * stop. Only the user's own words count: Omni's memory pack, repo-graph context and goal-hook nudges are
 * stripped first (server/index.mjs puts the first two in front of the user's text).
 */
export function userAskedForHandoff(userText) {
  let u = plain(userText);
  if (/^\s*<omni-hook\b/.test(u)) return false;
  u = u.replace(/<omni-memory\b[^>]*>[\s\S]*?(?:<\/omni-memory>|$)/g, " ").replace(/<(omni-graph|repo-graph)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g, " ").replace(/<omni-hook\b[^>]*>[\s\S]*?(?:<\/omni-hook>|$)/g, " ").slice(-1500);
  return [ASK_HANDOFF, ASK_SESSION_TEXT, SESSION_TEXT, ASK_PASTE].some((re) => re.test(u));
}
/** The reply ends by asking the user for something only they can give. */
const ASKS_USER = /(?:\?\s*$|\b(?:which (?:option|one|approach|do you)|do you want me to|would you like me to|should i (?:go|proceed|continue|do)|shall i|let me know (?:which|whether|if you)|your (?:call|decision|choice)|need your (?:call|decision|input|confirmation|ok|go-?ahead)|please (?:confirm|choose|decide|check|look at|tell me)|can you (?:confirm|check|tell me|look))\b)/i;

const lastParagraph = (text) => { const parts = String(text || "").trim().split(/\n\s*\n/); return parts[parts.length - 1] || ""; };

/**
 * What a turn-ending assistant message means for whoever keeps a long run going.
 * @param {object} m
 * @param {string} [m.text]         the assistant's visible text
 * @param {string} [m.thinking]     its reasoning, when the provider returns it (the reason to stop often shows only there)
 * @param {string} [m.stopReason]   pi's stopReason (stop | length | error | aborted | toolUse)
 * @param {{output?: number}} [m.usage]
 * @param {number} [m.maxTokens]    the model's output cap (a `length` stop at the cap is a runaway think)
 * @param {string} [m.userText]     the last real user message (a requested handoff is not a stop)
 * @returns {{ kind: "context-stop"|"asks-user"|"length-cap"|"length"|"error"|"aborted"|"tool-use"|"normal", reason: string }}
 */
export function classifyStop({ text = "", thinking = "", stopReason = "stop", usage = null, maxTokens = 0, userText = "" } = {}) {
  if (stopReason === "error") return { kind: "error", reason: "the provider returned an error" };
  if (stopReason === "aborted") return { kind: "aborted", reason: "the run was aborted" };
  if (stopReason === "toolUse") return { kind: "tool-use", reason: "the run ended on a tool call" };
  if (stopReason === "length") {
    const out = Number(usage?.output) || 0;
    const atCap = maxTokens > 0 && out >= maxTokens * 0.97;
    return atCap || !String(text).trim() ? { kind: "length-cap", reason: "the output limit was used up (most likely by reasoning) before it acted" } : { kind: "length", reason: "the reply was cut off by the output limit" };
  }
  const t = plain(text);
  if (!t.trim()) return { kind: "normal", reason: "empty reply" };
  if (userText && userAskedForHandoff(userText)) return { kind: "normal", reason: "the user asked for a handoff" };
  const claim = CONTEXT_CLAIMS.find((re) => re.test(t));
  if (claim) return { kind: "context-stop", reason: `it stopped claiming its context was used up ("${clipMatch(t, claim)}")` };
  const sessionStop = SESSION_STOP.find((re) => re.test(t));
  if (sessionStop) return { kind: "context-stop", reason: `it stopped "for this session" ("${clipMatch(t, sessionStop)}")` };
  const handoff = HANDOFF.find((re) => re.test(t)) || weakHandoff(t);
  if (handoff) return { kind: "context-stop", reason: `it wrote a handoff for another session ("${clipMatch(t, handoff)}")` };
  // The final message's reasoning is where it decides to wrap up (its end matters most; cap the scan).
  const th = plain(thinking).slice(-12000);
  const thought = th && [...CONTEXT_CLAIMS, ...THINK_CLAIMS].find((re) => re.test(th));
  if (thought) return { kind: "context-stop", reason: `it wrapped up believing its context was used up ("${clipMatch(th, thought)}")` };
  if (ASKS_USER.test(lastParagraph(t).slice(-600))) return { kind: "asks-user", reason: "it asked the user something" };
  return { kind: "normal", reason: "it stopped normally" };
}

/**
 * "context" in a sense other than the conversation's budget — a GL/Android/React/execution context, a
 * context menu/object/switch/provider, "in this context" — removed from a skip reason before it is read.
 */
const OTHER_CONTEXT = /(?:\b(?:e?gl|opengl|gles|webgl|wgl|glx|vulkan|cuda|opencl|android|react|render(?:ing)?|device|execution|security|ssl|tls|crypto|browser|app(?:lication)?|activity|audio|graphics|canvas|drawing|surface|request|async|script|lua|js|javascript|java|jni|thread|process|cpu|gpu|signal|interrupt|auth|logging|log|span|trace|tracing|build|docker|servlet|spring|test|testing)|provider)[- ]context\b|\bcontext[- ](?:menus?|objects?|switch(?:es|ing)?|providers?|managers?|api|class(?:es)?|values?|keys?|loss|lost|creation|current|handles?|pointers?|structs?|types?|hooks?|consumers?|vars?|variables?|params?|parameters?|args?|arguments?|fields?|propert(?:y|ies)|methods?|instances?|wrappers?|loaders?|path|root|dir(?:ectory)?|-?free|-?sensitive|-?dependent|-?aware|-?specific)\b|\bcontext\.(?=\w)|\bin (?:this|that|its|their|each|any|another|a different|the right|the wrong) context\b|\bin the context of\b/gi;
/** Context as a budget in a skip reason ("due to context", "context limits", "for a fresh session"). */
const SKIP_FOR_CONTEXT = /\b(?:(?:because of|due to|given|to save|to conserve|to preserve|saving|conserving|limited|remaining|little|low on|short on|out of|free up|not enough|insufficient) (?:the |my |some |remaining |limited )?(?:context|tokens?|token budget)|context[- ](?:window|budget|limits?|size|usage|space|pressure|constraints?|reasons?|exhaustion)|token (?:budget|limits?)|(?:fresh|new|next|another|later|separate) (?:session|chat|conversation)(?![- ](?:cookies?|tokens?|ids?|keys?|tickets?|storage|objects?|handlers?|managers?|api|headers?|secrets?|state|files?|data)\b)|this session(?![- ](?:cookies?|tokens?|ids?|keys?|tickets?|storage|objects?|headers?|secrets?)\b))\b/i;
/**
 * True for a plan step skipped "because of context" — not a real reason to skip work. Any mention of the
 * conversation's context counts ("to keep the context small", "would flood the context", "context
 * bloat"); other senses of the word (OTHER_CONTEXT) and product talk ("a new session cookie") do not.
 */
export function contextSkipReason(reason) {
  const r = plain(reason).replace(OTHER_CONTEXT, " ");
  return !!r.trim() && (/\bcontext\b/i.test(r) || SKIP_FOR_CONTEXT.test(r) || [...CONTEXT_CLAIMS, ...THINK_CLAIMS].some((re) => re.test(r)));
}

function clipMatch(text, re) {
  const m = re.exec(text);
  return m ? m[0].slice(0, 80) : "";
}

/** The re-engage message after a context stop (the context was compacted, or did not need to be). */
export function contextContinueMessage({ compacted = false, usagePercent = null } = {}) {
  const where = compacted ? "Your context was just compacted automatically" : `Your context is fine${usagePercent != null ? ` (${Math.round(usagePercent)}% of the budget before automatic compaction)` : ""}`;
  return `${where}. You stopped because you believed the context or session was used up, but context is managed for you and is never a reason to stop or hand off. Do not write a handoff or a summary for a fresh session. Continue the task from exactly where you left off: pick the next concrete step and do it now.`;
}

/**
 * A short tail note for the model when the context is getting full (added by the extension's `context`
 * hook to the newest message only, so the cached prefix is untouched). Null below `fromPercent`.
 */
export function contextStatusNote(percent, { fromPercent = 70 } = {}) {
  if (percent == null || !Number.isFinite(percent) || percent < fromPercent) return null;
  return `[context: ${Math.round(percent)}% of the budget before automatic compaction. Compaction is automatic and the work continues from a summary: keep working normally, never stop or hand off because of context.]`;
}

/**
 * Oversized compaction. pi writes a compaction summary in ONE request whose output budget is clamped to
 * `window − input − 4096`, so a span bigger than the (capped) window — an old chat resumed after the cap went in,
 * or one huge turn — cannot be summarized: the summary is cut off, compaction fails and the prompt goes out whole.
 * The omni-context extension then folds the span into the summary chunk by chunk with pi's own summarizer.
 */
export const CHARS_PER_TOKEN = 3.2; // conservative: code, logs and hex tokenize denser than prose
export const tokensOfChars = (n) => Math.ceil((Number(n) || 0) / CHARS_PER_TOKEN);

/**
 * Tokens of serialized conversation one summary request can carry for this model: the window minus the summary's
 * own output (pi: min(0.8 × reserveTokens, maxTokens)), pi's 4096 margin, the prompt/system text and the running
 * summary it is folded into (`carriedChars`).
 */
export function summaryInputBudget({ contextWindow, reserveTokens = 16384, maxTokens = 0, carriedChars = 0 }) {
  const out = Math.min(Math.floor(0.8 * (Number(reserveTokens) || 0)), Number(maxTokens) > 0 ? Number(maxTokens) : Infinity);
  return Math.max(0, Math.floor((Number(contextWindow) || 0) - out - 4096 - 3000 - tokensOfChars(carriedChars)));
}

/** Consecutive chunks of at most `limit` (by `sizeOf`); an item bigger than the limit is a chunk of its own. */
export function chunkBySize(items, sizeOf, limit) {
  const chunks = [];
  let cur = [], size = 0;
  for (const it of items || []) {
    const s = Math.max(0, Number(sizeOf(it)) || 0);
    if (cur.length && size + s > limit) { chunks.push(cur); cur = []; size = 0; }
    cur.push(it); size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Fold chunks into one summary, oldest first: every chunk but the last updates the running summary (`summarize`, pi's
 * "update the previous summary" mode); the last goes through `last` (pi's compact(): split turn, file lists) → its result.
 */
export async function foldIntoSummary({ chunks, previousSummary, summarize, last }) {
  let summary = previousSummary;
  for (let i = 0; i < chunks.length - 1; i++) summary = await summarize(chunks[i], summary, i);
  return last(chunks[chunks.length - 1] || [], summary);
}

/**
 * The context window pi should see for a model so it compacts at `compactAt` prompt tokens:
 * pi compacts when tokens > contextWindow − reserveTokens. Never larger than the model's real window;
 * null when no cap is needed (the real window already triggers at or below compactAt).
 */
export function effectiveContextWindow({ contextWindow, compactAt, reserveTokens = 16384 }) {
  const real = Number(contextWindow) || 0, cap = Number(compactAt) || 0, reserve = Math.max(0, Number(reserveTokens) || 0);
  if (!real || !cap) return null;
  const want = cap + reserve;
  return want < real ? want : null;
}
