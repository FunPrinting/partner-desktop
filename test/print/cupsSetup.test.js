'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ipp = require('../../src/print/ipp');
const { createCupsEngine } = require('../../src/print/engines/cupsEngine');
const { queueName, ippCandidates, parseDrivers, pickDriver, rawUri, isPermissionError } = require('../../src/print/engines/cupsSetup');
const { mergeServices } = require('../../src/print/discovery/merge');

const txt = { ty: 'EPSON L3250 Series', UUID: 'u1', rp: 'ipp/print', usb_MFG: 'EPSON', usb_MDL: 'L3250 Series' };
const svc = (type, port, extra = {}) => ({ type, name: 'EPSON L3250 Series', host: 'EPSON1.local', port, addresses: ['192.168.1.9'], txt, ...extra });
const epson = mergeServices([svc('_ipps._tcp', 631), svc('_ipp._tcp', 631), svc('_pdl-datastream._tcp', 9100)])[0];
const brother = mergeServices([{ type: '_pdl-datastream._tcp', name: 'Brother HL-2130', host: 'brw.local', port: 9100, addresses: ['10.0.0.5'], txt: { ty: 'Brother HL-2130 series', usb_MFG: 'Brother', usb_MDL: 'HL-2130 series' } }])[0];

test('queue names are safe and unique', () => {
  assert.equal(queueName({ name: 'EPSON L3250 Series' }), 'EPSON_L3250_Series');
  assert.equal(queueName({ name: 'EPSON L3250 Series' }, ['EPSON_L3250_Series']), 'EPSON_L3250_Series_2');
  assert.match(queueName({ name: '../../etc; rm -rf' }), /^[A-Za-z0-9_-]+$/);
  assert.match(queueName({ name: '###' }), /^Printer$/);
});

test('IPP addresses: .local name first, then IP, then plain ipp for a failing TLS handshake', () => {
  assert.deepEqual(ippCandidates(epson), [
    'ipps://epson1.local:631/ipp/print',
    'ipps://192.168.1.9:631/ipp/print',
    'ipp://epson1.local:631/ipp/print',
    'ipp://192.168.1.9:631/ipp/print',
  ]);
});

const DRIVERS = parseDrivers(`drv:///brlaser.drv/brl2130.ppd Brother HL-2130 series, using brlaser v6
drv:///brlaser.drv/brl2140.ppd Brother HL-2140 series, using brlaser v6
drv:///sample.drv/generic.ppd Generic PostScript Printer
everywhere IPP Everywhere
lsb/usr/cupsfilters/Generic-PDF_Printer-PDF.ppd Generic PDF Printer`);

test('driver matching needs every model word and never picks a sibling model', () => {
  assert.equal(pickDriver(DRIVERS, { make: 'Brother', model: 'HL-2130 series' }).id, 'drv:///brlaser.drv/brl2130.ppd');
  assert.equal(pickDriver(DRIVERS, { make: 'Brother', model: 'HL-2170W' }), null);
  assert.equal(pickDriver(DRIVERS, { make: 'Canon', model: 'HL-2130 series' }), null);
  assert.equal(pickDriver(DRIVERS, { make: 'X', model: undefined }), null);
});

test('raw URIs for socket and LPD', () => {
  assert.equal(rawUri(brother), 'socket://10.0.0.5:9100');
  const lpd = mergeServices([{ type: '_printer._tcp', name: 'L', host: 'l.local', port: 515, addresses: ['10.0.0.6'], txt: { ty: 'L', rp: 'raw' } }])[0];
  assert.equal(rawUri(lpd), 'lpd://10.0.0.6/raw');
});

test('permission errors are recognised', () => {
  assert.equal(isPermissionError('lpadmin: Forbidden'), true);
  assert.equal(isPermissionError('lpadmin: Unauthorized'), true);
  assert.equal(isPermissionError('lpadmin: Unable to connect'), false);
});

function engineWith(responses, opts = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    const r = responses(file, args, calls.length);
    return r || { code: 0, stdout: '', stderr: '' };
  };
  const engine = createCupsEngine({ run, ipp: { ...ipp, getPrinters: async () => (opts.existing || []).map((n) => ({ 'printer-name': [n] })) }, platform: opts.platform || 'darwin' });
  return { engine, calls };
}

