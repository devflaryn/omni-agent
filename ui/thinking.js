/**
 * Which thinking levels a model really has, guessed from its id and name. pi offers one fixed ladder
 * (off · minimal · low · medium · high · xhigh · max) and maps it onto each provider's own control, but the
 * controls differ by family: GPT takes an effort (and "none" for off), Claude an effort that tops out at max,
 * DeepSeek V4 only high and max, Qwen, GLM and DeepSeek V3.x only switch thinking on or off, and a reasoner such as
 * DeepSeek R1 or a "-thinking" model cannot turn it off at all. A level the model lacks is either refused by the
 * provider (a 400 the goal hook then pauses on) or silently ignored.
 *
 * `thinkingProfile` answers the levels to offer and pi's `thinkingLevelMap` for them (models.json: a string sends
 * that value, null hides the level and pi clamps away from it; levels left out keep pi's own mapping). A map the
 * user wrote on the model wins over the guess. Shared by the server (models.json, the API) and the UI (the picker).
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const STANDARD = ["off", "minimal", "low", "medium", "high"];
/** Only on or off: the one "on" level is shown as "on". */
const SWITCH = { levels: ["off", "high"], labels: { high: "on" } };
/** Always thinks, with no effort to choose. */
const ALWAYS = { levels: ["high"], labels: { high: "on" } };

/** "opus 4.6" → [4, 6]: the version after a Claude model's family word (ids use "-", names a space or "."); a date is not one. */
const claudeVersion = (k) => { const m = /(?:opus|sonnet|haiku|fable)[- ](\d)(?!\d)(?:[.-](\d)(?!\d))?/.exec(k); return m ? [Number(m[1]), Number(m[2] || 0)] : null; };
/** "gpt-5.2" → 2, "gpt-5" or "gpt-5-2025-08-07" → 0. */
const gpt5Minor = (k) => { const m = /gpt-5(?:\.(\d+))?/.exec(k); return m ? Number(m[1] || 0) : -1; };

/** First match wins; `test` (a RegExp or a function) sees "<provider>/<id> <name>" lowercased. */
const FAMILIES = [
  // Claude: effort low…high; Opus/Sonnet 4.6 and the 5 family add xhigh and max. No minimal.
  { family: "claude", test: (k) => /claude/.test(k) && (([a, b] = claudeVersion(k) || [0, 0]) => a >= 5 || (a === 4 && b >= 6))(), levels: ["off", "low", "medium", "high", "xhigh", "max"] },
  { family: "claude", test: /claude/, levels: ["off", "low", "medium", "high"] },
  // OpenAI: GPT-5 cannot turn reasoning off (minimal is its least); from 5.1 "none" is off; xhigh from 5.2, max from 5.6.
  { family: "gpt", test: (k) => gpt5Minor(k) >= 6, levels: ["off", "low", "medium", "high", "xhigh", "max"], values: { off: "none" } },
  { family: "gpt", test: (k) => gpt5Minor(k) >= 2, levels: ["off", "low", "medium", "high", "xhigh"], values: { off: "none" } },
  { family: "gpt", test: (k) => gpt5Minor(k) === 1, levels: ["off", "low", "medium", "high"], values: { off: "none" } },
  { family: "gpt", test: /gpt-5/, levels: ["minimal", "low", "medium", "high"] },
  { family: "gpt", test: /gpt-oss|(?:^|[/\s])o[134](?:-|\b)/, levels: ["low", "medium", "high"] },
  { family: "gpt", test: /gpt-(?:4|3\.5)/, levels: ["off"] },
  // DeepSeek: R1 / reasoner always think; V4 has high and max; V3.1+ is a switch; the plain chat model does not think.
  { family: "deepseek", test: /deepseek[\w.-]*(?:-r1|reasoner)|deepseek-r\d/, ...ALWAYS },
  { family: "deepseek", test: /deepseek[\w.-]*-v(?:[4-9]|\d\d)/, levels: ["off", "high", "max"] },
  { family: "deepseek", test: /deepseek-chat\b/, levels: ["off"] },
  { family: "deepseek", test: /deepseek/, ...SWITCH },
  // Qwen: QwQ and the "-thinking" builds always think, the "-instruct-2507" builds and Qwen2 never do, Qwen3 on is a switch.
  { family: "qwen", test: /qwq|qwen[\w.-]*thinking/, ...ALWAYS },
  { family: "qwen", test: /qwen[\w.-]*instruct-2507|qwen-?2(?:\.5)?\b|qwen2/, levels: ["off"] },
  { family: "qwen", test: /qwen/, ...SWITCH },
  // GLM: the Z1 / "-thinking" builds always think; 4.5 on is a switch.
  { family: "glm", test: /glm-z1|glm[\w.-]*thinking/, ...ALWAYS },
  { family: "glm", test: /glm/, ...SWITCH },
  // Gemini: 3 has low and high and cannot turn thinking off; 2.5 Pro cannot either; 2.5 Flash can.
  { family: "gemini", test: /gemini-(?:[3-9]|\d\d)/, levels: ["low", "high"] },
  { family: "gemini", test: /gemini-2\.5-pro/, levels: ["low", "medium", "high"] },
  { family: "gemini", test: /gemini-2\.5/, levels: ["off", "low", "medium", "high"] },
  // Others that always think, with no effort control.
  { family: "grok", test: /grok-3-mini/, levels: ["low", "high"] },
  { family: "grok", test: /grok-(?:[4-9]|code)/, ...ALWAYS },
  { family: "kimi", test: /kimi[\w.-]*thinking/, ...ALWAYS },
  { family: "minimax", test: /minimax[\w.-]*-m\d/, ...ALWAYS },
];
const matches = (f, k) => (typeof f.test === "function" ? f.test(k) : f.test.test(k));

