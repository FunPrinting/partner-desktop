'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowsEngine, PS, JS } = require('../../src/print/engines/windowsEngine');

function fakeNative(over = {}) {
  const calls = [];
  return {
    calls,
    init: (p) => calls.push(['init', p]),
    listPrinters: () => [
      { name: 'HP LaserJet', port: 'USB001', driver: 'HP Universal', location: '', comment: '', status: 0, attributes: 0, jobs: 0, isDefault: true },
      { name: 'Epson L3250', port: 'IP_192.168.1.11', driver: 'EPSON L3250', location: 'Counter', comment: '', status: PS.OFFLINE, attributes: 0, jobs: 0, isDefault: false },
    ],
    capabilities: (name) => (name === 'HP LaserJet' ? { color: false, duplex: true, papers: [9, 8, 1], maxCopies: 999, collate: true } : { color: true, duplex: false, papers: [9], maxCopies: 1, collate: false }),
    print: async (job) => {
      calls.push(['print', job]);
      return { jobId: 77, pages: 3, sheetsSent: 3, mode: 'emf', driverCopies: true };
    },
    jobStatus: () => ({ found: false, status: 0, statusText: '', pagesPrinted: 0, totalPages: 0 }),
    cancelJob: (...a) => calls.push(['cancel', ...a]),
    ...over,
  };
}

const engineWith = (native) => createWindowsEngine({ native, pdfiumPath: 'C:\\app\\pdfium.dll' });

test('listing printers does not need PDFium; printing loads it once, with the given path', async () => {
  const n = fakeNative();
  const e = engineWith(n);
  await e.listPrinters();
  await e.capabilities('HP LaserJet');
  assert.deepEqual(n.calls.filter((c) => c[0] === 'init'), []);
  await e.print({ printer: 'HP LaserJet', file: 'a.pdf', copies: 1, media: 'A4', colour: 'bw' });
  await e.print({ printer: 'HP LaserJet', file: 'a.pdf', copies: 1, media: 'A4', colour: 'bw' });
  assert.deepEqual(n.calls.filter((c) => c[0] === 'init'), [['init', 'C:\\app\\pdfium.dll']]);
});

test('a PDFium that will not load fails printing but still lists printers', async () => {
  const n = fakeNative({
    init: () => {
      throw new Error('DRIVER_FAILED: LoadLibrary failed (126)');
    },
  });
  const e = engineWith(n);
  assert.equal((await e.listPrinters()).length, 2);
  await assert.rejects(e.print({ printer: 'HP LaserJet', file: 'a.pdf', copies: 1, media: 'A4', colour: 'bw' }), (err) => err.code === 'DRIVER_FAILED' && /LoadLibrary/.test(err.message));
});

test('in the installed app the native files are read from app.asar.unpacked', () => {
  const { nativeDir } = require('../../src/print/engines/windowsEngine');
  assert.match(nativeDir('C:\\Program Files\\FunPrinting Partner\\resources\\app.asar'), /resources\\app\.asar\.unpacked[\\/]native[\\/]fp-print$/);
  assert.match(nativeDir('/opt/app/resources/app.asar'), /app\.asar\.unpacked\/native\/fp-print$/);
  assert.equal(nativeDir('/src/partner-desktop'), require('node:path').join('/src/partner-desktop', 'native', 'fp-print'));
});

test('printers get a stable id (port + driver) and an online state from the spooler flags', async () => {
  const list = await engineWith(fakeNative()).listPrinters();
  assert.deepEqual(list.map((p) => [p.name, p.id, p.isDefault, p.status.online]), [
    ['HP LaserJet', 'USB001|HP Universal', true, true],
    ['Epson L3250', 'IP_192.168.1.11|EPSON L3250', false, false],
  ]);
  assert.match(list[1].status.message, /offline/i);
});

test('paper out, jam and a paused queue become clear messages', async () => {
  const n = fakeNative({
    listPrinters: () => [
      { name: 'A', port: 'p1', driver: 'd', status: PS.PAPER_OUT, attributes: 0, jobs: 1, isDefault: false },
      { name: 'B', port: 'p2', driver: 'd', status: PS.PAPER_JAM, attributes: 0, jobs: 0, isDefault: false },
      { name: 'C', port: 'p3', driver: 'd', status: PS.PAUSED, attributes: 0, jobs: 0, isDefault: false },
      { name: 'D', port: 'p4', driver: 'd', status: 0, attributes: 0x400, jobs: 0, isDefault: false },
    ],
  });
  const [a, b, c, d] = await engineWith(n).listPrinters();
  assert.match(a.status.message, /Out of paper/);
  assert.match(b.status.message, /jam/i);
  assert.equal(c.status.online, false);
  assert.equal(d.status.online, false); // "Use printer offline" is set
});