test('addPrinter sets an IPP printer up driverless with the .local address', async () => {
  const { engine, calls } = engineWith(() => null);
  const r = await engine.addPrinter(epson);
  assert.equal(r.name, 'EPSON_L3250_Series');
  assert.deepEqual(calls[0], ['lpadmin', '-p', 'EPSON_L3250_Series', '-E', '-D', 'EPSON L3250 Series', '-v', 'ipps://epson1.local:631/ipp/print', '-m', 'everywhere']);
});

test('addPrinter tries the next address when the first fails', async () => {
  const { engine, calls } = engineWith((f, a, n) => (n === 1 ? { code: 1, stdout: '', stderr: 'lpadmin: Unable to connect' } : null));
  const r = await engine.addPrinter(epson);
  assert.equal(calls.length, 2);
  assert.equal(r.via, 'ipps://192.168.1.9:631/ipp/print');
});

test('addPrinter says so when every address fails', async () => {
  const { engine } = engineWith(() => ({ code: 1, stdout: '', stderr: 'lpadmin: Bad device URI' }));
  await assert.rejects(engine.addPrinter(epson), (e) => e.code === 'ADD_FAILED' && /Bad device URI/.test(e.message));
});

test('a user who may not change printers gets a clear message on macOS', async () => {
  const { engine, calls } = engineWith(() => ({ code: 1, stdout: '', stderr: 'lpadmin: Forbidden' }));
  await assert.rejects(engine.addPrinter(epson), (e) => e.code === 'NEEDS_ADMIN');
  assert.equal(calls.length, 1);
});

test('on Linux a permission error is retried through pkexec', async () => {
  const { engine, calls } = engineWith((f) => (f === 'lpadmin' ? { code: 1, stdout: '', stderr: 'lpadmin: Forbidden' } : null), { platform: 'linux' });
  const r = await engine.addPrinter(epson);
  assert.equal(calls[1][0], 'pkexec');
  assert.equal(calls[1][1], 'lpadmin');
  assert.equal(r.name, 'EPSON_L3250_Series');
});

test('a raw printer uses its manufacturer driver, or says it has none', async () => {
  const list = `drv:///brlaser.drv/brl2130.ppd Brother HL-2130 series, using brlaser v6\n`;
  const { engine, calls } = engineWith((f) => (f === 'lpinfo' ? { code: 0, stdout: list, stderr: '' } : null));
  await engine.addPrinter(brother);
  assert.deepEqual(calls[1].slice(-4), ['-v', 'socket://10.0.0.5:9100', '-m', 'drv:///brlaser.drv/brl2130.ppd']);
  const none = engineWith((f) => (f === 'lpinfo' ? { code: 0, stdout: 'everywhere IPP Everywhere\n', stderr: '' } : null)).engine;
  await assert.rejects(none.addPrinter(brother), (e) => e.code === 'NEEDS_DRIVER' && /no driver/.test(e.message));
});

test('an existing queue name is not reused', async () => {
  const { engine, calls } = engineWith(() => null, { existing: ['EPSON_L3250_Series'] });
  assert.equal((await engine.addPrinter(epson)).name, 'EPSON_L3250_Series_2');
  assert.equal(calls[0][2], 'EPSON_L3250_Series_2');
});

test('removePrinter deletes the queue, treats an already-gone queue as done, and refuses odd names', async () => {
  const { engine, calls } = engineWith(() => null);
  assert.deepEqual(await engine.removePrinter('_192_168_1_11'), { removed: true });
  assert.deepEqual(calls[0], ['lpadmin', '-x', '_192_168_1_11']);
  const gone = engineWith(() => ({ code: 1, stdout: '', stderr: 'lpadmin: The printer or class does not exist.' })).engine;
  assert.deepEqual(await gone.removePrinter('Old'), { removed: true });
  await assert.rejects(engine.removePrinter('a; rm -rf /'), /not a printer name/);
  const denied = engineWith(() => ({ code: 1, stdout: '', stderr: 'lpadmin: Forbidden' })).engine;
  await assert.rejects(denied.removePrinter('Epson'), (e) => e.code === 'NEEDS_ADMIN');
});
