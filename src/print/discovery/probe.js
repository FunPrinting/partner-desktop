'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const ipp = require('../ipp');
const { capabilitiesFrom, printerFrom } = require('../engines/cupsEngine');
const { ippUrl } = require('./merge');
const { isPrivateHost, connectPinned, CertChangedError } = require('./trust');

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

/**
 * One Get-Printer-Attributes request to an ipp:// or ipps:// URL. Returns the attribute map.
 *
 * ipps:// goes over TLS 1.2+ with the printer's certificate pinned (see trust.js):
 * `pin` is the saved fingerprint, and `onFingerprint(fp)` receives the one seen, so the
 * caller can save it. A changed certificate rejects with code CERT_CHANGED.
 */
async function getAttributes(url, { timeoutMs = 4000, request, pin, onFingerprint } = {}) {
  const u = new URL(url.replace(/^ipp/, 'http'));
  const secure = url.startsWith('ipps:');
  const port = Number(u.port) || 631;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const body = ipp.encode(ipp.Op.GetPrinterAttributes, 1, [
    ipp.attr(ipp.Tag.uri, 'printer-uri', url.replace(/^ipps:/, 'ipp:')),
    ipp.attr(ipp.Tag.name, 'requesting-user-name', 'FunPrinting'),
    ipp.attr(ipp.Tag.keyword, 'requested-attributes', REQUESTED),
  ]);
  const options = {
    method: 'POST',
    host,
    port,
    path: u.pathname || '/',
    headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length },
    timeout: timeoutMs,
  };
  if (secure) {
    // Connect first and check the certificate; the request then reuses that connection
    const { socket, fingerprint } = await connectPinned({ host, port, pin, timeoutMs });
    if (onFingerprint) onFingerprint(fingerprint);
    // Build the request manually over the TLS socket
    return new Promise((resolve, reject) => {
      const chunks = [];
      let headerParsed = false;
      let contentLength = 0;
      let bodyStart = 0;
      const fail = (err) => {
        socket.destroy();
        reject(err);
      };
      const tryParse = () => {
        const raw = Buffer.concat(chunks);
        if (!headerParsed) {
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const headers = raw.subarray(0, headerEnd).toString('utf8');
          const statusMatch = headers.match(/^HTTP\/\d\.\d (\d+)/);
          if (!statusMatch) return fail(new Error('No HTTP status line'));
          const statusCode = Number(statusMatch[1]);
          if (statusCode !== 200) return fail(Object.assign(new Error(`The printer answered HTTP ${statusCode}`), { http: statusCode }));
          const lengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
          contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
          bodyStart = headerEnd + 4;
          headerParsed = true;
        }
        if (headerParsed && raw.length >= bodyStart + contentLength) {
          socket.destroy();
          try {
            const out = ipp.decode(raw.subarray(bodyStart));
            if (out.statusCode > 0xff) return fail(Object.assign(new Error(`The printer refused (0x${out.statusCode.toString(16)})`), { ipp: out.statusCode }));
            resolve(out.groups.find((g) => g.name === 'printer')?.attrs || {});
          } catch (err) {
            fail(err);
          }
        }
      };
      socket.setTimeout(timeoutMs, () => fail(new Error('The printer did not answer in time')));
      socket.on('error', fail);
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        tryParse();
      });
      const req = `POST ${u.pathname || '/'} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/ipp\r\nContent-Length: ${body.length}\r\n\r\n`;
      socket.write(req);
      socket.write(body);
    });
  }
  const send = request || ((opts, cb) => http.request(opts, cb));
  return new Promise((resolve, reject) => {
    const req = send(options, (res) => {
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
    });
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
 * @param {object} [opts]
 * @param {string} [opts.pin]  saved fingerprint for this device (hex, any case or colons)
 * @param {function} [opts.onPin]  callback(fingerprint) when IPPS succeeds
 * @param {boolean} [opts.secureOnly]  true after a successful IPPS connection: never downgrade to plain IPP
 * @returns {Promise<{ reachable: boolean, estimated: boolean, caps: object|null, status: object, security: string, fingerprint?: string, certChanged?: boolean, expectedFingerprint?: string, seenFingerprint?: string, makeAndModel?: string, uuid?: string, url?: string, error?: string }>}
 */
async function probeDevice(device, { timeoutMs = 4000, get = getAttributes, tcp = tcpOpen, pin, onPin, secureOnly } = {}) {
  // Try the host name first (survives IP changes), then each address. IPPS before plain IPP.
  const targets = [];
  for (const preferHostName of [true, false]) {
    const url = ippUrl(device, { preferHostName });
    if (url && !targets.includes(url)) targets.push(url);
  }
  // If both IPPS and plain IPP are offered and we haven't locked to IPPS-only yet, add the plain fallback
  if (device.protocols.ipps && device.protocols.ipp && !secureOnly) {
    const p = device.protocols.ipp;
    const where = device.host || device.addresses[0];
    if (where) targets.push(`ipp://${net.isIPv6(where) ? `[${where}]` : where}:${p.port}/${p.rp}`);
  }
  let lastError;
  let fingerprint;
  for (const url of targets) {
    try {
      const attrs = await get(url, {
        timeoutMs,
        pin: url.startsWith('ipps:') ? pin : undefined,
        onFingerprint: (fp) => {
          fingerprint = fp;
          if (onPin) onPin(fp);
        },
      });
      const reasonsAndState = printerFrom({ 'printer-name': [device.name], ...attrs }, null).status;
      return {
        reachable: true,
        estimated: false,
        url,
        security: url.startsWith('ipps:') ? 'encrypted' : 'not-encrypted',
        fingerprint,
        caps: capabilitiesFrom(attrs),
        status: reasonsAndState,
        makeAndModel: attrs['printer-make-and-model']?.[0],
        uuid: attrs['printer-uuid']?.[0]?.replace(/^urn:uuid:/, ''),
        formats: attrs['document-format-supported'] || [],
      };
    } catch (err) {
      if (err.code === 'CERT_CHANGED') {
        return {
          reachable: false,
          estimated: false,
          certChanged: true,
          expectedFingerprint: err.expected,
          seenFingerprint: err.seen,
          security: 'encrypted',
          caps: null,
          status: { online: false, state: 'unknown', reasons: [], message: "The printer's security certificate has changed." },
          error: err.message,
        };
      }
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
      security: 'not-encrypted',
      caps: { color: Boolean(a.color), duplex: Boolean(a.duplex), media: ['A4'], sides: [], colourModes: [], mediaKeywords: [] },
      status: { online: true, state: 'unknown', reasons: [], message: undefined },
    };
  }
  return { reachable: false, estimated: !targets.length, security: secureOnly ? 'encrypted' : 'error', caps: null, status: OFFLINE, error: lastError };
}

module.exports = { probeDevice, getAttributes, isPrivateHost, tcpOpen };
