'use strict';
const net = require('node:net');

/**
 * Turns raw mDNS service records into one entry per physical printer.
 *
 * A single Wi-Fi printer usually advertises several services at once (IPP, IPPS, raw
 * port 9100 and LPD). They share a UUID (when the printer sends one) or a host name,
 * so they are merged and the best protocol is chosen: IPPS, then IPP, then raw 9100,
 * then LPD. Pure functions; no network.
 */

const SERVICE_TYPES = {
  '_ipps._tcp': 'ipps',
  '_ipp._tcp': 'ipp',
  '_pdl-datastream._tcp': 'socket',
  '_printer._tcp': 'lpd',
};
const PREFERENCE = ['ipps', 'ipp', 'socket', 'lpd'];

function txtValue(v) {
  if (v === undefined || v === null) return '';
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

/** TXT record (object or array of "key=value") -> plain object with lower-case keys. */
function parseTxt(txt) {
  const out = {};
  if (Array.isArray(txt)) {
    for (const item of txt) {
      const s = txtValue(item);
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
    }
  } else if (txt && typeof txt === 'object') {
    for (const [k, v] of Object.entries(txt)) out[k.toLowerCase()] = txtValue(v);
  }
  return out;
}

const normHost = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '');
const tri = (v) => (/^t/i.test(v) ? true : /^f/i.test(v) ? false : undefined);

/** Link-local and loopback addresses are no use to a person or to another subnet. */
function usableAddress(a) {
  if (net.isIPv4(a)) return !/^(127\.|169\.254\.)/.test(a);
  if (net.isIPv6(a)) return !/^fe80:/i.test(a) && a !== '::1';
  return false;
}

function sortAddresses(addrs) {
  const v4 = addrs.filter(net.isIPv4);
  const v6 = addrs.filter(net.isIPv6);
  return [...v4, ...v6];
}

function deviceKey(rec, txt) {
  const uuid = (txt.uuid || '').toLowerCase().replace(/^urn:uuid:/, '');
  if (uuid) return `uuid:${uuid}`;
  const host = normHost(rec.host);
  if (host) return `host:${host}`;
  return `name:${String(rec.name || '').toLowerCase()}`;
}

/**
 * @param {Array<{type:string, name:string, host?:string, port:number, addresses?:string[], txt?:object}>} records
 *   type is the service type without the dot-suffix, e.g. "_ipp._tcp" (a leading/trailing dot is ignored)
 * @returns {Array<object>} devices
 */
function mergeServices(records) {
  const byKey = new Map();
  const hostToKey = new Map();
  const nameToKey = new Map();
  for (const rec of records) {
    const proto = SERVICE_TYPES[String(rec.type || '').replace(/^\.|\.$/g, '').replace(/\.local$/, '')];
    if (!proto) continue;
    const txt = parseTxt(rec.txt);
    let key = deviceKey(rec, txt);
    // Records of one device without a UUID in every service: join by host or by service name
    const host = normHost(rec.host);
    if (!key.startsWith('uuid:')) key = (host && hostToKey.get(host)) || nameToKey.get(String(rec.name).toLowerCase()) || key;
    else if (host && hostToKey.has(host) && hostToKey.get(host) !== key) {
      // Earlier records for this host had no UUID: fold them into this one
      const earlier = byKey.get(hostToKey.get(host));
      if (earlier) {
        byKey.delete(hostToKey.get(host));
        byKey.set(key, earlier);
        earlier.key = key;
      }
    }
    let dev = byKey.get(key);
    if (!dev) {
      dev = { key, name: rec.name, host: host || undefined, addresses: [], protocols: {}, txt: {} };
      byKey.set(key, dev);
    }
    if (host) {
      hostToKey.set(host, key);
      dev.host ||= host;
    }
    nameToKey.set(String(rec.name).toLowerCase(), key);
    for (const a of rec.addresses || []) if (usableAddress(a) && !dev.addresses.includes(a)) dev.addresses.push(a);
    dev.txt = { ...txt, ...dev.txt }; // first service wins; IPP records come first when sorted below
    dev.protocols[proto] = { port: Number(rec.port), rp: proto === 'ipp' || proto === 'ipps' ? txt.rp?.replace(/^\//, '') ?? 'ipp/print' : undefined, queue: proto === 'lpd' ? txt.rp : undefined };
  }
  return [...byKey.values()].map(finish).sort((a, b) => a.name.localeCompare(b.name));
}

function finish(dev) {
  const t = dev.txt;
  const protocols = dev.protocols;
  const preferred = PREFERENCE.find((p) => protocols[p]);
  const pdl = (t.pdl || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const make = t.usb_mfg || (t.ty || '').split(' ')[0] || undefined;
  const model = t.usb_mdl || t.ty || t.product?.replace(/^\(|\)$/g, '') || undefined;
  const uuid = (t.uuid || '').toLowerCase().replace(/^urn:uuid:/, '') || undefined;
  return {
    id: uuid ? `uuid:${uuid}` : dev.key,
    uuid,
    name: t.ty || dev.name,
    serviceName: dev.name,
    make,
    model,
    host: dev.host,
    addresses: sortAddresses(dev.addresses),
    location: t.note || undefined,
    protocols,
    preferred,
    // Only IPP printers can be asked for exact properties; the rest is what the printer announced
    announced: { color: tri(t.color), duplex: tri(t.duplex), pdl, acceptsPdf: pdl.includes('application/pdf') },
  };
}

/** The URL to talk to or set up the printer with its best IPP protocol, or null. */
function ippUrl(device, { preferHostName = true } = {}) {
  const p = device.protocols.ipps || device.protocols.ipp;
  if (!p) return null;
  const scheme = device.protocols.ipps ? 'ipps' : 'ipp';
  const where = (preferHostName && device.host) || device.addresses[0];
  if (!where) return null;
  const host = net.isIPv6(where) ? `[${where}]` : where;
  return `${scheme}://${host}:${p.port}/${p.rp}`;
}

module.exports = { mergeServices, parseTxt, ippUrl, usableAddress, SERVICE_TYPES, PREFERENCE };
