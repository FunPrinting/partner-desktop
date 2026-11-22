'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { browse } = require('../../src/print/discovery/browse');

const buf = (s) => Buffer.from(s);

/** A fake multicast-dns: answers the first PTR question, and SRV/TXT/A follow-ups, like a printer. */
function fakeMdns() {
  const e = new EventEmitter();
  e.queries = [];
  e.destroyed = false;
  const inst = (t) => `EPSON L3250._${t}._tcp.local`;
  const reply = (answers) => setImmediate(() => e.emit('response', { answers, additionals: [] }));
  e.query = ({ questions }) => {
    e.queries.push(questions);
    const answers = [];
    for (const q of questions) {
      if (q.type === 'PTR' && /^_(ipp|pdl-datastream)\._tcp\.local$/.test(q.name)) answers.push({ name: q.name, type: 'PTR', data: inst(q.name.split('.')[0].slice(1)) });
      if (q.type === 'SRV' && q.name.startsWith('epson l3250._')) answers.push({ name: q.name, type: 'SRV', data: { target: 'EPSON1.local', port: q.name.includes('_ipp') ? 631 : 9100 } });
      if (q.type === 'TXT' && q.name.startsWith('epson l3250._')) answers.push({ name: q.name, type: 'TXT', data: [buf('ty=EPSON L3250'), buf('UUID=u-1'), buf('rp=ipp/print'), buf('Color=T')] });
      if (q.type === 'A' && q.name === 'epson1.local') answers.push({ name: q.name, type: 'A', data: '10.0.0.2' });
    }
    if (answers.length) reply(answers);
  };
  e.destroy = () => (e.destroyed = true);
  return e;
}

test('browse asks for all four types in one packet, follows up, merges and stops', async () => {
  const m = fakeMdns();
  const { devices, error } = await browse({ timeoutMs: 1000, createMdns: () => m });
  assert.equal(error, undefined);
  assert.equal(m.queries[0].length, 4);
  assert.equal(devices.length, 1);
  const d = devices[0];
  assert.equal(d.preferred, 'ipp');
  assert.deepEqual(d.addresses, ['10.0.0.2']);
  assert.equal(d.protocols.socket.port, 9100);
  assert.equal(d.name, 'EPSON L3250');
  assert.equal(m.destroyed, true);
});

test('a service that never says its port is not listed', async () => {
  const m = new EventEmitter();
  m.query = ({ questions }) => {
    if (questions[0].type === 'PTR') setImmediate(() => m.emit('response', { answers: [{ name: '_ipp._tcp.local', type: 'PTR', data: 'X._ipp._tcp.local' }], additionals: [] }));
  };
  m.destroy = () => {};
  const { devices } = await browse({ timeoutMs: 300, createMdns: () => m });
  assert.deepEqual(devices, []);
});

test('browse reports an error instead of throwing', async () => {
  const r = await browse({ timeoutMs: 5, createMdns: () => { throw new Error('no network'); } });
  assert.deepEqual(r, { devices: [], error: 'no network' });
});
