'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ipp = require('../../src/print/ipp');
const { probeDevice, getAttributes, isPrivateHost } = require('../../src/print/discovery/probe');
const { mergeServices } = require('../../src/print/discovery/merge');

/** An IPP response with one printer-attributes group. */
function response(status, attrs) {
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt8(1, 1);
  head.writeUInt16BE(status, 2);
  head.writeUInt32BE(1, 4);
  const parts = [head, Buffer.from([0x01]), ipp.attr(ipp.Tag.charset, 'attributes-charset', 'utf-8'), ipp.attr(ipp.Tag.language, 'attributes-natural-language', 'en'), Buffer.from([0x04])];
  for (const [name, tag, values] of attrs) parts.push(ipp.attr(tag, name, values));
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}

const EPSON = [
  ['printer-name', ipp.Tag.name, 'EPSON'],
  ['printer-make-and-model', ipp.Tag.text, 'EPSON L3250 Series'],
  ['printer-uuid', ipp.Tag.uri, 'urn:uuid:cfe92100-67c4-11d4-a45f-d4808b1c0ba2'],
  ['printer-state', ipp.Tag.enum, 3],
  ['printer-state-reasons', ipp.Tag.keyword, 'none'],
  ['printer-is-accepting-jobs', ipp.Tag.boolean, true],
  ['color-supported', ipp.Tag.boolean, true],
  ['sides-supported', ipp.Tag.keyword, ['one-sided']],
  ['print-color-mode-supported', ipp.Tag.keyword, ['color', 'monochrome']],
  ['media-supported', ipp.Tag.keyword, ['iso_a4_210x297mm', 'iso_a3_297x420mm', 'na_letter_8.5x11in']],
];

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, Buffer.concat(chunks), res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const deviceAt = (port, extra = {}) => ({
  name: 'EPSON',
  host: undefined,
  addresses: ['127.0.0.1'],
  protocols: { ipp: { port, rp: 'ipp/print' } },
  announced: { color: true, duplex: false, pdl: [], acceptsPdf: false },
  ...extra,
});

test('probe reads exact properties from an IPP printer', async () => {
  let seen;
  const s = await server((req, body, res) => {
    seen = { path: req.url, body };
    res.end(response(0, EPSON));
  });
  const r = await probeDevice(deviceAt(s.address().port));
  s.close();
  assert.equal(seen.path, '/ipp/print');
  assert.equal(r.reachable, true);
  assert.equal(r.estimated, false);
  assert.deepEqual({ color: r.caps.color, duplex: r.caps.duplex, media: r.caps.media }, { color: true, duplex: false, media: ['A4', 'A3'] });
  assert.equal(r.status.online, true);
  assert.equal(r.uuid, 'cfe92100-67c4-11d4-a45f-d4808b1c0ba2');
  assert.equal(r.makeAndModel, 'EPSON L3250 Series');
});

test('a printer out of paper is reported offline with a plain message', async () => {
  const attrs = EPSON.map((a) => (a[0] === 'printer-state-reasons' ? ['printer-state-reasons', ipp.Tag.keyword, ['media-empty-error']] : a));
  const s = await server((req, body, res) => res.end(response(0, attrs)));
  const r = await probeDevice(deviceAt(s.address().port));
  s.close();
  assert.equal(r.reachable, true);
  assert.match(r.status.message || '', /paper/i);
});

test('an HTTP error or a refusal moves on and finally reports unreachable', async () => {
  const s = await server((req, body, res) => {
    res.statusCode = 500;
    res.end();
  });
  const r = await probeDevice(deviceAt(s.address().port), { tcp: async () => false });
  s.close();
  assert.equal(r.reachable, false);
  assert.match(r.status.message, /does not answer/);
});

test('a raw 9100 printer is estimated from what it announced', async () => {
  const dev = mergeServices([{ type: '_pdl-datastream._tcp', name: 'Old Brother', host: 'brw.local', port: 9100, addresses: ['10.0.0.5'], txt: { ty: 'Brother', Color: 'F', Duplex: 'T' } }])[0];
  let asked;
  const r = await probeDevice(dev, { tcp: async (host, port) => ((asked = [host, port]), true) });
  assert.deepEqual(asked, ['10.0.0.5', 9100]);
  assert.equal(r.estimated, true);
  assert.deepEqual({ color: r.caps.color, duplex: r.caps.duplex, media: r.caps.media }, { color: false, duplex: true, media: ['A4'] });
});

test('a raw printer whose port is closed is unreachable', async () => {
  const dev = mergeServices([{ type: '_pdl-datastream._tcp', name: 'X', host: 'x.local', port: 9100, addresses: ['10.0.0.5'], txt: { ty: 'X' } }])[0];
  assert.equal((await probeDevice(dev, { tcp: async () => false })).reachable, false);
});

test('certificates are only waived on local networks', () => {
  for (const h of ['printer.local', '192.168.1.9', '10.1.2.3', '172.20.0.4', '[fe80::1]', 'fd00::5', 'printer']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['printer.example.com', '8.8.8.8', '172.32.0.1', '2401:4900::1']) assert.equal(isPrivateHost(h), false, h);
});

test('getAttributes rejects a non-IPP status code', async () => {
  const s = await server((req, body, res) => res.end(response(0x0400, [])));
  await assert.rejects(getAttributes(`ipp://127.0.0.1:${s.address().port}/ipp/print`), /refused/);
  s.close();
});
