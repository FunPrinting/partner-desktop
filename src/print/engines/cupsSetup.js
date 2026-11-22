'use strict';
const { ippUrl } = require('../discovery/merge');

/**
 * Pure helpers for setting a found network printer up in CUPS (macOS and Linux).
 * The engine runs the commands these build.
 */

/** A CUPS queue name: letters, digits, "_" and "-" only. */
function queueName(device, existing = []) {
  const base =
    String(device.name || device.model || 'Printer')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'Printer';
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
  return name;
}

const hostForUri = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** Where to connect, best first. IPP uses the .local name so a new IP keeps working. */
function ippCandidates(device) {
  const out = [];
  const add = (u) => u && !out.includes(u) && out.push(u);
  add(ippUrl(device, { preferHostName: true }));
  add(ippUrl(device, { preferHostName: false }));
  // Some printers advertise IPPS but fail the TLS handshake: plain IPP on the same LAN
  const p = device.protocols.ipp;
  if (device.protocols.ipps && p) {
    for (const where of [device.host, device.addresses[0]]) if (where) add(`ipp://${hostForUri(where)}:${p.port}/${p.rp}`);
  }
  return out;
}

/** `lpinfo -m` lines -> [{ id, text }] */
function parseDrivers(text) {
  return String(text)
    .split('\n')
    .map((l) => /^(\S+)\s+(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ id: m[1], text: m[2] }));
}

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && t.length > 1);

/**
 * The driver for a printer that has no IPP: its manufacturer's own PPD when the system
 * has one. Every model word must appear in the driver's description, so "HL-2130" never
 * matches "HL-2140". Returns { id, text } or null.
 */
function pickDriver(drivers, { make, model }) {
  const modelTokens = tokens(model).filter((t) => t !== tokens(make)[0]);
  if (!modelTokens.length) return null;
  const makeTokens = tokens(make);
  let best = null;
  for (const d of drivers) {
    if (d.id === 'everywhere' || /^(lsb\/usr\/cupsfilters|drv:\/\/\/sample\.drv\/generic)/.test(d.id)) continue;
    const hay = new Set(tokens(d.text));
    if (!modelTokens.every((t) => hay.has(t))) continue;
    if (makeTokens.length && !makeTokens.some((t) => hay.has(t))) continue;
    // Fewer extra words = closer match; prefer a manufacturer PPD over a generic third-party one
    const extra = hay.size - modelTokens.length;
    const score = -extra + (/gutenprint|foomatic/i.test(d.id) ? 0 : 3);
    if (!best || score > best.score) best = { ...d, score };
  }
  return best && { id: best.id, text: best.text };
}

/** The device URI for a printer that is not IPP. */
function rawUri(device) {
  const where = device.addresses.find((a) => !a.includes(':')) || device.addresses[0] || device.host;
  if (!where) return null;
  if (device.protocols.socket) return `socket://${hostForUri(where)}:${device.protocols.socket.port}`;
  if (device.protocols.lpd) return `lpd://${hostForUri(where)}/${encodeURIComponent(device.protocols.lpd.queue || 'lp')}`;
  return null;
}

/** True when lpadmin refused because the user may not change printers. */
function isPermissionError(stderr) {
  return /forbidden|unauthori[sz]ed|not authori[sz]ed|permission denied|must be root|authentication/i.test(String(stderr));
}

module.exports = { queueName, ippCandidates, parseDrivers, pickDriver, rawUri, isPermissionError };
