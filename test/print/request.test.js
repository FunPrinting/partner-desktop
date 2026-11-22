'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { buildRequest, summaryPrefixPages } = require('../../src/print/request');
const { withSummary, pageCount } = require('../../src/print/pdf');
const { sendRequest } = require('../../src/print/sendRequest');
const { createFileEngine } = require('../../src/print/engines/fileEngine');
const { CODES } = require('../../src/print/engine');

async function pdf(pages, size = [595.28, 841.89]) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage(size).drawText(`p${i + 1}`, { x: 40, y: 40 });
  return Buffer.from(await d.save());
}

test('options map with safe defaults', () => {
  const r = buildRequest({ pageSize: 'Letter', color: 'weird', sided: 'single', copies: 0, pages: 4 });
  assert.equal(r.media, 'A4');
  assert.equal(r.colour, 'bw');
  assert.equal(r.copies, 1);
  assert.equal(r.duplex, false);
  assert.equal(r.totalPages, 4);
  const big = buildRequest({ pageSize: 'A3', color: 'color', sided: 'double', copies: 5000, pages: 1 });
  assert.deepEqual([big.media, big.duplex, big.copies], ['A3', true, 100]);
});

test('the real page count wins over the server page count', () => {
  assert.equal(buildRequest({ pages: 2 }, { pageCount: 9 }).totalPages, 9);
});

test('summary prints once, in B&W, before all copies; colour pages are shifted past it', () => {
  const r = buildRequest({ color: 'mixed', colorPages: [2], sided: 'double', copies: 2, pages: 3 }, { prefixPages: summaryPrefixPages(true) });
  // Summary + blank back = pages 1-2; document = pages 3-5 (sheets [3,4] [5])
  assert.deepEqual(
    r.runs.map((x) => `${x.summary ? 'S ' : ''}${x.colour}:${x.pages.join(',')}x${x.copies}`),
    ['S bw:1,2x1', 'color:3,4x1', 'bw:5x1', 'color:3,4x1', 'bw:5x1']
  );
});

test('a colour document with a summary prints the summary in B&W and the document in colour', () => {
  const r = buildRequest({ color: 'color', sided: 'single', copies: 3, pages: 2 }, { prefixPages: 1 });
  assert.deepEqual(r.runs.map((x) => `${x.colour}:${x.pages.join(',')}x${x.copies}`), ['bw:1x1', 'color:2,3x3']);
});

test('cohesive request produces one single document run', () => {
  const r = buildRequest({ color: 'mixed', colorPages: [2, 3], sided: 'single', copies: 2, pages: 4 }, { cohesive: true });
  assert.equal(r.runs.length, 1);
  assert.deepEqual(r.runs[0], { pages: [1, 2, 3, 4], colour: 'color', copies: 2 });
});

test('suffix summary sheet (LIFO mode) places summary run after document', () => {
  const r = buildRequest({ color: 'bw', sided: 'single', copies: 1, pages: 3 }, { suffixPages: 1 });
  assert.deepEqual(r.runs.map((x) => `${x.summary ? 'S ' : ''}${x.colour}:${x.pages.join(',')}x${x.copies}`), [
    'bw:1,2,3x1',
    'S bw:4x1',
  ]);
});

test('withSummary adds a blank back page for double-sided, sized to the paper', async () => {
  const one = await withSummary(await pdf(3), await pdf(1), { duplex: false });
  assert.equal(one.prefixPages, 1);
  assert.equal(await pageCount(one.bytes), 4);
  const two = await withSummary(await pdf(3), await pdf(1), { duplex: true, media: 'A3' });
  assert.equal(two.prefixPages, 2);
  const doc = await PDFDocument.load(two.bytes);
  assert.equal(doc.getPageCount(), 5);
  assert.equal(Math.round(doc.getPage(1).getWidth()), 842); // A3 blank
});

test('sendRequest prints the whole file directly and extracted runs as separate PDFs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-print-'));
  const src = path.join(dir, 'order.pdf');
  await fs.writeFile(src, await pdf(4));
  const engine = createFileEngine({ dir: path.join(dir, 'out') });

  const plain = buildRequest({ color: 'bw', copies: 2, pages: 4 });
  const a = await sendRequest(engine, { printer: 'Test Printer', sourcePath: src, request: plain, title: 'FP1' });
  assert.equal(a.length, 1);
  assert.equal(engine.jobs.get(a[0].jobRef).copies, 2);

  const mixed = buildRequest({ color: 'mixed', colorPages: [3], copies: 1, pages: 4 });
  const b = await sendRequest(engine, { printer: 'Test Printer', sourcePath: src, request: mixed, title: 'FP2' });
  assert.deepEqual(b.map((s) => engine.jobs.get(s.jobRef).colour), ['bw', 'color', 'bw']);
  const counts = await Promise.all(b.map(async (s) => pageCount(await fs.readFile(engine.jobs.get(s.jobRef).file))));
  assert.deepEqual(counts, [2, 1, 1]);
  // Temporary run files are cleaned up; only the source remains next to it
  assert.deepEqual((await fs.readdir(dir)).sort(), ['order.pdf', 'out']);
});

test('sendRequest reports runs already queued when a later run fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-print-'));
  const src = path.join(dir, 'order.pdf');
  await fs.writeFile(src, await pdf(3));
  const engine = createFileEngine({ dir: path.join(dir, 'out') });
  const realPrint = engine.print;
  let calls = 0;
  engine.print = async (job) => (++calls === 2 ? Promise.reject(Object.assign(new Error('gone'), { code: CODES.PRINTER_OFFLINE })) : realPrint(job));
  const req = buildRequest({ color: 'mixed', colorPages: [2], pages: 3 });
  await assert.rejects(sendRequest(engine, { printer: 'Test Printer', sourcePath: src, request: req, title: 'FP3' }), (err) => {
    assert.equal(err.sent.length, 1);
    return true;
  });
});
