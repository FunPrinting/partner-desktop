'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sweep, subnetsOf } = require('../../src/print/discovery/sweep');
const { mergeServices } = require('../../src/print/discovery/merge');

const ifaces = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
  Ethernet: [{ family: 'IPv4', address: '192.168.1.6', internal: false }],
  VPN: [{ family: 'IPv4', address: '100.64.0.7', internal: false }],
};

test('only private networks are swept, each /24 once', () => {
  assert.deepEqual(subnetsOf(ifaces), [{ prefix: '192.168.1', self: '192.168.1.5' }]);
});

test('sweep finds printers that answer IPP, skips computers that only share printers, and is mergeable', async () => {
  const open = async (h) => h === '192.168.1.9' || h === '192.168.1.30';
  const attributes = async (url) => {
    if (url.startsWith('ipp://192.168.1.9:631/ipp/print')) return { 'printer-make-and-model': ['EPSON L3250 Series'], 'printer-uuid': ['urn:uuid:abc'], 'color-supported': [true], 'sides-supported': ['one-sided'], 'document-format-supported': ['image/pwg-raster'] };
    throw new Error('not a printer');
  };
  const { records, stats } = await sweep({ interfaces: ifaces, open, attributes, concurrency: 16 });
  assert.deepEqual(stats.subnets, ['192.168.1.0/24']);
  assert.deepEqual(stats.open.sort(), ['192.168.1.30', '192.168.1.9']);
  assert.equal(records.length, 1);
  const [d] = mergeServices(records);
  assert.equal(d.name, 'EPSON L3250 Series');
  assert.equal(d.uuid, 'abc');
  assert.deepEqual(d.addresses, ['192.168.1.9']);
  assert.deepEqual(d.announced, { color: true, duplex: false, pdl: ['image/pwg-raster'], acceptsPdf: false });
});

test('the sweep does not try its own address', async () => {
  const tried = [];
  await sweep({ interfaces: { 'Wi-Fi': ifaces['Wi-Fi'] }, open: async (h) => (tried.push(h), false), attributes: async () => ({}) });
  assert.equal(tried.length, 253);
  assert.ok(!tried.includes('192.168.1.5'));
});
