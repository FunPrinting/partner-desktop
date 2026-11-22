'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../../src/print/registry');

function memoryStore(initial = {}) {
  let v = initial;
  return { get: () => v, set: (n) => (v = JSON.parse(JSON.stringify(n))), value: () => v };
}

function fakeEngine(list) {
  const state = { list, capsCalls: 0, fail: false };
  return {
    state,
    async listPrinters() {
      if (state.fail) throw new Error('print system down');
      return state.list.map((p) => ({ ...p }));
    },
    async capabilities(name) {
      state.capsCalls++;
      return { color: name.includes('Colour'), duplex: true, media: ['A4'] };
    },
  };
}

const laser = { id: 'uuid-1', name: 'HP_Laser', displayName: 'HP Laser', isDefault: true, uri: 'usb://HP', driver: 'HP', status: { online: true } };
const inkjet = { id: 'uuid-2', name: 'Epson_Colour', displayName: 'Epson Colour', isDefault: false, uri: 'ipp://1.2.3.4', driver: 'Epson', status: { online: true } };

test('first run enables the system default printer only', async () => {
  const store = memoryStore();
  const reg = createRegistry({ engine: fakeEngine([inkjet, laser]), store });
  const snap = await reg.refresh();
  assert.deepEqual(snap.printers.map((p) => [p.name, p.enabled]), [['Epson_Colour', false], ['HP_Laser', true]]);
  assert.deepEqual(reg.usable().map((p) => p.name), ['HP_Laser']);
});

test('the printer chosen in the older app version is enabled on upgrade', async () => {
  const store = memoryStore();
  const reg = createRegistry({ engine: fakeEngine([inkjet, laser]), store });
  await reg.refresh({ legacyPrinterName: 'Epson_Colour' });
  assert.deepEqual(reg.usable().map((p) => p.name), ['Epson_Colour']);
});

test('a renamed printer keeps its settings', async () => {
  const store = memoryStore();
  const engine = fakeEngine([laser]);
  const reg = createRegistry({ engine, store });
  await reg.refresh();
  reg.update('uuid-1', { preferredBw: true });
  engine.state.list = [{ ...laser, name: 'Front_Desk_Laser' }];
  const snap = await reg.refresh();
  assert.deepEqual(snap.printers.map((p) => [p.name, p.enabled, p.preferredBw]), [['Front_Desk_Laser', true, true]]);
  assert.equal(store.value()['uuid-1'].name, 'Front_Desk_Laser');
});

test('added and removed printers show up; offline printers are not usable', async () => {
  const engine = fakeEngine([laser]);
  const reg = createRegistry({ engine, store: memoryStore() });
  await reg.refresh();
  engine.state.list = [laser, inkjet];
  await reg.refresh();
  reg.update('uuid-2', { enabled: true });
  assert.equal(reg.usable().length, 2);
  engine.state.list = [{ ...laser, status: { online: false, message: 'Out of paper.' } }, inkjet];
  await reg.refresh();
  assert.deepEqual(reg.usable().map((p) => p.name), ['Epson_Colour']);
  engine.state.list = [laser];
  await reg.refresh();
  assert.deepEqual(reg.snapshot().printers.map((p) => p.name), ['HP_Laser']);
});

test('capabilities are read once, not on every refresh', async () => {
  const engine = fakeEngine([laser, inkjet]);
  const reg = createRegistry({ engine, store: memoryStore() });
  await reg.refresh();
  await reg.refresh();
  await reg.refresh();
  assert.equal(engine.state.capsCalls, 2);
  assert.equal(reg.get('uuid-2').caps.color, true);
});

test('only one printer is preferred for B&W; disabling a printer clears it', async () => {
  const reg = createRegistry({ engine: fakeEngine([laser, inkjet]), store: memoryStore() });
  await reg.refresh();
  reg.update('uuid-2', { enabled: true, preferredBw: true });
  reg.update('uuid-1', { preferredBw: true });
  assert.deepEqual(reg.snapshot().printers.map((p) => [p.name, p.preferredBw]), [['HP_Laser', true], ['Epson_Colour', false]]);
  reg.update('uuid-1', { enabled: false });
  assert.equal(reg.snapshot().printers[0].preferredBw, false);
});

test('a failing print system is reported, and the last list is kept', async () => {
  const engine = fakeEngine([laser]);
  const reg = createRegistry({ engine, store: memoryStore() });
  await reg.refresh();
  engine.state.fail = true;
  const snap = await reg.refresh();
  assert.equal(snap.lastError, 'print system down');
  assert.equal(snap.printers.length, 1);
});

test('changes are announced; an unchanged refresh is quiet', async () => {
  const reg = createRegistry({ engine: fakeEngine([laser]), store: memoryStore() });
  let n = 0;
  reg.events.on('changed', () => n++);
  await reg.refresh();
  const after = n;
  await reg.refresh();
  assert.equal(n, after);
});

test('an engine that cannot list printers reports why, instead of an empty list', async () => {
  const { createRegistry: make } = require('../../src/print/registry');
  let saved = {};
  const engine = {
    listPrinters: async () => {
      throw Object.assign(new Error('The print engine could not be loaded: LoadLibrary failed'), { code: 'DRIVER_FAILED' });
    },
    capabilities: async () => ({}),
  };
  const reg = make({ engine, store: { get: () => saved, set: (v) => (saved = v) } });
  const snap = await reg.refresh();
  require('node:assert/strict').deepEqual(snap.printers, []);
  require('node:assert/strict').match(snap.lastError, /could not be loaded/);
});
