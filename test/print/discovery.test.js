'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeServices, parseTxt, ippUrl } = require('../../src/print/discovery/merge');

const epsonTxt = { txtvers: '1', ty: 'EPSON L3250 Series', usb_MFG: 'EPSON', usb_MDL: 'L3250 Series', rp: 'ipp/print', Color: 'T', Duplex: 'F', pdl: 'application/octet-stream,image/pwg-raster', UUID: 'cfe92100-67c4-11d4-a45f-d4808b1c0ba2' };
const addrs = ['192.168.1.9', 'fe80::d680:8bff:fe1c:ba2', '2401:4900:1f3b:1131:d680:8bff:fe1c:ba2'];
const svc = (type, port, extra = {}) => ({ type, name: 'EPSON L3250 Series', host: 'EPSON1C0BA2.local', port, addresses: addrs, txt: epsonTxt, ...extra });

test('one printer advertising four services becomes one device, IPPS preferred', () => {
  const devices = mergeServices([svc('_printer._tcp', 515), svc('_pdl-datastream._tcp', 9100), svc('_ipp._tcp', 631), svc('_ipps._tcp', 631)]);
  assert.equal(devices.length, 1);
  const d = devices[0];
  assert.equal(d.preferred, 'ipps');
  assert.deepEqual(Object.keys(d.protocols).sort(), ['ipp', 'ipps', 'lpd', 'socket']);
  assert.equal(d.protocols.socket.port, 9100);
  assert.equal(d.make, 'EPSON');
  assert.equal(d.uuid, 'cfe92100-67c4-11d4-a45f-d4808b1c0ba2');
  assert.deepEqual(d.announced, { color: true, duplex: false, pdl: ['application/octet-stream', 'image/pwg-raster'], acceptsPdf: false });
});

test('link-local addresses are dropped and IPv4 sorts first', () => {
  const d = mergeServices([svc('_ipp._tcp', 631)])[0];
  assert.deepEqual(d.addresses, ['192.168.1.9', '2401:4900:1f3b:1131:d680:8bff:fe1c:ba2']);
});

test('ippUrl prefers the .local host name so a changed IP keeps working', () => {
  const d = mergeServices([svc('_ipp._tcp', 631)])[0];
  assert.equal(ippUrl(d), 'ipp://epson1c0ba2.local:631/ipp/print');
  assert.equal(ippUrl(d, { preferHostName: false }), 'ipp://192.168.1.9:631/ipp/print');
});

test('without a UUID, services join by host name', () => {
  const noUuid = { ...epsonTxt };
  delete noUuid.UUID;
  const d = mergeServices([svc('_ipp._tcp', 631, { txt: noUuid, name: 'A' }), svc('_pdl-datastream._tcp', 9100, { txt: noUuid, name: 'B' })]);
  assert.equal(d.length, 1);
  assert.ok(d[0].protocols.ipp && d[0].protocols.socket);
});

test('a UUID that appears on a later record folds in earlier records of the same host', () => {
  const noUuid = { ...epsonTxt };
  delete noUuid.UUID;
  const d = mergeServices([svc('_pdl-datastream._tcp', 9100, { txt: noUuid }), svc('_ipp._tcp', 631)]);
  assert.equal(d.length, 1);
  assert.equal(d[0].id, 'uuid:cfe92100-67c4-11d4-a45f-d4808b1c0ba2');
});

test('two different printers stay apart', () => {
  const other = { ...epsonTxt, UUID: '11111111-2222-3333-4444-555555555555', ty: 'HP LaserJet' };
  const d = mergeServices([svc('_ipp._tcp', 631), { ...svc('_ipp._tcp', 631), name: 'HP', host: 'hp.local', txt: other, addresses: ['192.168.1.20'] }]);
  assert.equal(d.length, 2);
});

test('a printer with only a raw port is kept and marked as not IPP', () => {
  const d = mergeServices([{ type: '_pdl-datastream._tcp', name: 'Old Brother', host: 'brw.local', port: 9100, addresses: ['10.0.0.5'], txt: { ty: 'Brother HL-2130', pdl: 'application/vnd.brother-hbp' } }])[0];
  assert.equal(d.preferred, 'socket');
  assert.equal(ippUrl(d), null);
});

test('TXT parsing accepts objects, Buffers and key=value arrays', () => {
  assert.deepEqual(parseTxt({ RP: Buffer.from('ipp/print') }), { rp: 'ipp/print' });
  assert.deepEqual(parseTxt(['ty=Foo Bar', 'Color=T']), { ty: 'Foo Bar', color: 'T' });
  assert.deepEqual(parseTxt(undefined), {});
});

test('unknown service types are ignored', () => {
  assert.equal(mergeServices([{ type: '_http._tcp', name: 'x', port: 80 }]).length, 0);
});
