'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ipp = require('../../src/print/ipp');
const { createCupsEngine, parsePpdOptions, ppdExtras } = require('../../src/print/engines/cupsEngine');
const { describeReasons, worstReason } = require('../../src/print/reasons');

// Attributes as the local CUPS server reports them (recorded from macOS CUPS 2.3)
const EPSON = {
  'printer-name': ['EPSON_L3250'],
  'printer-info': ['EPSON L3250 Series'],
  'printer-make-and-model': ['EPSON L3250 Series'],
  'device-uri': ['ipp://192.168.1.11/ipp/print'],
  'printer-uuid': ['urn:uuid:0ab88131-e5d6-333b-5505-04a2aa3544aa'],
  'printer-state': [3],
  'printer-state-reasons': ['none'],
  'printer-is-accepting-jobs': [true],
  'color-supported': [true],
  'sides-supported': ['one-sided'],
  'print-color-mode-supported': ['monochrome', 'color'],
  'media-supported': ['iso_a4_210x297mm', 'na_letter_8.5x11in'],
};
const LASER = {
  ...EPSON,
  'printer-name': ['HP_Laser'],
  'printer-uuid': ['urn:uuid:1111'],
  'color-supported': [false],
  'sides-supported': ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'],
  'print-color-mode-supported': ['monochrome'],
  'media-supported': ['iso_a4_210x297mm', 'iso_a3_297x420mm'],
};

function fakes({ printers = [EPSON, LASER], ppd = '', lp = { code: 0, stdout: 'request id is HP_Laser-42 (1 file(s))\n', stderr: '' }, job } = {}) {
  const calls = [];
  const fakeIpp = {
    ...ipp,
    getPrinters: async () => printers,
    getPrinterAttributes: async (name) => {
      const p = printers.find((x) => x['printer-name'][0] === name);
      if (!p) throw Object.assign(new Error('not found'), { ipp: 0x0406 });
      return p;
    },
    getJobAttributes: async () => job ?? null,
    cancelJob: async (...a) => calls.push(['cancel', ...a]),
  };
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'lpstat') return { code: 0, stdout: 'system default destination: EPSON_L3250\n', stderr: '' };
    if (file === 'lpoptions') return { code: 0, stdout: ppd, stderr: '' };
    return lp;
  };
  return { engine: createCupsEngine({ ipp: fakeIpp, run }), calls };
}

test('lists printers with a stable id, the default, and online state', async () => {
  const { engine } = fakes();
  const list = await engine.listPrinters();
  assert.deepEqual(list.map((p) => [p.name, p.isDefault, p.id, p.status.online]), [
    ['EPSON_L3250', true, 'urn:uuid:0ab88131-e5d6-333b-5505-04a2aa3544aa', true],
    ['HP_Laser', false, 'urn:uuid:1111', true],
  ]);
});

test('capabilities come from CUPS: colour, duplex, A4/A3', async () => {
  const { engine } = fakes();
  assert.deepEqual(await engine.capabilities('EPSON_L3250'), { color: true, duplex: false, media: ['A4'] });
  assert.deepEqual(await engine.capabilities('HP_Laser'), { color: false, duplex: true, media: ['A4', 'A3'] });
});

test('lp gets every option the printer supports, and nothing it does not', async () => {
  const { engine } = fakes();
  const laser = await engine.argsFor({ printer: 'HP_Laser', file: '/tmp/a.pdf', title: 'FP1 (1/2)', copies: 3, media: 'A3', duplex: true, colour: 'bw' });
  assert.deepEqual(laser, ['-d', 'HP_Laser', '-t', 'FP1 (1/2)', '-n', '3', '-o', 'collate=true', '-o', 'media=iso_a3_297x420mm', '-o', 'sides=two-sided-long-edge', '-o', 'print-color-mode=monochrome', '--', '/tmp/a.pdf']);
  // No duplex on this printer: asks for one-sided rather than an option it would reject
  const epson = await engine.argsFor({ printer: 'EPSON_L3250', file: '/tmp/b.pdf', copies: 1, media: 'A4', duplex: true, colour: 'color', fit: true });
  assert.ok(epson.includes('sides=one-sided'));
  assert.ok(epson.includes('print-color-mode=color'));
  assert.ok(epson.includes('fit-to-page'));
  assert.ok(!epson.includes('-n'));
});