const key = (m) => `${m?.provider || ""}/${m?.id || ""} ${m?.name || ""}`.toLowerCase();

/** The levels a user-written thinkingLevelMap allows (the standard ones unless null, xhigh/max only with a value). */
function levelsOfMap(map) {
  return THINKING_LEVELS.filter((l) => (Object.hasOwn(map, l) ? map[l] !== null : STANDARD.includes(l)));
}

/**
 * @param {{provider?: string, id?: string, name?: string, reasoning?: boolean, thinkingLevelMap?: object}} model
 * @returns {{family: string, levels: string[], labels: Record<string, string>, map: Record<string, string|null>|null, guessed: boolean}}
 *   `map` is what models.json should carry (null: pi's own mapping is right as it is).
 */
export function thinkingProfile(model) {
  const own = model?.thinkingLevelMap;
  if (own && typeof own === "object") return { family: "custom", levels: levelsOfMap(own), labels: {}, map: null, guessed: false };
  if (model?.reasoning === false) return { family: "none", levels: ["off"], labels: {}, map: null, guessed: false };
  const k = key(model);
  const f = FAMILIES.find((x) => matches(x, k));
  if (!f) return { family: "other", levels: STANDARD, labels: {}, map: null, guessed: false };
  const map = {};
  for (const l of THINKING_LEVELS) {
    if (!f.levels.includes(l)) { if (STANDARD.includes(l)) map[l] = null; continue; }
    if (f.values?.[l]) map[l] = f.values[l];
    else if (!STANDARD.includes(l)) map[l] = l;
  }
  return { family: f.family, levels: f.levels, labels: f.labels || {}, map: Object.keys(map).length ? map : null, guessed: true };
}

/**
 * The supported level nearest to `level`: the closest below it, else the closest above. A level that thinks never
 * lands on off (a switch model asked for "medium" is on, not off), and off on a model that always thinks is its least.
 */
export function clampThinking(level, levels) {
  if (!levels?.length || levels.includes(level)) return level;
  const rank = (l) => THINKING_LEVELS.indexOf(l);
  const at = rank(level);
  if (at < 0) return levels[levels.length - 1];
  const thinking = levels.filter((l) => l !== "off");
  if (level === "off" || !thinking.length) return levels[0];
  const below = thinking.filter((l) => rank(l) < at);
  return below.length ? below[below.length - 1] : thinking[0];
}
