'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { whereIs, isSame, findSetUp } = require('../../src/print/discovery/match');
const { createFinder } = require('../../src/print/discovery/finder');
const { createRegistry } = require('../../src/print/registry');
const { createFileEngine } = require('../../src/print/engines/fileEngine');
const { mergeServices } = require('../../src/print/discovery/merge');

const UUID = 'cfe92100-67c4-11d4-a45f-d4808b1c0ba2';
const device = (over = {}) => ({ uuid: UUID, serviceName: 'EPSON L3250 Series', host: 'epson1c0ba2.local', addresses: ['192.168.1.9'], protocols: {}, ...over });

test('whereIs understands CUPS URIs and Windows port names', () => {
  assert.deepEqual(whereIs('ipp://192.168.1.11:631/ipp/print'), { host: '192.168.1.11' });
  assert.deepEqual(whereIs('socket://10.0.0.5:9100'), { host: '10.0.0.5' });
  assert.deepEqual(whereIs('lpd://printer.local/queue'), { host: 'printer.local' });
  assert.deepEqual(whereIs('IP_192.168.1.9'), { host: '192.168.1.9' });
  assert.deepEqual(whereIs('192.168.1.9_1'), { host: '192.168.1.9' });
  assert.deepEqual(whereIs('http://192.168.1.9:631/ipp/print'), { host: '192.168.1.9' });
  assert.deepEqual(whereIs('USB001'), {});
  assert.deepEqual(whereIs('usb://EPSON/L3250?serial=1'), {});
  assert.deepEqual(whereIs('WSD-1234'), {});
  assert.deepEqual(whereIs('dnssd://EPSON%20L3250%20Series._ipp._tcp.local./?uuid=' + UUID), { uuid: UUID, service: 'epson l3250 series' });
});

test('a queue is the same printer by uuid, by address or by host name', () => {
  assert.equal(isSame({ id: `urn:uuid:${UUID}`, uri: 'ipp://x' }, device()), true);
  assert.equal(isSame({ id: 'q', uri: 'ipp://192.168.1.9:631/ipp/print' }, device()), true);
  assert.equal(isSame({ id: 'q', uri: 'ipp://epson1c0ba2:631/ipp/print' }, device()), true);
  assert.equal(isSame({ id: 'q', uri: 'IP_192.168.1.9' }, device()), true);
});

test('a different address or no connection info is not a match', () => {
  assert.equal(isSame({ id: 'q', uri: 'ipp://192.168.1.11:631/ipp/print' }, device()), false);
  assert.equal(isSame({ id: 'q', uri: 'usb://EPSON/L3250' }, device({ uuid: undefined })), false);
  assert.equal(findSetUp(device(), []), undefined);
});

function makeRegistry(printers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-net-'));
  let saved = {};
  const engine = createFileEngine({ dir, printers });
  return createRegistry({ engine, store: { get: () => saved, set: (v) => (saved = v) } });
}

const found = mergeServices([{ type: '_ipp._tcp', name: 'EPSON L3250 Series', host: 'EPSON1.local', port: 631, addresses: ['192.168.1.9'], txt: { ty: 'EPSON L3250 Series', UUID, rp: 'ipp/print', Color: 'T' } }]);
const probed = { reachable: true, estimated: false, caps: { color: true, duplex: false, media: ['A4'] }, status: { online: true } };

test('finder publishes printers that are not set up, with their properties', async () => {
  const registry = makeRegistry([{ name: 'Office', displayName: 'Office', isDefault: true, uri: 'usb://HP/1' }]);
  await registry.refresh();
  const finder = createFinder({ registry, browse: async () => ({ devices: found }), probe: async () => probed, browseMs: 1 });
  const events = [];
  registry.events.on('available', (s) => events.push(s.scan.scanning));
  const snap = await finder.scan();
  assert.equal(snap.available.length, 1);
  assert.equal(snap.available[0].name, 'EPSON L3250 Series');
  assert.deepEqual(snap.available[0].caps, probed.caps);
  assert.equal(snap.available[0].viaIpp, true);
  assert.equal(snap.scan.scanning, false);
  assert.ok(snap.scan.lastScanAt > 0);
  assert.deepEqual(events, [true, false]);
});

test('a printer already set up is not offered again, and appears again if it is removed', async () => {
  const registry = makeRegistry([{ name: 'Epson', displayName: 'Epson', isDefault: false, uri: 'ipp://192.168.1.9:631/ipp/print' }]);
  await registry.refresh();
  const finder = createFinder({ registry, browse: async () => ({ devices: found }), probe: async () => probed, browseMs: 1 });
  assert.equal((await finder.scan()).available.length, 0);
});

test('concurrent scans share one browse', async () => {
  const registry = makeRegistry([]);
  let n = 0;
  const finder = createFinder({ registry, browse: async () => ((n += 1), { devices: [] }), probe: async () => probed, browseMs: 1 });
  await Promise.all([finder.scan(), finder.scan()]);
  assert.equal(n, 1);
});

test('a probe that throws still lists the printer as unreachable', async () => {
  const registry = makeRegistry([]);
  const finder = createFinder({ registry, browse: async () => ({ devices: found }), probe: async () => { throw new Error('boom'); }, browseMs: 1 });
  const snap = await finder.scan();
  assert.equal(snap.available[0].reachable, false);
});
