'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createPrintService } = require('../../src/print/service');
const { createFileEngine } = require('../../src/print/engines/fileEngine');
const { mergeServices } = require('../../src/print/discovery/merge');

const txt = (extra = {}) => ({ ty: 'Test Printer X', UUID: 'u-x', rp: 'ipp/print', ...extra });
const ippDevice = mergeServices([{ type: '_ipp._tcp', name: 'Test Printer X', host: 'x.local', port: 631, addresses: ['10.0.0.9'], txt: txt() }]);
const rawDevice = mergeServices([{ type: '_pdl-datastream._tcp', name: 'Old Raw', host: 'raw.local', port: 9100, addresses: ['10.0.0.8'], txt: { ty: 'Old Raw', UUID: 'u-raw' } }]);
const exact = { reachable: true, estimated: false, caps: { color: true, duplex: false, media: ['A4'] }, status: { online: true } };
const estimated = { reachable: true, estimated: true, caps: { color: false, duplex: false, media: ['A4'] }, status: { online: true } };

function setup(devices, probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-addnet-'));
  let saved = {};
  const listed = [{ name: 'Office', displayName: 'Office', isDefault: true, uri: 'usb://HP/1' }];
  const base = createFileEngine({ dir, printers: listed }); // the same array: a printer added later can print
  const engine = {
    ...base,
    listPrinters: async () => listed.map((p) => ({ ...p })),
    addPrinter: async (device) => {
      listed.push({ name: device.name, displayName: device.name, isDefault: false, uri: `ipp://${device.host}:631/ipp/print` });
      return { name: device.name, via: 'x' };
    },
  };
  const svc = createPrintService({ prefs: { get: () => ({ printers: saved }), set: (p) => (saved = p.printers) }, dataDir: dir, engine, discovery: { browse: async () => ({ devices }), sweep: async () => ({ records: [], stats: {} }), probe: async () => probe, browseMs: 1 } });
  return { svc, engine };
}

test('adding an IPP printer switches it on', async () => {
  const { svc } = setup(ippDevice, exact);
  await svc.start();
  const snap = await svc.scanNetwork();
  assert.equal(snap.available.length, 1);
  const r = await svc.addNetworkPrinter(snap.available[0].id);
  assert.equal(r.enabled, true);
  const after = svc.registry.snapshot();
  assert.equal(after.printers.find((p) => p.name === 'Test Printer X').enabled, true);
  assert.equal(after.available.length, 1);
  assert.equal(after.available[0].setUpAs, 'Test Printer X');
  svc.stop();
});

test('a printer with only estimated abilities stays off until a test page prints', async () => {
  const { svc } = setup(rawDevice, estimated);
  await svc.start();
  const snap = await svc.scanNetwork();
  const r = await svc.addNetworkPrinter(snap.available[0].id);
  assert.equal(r.enabled, false);
  let p = svc.registry.snapshot().printers.find((x) => x.name === 'Old Raw');
  assert.equal(p.enabled, false);
  assert.equal(p.needsTest, true);
  await svc.printTestPage(p.id);
  p = svc.registry.snapshot().printers.find((x) => x.name === 'Old Raw');
  assert.equal(p.enabled, true);
  assert.equal(p.needsTest, false);
  svc.stop();
});

test('adding something that is no longer found asks to search again', async () => {
  const { svc } = setup([], exact);
  await svc.start();
  await assert.rejects(svc.addNetworkPrinter('uuid:nope'), /Search again/);
  svc.stop();
});

test('a failing add leaves the list as it was', async () => {
  const { svc, engine } = setup(ippDevice, exact);
  engine.addPrinter = async () => {
    throw Object.assign(new Error('needs admin'), { code: 'NEEDS_ADMIN' });
  };
  await svc.start();
  const snap = await svc.scanNetwork();
  await assert.rejects(svc.addNetworkPrinter(snap.available[0].id), (e) => e.code === 'NEEDS_ADMIN');
  assert.equal(svc.registry.snapshot().available.length, 1);
  svc.stop();
});
