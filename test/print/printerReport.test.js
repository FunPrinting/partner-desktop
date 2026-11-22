'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
// session.js needs electron; stub it for this unit test
require.cache[require.resolve('../../src/main/session')] = { id: 'x', filename: 'x', loaded: true, exports: {} };
const { createPrinterReporter, summarize } = require('../../src/main/printerReport');

const snap = { printers: [
  { name: 'B', enabled: true, caps: { color: false, duplex: true, media: ['A4'] } },
  { name: 'A', displayName: 'Epson', enabled: true, caps: { color: true, duplex: false, media: ['A4', 'A3'] } },
  { name: 'C', enabled: false, caps: { color: true, duplex: true, media: ['A4'] } },
] };

test('summarize lists enabled printers with capabilities', () => {
  assert.deepEqual(summarize(snap), [
    { name: 'B', color: false, duplex: true, a3: false },
    { name: 'Epson', color: true, duplex: false, a3: true },
  ]);
});

test('reporter sends once per change', async () => {
  const calls = [];
  const registry = { events: new EventEmitter(), snapshot: () => snap };
  const r = createPrinterReporter({ registry, apiFetch: async (...a) => (calls.push(a), { ok: true }) });
  await r.send();
  await r.send();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/partner/printers');
});
