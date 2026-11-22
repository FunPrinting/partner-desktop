'use strict';
const dgram = require('node:dgram');
const os = require('node:os');
const { mergeServices, SERVICE_TYPES } = require('./merge');

/**
 * Looks for printers on the local network with mDNS (Bonjour / Avahi compatible) for
 * `timeoutMs`, then returns one merged device per printer and what happened (`stats`).
 *
 * How it asks, so that it works on a locked-down Windows PC:
 *  - On EVERY network adapter (Wi-Fi, Ethernet; PCs often also have VPN, Hyper-V, WSL or
 *    Docker adapters, and the default one may not be the printer's network), a socket on
 *    a random port sends the question to 224.0.0.251:5353. A question from a port other
 *    than 5353 is a "legacy unicast" query (RFC 6762 6.7): printers answer straight back to
 *    that socket. Windows Firewall lets that answer in (it is a reply to the app's own
 *    packet), so no firewall rule or admin rights are needed.
 *  - One shared socket on port 5353 also listens for ordinary multicast answers, where the
 *    system allows it (macOS, Linux, Windows with FunPrinting allowed through the firewall).
 *  - Questions are repeated (Wi-Fi drops packets), and follow-ups ask for the host, port,
 *    text record and addresses of every service that answered without them.
 * Never throws: no network gives an empty list and an `error`.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.deps]  { createSocket, interfaces, packet } overrides for tests
 * @returns {Promise<{ devices: object[], error?: string, stats: object }>}
 */

const MDNS = { address: '224.0.0.251', port: 5353 };

/** Non-internal IPv4 adapters: [{ name, address }] */
function adapters(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && !/^169\.254\./.test(i.address)) out.push({ name, address: i.address });
    }
  }
  return out;
}

