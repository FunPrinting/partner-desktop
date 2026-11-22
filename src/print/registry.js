'use strict';

const { EventEmitter } = require('node:events');

/**
 * The shop's printers: what the OS has, what each can do, whether it is ready, and which
 * ones the shop lets the app use.
 *
 * - Printers are keyed by a stable id from the engine (printer UUID, or where it is
 *   connected), so renaming a printer in the OS keeps its settings.
 * - Refreshed every `intervalMs`, on wake from sleep, and on demand. Capabilities are read
 *   when a printer first appears or changes driver/connection, and every `capsTtlMs`.
 * - Settings per printer: { enabled, preferredBw, name } saved through `store`.
 * - First run: the system default printer is enabled. A printer chosen in the older app
 *   version (`legacyPrinterName`) is enabled instead.
 */
/** A job that finished on a printer proves it is on for this long. */
const PRINTED_PROVES_ON_MS = 15 * 60_000;

function createRegistry({ engine, store, intervalMs = 15_000, capsTtlMs = 10 * 60_000, now = () => Date.now(), reach = null }) {
  const events = new EventEmitter();
  let printers = new Map(); // id -> entry
  let timer = null;
  let refreshing = null;
  let lastError = null;
  let lastRefreshAt = null;
  const lastPrinted = new Map(); // printer name -> when a job last finished on it
  let networkBlocked = false; // printer checks were refused by the system
  let moves = []; // set-up printers that stopped answering, with where they now are
  let available = []; // found on the network, not set up here (set by discovery/finder.js)
  let scanState = { scanning: false, lastScanAt: 0, error: null };

  const settings = () => ({ ...(store.get() || {}) });

  function saveSettings(next) {
    store.set(next);
  }

  function snapshot() {
    const s = settings();
    return {
      printers: [...printers.values()].map((p) => ({
        ...p,
        enabled: Boolean(s[p.id]?.enabled),
        preferredBw: Boolean(s[p.id]?.preferredBw),
        needsTest: Boolean(s[p.id]?.needsTest),
        source: s[p.id]?.source,
        sourceUrl: s[p.id]?.sourceUrl,
      })),
      available,
      moves,
      networkBlocked,
      scan: scanState,
      lastRefreshAt,
      lastError,
    };
  }

  /** Enabled printers that can take a job now. */
  function usable() {
    return snapshot().printers.filter((p) => p.enabled && p.status?.online);
  }

  function applyFirstRun(list, legacyPrinterName) {
    const s = settings();
    if (Object.keys(s).length || !list.length) return false;
    const pick = (legacyPrinterName && list.find((p) => p.name === legacyPrinterName)) || list.find((p) => p.isDefault) || list[0];
    saveSettings({ [pick.id]: { enabled: true, name: pick.name } });
    return true;
  }

  async function readCaps(p, previous) {
    const sameDevice = previous && previous.uri === p.uri && previous.driver === p.driver;
    if (sameDevice && previous.caps && now() - previous.capsAt < capsTtlMs) return { caps: previous.caps, capsAt: previous.capsAt };
    try {
      return { caps: await engine.capabilities(p.name), capsAt: now() };
    } catch {
      // Keep what we knew; a printer that can't be read is still listed
      return { caps: previous?.caps || null, capsAt: previous?.capsAt || 0 };
    }
  }

  async function doRefresh({ legacyPrinterName } = {}) {
    let list;
    try {
      list = await engine.listPrinters();
      lastError = null;
    } catch (err) {
      lastError = err.message;
      console.error(`Printer list failed: ${err.code || ''} ${err.message}`);
      events.emit('changed', snapshot());
      return snapshot();
    }
    // A network printer that is switched off, or has a new IP address, does not answer
    // ...but a printer that has just printed is on, whatever a check says, and a check the
    // system blocked (macOS Local Network permission, a firewall) proves nothing.
    if (reach) {
      let blocked = false;
      await Promise.all(
        list.map(async (p) => {
          const answer = await reach(p).catch(() => null);
          if (answer && answer.blocked) blocked = true;
          const printedRecently = now() - (lastPrinted.get(p.name) || 0) < PRINTED_PROVES_ON_MS;
          if (answer && answer.reachable === false && !printedRecently) p.status = { ...(p.status || {}), online: false, state: 'unreachable', message: answer.message };
        })
      );
      networkBlocked = blocked;
    }
    const next = new Map();
    for (const p of list) {
      const previous = printers.get(p.id);
      const { caps, capsAt } = await readCaps(p, previous);
      next.set(p.id, { id: p.id, name: p.name, displayName: p.displayName || p.name, isDefault: Boolean(p.isDefault), uri: p.uri, driver: p.driver, location: p.location, status: p.status || { online: true }, caps, capsAt });
    }

    // Renamed printers keep their settings; remember the current name
    const s = settings();
    let changedSettings = false;
    for (const p of next.values()) {
      if (s[p.id] && s[p.id].name !== p.name) {
        s[p.id] = { ...s[p.id], name: p.name };
        changedSettings = true;
      }
    }
    if (changedSettings) saveSettings(s);
    const firstRun = applyFirstRun([...next.values()], legacyPrinterName);

    const before = JSON.stringify(snapshot().printers.map(({ capsAt, ...p }) => p));
    printers = next;
    lastRefreshAt = now();
    const after = JSON.stringify(snapshot().printers.map(({ capsAt, ...p }) => p));
    if (before !== after || firstRun || changedSettings) events.emit('changed', snapshot());
    return snapshot();
  }

  /** Re-reads the OS printers. Concurrent calls share one refresh. */
  function refresh(opts) {
    if (!refreshing) refreshing = doRefresh(opts).finally(() => (refreshing = null));
    return refreshing;
  }

  /** { enabled?, preferredBw? } for one printer. Only one printer is preferred for B&W. */
  function update(id, patch = {}) {
    const p = printers.get(id);
    if (!p) throw new Error('Unknown printer');
    const s = settings();
    const cur = { ...(s[id] || {}), name: p.name };
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled;
    if (typeof patch.preferredBw === 'boolean') {
      if (patch.preferredBw) for (const k of Object.keys(s)) if (s[k]?.preferredBw) s[k] = { ...s[k], preferredBw: false };
      cur.preferredBw = patch.preferredBw;
    }
    if (!cur.enabled) cur.preferredBw = false;
    s[id] = cur;
    saveSettings(s);
    events.emit('changed', snapshot());
    return snapshot();
  }

  function start({ powerMonitor, legacyPrinterName } = {}) {
    stop();
    timer = setInterval(() => refresh().catch(() => undefined), intervalMs);
    timer.unref?.();
    if (powerMonitor) powerMonitor.on('resume', () => refresh().catch(() => undefined));
    return refresh({ legacyPrinterName });
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  /** A job finished on this printer: it is on. Clears an "unreachable" shown by a check. */
  function notePrinted(name) {
    lastPrinted.set(name, now());
    for (const p of printers.values()) {
      if (p.name === name && p.status && p.status.state === 'unreachable') {
        p.status = { online: true, state: 'idle', reasons: [] };
        events.emit('changed', snapshot());
      }
    }
  }
  /** Remember which found network device (and URL) a queue was set up from. */
  function setSource(id, source, sourceUrl) {
    const p = printers.get(id);
    if (!p) return;
    const s = settings();
    s[id] = { ...(s[id] || {}), name: p.name, source, sourceUrl };
    saveSettings(s);
    events.emit('changed', snapshot());
  }
  /** A printer whose properties are only estimated stays off until a test page has printed. */
  function setNeedsTest(id, value) {
    const p = printers.get(id);
    if (!p) return;
    const s = settings();
    s[id] = { ...(s[id] || {}), name: p.name, needsTest: Boolean(value), ...(value ? { enabled: false } : {}) };
    saveSettings(s);
    events.emit('changed', snapshot());
  }
  /** Set-up printers that can be pointed at a found printer's new address. */
  function setMoves(list) {
    if (JSON.stringify(list) === JSON.stringify(moves)) return;
    moves = list;
    events.emit('available', snapshot());
  }
  /** Network printers that are not set up on this computer. */
  function setAvailable(list, { scanning = false, lastScanAt = scanState.lastScanAt, stats = scanState.stats } = {}) {
    const before = JSON.stringify([available, scanState.scanning, scanState.stats]);
    available = list;
    scanState = { ...scanState, scanning, lastScanAt, stats };
    if (before !== JSON.stringify([available, scanState.scanning, scanState.stats])) events.emit('available', snapshot());
  }
  function setScanError(error) {
    scanState = { ...scanState, error };
  }
  return { notePrinted, setMoves, setSource, setNeedsTest, setAvailable, setScanError, refresh, update, snapshot, usable, start, stop, events, get: (id) => printers.get(id) };
}

module.exports = { createRegistry, PRINTED_PROVES_ON_MS };
