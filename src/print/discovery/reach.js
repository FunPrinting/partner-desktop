'use strict';
const dns = require('node:dns');
const net = require('node:net');
const { endpointOf, whereIs } = require('./match');

/**
 * Is a network printer answering? The OS keeps showing "Ready" for a queue whose printer
 * was switched off or got a new IP address, so the app asks the network itself: can we
 * open the printer's port? Only network queues are checked (not USB, WSD, file ports).
 *
 * Returns { reachable: true } | { reachable: false, message } | null (cannot tell).
 * A host name that does not resolve is "cannot tell", never "offline": some systems
 * can't look up .local names.
 */

const FALLBACK_PORTS = [9100, 631, 515, 80];

function targetsFor(printer) {
  const ep = endpointOf(printer.uri);
  if (ep) return { host: ep.host, ports: [ep.port] };
  const w = whereIs(printer.uri); // Windows "IP_192.168.1.9" ports
  if (w.host) return { host: w.host, ports: FALLBACK_PORTS };
  return null;
}

/** { ok, code?, ms } for one TCP connection attempt. */
function tryOne(address, port, timeoutMs, now = Date.now) {
  return new Promise((resolve) => {
    const started = now();
    const s = net.connect({ host: address, port });
    const done = (ok, code) => {
      s.destroy();
      resolve({ ok, code, ms: now() - started });
    };
    s.setTimeout(timeoutMs, () => done(false, 'ETIMEDOUT'));
    s.on('connect', () => done(true));
    s.on('error', (err) => done(false, err.code || 'ERROR'));
  });
}

/**
 * Errors that mean "this app was not allowed to connect" rather than "nothing is there":
 * macOS Local Network privacy refuses at once with EHOSTUNREACH, sandboxes and some
 * firewalls with EACCES / EPERM. A printer that is really off times out instead.
 */
const BLOCK_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM', 'EADDRNOTAVAIL']);
const BLOCKED_WITHIN_MS = 100;

/**
 * { state: 'open' | 'closed' | 'blocked' | 'unresolved', code?, ms? }. A name can resolve
 * to several addresses (IPv4, IPv6, link-local): every one is tried, IPv4 first, and one
 * open port is enough.
 */
async function connectState(host, port, timeoutMs, lookup = dns.lookup) {
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      const all = await new Promise((resolve, reject) => lookup(host, { all: true }, (err, list) => (err ? reject(err) : resolve(list))));
      addresses = all.map((a) => a.address).sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
    } catch (err) {
      return { state: 'unresolved', code: err.code };
    }
  }
  const tries = [];
  for (const address of addresses.slice(0, 4)) {
    const t = await tryOne(address, port, timeoutMs);
    if (t.ok) return { state: 'open', ms: t.ms };
    tries.push(t);
  }
  const blocked = tries.length && tries.every((t) => BLOCK_CODES.has(t.code) && t.ms < BLOCKED_WITHIN_MS);
  return { state: blocked ? 'blocked' : 'closed', code: tries.map((t) => t.code).join(','), ms: Math.max(0, ...tries.map((t) => t.ms)) };
}

/**
 * Returns { reachable: true } | { reachable: false, message, code } | { blocked: true, code }
 * | null (cannot tell: not a network printer, or the name does not resolve).
 */
function createReach({ timeoutMs = 1500, connect = connectState, log = () => {} } = {}) {
  const last = new Map(); // printer name -> last outcome, so the log says only what changed
  const note = (printer, outcome, detail) => {
    if (last.get(printer.name) === outcome) return;
    last.set(printer.name, outcome);
    log(`Printer check ${printer.name} (${printer.uri}): ${outcome}${detail ? ` ${detail}` : ''}`);
  };
  return async function reach(printer) {
    const t = targetsFor(printer);
    if (!t) return null;
    let unresolved = false;
    let blocked = false;
    const codes = [];
    for (const port of t.ports) {
      const r = await connect(t.host, port, timeoutMs);
      const state = typeof r === 'string' ? r : r.state; // tests may return a plain state
      if (state === 'open') {
        note(printer, 'answers');
        return { reachable: true };
      }
      if (state === 'unresolved') unresolved = true;
      if (state === 'blocked') blocked = true;
      if (r && r.code) codes.push(`${port}:${r.code}`);
    }
    if (blocked) {
      note(printer, 'blocked by the system', codes.join(' '));
      return { blocked: true, code: codes.join(' ') };
    }
    if (unresolved) {
      note(printer, 'cannot tell (name not found)', codes.join(' '));
      return null;
    }
    note(printer, 'no answer', codes.join(' '));
    return { reachable: false, code: codes.join(' '), message: 'The printer does not answer. Check it is on and on this Wi-Fi.' };
  };
}

module.exports = { createReach, targetsFor, connectState, BLOCK_CODES };
