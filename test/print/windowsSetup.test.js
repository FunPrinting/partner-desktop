'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createWindowsEngine } = require('../../src/print/engines/windowsEngine');
const { printerName, windowsIppUrls, buildParams, chooseInstalledDriver, launcherCommand } = require('../../src/print/engines/windowsSetup');
const { mergeServices } = require('../../src/print/discovery/merge');

const txt = { ty: 'EPSON L3250 Series', UUID: 'u1', rp: 'ipp/print', usb_MFG: 'EPSON', usb_MDL: 'L3250 Series' };
const svc = (type, port, extra = {}) => ({ type, name: 'EPSON L3250 Series', host: 'EPSON1.local', port, addresses: ['192.168.1.9'], txt, ...extra });
const epson = mergeServices([svc('_ipps._tcp', 631), svc('_ipp._tcp', 631)])[0];
const brother = mergeServices([{ type: '_pdl-datastream._tcp', name: 'Brother HL-2130', host: 'brw.local', port: 9100, addresses: ['10.0.0.5'], txt: { ty: 'Brother HL-2130 series', usb_MFG: 'Brother', usb_MDL: 'HL-2130 series' } }])[0];

test('printer names are plain and unique', () => {
  assert.equal(printerName({ name: 'EPSON L3250 Series' }), 'EPSON L3250 Series');
  assert.equal(printerName({ name: 'EPSON L3250 Series' }, ['epson l3250 series']), 'EPSON L3250 Series (2)');
  assert.equal(printerName({ name: 'A;b|c"d' }), 'A b c d');
});

test('IPP URLs are http(s), host name first, with plain http as the last resort', () => {
  assert.deepEqual(windowsIppUrls(epson), [
    'https://epson1.local:631/ipp/print',
    'https://192.168.1.9:631/ipp/print',
    'http://epson1.local:631/ipp/print',
    'http://192.168.1.9:631/ipp/print',
  ]);
});

test('params: IPP printers get URLs, raw printers get a validated host and port', () => {
  assert.equal(buildParams(epson, []).mode, 'ipp');
  const raw = buildParams(brother, []);
  assert.deepEqual({ mode: raw.mode, host: raw.host, port: raw.port }, { mode: 'raw', host: '10.0.0.5', port: 9100 });
  assert.equal(buildParams({ ...brother, addresses: ['not an ip; calc'] }, []), null);
});

test('a raw printer needs an installed driver that matches its model exactly', () => {
  const installed = ['Brother HL-2130 series', 'Brother HL-2140 series', 'Microsoft IPP Class Driver'];
  assert.equal(chooseInstalledDriver(installed, { make: 'Brother', model: 'HL-2130 series' }), 'Brother HL-2130 series');
  assert.equal(chooseInstalledDriver(installed, { make: 'Brother', model: 'HL-2170W' }), null);
});

test('the elevated launcher quotes paths with spaces and apostrophes', () => {
  const c = launcherCommand("C:\\Users\\O'Neil\\AppData\\Local\\Temp\\fp add\\a.ps1", 'C:\\p.json', 'C:\\r.json');
  assert.match(c, /Start-Process -FilePath powershell\.exe -Verb RunAs -Wait/);
  assert.match(c, /'"C:\\Users\\O''Neil\\AppData\\Local\\Temp\\fp add\\a\.ps1"'/);
});

const native = { init() {}, listPrinters: () => [{ name: 'HP', port: 'USB001', driver: 'x', location: '', comment: '', status: 0, attributes: 0, jobs: 0, isDefault: true }] };

/** A fake PowerShell: the launcher call writes result.json like the elevated script would. */
function fakeRun({ result, drivers = [], launchCode = 0 }) {
  const calls = [];
  const run = async (file, args) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (/Get-PrinterDriver/.test(cmd)) return { code: 0, stdout: JSON.stringify(drivers), stderr: '' };
    const m = /'-Result','"([^"]+)"'/.exec(cmd);
    const p = /'-Params','"([^"]+)"'/.exec(cmd);
    calls.params = JSON.parse(fs.readFileSync(p[1], 'utf8'));
    calls.scriptExists = fs.existsSync(/'-File','"([^"]+)"'/.exec(cmd)[1]);
    if (result) fs.writeFileSync(m[1], JSON.stringify(result));
    return { code: launchCode, stdout: '', stderr: launchCode ? 'The operation was canceled by the user.' : '' };
  };
  return { run, calls };
}

test('addPrinter hands the script its details in a JSON file and returns the new printer', async () => {
  const f = fakeRun({ result: { ok: true, name: 'EPSON L3250 Series', via: 'https://epson1.local:631/ipp/print' } });
  const e = createWindowsEngine({ native, run: f.run });
  const r = await e.addPrinter(epson);
  assert.deepEqual(r, { name: 'EPSON L3250 Series', via: 'https://epson1.local:631/ipp/print' });
  assert.equal(f.calls.params.mode, 'ipp');
  assert.equal(f.calls.scriptExists, true);
});

test('declining the Windows permission prompt gives a plain message', async () => {
  const f = fakeRun({ result: null, launchCode: 1 });
  await assert.rejects(createWindowsEngine({ native, run: f.run }).addPrinter(epson), (err) => err.code === 'NEEDS_ADMIN' && /permission/.test(err.message));
});

test('a refusal from Windows is passed on', async () => {
  const f = fakeRun({ result: { ok: false, code: 'ADD_FAILED', message: 'The printer is not reachable' } });
  await assert.rejects(createWindowsEngine({ native, run: f.run }).addPrinter(epson), (err) => err.code === 'ADD_FAILED' && /not reachable/.test(err.message));
});

test('a raw printer with no installed driver stops before any permission prompt', async () => {
  const f = fakeRun({ drivers: ['Microsoft IPP Class Driver'] });
  await assert.rejects(createWindowsEngine({ native, run: f.run }).addPrinter(brother), (err) => err.code === 'NEEDS_DRIVER');
  assert.equal(f.calls.length, 1);
});

test('a raw printer with a matching driver is added with that driver', async () => {
  const f = fakeRun({ drivers: ['Brother HL-2130 series'], result: { ok: true, name: 'Brother HL-2130', via: 'IP_10.0.0.5' } });
  await createWindowsEngine({ native, run: f.run }).addPrinter(brother);
  assert.equal(f.calls.params.driver, 'Brother HL-2130 series');
  assert.equal(f.calls.params.host, '10.0.0.5');
});