test('PPD-only colour and duplex choices are added for driver queues', () => {
  const ppd = parsePpdOptions('ColorModel/Color Mode: *RGB Gray\nDuplex/2-Sided: *None DuplexNoTumble DuplexTumble\nPageSize/Media Size: *A4 A3 Letter\n');
  assert.deepEqual(ppd.ColorModel, { choices: ['RGB', 'Gray'], default: 'RGB' });
  assert.deepEqual(ppdExtras(ppd, { colour: 'bw', duplex: true }), ['ColorModel=Gray', 'Duplex=DuplexNoTumble']);
  assert.deepEqual(ppdExtras(ppd, { colour: 'color', duplex: false }), ['ColorModel=RGB', 'Duplex=None']);
  assert.deepEqual(ppdExtras(parsePpdOptions('ColorModel/Output Mode: *Gray\n'), { colour: 'color', duplex: false }), []);
});

test('print returns the CUPS job id; lp errors become clear codes', async () => {
  const ok = fakes();
  assert.deepEqual(await ok.engine.print({ printer: 'HP_Laser', file: '/tmp/a.pdf', copies: 1, media: 'A4', colour: 'bw' }), { jobRef: '42' });

  const offline = fakes({ lp: { code: 1, stdout: '', stderr: 'lp: Destination "HP_Laser" is not accepting jobs.' } });
  await assert.rejects(offline.engine.print({ printer: 'HP_Laser', file: '/tmp/a.pdf', copies: 1, media: 'A4', colour: 'bw' }), (e) => e.code === 'PRINTER_OFFLINE' && e.printerIssue);

  const missing = fakes();
  await assert.rejects(missing.engine.print({ printer: 'Gone', file: '/tmp/a.pdf', copies: 1, media: 'A4', colour: 'bw' }), (e) => e.code === 'PRINTER_NOT_FOUND');
});

test('job states map to completed / failed / held with the printer problem', async () => {
  const done = fakes({ job: { 'job-state': [9], 'job-state-reasons': ['job-completed-successfully'] } });
  assert.deepEqual(await done.engine.jobStatus('HP_Laser', '42'), { state: 'completed' });

  const aborted = fakes({ job: { 'job-state': [8], 'job-state-reasons': ['aborted-by-system'] } });
  assert.equal((await aborted.engine.jobStatus('HP_Laser', '42')).state, 'failed');

  const held = fakes({ printers: [{ ...LASER, 'printer-state': [5], 'printer-state-reasons': ['media-empty-error'] }], job: { 'job-state': [6], 'job-state-reasons': ['printer-stopped'] } });
  assert.deepEqual(await held.engine.jobStatus('HP_Laser', '42'), { state: 'held', reason: 'Out of paper. Load paper in the printer.' });

  const gone = fakes();
  assert.deepEqual(await gone.engine.jobStatus('HP_Laser', '42'), { state: 'unknown' });
});

test('printer reasons read as plain messages, worst first', () => {
  assert.deepEqual(describeReasons(['none', 'toner-low-report', 'media-jam-error']).map((r) => r.severity), ['info', 'attention']);
  assert.equal(worstReason(['toner-low-warning', 'offline-report']).message, 'The printer is offline. Check that it is on and connected.');
  assert.equal(worstReason(['toner-low-warning']), null);
  assert.equal(worstReason(['something-new-error']).severity, 'attention');
});

test('IPP encode/decode round trip', () => {
  const body = ipp.encode(ipp.Op.GetJobAttributes, 5, [ipp.attr(ipp.Tag.uri, 'printer-uri', 'ipp://localhost/printers/X'), ipp.attr(ipp.Tag.integer, 'job-id', 42)]);
  // A response is the same layout: version, status, request id, groups
  const res = ipp.decode(Buffer.concat([Buffer.from([1, 1, 0, 0]), body.subarray(4)]));
  assert.equal(res.statusCode, 0);
  assert.equal(res.requestId, 5);
  assert.deepEqual(res.groups[0].attrs['job-id'], [42]);
  assert.deepEqual(res.groups[0].attrs['printer-uri'], ['ipp://localhost/printers/X']);
});
