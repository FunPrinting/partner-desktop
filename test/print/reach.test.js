'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createReach, targetsFor, connectState } = require('../../src/print/discovery/reach');
const { endpointOf, computeMoves } = require('../../src/print/discovery/match');
const { createRegistry } = require('../../src/print/registry');
const { createFileEngine } = require('../../src/print/engines/fileEngine');
const ipp = require('../../src/print/ipp');
const { createCupsEngine } = require('../../src/print/engines/cupsEngine');

test('endpoints: scheme, host and the default port of each protocol', () => {
  assert.deepEqual(endpointOf('ipp://192.168.1.11/ipp/print'), { scheme: 'ipp', host: '192.168.1.11', port: 631 });
  assert.deepEqual(endpointOf('socket://10.0.0.5:9100'), { scheme: 'socket', host: '10.0.0.5', port: 9100 });
  assert.deepEqual(endpointOf('lpd://printer.local/q'), { scheme: 'lpd', host: 'printer.local', port: 515 });
  assert.equal(endpointOf('usb://EPSON/L3250'), null);
  assert.equal(endpointOf('WSD-1'), null);
});

test('targets: a URL checks its own port, a Windows IP port tries the usual ones, others are skipped', () => {
  assert.deepEqual(targetsFor({ uri: 'ipps://p.local:631/x' }), { host: 'p.local', ports: [631] });
  assert.deepEqual(targetsFor({ uri: 'IP_192.168.1.9' }), { host: '192.168.1.9', ports: [9100, 631, 515, 80] });
  assert.equal(targetsFor({ uri: 'USB001' }), null);
});

test('reach: open port, closed port, and a name that cannot be looked up', async () => {
  const mk = (state) => createReach({ connect: async () => state });
  assert.deepEqual(await mk('open')({ uri: 'ipp://10.0.0.2/ipp/print' }), { reachable: true });
  assert.equal((await mk('closed')({ uri: 'ipp://10.0.0.2/ipp/print' })).reachable, false);
  assert.equal(await mk('unresolved')({ uri: 'ipp://printer.local/ipp/print' }), null); // cannot tell: not "offline"
  assert.equal(await mk('open')({ uri: 'usb://x' }), null);
});

test('connectState sees a real open and a real closed port', async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  assert.equal((await connectState('127.0.0.1', port, 500)).state, 'open');
  await new Promise((r) => server.close(r));
  const closed = await connectState('127.0.0.1', port, 500);
  assert.equal(closed.state, 'closed'); // ECONNREFUSED: something is there and said no
  assert.equal(closed.code, 'ECONNREFUSED');
  assert.equal((await connectState('no-such-host.invalid', 631, 500)).state, 'unresolved');
});

function registryWith(printers, reach) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-reach-'));
  let saved = {};
  return createRegistry({ engine: createFileEngine({ dir, printers }), store: { get: () => saved, set: (v) => (saved = v) }, reach });
}

test('a network printer that does not answer is shown offline even if the OS says ready', async () => {
  const reg = registryWith(
    [
      { id: 'n1', name: 'Net', displayName: 'Net', isDefault: true, uri: 'ipp://10.0.0.2/ipp/print', status: { online: true } },
      { id: 'u1', name: 'Usb', displayName: 'Usb', isDefault: false, uri: 'usb://x/1', status: { online: true } },
    ],
    async (p) => (p.name === 'Net' ? { reachable: false, message: 'gone' } : null)
  );
  await reg.refresh();
  const byName = Object.fromEntries(reg.snapshot().printers.map((p) => [p.name, p]));
  assert.equal(byName.Net.status.online, false);
  assert.equal(byName.Net.status.state, 'unreachable');
  assert.equal(byName.Net.status.message, 'gone');
  assert.equal(byName.Usb.status.online, true);
});

test('a check the system blocked is reported as blocked, not as a printer that is off', async () => {
  const blocked = createReach({ connect: async () => ({ state: 'blocked', code: 'EHOSTUNREACH' }) });
  assert.deepEqual(await blocked({ uri: 'ipp://10.0.0.2/ipp/print' }), { blocked: true, code: '631:EHOSTUNREACH' });
  const reg = registryWith([{ id: 'n3', name: 'Net', displayName: 'Net', isDefault: true, uri: 'ipp://10.0.0.2/x', status: { online: true } }], blocked);
  await reg.refresh();
  const snap = reg.snapshot();
  assert.equal(snap.printers[0].status.online, true);
  assert.equal(snap.networkBlocked, true);
});

