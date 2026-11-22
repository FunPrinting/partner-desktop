'use strict';
const net = require('node:net');
const { adapters } = require('./browse');
const { getAttributes } = require('./probe');

/**
 * Fallback search for networks where printers' mDNS announcements never arrive (multicast
 * blocked by the router, "AP isolation" for multicast, a strict firewall): tries the IPP
 * port (631) on every address of each local /24 network, and asks each machine that
 * answers whether it is a printer (Get-Printer-Attributes).
 *
 * Only private networks are swept (10.x, 172.16-31.x, 192.168.x), at most 3 of them,
 * 64 connections at a time with a short time limit: about 2-3 seconds per network.
 * Returns records in the same shape as mDNS services, so merge.js treats both alike.
 */

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function subnetsOf(interfaces) {
  const seen = new Set();
  const out = [];
  for (const a of adapters(interfaces)) {
    if (!PRIVATE.test(a.address)) continue;
    const prefix = a.address.split('.').slice(0, 3).join('.');
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    out.push({ prefix, self: a.address });
  }
  return out.slice(0, 3);
}

function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

async function pool(items, size, fn) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

const IPP_PATHS = ['ipp/print', 'ipp/printer', 'printers/ipp', ''];

/**
 * @returns {Promise<{ records: object[], stats: { subnets: string[], open: string[], printers: number } }>}
 */
async function sweep({ interfaces, connectMs = 350, concurrency = 64, open = portOpen, attributes = getAttributes } = {}) {
  const subnets = subnetsOf(interfaces);
  const hosts = [];
  for (const { prefix, self } of subnets) for (let i = 1; i < 255; i++) if (`${prefix}.${i}` !== self) hosts.push(`${prefix}.${i}`);
  const answered = (await pool(hosts, concurrency, async (h) => ((await open(h, 631, connectMs)) ? h : null))).filter(Boolean);
  const records = [];
  for (const host of answered) {
    // Many printers only talk encrypted IPP on port 631 (plain requests get HTTP 426 Upgrade
    // Required), others only plain: try the encrypted form first, then plain.
    let secure = true;
    let fingerprint;
    for (const rp of IPP_PATHS) {
      let attrs;
      for (const scheme of secure ? ['ipps', 'ipp'] : ['ipp']) {
        try {
          attrs = await attributes(`${scheme}://${host}:631/${rp}`, {
            timeoutMs: 3000,
            // No pin: this is a fresh search. The fingerprint is recorded for when the device is added.
            onFingerprint: (fp) => (fingerprint = fp),
          });
          secure = scheme === 'ipps';
          break;
        } catch (err) {
          if (scheme === 'ipps' && err.code && /EPROTO|ECONNRESET|ERR_SSL|WRONG_VERSION|CERT_CHANGED/i.test(err.code)) secure = false; // no TLS on this host
        }
      }
      if (!attrs) continue;
      // A computer sharing printers (CUPS) also answers on 631: only real printers have these
      if (!attrs['printer-make-and-model'] && !attrs['printer-name']) continue;
      const uuid = String(attrs['printer-uuid']?.[0] || '').replace(/^urn:uuid:/i, '');
      const colour = attrs['color-supported']?.[0];
      const sides = attrs['sides-supported'] || [];
      records.push({
        type: secure ? '_ipps._tcp' : '_ipp._tcp',
        fingerprint,
        name: String(attrs['printer-info']?.[0] || attrs['printer-make-and-model']?.[0] || attrs['printer-name']?.[0] || host),
        host: undefined,
        port: 631,
        addresses: [host],
        txt: {
          ty: String(attrs['printer-make-and-model']?.[0] || attrs['printer-name']?.[0] || host),
          rp,
          ...(uuid ? { UUID: uuid } : {}),
          ...(colour === undefined ? {} : { Color: colour ? 'T' : 'F' }),
          ...(sides.length ? { Duplex: sides.some((s) => String(s).startsWith('two-sided')) ? 'T' : 'F' } : {}),
          pdl: (attrs['document-format-supported'] || []).join(','),
        },
        foundBy: 'sweep',
      });
      break;
    }
  }
  return { records, stats: { subnets: subnets.map((s) => `${s.prefix}.0/24`), open: answered, printers: records.length } };
}

module.exports = { sweep, subnetsOf };
