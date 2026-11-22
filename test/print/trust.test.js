'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { connectPinned, isPrivateHost, normalise, shortFingerprint, CertChangedError } = require('../../src/print/discovery/trust');

const cert = {
  a: { key: fs.readFileSync(path.join(__dirname, '../fixtures/tls/printer-a.key')), cert: fs.readFileSync(path.join(__dirname, '../fixtures/tls/printer-a.crt')) },
  b: { key: fs.readFileSync(path.join(__dirname, '../fixtures/tls/printer-b.key')), cert: fs.readFileSync(path.join(__dirname, '../fixtures/tls/printer-b.crt')) },
};

test('isPrivateHost: local names and private addresses', () => {
  for (const h of ['printer.local', '192.168.1.9', '10.1.2.3', '172.20.0.4', '[fe80::1]', 'fd00::5', 'printer']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['printer.example.com', '8.8.8.8', '172.32.0.1', '2401:4900::1']) assert.equal(isPrivateHost(h), false, h);
});

test('connectPinned: the first connection records the fingerprint, same one passes, different one fails', async () => {
  const server = https.createServer(cert.a, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const first = await connectPinned({ host: '127.0.0.1', port });
    first.socket.destroy();
    assert.ok(first.fingerprint.length > 20);
    const same = await connectPinned({ host: '127.0.0.1', port, pin: first.fingerprint });
    same.socket.destroy();
    assert.equal(normalise(same.fingerprint), normalise(first.fingerprint));
    server.setSecureContext(cert.b);
    await assert.rejects(connectPinned({ host: '127.0.0.1', port, pin: first.fingerprint }), (e) => e.code === 'CERT_CHANGED');
  } finally {
    server.close();
  }
});

test('connectPinned: refuses TLS < 1.2', async () => {
  const server = https.createServer({ ...cert.a, maxVersion: 'TLSv1.1' }, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(connectPinned({ host: '127.0.0.1', port, timeoutMs: 2000 }), /EPROTO|version|alert/i);
  } finally {
    server.close();
  }
});

test('shortFingerprint: first 8 bytes with colons', () => {
  assert.equal(shortFingerprint('ab:cd:ef:01:23:45:67:89:aa:bb'), 'AB:CD:EF:01:23:45:67:89');
  assert.equal(shortFingerprint('abcdef0123456789aabb'), 'AB:CD:EF:01:23:45:67:89');
});
