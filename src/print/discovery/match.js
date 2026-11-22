'use strict';
const net = require('node:net');

/**
 * Which set-up OS printers are the same machine as a found network device.
 *
 * An OS printer says where it is connected in different ways:
 *   CUPS     device-uri: ipp://host:631/..  ipps://..  socket://ip:9100  lpd://ip/queue
 *            dnssd://Name._ipp._tcp.local/?uuid=...  usb://...  (printer-uuid also known)
 *   Windows  port name: "IP_192.168.1.9", "192.168.1.9", "http://host:631/ipp/print",
 *            "WSD-<guid>", "USB001", "FILE:"
 * We pull out a host (or a uuid) and compare with the device's host name, addresses, uuid.
 */

const stripUuid = (s) => String(s || '').toLowerCase().replace(/^urn:uuid:/, '');

/** { host?, uuid?, service? } found in a device URI or port name. */
function whereIs(uriOrPort) {
  const s = String(uriOrPort || '').trim();
  if (!s) return {};
  const out = {};
  const uuid = /[?&]uuid=([0-9a-f-]{36})/i.exec(s) || /^urn:uuid:([0-9a-f-]{36})$/i.exec(s);
  if (uuid) out.uuid = stripUuid(uuid[1]);
  if (/^(usb|file|nul|lpt\d|com\d|portprompt|usb\d+)/i.test(s) || /^FILE:/i.test(s)) return out;
  if (/^dnssd:/i.test(s)) {
    const m = /^dnssd:\/\/([^/?]+)/i.exec(s);
    if (m) {
      let name = m[1];
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep the raw text
      }
      out.service = name.replace(/\._(ipps?|pdl-datastream|printer)\._tcp.*$/i, '').toLowerCase();
    }
    return out;
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : null;
  if (url) {
    try {
      out.host = new URL(url.replace(/^(ipps?|socket|lpd|http|https)/i, 'http')).hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    } catch {
      // ignore
    }
    return out;
  }
  const ip = /^(?:IP_)?((?:\d{1,3}\.){3}\d{1,3})(?:_\d+)?$/i.exec(s);
  if (ip) {
    out.host = ip[1];
    return out;
  }
  const v6 = /^(?:IP_)?([0-9a-f:]+:[0-9a-f:]+)$/i.exec(s);
  if (v6 && net.isIPv6(v6[1])) out.host = v6[1].toLowerCase();
  else if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/i.test(s)) out.host = s.toLowerCase();
  return out;
}

function sameHost(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  // "printer" and "printer.local" are the same machine
  return x.replace(/\.local$/, '') === y.replace(/\.local$/, '') && !net.isIP(x);
}

const DEFAULT_PORT = { ipp: 631, ipps: 631, http: 631, https: 631, socket: 9100, lpd: 515 };

/** { scheme, host, port } of a network device URI or URL port name, or null (USB, WSD, "IP_x"...). */
function endpointOf(uriOrPort) {
  const s = String(uriOrPort || '').trim();
  const m = /^(ipps?|socket|lpd|https?):\/\//i.exec(s);
  if (!m) return null;
  try {
    const scheme = m[1].toLowerCase();
    const u = new URL(s.replace(/^(ipps?|socket|lpd)/i, 'http'));
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!host) return null;
    return { scheme, host, port: Number(u.port) || DEFAULT_PORT[scheme] };
  } catch {
    return null;
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** True if this OS printer is the found device. */
function isSame(printer, device) {
  // We set this queue up from this device ourselves
  if (printer.source && (printer.source === device.id || printer.source === device.uuid)) return true;
  const w = whereIs(printer.uri);
  const printerUuid = stripUuid(printer.uuid) || (/^urn:uuid:/i.test(printer.id) ? stripUuid(printer.id) : '');
  if (device.uuid && (device.uuid === printerUuid || device.uuid === w.uuid)) return true;
  if (w.service && w.service === String(device.serviceName || '').toLowerCase()) return true;
  if (w.host) {
    if (sameHost(w.host, device.host)) return true;
    if (device.addresses.some((a) => a.toLowerCase() === w.host)) return true;
  }
  // Windows connects many network printers on a WSD port, which names no address.
  // For those, the same name (or model) is the best evidence there is.
  if (/^WSD-/i.test(String(printer.uri || ''))) {
    const names = [printer.name, printer.displayName].map(norm).filter(Boolean);
    const theirs = [device.name, device.model, device.serviceName].map(norm).filter(Boolean);
    if (names.some((n) => theirs.includes(n))) return true;
  }
  return false;
}

/** The set-up printer for a device, or undefined. */
function findSetUp(device, printers) {
  return printers.find((p) => isSame(p, device));
}

module.exports = { whereIs, endpointOf, isSame, findSetUp };

const modelKey = (s) => norm(String(s || '').replace(/\bseries\b/gi, ''));

/**
 * Set-up network printers that stopped answering while a printer of the same model shows
 * up on the network at another address. Only offered when it is unambiguous: one such
 * queue, one such device.
 */
function computeMoves(printers, devices) {
  const unmatched = devices.filter((d) => !findSetUp(d, printers));
  const gone = printers.filter((p) => p.status && p.status.state === 'unreachable' && endpointOf(p.uri));
  const moves = [];
  for (const p of gone) {
    const key = modelKey(p.driver) || modelKey(p.displayName) || modelKey(p.name);
    const sameModel = (d) => (p.source && (p.source === d.id || p.source === d.uuid)) || (key && [d.model, d.name, d.serviceName].some((x) => modelKey(x) === key));
    const candidates = unmatched.filter(sameModel);
    const rivals = gone.filter((q) => q !== p && (modelKey(q.driver) || modelKey(q.displayName) || modelKey(q.name)) === key);
    if (candidates.length === 1 && !rivals.length) {
      const d = candidates[0];
      moves.push({ printerId: p.id, printerName: p.displayName || p.name, toId: d.id, toName: d.name, address: d.addresses[0] || d.host });
    }
  }
  return moves;
}

module.exports.computeMoves = computeMoves;