test('a printer that has just printed stays ready even if a check gets no answer', async () => {
  const reg = registryWith([{ id: 'n4', name: 'Net', displayName: 'Net', isDefault: true, uri: 'ipp://10.0.0.2/x', status: { online: true } }], async () => ({ reachable: false, message: 'gone' }));
  await reg.refresh();
  assert.equal(reg.snapshot().printers[0].status.online, false);
  reg.notePrinted('Net');
  assert.equal(reg.snapshot().printers[0].status.online, true); // cleared at once
  await reg.refresh();
  assert.equal(reg.snapshot().printers[0].status.online, true); // and for the next 15 minutes
});

test('the check log says each change once', async () => {
  const lines = [];
  const r = createReach({ connect: async () => ({ state: 'closed', code: 'ETIMEDOUT' }), log: (m) => lines.push(m) });
  await r({ name: 'P', uri: 'ipp://10.0.0.2/x' });
  await r({ name: 'P', uri: 'ipp://10.0.0.2/x' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /P \(ipp:\/\/10\.0\.0\.2\/x\): no answer 631:ETIMEDOUT/);
});

test('a throwing reachability check never takes a printer offline', async () => {
  const reg = registryWith([{ id: 'n2', name: 'Net', displayName: 'Net', isDefault: true, uri: 'ipp://10.0.0.2/x', status: { online: true } }], async () => {
    throw new Error('boom');
  });
  await reg.refresh();
  assert.equal(reg.snapshot().printers[0].status.online, true);
});

const gone = { id: 'q1', name: 'Epson_old', displayName: 'Epson_old', driver: 'EPSON L3250 Series', uri: 'ipp://192.168.1.11/ipp/print', status: { online: false, state: 'unreachable' } };
const dev = (over = {}) => ({ id: 'uuid:a', uuid: 'a', name: 'EPSON L3250 Series', model: 'L3250 Series', serviceName: 'EPSON L3250 Series', host: 'e.local', addresses: ['192.168.1.9'], protocols: {}, ...over });

test('moves: a dead queue and one same-model printer at another address', () => {
  assert.deepEqual(computeMoves([gone], [dev()]), [{ printerId: 'q1', printerName: 'Epson_old', toId: 'uuid:a', toName: 'EPSON L3250 Series', address: '192.168.1.9' }]);
});

test('moves: nothing when it is ambiguous or the new printer is already set up', () => {
  assert.deepEqual(computeMoves([gone], [dev(), dev({ id: 'uuid:b', uuid: 'b', host: 'f.local', addresses: ['192.168.1.10'] })]), []);
  assert.deepEqual(computeMoves([gone, { ...gone, id: 'q2', name: 'Epson_old2' }], [dev()]), []);
  assert.deepEqual(computeMoves([gone, { id: 'q3', name: 'New', uri: 'ipp://192.168.1.9/ipp/print', status: { online: true } }], [dev()]), []);
  assert.deepEqual(computeMoves([{ ...gone, status: { online: true } }], [dev()]), []);
});

test('cups movePrinter keeps protocol, port and path and prefers the .local name', async () => {
  const calls = [];
  const engine = createCupsEngine({
    ipp: { ...ipp, getPrinterAttributes: async () => ({ 'device-uri': ['ipp://192.168.1.11:631/ipp/print'] }) },
    run: async (f, a) => (calls.push([f, ...a]), { code: 0, stdout: '', stderr: '' }),
  });
  const r = await engine.movePrinter('Epson_old', dev());
  assert.deepEqual(calls[0], ['lpadmin', '-p', 'Epson_old', '-v', 'ipp://e.local:631/ipp/print']);
  assert.equal(r.uri, 'ipp://e.local:631/ipp/print');
  const raw = createCupsEngine({
    ipp: { ...ipp, getPrinterAttributes: async () => ({ 'device-uri': ['socket://10.0.0.5:9100'] }) },
    run: async (f, a) => (calls.push([f, ...a]), { code: 0, stdout: '', stderr: '' }),
  });
  await raw.movePrinter('Old', dev({ addresses: ['10.0.0.77'] }));
  assert.deepEqual(calls[1].slice(-2), ['-v', 'socket://10.0.0.77:9100']);
});
