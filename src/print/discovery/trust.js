'use strict';
const net = require('node:net');
const tls = require('node:tls');

/**
 * How the app trusts a printer's encrypted (IPPS) connection.
 *
 * Printers use self-signed certificates: no certificate authority vouches for them, so
 * normal checking always fails. Like CUPS ("trust on first use"), the app remembers the
 * SHA-256 fingerprint of the printer's certificate the first time and requires the same
 * one every time after. A different certificate means a reset printer, a new printer, or
 * a device pretending to be the printer: the connection stops (CERT_CHANGED) before any
 * document is sent, until the shop confirms it.
 *
 * - The certificate is only checked this way for local-network hosts (private addresses,
 *   .local names). Public hosts get normal certificate checking.
 * - TLS 1.2 or newer only.
 * - The check runs after the handshake and before the first byte of the request.
 */

const MIN_TLS = 'TLSv1.2';

/** Hosts on a local network, where printers' self-signed certificates are the norm. */
function isPrivateHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h.endsWith('.local') || (!h.includes('.') && !h.includes(':'))) return true;
  if (net.isIPv4(h)) return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (net.isIPv6(h)) return /^(fe80:|fc|fd|::1$)/.test(h);
  return false;
}

/** "AB:CD:..." from Node -> "abcd..." */
const normalise = (fp) => String(fp || '').replace(/:/g, '').toLowerCase();

class CertChangedError extends Error {
  constructor(expected, seen) {
    super("The printer's security certificate has changed. Confirm in Settings that this is your printer before printing to it again.");
    this.code = 'CERT_CHANGED';
    this.expected = expected;
    this.seen = seen;
  }
}

/**
 * Opens a TLS connection and checks the printer's certificate.
 * Resolves { socket, fingerprint } with the handshake done and nothing sent yet.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} [o.pin]   fingerprint saved for this printer (hex, any case or colons)
 * @param {number} [o.timeoutMs]
 */
function connectPinned({ host, port, pin, timeoutMs = 4000 }) {
  const bare = String(host).replace(/^\[|\]$/g, '');
  const local = isPrivateHost(bare);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: bare,
      port,
      minVersion: MIN_TLS,
      servername: net.isIP(bare) ? undefined : bare,
      // Local printers: the pinned fingerprint replaces the certificate authority check
      rejectUnauthorized: !local,
    });
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error('The printer did not answer in time'), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      const fingerprint = normalise(socket.getPeerCertificate()?.fingerprint256);
      if (!fingerprint) return fail(Object.assign(new Error('The printer sent no certificate'), { code: 'CERT_MISSING' }));
      if (pin && normalise(pin) !== fingerprint) return fail(new CertChangedError(normalise(pin), fingerprint));
      resolve({ socket, fingerprint });
    });
  });
}

/** Short form for the screen: first 8 bytes, "AB:CD:...". */
function shortFingerprint(fp) {
  return normalise(fp).slice(0, 16).toUpperCase().replace(/(..)(?!$)/g, '$1:');
}

module.exports = { connectPinned, isPrivateHost, normalise, shortFingerprint, CertChangedError, MIN_TLS };
