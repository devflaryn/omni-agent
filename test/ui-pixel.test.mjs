import { test } from "node:test";
import assert from "node:assert/strict";
import { pixelsOf, screenGlyph, spriteOf } from "../ui/pixel.js";

const KINDS = ["claude", "pi", "orchestrator", "shell"];
const STATES = ["running", "starting", "idle", "done", "error", "timeout", "interrupted", "queued", "cancelled", undefined];

test("each node kind has its own sprite; Claude subagents draw as Claude, unknown kinds as OpenCode", () => {
  assert.deepEqual(["claude", "claude-sub", "pi", "orchestrator", "shell", "mystery"].map(spriteOf), ["claude", "claude", "pi", "orchestrator", "shell", "pi"]);
  const sig = (k) => JSON.stringify(pixelsOf(k, "idle").pixels.map((p) => [p.x, p.y, p.color]));
  assert.equal(new Set(KINDS.map(sig)).size, 4, "four distinct pictures");
  // Claude and OpenCode differ in the person, not only in colour: the OpenCode hood frames the face.
  const shape = (k) => pixelsOf(k, "idle").pixels.filter((p) => p.part === "person").map((p) => `${p.x},${p.y}`).sort().join(" ");
  assert.notEqual(shape("claude"), shape("pi"));
});

test("sprites are rectangular, every pixel is inside, glyphs sit inside a screen", () => {
  for (const k of KINDS) for (const s of STATES) {
    const r = pixelsOf(k, s);
    for (const p of r.pixels) assert.ok(p.x >= 0 && p.x < r.width && p.y >= 0 && p.y < r.height && /^#[0-9a-f]{6}$/.test(p.color), `${k}/${s} ${JSON.stringify(p)}`);
    const glyph = r.pixels.filter((p) => p.part === "glyph");
    const scene = new Map(r.pixels.filter((p) => p.part === "scene").map((p) => [`${p.x},${p.y}`, p.color]));
    for (const g of glyph) assert.ok(scene.has(`${g.x},${g.y}`), `${k}/${s}: glyph pixel ${g.x},${g.y} is on the screen`);
  }
});

test("the screen tells the state", () => {
  assert.equal(screenGlyph("claude", "running").mode, "run");
  assert.equal(screenGlyph("pi", "done").mode, "done");
  assert.equal(screenGlyph("pi", "error").mode, "failed");
  assert.equal(screenGlyph("pi", "queued").mode, "waiting");
  assert.equal(screenGlyph("orchestrator", "cancelled").mode, "off");
  assert.equal(pixelsOf("pi", "cancelled").pixels.filter((p) => p.part === "glyph").length, 0, "a stopped agent's screen is dark");
  assert.ok(pixelsOf("claude", "error").pixels.some((p) => p.part === "glyph" && p.color === "#ef4444"), "failure is red");
  assert.equal(pixelsOf("orchestrator", "running").pixels.filter((p) => p.part === "glyph").length, 2 * pixelsOf("orchestrator", "running").pixels.filter((p) => p.part === "glyph" && p.x < 7).length, "both of the orchestrator's screens light up");
});
