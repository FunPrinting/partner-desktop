'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { renderSummary, compactPages } = require('../../src/print/summary');
const { prepareFile } = require('../../src/print/prepare');

const job = {
  orderId: 'FP1001',
  deliveryNumber: 'A20261118-1',
  deliveryType: 'pickup',
  createdAt: '2026-11-18T10:00:00.000Z',
  service: ['binding'],
  files: [
    { name: 'notes.pdf', pages: 12, pageSize: 'A4', sided: 'double', color: 'mixed', colorPages: [1, 2, 3, 7], copies: 2 },
    { name: 'राम.pdf', pages: 1, pageSize: 'A3', sided: 'single', color: 'color', copies: 1 },
  ],
};

async function pdf(pages) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595.28, 841.89]);
  return Buffer.from(await d.save());
}

test('the cover sheet is one A4 page, even with non-Latin names', async () => {
  const doc = await PDFDocument.load(await renderSummary(job, { customerInfo: { name: 'प्रिया Sharma', phone: '9876543210' }, amount: 120 }));
  assert.equal(doc.getPageCount(), 1);
  const p = doc.getPage(0);
  assert.deepEqual([Math.round(p.getWidth()), Math.round(p.getHeight())], [595, 842]);
});

test('compactPages writes page ranges', () => {
  assert.equal(compactPages([9, 1, 2, 3, 7, 10, 3]), '1-3, 7, 9-10');
});

test('prepareFile: without a cover sheet the cached file is printed as it is', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-prep-'));
  const cached = path.join(dir, 'cached.pdf');
  await fs.writeFile(cached, await pdf(5));
  const out = await prepareFile({ file: { ...job.files[1], pages: 99 }, cachedPath: cached, workDir: dir, name: 'J1-1' });
  assert.equal(out.sourcePath, cached);
  assert.equal(out.request.totalPages, 5); // the real page count, not the server's
});

test('prepareFile: cover sheet + blank back for double-sided, and colour pages follow it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-prep-'));
  const cached = path.join(dir, 'cached.pdf');
  await fs.writeFile(cached, await pdf(4));
  const file = { pageSize: 'A4', sided: 'double', color: 'mixed', colorPages: [3], copies: 1, pages: 4 };
  const out = await prepareFile({ file, cachedPath: cached, workDir: path.join(dir, 'work'), name: 'J1-0', summary: await renderSummary(job) });
  assert.notEqual(out.sourcePath, cached);
  assert.equal((await PDFDocument.load(await fs.readFile(out.sourcePath))).getPageCount(), 6);
  assert.deepEqual(out.request.runs.map((r) => `${r.colour}:${r.pages.join(',')}`), ['bw:1,2', 'bw:3,4', 'color:5,6']);
  // The cached download is untouched
  assert.equal((await PDFDocument.load(await fs.readFile(cached))).getPageCount(), 4);
  await out.cleanup();
  await assert.rejects(fs.stat(out.sourcePath));
});
