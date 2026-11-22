'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const ipp = require('../ipp');
const { capabilitiesFrom, printerFrom } = require('../engines/cupsEngine');
const { ippUrl } = require('./merge');

/**
 * Asks a printer on the network about itself, the same way CUPS does for a set-up queue:
 *   IPP printers   Get-Printer-Attributes straight to the printer: colour, double-sided,
 *                  paper sizes, formats, state and alerts. Exact.
 *   9100 / LPD     No protocol to ask. We test that the port answers and use what the
 *                  printer announced (colour, duplex); paper is assumed A4. Marked `estimated`.
 */

const REQUESTED = [
  'printer-name',
  'printer-info',
  'printer-make-and-model',
  'printer-location',
  'printer-uuid',
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-is-accepting-jobs',
  'color-supported',
  'sides-supported',
  'print-color-mode-supported',
  'media-supported',
  'document-format-supported',
  'ipp-versions-supported',
];

/** Hosts on a local network, where printers' self-signed certificates are the norm. */
function isPrivateHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return true;
  if (net.isIPv4(h)) return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (net.isIPv6(h)) return /^(fe80:|fc|fd|::1$)/.test(h);
  return false;
}

/** One Get-Printer-Attributes request to an ipp:// or ipps:// URL. Returns the attribute map. */
function getAttributes(url, { timeoutMs = 4000, request } = {}) {
  const u = new URL(url.replace(/^ipp/, 'http'));
  const secure = url.startsWith('ipps:');
  const port = Number(u.port) || 631;
  const body = ipp.encode(ipp.Op.GetPrinterAttributes, 1, [
    ipp.attr(ipp.Tag.uri, 'printer-uri', url.replace(/^ipps:/, 'ipp:')),
    ipp.attr(ipp.Tag.name, 'requesting-user-name', 'FunPrinting'),
    ipp.attr(ipp.Tag.keyword, 'requested-attributes', REQUESTED),
  ]);
  const send = request || ((opts, cb) => (secure ? https : http).request(opts, cb));
  return new Promise((resolve, reject) => {
    const req = send(
      {
        method: 'POST',
        host: u.hostname.replace(/^\[|\]$/g, ''),
        port,
        path: u.pathname || '/',
        headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length },
        timeout: timeoutMs,
        // A printer's own certificate is self-signed. Only trust that on a local network.
        ...(secure ? { rejectUnauthorized: !isPrivateHost(u.hostname) } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(Object.assign(new Error(`The printer answered HTTP ${res.statusCode}`), { http: res.statusCode }));
          try {
            const out = ipp.decode(Buffer.concat(chunks));
            if (out.statusCode > 0xff) return reject(Object.assign(new Error(`The printer refused (0x${out.statusCode.toString(16)})`), { ipp: out.statusCode }));
            resolve(out.groups.find((g) => g.name === 'printer')?.attrs || {});
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('The printer did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

function tcpOpen(host, port, timeoutMs = 2000) {
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

const OFFLINE = { online: false, state: 'unknown', reasons: [], message: 'The printer does not answer. Check it is on and on this Wi-Fi.' };

/**
 * @param {object} device  from merge.js
 * @returns {Promise<{ reachable: boolean, estimated: boolean, caps: object|null, status: object, makeAndModel?: string, uuid?: string, url?: string, error?: string }>}
 */
async function probeDevice(device, { timeoutMs = 4000, get = getAttributes, tcp = tcpOpen } = {}) {
  // Try the host name first (survives IP changes), then each address
  const targets = [];
  for (const preferHostName of [true, false]) {
    const url = ippUrl(device, { preferHostName });
    if (url && !targets.includes(url)) targets.push(url);
  }
  if (device.protocols.ipps && device.protocols.ipp) {
    // IPPS first; if the TLS handshake fails (old firmware), plain IPP on the same LAN
    const p = device.protocols.ipp;
    const where = device.host || device.addresses[0];
    if (where) targets.push(`ipp://${net.isIPv6(where) ? `[${where}]` : where}:${p.port}/${p.rp}`);
  }
  let lastError;
  for (const url of targets) {
    try {
      const attrs = await get(url, { timeoutMs });
      const reasonsAndState = printerFrom({ 'printer-name': [device.name], ...attrs }, null).status;
      return {
        reachable: true,
        estimated: false,
        url,
        caps: capabilitiesFrom(attrs),
        status: reasonsAndState,
        makeAndModel: attrs['printer-make-and-model']?.[0],
        uuid: attrs['printer-uuid']?.[0]?.replace(/^urn:uuid:/, ''),
        formats: attrs['document-format-supported'] || [],
      };
    } catch (err) {
      lastError = err.message;
    }
  }
  // Not an IPP printer (or not answering): is the raw port or LPD port open?
  const raw = device.protocols.socket || device.protocols.lpd;
  const host = device.addresses.find(net.isIPv4) || device.addresses[0] || device.host;
  if (raw && host && (await tcp(host, raw.port, 2000))) {
    const a = device.announced;
    return {
      reachable: true,
      estimated: true,
      caps: { color: Boolean(a.color), duplex: Boolean(a.duplex), media: ['A4'], sides: [], colourModes: [], mediaKeywords: [] },
      status: { online: true, state: 'unknown', reasons: [], message: undefined },
    };
  }
  return { reachable: false, estimated: !targets.length, caps: null, status: OFFLINE, error: lastError };
}

module.exports = { probeDevice, getAttributes, isPrivateHost, tcpOpen };
