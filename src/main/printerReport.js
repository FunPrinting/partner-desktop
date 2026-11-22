'use strict';
/**
 * Tells the web app which printers this computer uses and what they can do (colour,
 * double-sided, A3), so the shop's dashboard and admin see it. Sent when the enabled
 * printers change and after sign-in; skipped when nothing changed.
 */
const session = require('./session');

function summarize(snapshot) {
  return (snapshot.printers || [])
    .filter((p) => p.enabled && p.caps)
    .map((p) => ({
      name: String(p.displayName || p.name).slice(0, 120),
      color: Boolean(p.caps.color),
      duplex: Boolean(p.caps.duplex),
      a3: (p.caps.media || []).includes('A3'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20);
}

function createPrinterReporter({ registry, apiFetch = (...a) => session.apiFetch(...a) }) {
  let lastSent = null;
  let timer = null;
  async function send() {
    const printers = summarize(registry.snapshot());
    const key = JSON.stringify(printers);
    if (key === lastSent) return;
    try {
      const res = await apiFetch('/api/partner/printers', { method: 'PATCH', body: { printers } });
      if (res.ok) lastSent = key;
    } catch {
      // Offline or signed out: the next change or sign-in sends it
    }
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(send, 3000);
  };
  registry.events.on('changed', schedule);
  return { send, reset: () => (lastSent = null), schedule };
}

module.exports = { createPrinterReporter, summarize };
