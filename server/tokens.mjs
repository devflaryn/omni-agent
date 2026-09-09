/**
 * Token + cost accounting per session.
 *
 * Claude prices are Anthropic first-party API rates per 1M tokens (input, output);
 * cache read = 10% of input, cache write = 125% of input. Unknown models (e.g. a
 * self-hosted Qwen via pi) cost 0 unless the provider reports a cost itself.
 */
const PRICES = [
  [/fable-5/, 10, 50],
  [/mythos-5/, 10, 50],
  [/opus-5/, 5, 25],
  [/opus-4-8|opus-4-7|opus-4-6/, 5, 25],
  [/opus-4/, 15, 75],
  [/sonnet-5/, 2, 10],
  [/sonnet-4-6/, 3, 15],
  [/sonnet-4/, 3, 15],
  [/haiku-4-5/, 1, 5],
  [/haiku/, 0.8, 4],
];

export function priceFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [re, inp, out] of PRICES) if (re.test(m)) return { input: inp, output: out };
  return null;
}

export function estimateCost(model, u) {
  const p = priceFor(model);
  if (!p || !u) return 0;
  const M = 1_000_000;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.input * 0.1 + u.cacheWrite * p.input * 1.25) / M;
}

export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

export function createTally() {
  const sessions = new Map();
  function get(sid) {
    let s = sessions.get(sid);
    if (!s) {
      s = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0, context: 0, model: null, seen: new Set(), lastAt: 0 };
      sessions.set(sid, s);
    }
    return s;
  }
  return {
    add(sid, { groupId, usage, model, cost, ts }) {
      const s = get(sid);
      if (model) s.model = model;
      if (ts) s.lastAt = Math.max(s.lastAt, ts);
      if (!usage) return s;
      const key = groupId || `${ts || Date.now()}-${s.messages}`;
      if (s.seen.has(key)) return s;
      s.seen.add(key);
      s.messages++;
      s.input += usage.input; s.output += usage.output; s.cacheRead += usage.cacheRead; s.cacheWrite += usage.cacheWrite;
      s.total = s.input + s.output + s.cacheRead + s.cacheWrite;
      s.context = usage.input + usage.cacheRead + usage.cacheWrite;
      s.cost += typeof cost === "number" && cost > 0 ? cost : estimateCost(model || s.model, usage);
      return s;
    },
    get(sid) {
      const s = get(sid);
      const { seen, ...pub } = s;
      return pub;
    },
    has: (sid) => sessions.has(sid),
    reset(sid) { sessions.delete(sid); },
    all() {
      const out = {};
      for (const [sid] of sessions) out[sid] = this.get(sid);
      return out;
    },
  };
}
