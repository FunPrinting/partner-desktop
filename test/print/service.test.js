'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createPrintService, describeStatus } = require('../../src/print/service');
const { createFileEngine } = require('../../src/print/engines/fileEngine');

test('service: first run enables the default printer and saves settings in prefs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-svc-'));
  let saved = {};
  const prefs = { get: () => ({ printers: saved }), set: (patch) => (saved = patch.printers) };
  const svc = createPrintService({ prefs, dataDir: dir, engine: createFileEngine({ dir }) });
  await svc.start();
  const snap = svc.registry.snapshot();
  assert.equal(snap.printers.length, 1);
  assert.equal(snap.printers[0].enabled, true);
  assert.ok(Object.keys(saved).length === 1);
  svc.stop();
});

test('describeStatus gives plain sentences', () => {
  assert.match(describeStatus({ state: 'printing', fileName: 'a.pdf', printer: 'HP' }), /Printing a\.pdf on HP/);
  assert.equal(describeStatus({ state: 'failed', reason: 'Out of paper' }), 'Out of paper');
});
