'use strict';
const { mergeServices, SERVICE_TYPES } = require('./merge');

/**
 * Looks for printers on the local network with mDNS (Bonjour / Avahi compatible) for
 * `timeoutMs`, then returns one merged device per printer.
 *
 * One packet asks for all four printer service types at once. (Several separate
 * browsers on one socket lose answers on macOS, so this does not use a browser library.)
 * Follow-up questions fetch the host, port, text record and addresses of every service
 * that answered without them. Never throws: no Wi-Fi or a blocking firewall gives an
 * empty list and `error`.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {() => object} [opts.createMdns]  override for tests; returns a multicast-dns instance
 * @returns {Promise<{ devices: object[], error?: string }>}
 */
async function browse({ timeoutMs = 3500, createMdns } = {}) {
  const types = Object.keys(SERVICE_TYPES);
  const instances = new Map(); // fqdn -> { type, name }
  const srv = new Map(); // fqdn -> { target, port }
  const txt = new Map(); // fqdn -> [Buffer]
  const addrs = new Map(); // host -> Set<address>
  let mdns;
  let error;
  const timers = [];

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

  function askMissing() {
    const questions = [];
    for (const fqdn of instances.keys()) {
      if (!srv.has(fqdn)) questions.push({ name: fqdn, type: 'SRV' });
      if (!txt.has(fqdn)) questions.push({ name: fqdn, type: 'TXT' });
      const host = srv.get(fqdn)?.target;
      if (host && !addrs.has(host)) questions.push({ name: host, type: 'A' }, { name: host, type: 'AAAA' });
    }
    if (questions.length) mdns.query({ questions });
  }

  try {
    mdns = createMdns ? createMdns() : require('multicast-dns')();
    mdns.on('error', (e) => (error = e.message));
    mdns.on('response', (res) => {
      ingest(res.answers);
      ingest(res.additionals);
    });
    const ask = () => mdns.query({ questions: types.map((t) => ({ name: `${t}.local`, type: 'PTR' })) });
    // mDNS advises repeating the question: printers on Wi-Fi miss some packets
    [0, 600, 1400].forEach((ms) => timers.push(setTimeout(ask, ms)));
    for (let ms = 400; ms < timeoutMs; ms += 500) timers.push(setTimeout(askMissing, ms));
    await new Promise((r) => setTimeout(r, timeoutMs));
  } catch (err) {
    error = err.message;
  } finally {
    timers.forEach(clearTimeout);
    try {
      mdns?.destroy();
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
  return { devices: mergeServices(records), ...(error ? { error } : {}) };
}

module.exports = { browse };
