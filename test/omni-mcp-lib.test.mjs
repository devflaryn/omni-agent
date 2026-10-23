/**
 * Pure-unit tests for the omni-mcp wrapper's two harness smoothers, which the measured pi runs needed:
 *   idempotentStopNote  — a stop on an already-ended target is a no-op, not an error to react to (46 such errors)
 *   trimInstanceList    — a list_instances result that is mostly ended instances is trimmed, not left to overflow
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_TRIM_CHARS, KEEP_ENDED, idempotentStopNote, trimInstanceList, waitDeviceVerdict } from "../integrations/pi/omni-mcp-lib.mjs";

test("idempotentStopNote: only stop tools, only 'already stopped' errors", () => {
  assert.match(idempotentStopNote("stop_instance", "#31 ended already"), /already in the state/);
  assert.match(idempotentStopNote("stop_app", "no instance #7"), /already in the state/);
  assert.match(idempotentStopNote("stop_device", "the device is already down"), /already in the state/);
  // Not a stop tool, or a real failure the model must see:
  assert.equal(idempotentStopNote("start_instance", "#31 ended already"), null);
  assert.equal(idempotentStopNote("stop_instance", "the omnidroid app is not reachable"), null);
  assert.equal(idempotentStopNote("stop_instance", ""), null);
  assert.equal(idempotentStopNote("stop_instance", undefined), null);
});

const list = (n, live = 0) => JSON.stringify({
  instances: [
    ...Array.from({ length: n }, (_, i) => ({ instance_id: i + 1, package: "p", state: "ended: the app stopped", up_s: 100 + i, sha256: "x".repeat(64), apk: "C:/".padEnd(80, "a") })),
    ...Array.from({ length: live }, (_, i) => ({ instance_id: 900 + i, package: "p", state: "running", up_s: 5, sha256: "y".repeat(64), apk: "C:/".padEnd(80, "b") })),
  ],
});

test("trimInstanceList: keeps live + newest KEEP_ENDED, summarizes the rest, stays valid JSON", () => {
  const out = trimInstanceList(list(24, 2));
  assert.ok(out, "a big, mostly-ended list is trimmed");
  const o = JSON.parse(out);
  assert.equal(o.instances.filter((i) => i.state === "running").length, 2, "both live instances kept");
  assert.equal(o.instances.filter((i) => String(i.state).startsWith("ended")).length, KEEP_ENDED);
  assert.equal(o.omittedEnded.count, 24 - KEEP_ENDED);
  // The kept ended ones are the newest (highest ids), and none of the dropped exceeds the kept.
  const keptIds = o.instances.filter((i) => String(i.state).startsWith("ended")).map((i) => i.instance_id);
  assert.deepEqual(keptIds.slice().sort((a, b) => b - a), [24, 23, 22, 21]);
  assert.ok(out.length < INSTANCE_TRIM_CHARS * 2, "the trimmed text is much smaller than the raw pile");
});

test("trimInstanceList: leaves small or not-ended-heavy lists exactly alone", () => {
  assert.equal(trimInstanceList(list(3, 1)), null, "few ended → untouched");
  assert.equal(trimInstanceList(JSON.stringify({ instances: [] })), null, "empty → untouched");
  assert.equal(trimInstanceList("not json"), null, "non-JSON → untouched");
  assert.equal(trimInstanceList(JSON.stringify({ ok: true })), null, "no instances array → untouched");
  // Many ended but tiny records that still fit under the threshold are left alone.
  const tiny = JSON.stringify({ instances: Array.from({ length: 20 }, (_, i) => ({ instance_id: i, state: "ended: x" })) });
  assert.equal(tiny.length <= INSTANCE_TRIM_CHARS ? trimInstanceList(tiny) : "trimmed", null);
});

test("waitDeviceVerdict: a named device is done when it is ready; otherwise it keeps waiting", () => {
  // The app's list_devices names each one `device` (an older shape used `id`): with `id` only, a named wait ran to its timeout.
  const two = (s) => JSON.stringify({ devices: [{ device: 2, state: s }] });
  assert.equal(waitDeviceVerdict(two("booting"), 2).done, false);
  assert.deepEqual(waitDeviceVerdict(two("ready"), 2).ready, [2]);
  assert.equal(waitDeviceVerdict(JSON.stringify({ devices: [{ id: 2, state: "ready" }] }), 2).done, true, "the old shape still works");
  assert.equal(waitDeviceVerdict(two("ready"), 2).done, true);
  assert.equal(waitDeviceVerdict(two("ready"), 9).done, false, "a device that is not the target does not end the wait");
  assert.equal(waitDeviceVerdict("not json", 2).done, false);
});

test("waitDeviceVerdict: no target → done once a device exists and none is still coming up", () => {
  const mix = (a, b) => JSON.stringify({ devices: [{ device: 1, state: a }, { device: 2, state: b }] });
  assert.equal(waitDeviceVerdict(mix("ready", "booting")).done, false, "one still booting");
  assert.equal(waitDeviceVerdict(mix("ready", "ready")).done, true);
  assert.equal(waitDeviceVerdict(JSON.stringify({ devices: [] })).done, false, "no devices at all");
  const v = waitDeviceVerdict(mix("ready", "closing"));
  assert.deepEqual([v.done, v.booting], [false, [2]], "closing counts as still coming/going");
});

test("repeatNudge: fires only on a watched read repeating byte-identical, never on change or other tools", async () => {
  const { repeatNudge } = await import("../integrations/pi/omni-mcp-lib.mjs");
  const prev = { name: "list_devices", args: "{}", result: "A" };
  assert.match(repeatNudge(prev, "list_devices", "{}", "A"), /nothing has changed/);
  assert.equal(repeatNudge(prev, "list_devices", "{}", "B"), null, "result changed → no nudge (real progress)");
  assert.equal(repeatNudge(prev, "list_devices", '{"x":1}', "A"), null, "different args → no nudge");
  assert.equal(repeatNudge(prev, "screenshot", "{}", "A"), null, "not a watched read → no nudge");
  assert.equal(repeatNudge(null, "list_devices", "{}", "A"), null, "no previous call → no nudge");
});

test("trimInstanceList: an oversized ended-heavy list stays VALID JSON under the 12000 clip (the production truncation)", () => {
  // Reproduces the 15 real cases: ended instances carry a crash `details` blob, pushing pretty past the clip.
  const CLIP = 12000;
  const clip = (s) => (s.length > CLIP ? s.slice(0, CLIP) + "\n… (truncated)" : s);
  const inst = (id, live) => ({
    apk: `\\?\C:\Users\berat\Desktop\rebuild\work\own${id}_signed.apk`, device: 1, display: 1,
    instance_id: id, package: "com.roblox.client", screenshot: null,
    sha256: "a62a96dd16ecc485374a46c1f674bb42588243c6632504f526620efb16a6" + String(id).padStart(4, "0"),
    state: live ? "running" : "ended: the app stopped", up_s: 30000 + id, user: 10,
    ...(live ? {} : { details: [`crash: signal 11 (SIGSEGV) in pid ${700000 + id}.`, "  #00 pc 5f8758 libzstd-jni.so", "  #01 pc df10f0 payload"] }),
  });
  const data = { instances: [...Array.from({ length: 30 }, (_, i) => inst(i + 1, false)), inst(90, true), inst(91, true)] };
  const text = JSON.stringify(data);
  const pretty = JSON.stringify(JSON.parse(text), null, 1);
  assert.ok(pretty.length > CLIP, "the raw pretty form overflows the clip (as the 15 real ones did)");
  assert.throws(() => JSON.parse(clip(pretty)), "OLD behavior: clipping the raw pretty form yields broken JSON");
  const shown = clip(trimInstanceList(text) ?? pretty);
  const parsed = JSON.parse(shown); // must not throw
  assert.ok(parsed.instances.some((i) => i.state === "running"), "live instances kept");
  assert.equal(parsed.omittedEnded.count, 26);
});
