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

function tryOne(address, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host: address, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/**
 * 'open' | 'closed' | 'unresolved'. A name can resolve to several addresses (IPv4, IPv6,
 * link-local): every one is tried, IPv4 first, and one open port is enough.
 */
async function connectState(host, port, timeoutMs, lookup = dns.lookup) {
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      const all = await new Promise((resolve, reject) => lookup(host, { all: true }, (err, list) => (err ? reject(err) : resolve(list))));
      addresses = all.map((a) => a.address).sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
    } catch {
      return 'unresolved';
    }
  }
  for (const address of addresses.slice(0, 4)) if (await tryOne(address, port, timeoutMs)) return 'open';
  return 'closed';
}

function createReach({ timeoutMs = 1500, connect = connectState } = {}) {
  return async function reach(printer) {
    const t = targetsFor(printer);
    if (!t) return null;
    let unresolved = false;
    for (const port of t.ports) {
      const state = await connect(t.host, port, timeoutMs);
      if (state === 'open') return { reachable: true };
      if (state === 'unresolved') unresolved = true;
    }
    if (unresolved) return null;
    return { reachable: false, message: 'The printer does not answer. Check it is on and on this Wi-Fi.' };
  };
}

module.exports = { createReach, targetsFor, connectState };
