'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { createRunner } = require('../../src/print/runner');
const { createCache } = require('../../src/print/cache');
const { createFileEngine } = require('../../src/print/engines/fileEngine');
const { renderSummary } = require('../../src/print/summary');
const { CODES, PrintError } = require('../../src/print/engine');

async function pdf(pages) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595.28, 841.89]);
  return Buffer.from(await d.save());
}

async function setup({ printers, pages = 4 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-run-'));
  const body = await pdf(pages);
  const srv = http.createServer((req, res) => (req.url.startsWith('/missing') ? res.writeHead(404).end() : res.end(body)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const engine = createFileEngine({ dir: path.join(dir, 'out'), printers: (printers || [{ name: 'Laser' }, { name: 'Inkjet' }]).map((p) => ({ displayName: p.name, ...p })) });
  const list = [
    { id: 'laser', name: 'Laser', displayName: 'Laser', enabled: true, isDefault: true, status: { online: true }, caps: { color: false, duplex: true, media: ['A4', 'A3'] } },
    { id: 'inkjet', name: 'Inkjet', displayName: 'Inkjet', enabled: true, isDefault: false, status: { online: true }, caps: { color: true, duplex: false, media: ['A4'] } },
  ];
  const registry = { refresh: async () => {}, snapshot: () => ({ printers: list }), get: (id) => list.find((p) => p.id === id) };
  const events = [];
  const runner = createRunner({
    engine,
    registry,
    cache: createCache({ dir: path.join(dir, 'cache'), backoffMs: 1 }),
    renderSummary,
    workDir: path.join(dir, 'work'),
    onStatus: (e) => events.push(e),
    sleep: async () => {},
    pollMs: 0,
  });
  return { dir, base, engine, list, runner, events, srv, close: () => srv.close() };
}

const file = (base, over = {}) => ({ name: 'a.pdf', printUrl: `${base}/a.pdf`, pageSize: 'A4', color: 'bw', sided: 'single', copies: 1, pages: 4, ...over });
const job = (files) => ({ jobId: 'J1', orderId: 'FP1', deliveryNumber: 'D-1', deliveryType: 'pickup', files });

test('prints each file on a printer that can do it, and reports which', async () => {
  const t = await setup();
  const results = [];
  await t.runner.runJob(job([file(t.base, { name: 'bw.pdf' }), file(t.base, { name: 'col.pdf', color: 'color', copies: 2 })]), { onFile: (i, r) => results.push([i, r.printer]) });
  assert.deepEqual(results, [[0, 'Laser'], [1, 'Inkjet']]);
  const printed = [...t.engine.jobs.values()];
  assert.deepEqual(printed.map((j) => [j.printer, j.colour, j.copies]), [['Laser', 'bw', 1], ['Inkjet', 'color', 2]]);
  t.close();
});

test('the cover sheet prints first, as its own B&W run with a blank back for double-sided; later files have none', async () => {
  const t = await setup();
  await t.runner.runJob(job([file(t.base, { sided: 'double', pages: 4 }), file(t.base)]), { coverSheet: true, order: { customerInfo: { name: 'Riya' } } });
  const jobs = [...t.engine.jobs.values()];
  const pageCounts = await Promise.all(jobs.map(async (j) => (await PDFDocument.load(await fs.readFile(j.file))).getPageCount()));
  // cover + blank back | the 4-page document | second file
  assert.deepEqual(pageCounts, [2, 4, 4]);
  assert.deepEqual(jobs.map((j) => j.colour), ['bw', 'bw', 'bw']);
  t.close();
});

test('files already printed are skipped when a job resumes, and no second cover sheet is made', async () => {
  const t = await setup();
  const results = [];
  await t.runner.runJob(job([file(t.base), file(t.base, { name: 'b.pdf' })]), { done: [0], coverSheet: true, onFile: (i) => results.push(i) });
  assert.deepEqual(results, [1]);
  assert.equal(t.engine.jobs.size, 1);
  assert.equal((await PDFDocument.load(await fs.readFile([...t.engine.jobs.values()][0].file))).getPageCount(), 4);
  t.close();
});

test('a printer that fails is skipped; the file prints on another capable printer', async () => {
  const t = await setup();
  t.list[1].caps = { ...t.list[1].caps, duplex: true }; // both can do the file
  const real = t.engine.print;
  t.engine.print = async (j) => {
    if (j.printer === 'Laser') throw new PrintError('Printer "Laser" is not accepting jobs', CODES.PRINTER_OFFLINE);
    return real(j);
  };
  const results = [];
  await t.runner.runJob(job([file(t.base, { sided: 'double' })]), { onFile: (i, r) => results.push(r.printer) });
  assert.deepEqual(results, ['Inkjet']);
  assert.ok(t.events.some((e) => e.state === 'attention' && /Laser/.test(e.reason)));
  t.close();
});

test('with no ready printer the file waits, and prints when one comes back', async () => {
  const t = await setup();
  t.list[0].status = { online: false, message: 'Out of paper. Load paper in the printer.' };
  t.list[1].enabled = false;
  let polls = 0;
  const runner = createRunner({ engine: t.engine, registry: { refresh: async () => { if (++polls === 3) t.list[0].status = { online: true }; }, snapshot: () => ({ printers: t.list }), get: () => t.list[0] }, cache: createCache({ dir: path.join(t.dir, 'cache2') }), renderSummary, workDir: t.dir, onStatus: (e) => t.events.push(e), sleep: async () => {} });
  await runner.runJob(job([file(t.base)]));
  assert.equal([...t.engine.jobs.values()].length, 1);
  assert.ok(t.events.some((e) => e.state === 'attention' && /Out of paper/.test(e.reason)));
  t.close();
});

test('a file no enabled printer can print fails at once with the reason', async () => {
  const t = await setup();
  await assert.rejects(t.runner.runJob(job([file(t.base, { pageSize: 'A3', color: 'color' })])), (e) => e.fatal === true && /No single printer can do colour and A3 paper together/.test(e.message));
  assert.equal(t.engine.jobs.size, 0);
  t.close();
});

test('a missing file fails at once; a flaky print is retried', async () => {
  const t = await setup();
  await assert.rejects(t.runner.runJob(job([file(t.base, { printUrl: `${t.base}/missing.pdf` })])), (e) => e.code === 'FILE_UNREADABLE');

  const real = t.engine.print;
  let n = 0;
  t.engine.print = async (j) => (++n < 3 ? Promise.reject(new PrintError('spooler hiccup', CODES.UNKNOWN)) : real(j));
  await t.runner.runJob(job([file(t.base)]));
  assert.equal(n, 3);
  assert.equal(t.engine.jobs.size, 1);
  t.close();
});

test('a job that is not print-ready yet is not printed', async () => {
  const t = await setup();
  await assert.rejects(t.runner.runJob(job([{ ...file(t.base), printUrl: undefined }])), (e) => e.notReady === true);
  t.close();
});

test('cancelling stops before the next file', async () => {
  const t = await setup();
  const results = [];
  await t.runner.runJob(job([file(t.base), file(t.base, { name: 'b.pdf' })]), {
    onFile: (i) => {
      results.push(i);
      t.runner.cancel('J1');
    },
  });
  assert.deepEqual(results, [0]);
  t.close();
});