async function browse({ timeoutMs = 3500, deps = {} } = {}) {
  const packet = deps.packet || require('dns-packet');
  const createSocket = deps.createSocket || ((o) => dgram.createSocket(o));
  const types = Object.keys(SERVICE_TYPES);
  const stats = { adapters: [], sent: 0, answers: 0, shared: 'not started', errors: [] };
  const instances = new Map(); // fqdn -> { type, name }
  const srv = new Map(); // fqdn -> { target, port }
  const txt = new Map(); // fqdn -> [Buffer]
  const addrs = new Map(); // host -> Set<address>
  const sockets = []; // { socket, adapter? }
  const timers = [];
  let error;
  let id = Math.floor(Math.random() * 0xffff);

  const lower = (s) => String(s).toLowerCase();
  function ingest(records) {
    for (const r of records || []) {
      const name = lower(r.name || '');
      if (r.type === 'PTR') {
        const type = types.find((t) => name === `${t}.local`);
        if (type) instances.set(lower(r.data), { type, name: String(r.data).slice(0, String(r.data).length - `.${type}.local`.length) });
      } else if (r.type === 'SRV' && r.data) srv.set(name, { target: lower(r.data.target), port: r.data.port });
      else if (r.type === 'TXT') txt.set(name, r.data);
      else if ((r.type === 'A' || r.type === 'AAAA') && typeof r.data === 'string') {
        if (!addrs.has(name)) addrs.set(name, new Set());
        addrs.get(name).add(r.data);
      }
    }
  }
  function onMessage(buf, from) {
    let msg;
    try {
      msg = packet.decode(buf);
    } catch {
      return;
    }
    if (msg.type !== 'response') return;
    stats.answers += 1;
    if (from) from.answers += 1;
    ingest(msg.answers);
    ingest(msg.additionals);
  }
  function send(questions) {
    if (!questions.length) return;
    id = (id + 1) & 0xffff;
    const buf = packet.encode({ type: 'query', id, questions });
    for (const s of sockets) {
      if (!s.ready) continue;
      s.socket.send(buf, 0, buf.length, MDNS.port, MDNS.address, (err) => {
        if (err) {
          if (s.adapter) s.adapter.error = err.code || err.message;
        } else stats.sent += 1;
      });
    }
  }
  function askMissing() {
    const questions = [];
    for (const fqdn of instances.keys()) {
      if (!srv.has(fqdn)) questions.push({ name: fqdn, type: 'SRV' });
      if (!txt.has(fqdn)) questions.push({ name: fqdn, type: 'TXT' });
      const host = srv.get(fqdn)?.target;
      if (host && !addrs.has(host)) questions.push({ name: host, type: 'A' });
    }
    send(questions.slice(0, 30));
  }

  // One socket per adapter, on a random port, sending out of that adapter
  const list = adapters(deps.interfaces);
  await Promise.all(
    list.map(
      (a) =>
        new Promise((resolve) => {
          const entry = { name: a.name, address: a.address, answers: 0 };
          stats.adapters.push(entry);
          let socket;
          try {
            socket = createSocket({ type: 'udp4', reuseAddr: true });
          } catch (err) {
            entry.error = err.code || err.message;
            return resolve();
          }
          const s = { socket, adapter: entry, ready: false };
          sockets.push(s);
          socket.on('error', (err) => {
            entry.error = err.code || err.message;
            resolve();
          });
          socket.on('message', (buf) => onMessage(buf, entry));
          socket.bind(0, a.address, () => {
            try {
              socket.setMulticastInterface(a.address);
              socket.setMulticastTTL(255);
            } catch (err) {
              entry.error = err.code || err.message;
            }
            s.ready = true;
            resolve();
          });
        })
    )
  );

  // The shared port: ordinary multicast answers, when the system lets the app listen
  try {
    const shared = createSocket({ type: 'udp4', reuseAddr: true });
    sockets.push({ socket: shared, ready: false, sharedListener: true });
    shared.on('error', (err) => (stats.shared = err.code || err.message));
    shared.on('message', (buf) => onMessage(buf, null));
    shared.bind(MDNS.port, () => {
      stats.shared = 'listening';
      for (const a of list) {
        try {
          shared.addMembership(MDNS.address, a.address);
        } catch {
          // this adapter can't join: the per-adapter socket still asks there
        }
      }
    });
  } catch (err) {
    stats.shared = err.code || err.message;
  }

  if (!list.length) error = 'This computer is not connected to a network.';
  const ask = () => send(types.map((t) => ({ name: `${t}.local`, type: 'PTR' })));
  [0, 700, 1600].forEach((ms) => timers.push(setTimeout(ask, ms)));
  for (let ms = 400; ms < timeoutMs; ms += 500) timers.push(setTimeout(askMissing, ms));
  await new Promise((r) => setTimeout(r, timeoutMs));
  timers.forEach(clearTimeout);
  for (const s of sockets) {
    try {
      s.socket.close();
    } catch {
      // already closed
    }
  }

  const records = [];
  for (const [fqdn, inst] of instances) {
    const s = srv.get(fqdn);
    if (!s) continue; // no host or port: nothing to connect to
    records.push({ type: inst.type, name: inst.name, host: s.target, port: s.port, addresses: [...(addrs.get(s.target) || [])], txt: txt.get(fqdn) });
  }

  // On macOS, if UDP sockets found no printers (firewall, sandboxing, or mDNSResponder
  // monopolising port 5353), use native dns-sd via IPC to mDNSResponder.
  if (!records.length && process.platform === 'darwin' && !deps.createSocket) {
    try {
      const { browseMac } = require('./dnssdMac');
      const macRecords = await browseMac({ timeoutMs: Math.min(2500, timeoutMs) });
      if (macRecords && macRecords.length) {
        records.push(...macRecords);
        error = undefined;
      }
    } catch {}
  }

  if (!error && list.length && stats.adapters.every((a) => a.error)) error = `Could not search the network (${stats.adapters.map((a) => a.error).join(', ')})`;
  return { devices: mergeServices(records), stats, ...(error ? { error } : {}) };
}

module.exports = { browse, adapters };