test('capabilities map Windows paper ids to A4/A3', async () => {
  const e = engineWith(fakeNative());
  assert.deepEqual(await e.capabilities('HP LaserJet'), { color: false, duplex: true, media: ['A4', 'A3'] });
  assert.deepEqual(await e.capabilities('Epson L3250'), { color: true, duplex: false, media: ['A4'] });
});

test('print passes every setting to the add-on and returns the spooler job id', async () => {
  const n = fakeNative();
  const out = await engineWith(n).print({ printer: 'HP LaserJet', file: 'C:\\x.pdf', title: 'FP1', copies: 2, media: 'A3', duplex: true, colour: 'bw' });
  assert.deepEqual(out, { jobRef: '77', mode: 'emf', pages: 3 });
  assert.deepEqual(n.calls.find((c) => c[0] === 'print')[1], { printer: 'HP LaserJet', file: 'C:\\x.pdf', title: 'FP1', copies: 2, duplex: true, color: false, paper: 'A3' });
});

test('add-on errors keep their code', async () => {
  const mk = (msg) => engineWith(fakeNative({ print: async () => { throw new Error(msg); } }));
  const job = { printer: 'X', file: 'f', copies: 1, media: 'A4', colour: 'bw' };
  await assert.rejects(mk('PRINTER_NOT_FOUND: The printer was not found').print(job), (e) => e.code === 'PRINTER_NOT_FOUND' && e.printerIssue);
  await assert.rejects(mk('FILE_UNREADABLE: The PDF file is damaged').print(job), (e) => e.code === 'FILE_UNREADABLE' && !e.retryable);
  await assert.rejects(mk('boom').print(job), (e) => e.code === 'DRIVER_FAILED');
});

test('a job that leaves the queue is completed; one deleted by someone is failed', async () => {
  let status = { found: true, status: JS.PRINTING, statusText: '', pagesPrinted: 1, totalPages: 3 };
  const e = engineWith(fakeNative({ jobStatus: () => status }));
  assert.equal((await e.jobStatus('HP LaserJet', '77')).state, 'printing');
  status = { found: false, status: 0, statusText: '', pagesPrinted: 0, totalPages: 0 };
  assert.deepEqual(await e.jobStatus('HP LaserJet', '77'), { state: 'completed' });

  // Deleted from the Windows print queue window
  status = { found: true, status: JS.DELETING, statusText: '', pagesPrinted: 0, totalPages: 3 };
  assert.equal((await e.jobStatus('HP LaserJet', '78')).state, 'failed');
  status = { found: true, status: JS.PRINTING | JS.DELETING, statusText: '', pagesPrinted: 0, totalPages: 3 };
  await e.jobStatus('HP LaserJet', '79');
  status = { found: false, status: 0, statusText: '', pagesPrinted: 0, totalPages: 0 };
  const gone = await e.jobStatus('HP LaserJet', '79');
  assert.equal(gone.state, 'failed');
  assert.equal(gone.cancelled, true);
});

test('a job stuck on the printer is held with the reason', async () => {
  const n = fakeNative({
    jobStatus: () => ({ found: true, status: JS.PAPEROUT, statusText: '', pagesPrinted: 0, totalPages: 3 }),
    listPrinters: () => [{ name: 'HP LaserJet', port: 'USB001', driver: 'd', status: PS.PAPER_OUT, attributes: 0, jobs: 1, isDefault: true }],
  });
  assert.deepEqual(await engineWith(n).jobStatus('HP LaserJet', '77'), { state: 'held', reason: 'Out of paper. Load paper in the printer.' });
});

test('cancel never throws', async () => {
  const e = engineWith(fakeNative({ cancelJob: () => { throw new Error('PRINTER_NOT_FOUND: gone'); } }));
  await assert.doesNotReject(e.cancel('X', '1'));
});
