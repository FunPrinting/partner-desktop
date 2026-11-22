'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const packet = require('dns-packet');
const { browse, adapters } = require('../../src/print/discovery/browse');

const buf = (s) => Buffer.from(s);
const inst = (t) => `EPSON L3250._${t}._tcp.local`;

/** What a printer answers to a question packet (legacy unicast: straight back to the sender). */
function printerAnswer(questions) {
  const answers = [];
  for (const q of questions) {
    if (q.type === 'PTR' && /^_(ipp|pdl-datastream)\._tcp\.local$/.test(q.name)) answers.push({ name: q.name, type: 'PTR', data: inst(q.name.split('.')[0].slice(1)) });
    if (q.type === 'SRV' && q.name.startsWith('epson l3250._')) answers.push({ name: q.name, type: 'SRV', data: { target: 'EPSON1.local', port: q.name.includes('_ipp') ? 631 : 9100 } });
    if (q.type === 'TXT' && q.name.startsWith('epson l3250._')) answers.push({ name: q.name, type: 'TXT', data: [buf('ty=EPSON L3250'), buf('UUID=u-1'), buf('rp=ipp/print'), buf('Color=T')] });
    if (q.type === 'A' && q.name === 'epson1.local') answers.push({ name: q.name, type: 'A', data: '10.0.0.2' });
  }
  return answers.length ? packet.encode({ type: 'response', answers }) : null;
}

/**
 * Fake sockets. `printerOn` is the adapter address the printer is reachable from.
 * `sharedBlocked`: binding port 5353 fails, like Windows Firewall / another mDNS service.
 */
function fakeNet({ printerOn = '10.0.0.5', sharedBlocked = false } = {}) {
  const made = [];
  const createSocket = () => {
    const s = new EventEmitter();
    s.closed = false;
    s.memberships = [];
    s.bind = (port, address, cb) => {
      if (typeof address === 'function') [address, cb] = [undefined, address];
      s.port = port;
      s.address = address;
      if (port === 5353 && sharedBlocked) setImmediate(() => s.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' })));
      else setImmediate(cb);
      return s;
    };
    s.setMulticastInterface = (a) => (s.iface = a);
    s.setMulticastTTL = () => {};
    s.addMembership = (g, a) => s.memberships.push(a);
    s.send = (b, off, len, port, host, cb) => {
      setImmediate(() => cb && cb(null));
      if (s.iface !== printerOn) return; // asked on the wrong adapter: no printer there
      const answer = printerAnswer(packet.decode(b).questions);
      if (answer) setImmediate(() => s.emit('message', answer, { address: '10.0.0.2', port: 5353 }));
    };
    s.close = () => (s.closed = true);
    made.push(s);
    return s;
  };
  return { made, createSocket };
}

const ifaces = {
  lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
  'Wi-Fi': [{ family: 'IPv4', address: '10.0.0.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
  APIPA: [{ family: 'IPv4', address: '169.254.3.3', internal: false }],
};

test('adapters: real IPv4 networks only (no loopback, no self-assigned 169.254)', () => {
  assert.deepEqual(adapters(ifaces), [
    { name: 'vEthernet (WSL)', address: '172.20.0.1' },
    { name: 'Wi-Fi', address: '10.0.0.5' },
  ]);
});

test('asks on every adapter and finds the printer behind the Wi-Fi one, even with port 5353 blocked', async () => {
  const net = fakeNet({ sharedBlocked: true });
  const { devices, stats, error } = await browse({ timeoutMs: 1200, deps: { createSocket: net.createSocket, interfaces: ifaces } });
  assert.equal(error, undefined);
  assert.equal(devices.length, 1);
  const d = devices[0];
  assert.equal(d.name, 'EPSON L3250');
  assert.equal(d.preferred, 'ipp');
  assert.deepEqual(d.addresses, ['10.0.0.2']);
  assert.equal(d.protocols.socket.port, 9100);
  assert.equal(stats.shared, 'EADDRINUSE');
  assert.deepEqual(stats.adapters.map((a) => [a.name, a.answers > 0]), [['vEthernet (WSL)', false], ['Wi-Fi', true]]);
  // per-adapter sockets: random port, bound to the adapter, sending out of it
  const perAdapter = net.made.filter((s) => s.port === 0);
  assert.deepEqual(perAdapter.map((s) => [s.address, s.iface]), [['172.20.0.1', '172.20.0.1'], ['10.0.0.5', '10.0.0.5']]);
  assert.ok(net.made.every((s) => s.closed));
});

test('no network at all is reported, not thrown', async () => {
  const r = await browse({ timeoutMs: 50, deps: { createSocket: fakeNet().createSocket, interfaces: { lo0: ifaces.lo0 } } });
  assert.deepEqual(r.devices, []);
  assert.match(r.error, /not connected/);
});

test('a service that never says its port is not listed', async () => {
  const createSocket = () => {
    const s = fakeNet().createSocket();
    s.send = (b, off, len, port, host, cb) => {
      cb && cb(null);
      const q = packet.decode(b).questions;
      if (q[0].type === 'PTR') setImmediate(() => s.emit('message', packet.encode({ type: 'response', answers: [{ name: '_ipp._tcp.local', type: 'PTR', data: 'X._ipp._tcp.local' }] })));
    };
    return s;
  };
  const { devices } = await browse({ timeoutMs: 600, deps: { createSocket, interfaces: { 'Wi-Fi': ifaces['Wi-Fi'] } } });
  assert.deepEqual(devices, []);
});
