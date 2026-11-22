'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createPrintService } = require('../../src/print/service');
const { createFileEngine } = require('../../src/print/engines/fileEngine');
const { pageCount } = require('../../src/print/pdf');

test('test page prints one A4 page on the chosen printer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
  let saved = {};
  const prefs = { get: () => ({ printers: saved }), set: (p) => (saved = p.printers) };
  const engine = createFileEngine({ dir });
  const svc = createPrintService({ prefs, dataDir: dir, engine });
  await svc.start();
  const id = svc.registry.snapshot().printers[0].id;
  const { ms } = await svc.printTestPage(id);
  assert.ok(ms >= 0);
  const pdfs = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'));
  assert.equal(pdfs.length, 1);
  assert.equal(await pageCount(fs.readFileSync(path.join(dir, pdfs[0]))), 1);
  svc.stop();
});
