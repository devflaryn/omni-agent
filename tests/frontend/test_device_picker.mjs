// Drives the REAL frontend/device_view.js over the shared DOM shim.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(here, '..', '..', 'frontend');

function load() {
  const byId = new Map();
  for (const id of ['deviceChip', 'deviceChipName', 'devicePicker', 'deviceList']) {
    const el = new El('div'); el.id = id; byId.set(id, el);
  }
  const document = { getElementById: (id) => byId.get(id) || null,
                     createElement: (t) => new El(t), body: new El('div') };
  const ctx = { document, window: {}, console, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'device_view.js'), 'utf8'), ctx);
  return { ctx, byId };
}

{
  const { ctx, byId } = load();
  ctx.deviceChanged({ type: 'device_changed', device: null });
  assert.equal(ctx.deviceState().device, null);
  assert.ok(/this computer/i.test(byId.get('deviceChipName')._text
    || byId.get('deviceChipName')._html), 'local state names this computer');
  console.log('PASS local chip');
}

{
  const { ctx, byId } = load();
  ctx.deviceChanged({ type: 'device_changed',
    device: { id: 'i', name: 'build-box', target: 'berat@h', remote_root: '/r' } });
  const name = byId.get('deviceChipName');
  assert.ok(/build-box/.test(name._text || name._html), 'chip names the device');
  console.log('PASS remote chip names the device');
}

{
  // The remote state must be visually distinct — this is the guard against
  // running a destructive command believing you are local.
  const { ctx, byId } = load();
  ctx.deviceChanged({ type: 'device_changed',
    device: { id: 'i', name: 'box', target: 't', remote_root: '/r' } });
  assert.ok(byId.get('deviceChip')._classes.has('device-chip-remote'),
    'remote chip carries a distinct class');
  ctx.deviceChanged({ type: 'device_changed', device: null });
  assert.ok(!byId.get('deviceChip')._classes.has('device-chip-remote'),
    'switching back to local clears it');
  console.log('PASS remote chip is visually distinct');
}

{
  const { ctx } = load();
  ctx.deviceChanged({ device: { id: 'i', name: '<img src=x onerror=alert(1)>',
                                target: 't', remote_root: '/r' } });
  const html = ctx.deviceState().lastHtml || '';
  assert.ok(!html.includes('<img'), 'device names are escaped before innerHTML');
  console.log('PASS device name is escaped');
}

console.log('OK');
