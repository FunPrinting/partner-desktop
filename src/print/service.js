'use strict';

const path = require('node:path');

/**
 * Builds the print system for this computer: the OS engine, the printer registry, the file
 * cache and the job runner. The only place that knows which engine a platform uses.
 *
 *   Windows       fp-print native add-on (PDFium -> GDI)
 *   macOS, Linux  CUPS
 */
function createEngine(platform = process.platform) {
  if (platform === 'win32') return require('./engines/windowsEngine').createWindowsEngine();
  return require('./engines/cupsEngine').createCupsEngine();
}

/** Plain-language progress for the Jobs page. */
function describeStatus(e) {
  const where = e.printer ? ` on ${e.printer}` : '';
  switch (e.state) {
    case 'preparing':
      return `Getting ${e.fileName || 'the file'} ready…`;
    case 'printing':
      return `Printing ${e.fileName || 'the file'}${where}…`;
    case 'retrying':
      return `Trying again: ${e.reason}`;
    case 'attention':
      return e.reason || 'Waiting for the printer…';
    case 'done':
      return `${e.fileName || 'File'} printed${where}`;
    case 'failed':
      return e.reason || 'Printing failed';
    default:
      return '';
  }
}

/**
 * @param {object} deps
 * @param {object} deps.prefs        { get(), set(patch) } (src/main/prefs.js)
 * @param {string} deps.dataDir      app data folder
 * @param {object} [deps.powerMonitor]
 * @param {(status: object) => void} [deps.onStatus]  runner progress
 * @param {object} [deps.engine]     override (tests)
 * @param {object} [deps.discovery]  { browse, probe } overrides (tests)
 */
function createPrintService({ prefs, dataDir, powerMonitor, onStatus = () => {}, engine = createEngine(), discovery = {} }) {
  const { createRegistry } = require('./registry');
  const { createCache } = require('./cache');
  const { createRunner } = require('./runner');
  const { renderSummary } = require('./summary');

  const { createFinder } = require('./discovery/finder');
  const { createReach } = require('./discovery/reach');
  const registry = createRegistry({
    engine,
    reach: createReach({ log: (m) => console.log(m) }),
    store: {
      get: () => prefs.get().printers || {},
      set: (value) => prefs.set({ printers: value }),
    },
  });
  const finder = createFinder({ registry, canMove: typeof engine.movePrinter === 'function', log: (m) => console.log(m), ...discovery });
  const cache = createCache({ dir: path.join(dataDir, 'print-cache') });
  const runner = createRunner({ engine, registry, cache, renderSummary, workDir: path.join(dataDir, 'print-work'), onStatus: (e) => onStatus({ ...e, status: describeStatus(e) }) });

  let scanTimer = null;

  /** Prints a test page on one printer; resolves with how long it took until the printer finished. */
  async function printTestPage(printerId) {
    const fs = require('node:fs/promises');
    const { buildRequest } = require('./request');
    const { sendRequest } = require('./sendRequest');
    const { trackRuns } = require('./tracker');
    const { renderTestPage } = require('./testPage');
    const printer = registry.get(printerId);
    if (!printer) throw new Error('Unknown printer');
    const colour = Boolean(printer.caps?.color);
    await fs.mkdir(path.join(dataDir, 'print-work'), { recursive: true });
    const file = path.join(dataDir, 'print-work', `test-${Date.now()}.pdf`);
    await fs.writeFile(file, await renderTestPage({ printerName: printer.displayName || printer.name, colour }));
    const started = Date.now();
    try {
      const request = buildRequest({ pageSize: 'A4', color: colour ? 'color' : 'bw', sided: 'single', copies: 1 }, { pageCount: 1 });
      const sent = await sendRequest(engine, { printer: printer.name, sourcePath: file, request, title: 'FunPrinting test page' });
      await trackRuns(engine, printer.name, sent, { onUpdate: (u) => onStatus({ state: u.state === 'ok' ? 'printing' : u.state, reason: u.reason, printer: printer.name, fileName: 'Test page', status: u.reason || 'Printing the test page…' }) });
      registry.notePrinted(printer.name);
      // A printer we could only estimate is switched on once it has printed a test page
      if (registry.snapshot().printers.find((p) => p.id === printerId)?.needsTest) {
        registry.setNeedsTest(printerId, false);
        registry.update(printerId, { enabled: true });
      }
      return { ms: Date.now() - started };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  /** Looks for printers on the network that are not set up here. */
  const scanNetwork = () => finder.scan({ thorough: true });

  /**
   * Sets a found network printer up in the OS. IPP printers (exact properties) are switched
   * on straight away; others wait for a test page. Resolves with { name, id, enabled }.
   */
  async function addNetworkPrinter(foundId) {
    const found = finder.device(foundId);
    if (!found) throw new Error('That printer was not found. Search again.');
    if (typeof engine.addPrinter !== 'function') throw new Error('Adding printers is not supported on this computer.');
    const { name, via } = await engine.addPrinter(found);
    await registry.refresh();
    const added = registry.snapshot().printers.find((p) => p.name === name);
    if (!added) return { name, id: null, enabled: false };
    registry.setSource(added.id, found.id, via);
    if (found.probe.estimated || !found.probe.reachable) registry.setNeedsTest(added.id, true);
    else registry.update(added.id, { enabled: true });
    finder.scan().catch(() => undefined); // the found list drops it
    return { name, id: added.id, enabled: !(found.probe.estimated || !found.probe.reachable) };
  }

  /** Points a set-up queue at the address its printer now has (macOS and Linux). */
  async function movePrinter(printerId) {
    const move = registry.snapshot().moves.find((m) => m.printerId === printerId);
    const printer = registry.get(printerId);
    const found = move && finder.device(move.toId);
    if (!move || !printer || !found) throw new Error('This printer cannot be moved right now. Search again.');
    await engine.movePrinter(printer.name, found);
    await registry.refresh();
    finder.scan().catch(() => undefined);
    return { name: printer.name };
  }

  return {
    movePrinter,
    scanNetwork,
    addNetworkPrinter,
    printTestPage,
    engine,
    registry,
    cache,
    runner,
    /** Starts watching printers; enables the printer chosen in the earlier app version. */
    async start() {
      cache.prune().catch(() => undefined);
      const first = registry.start({ powerMonitor, legacyPrinterName: prefs.get().printerName });
      // Look for network printers in the background: now, every 5 minutes and after sleep
      finder.scan().catch(() => undefined);
      scanTimer = setInterval(() => finder.scan().catch(() => undefined), 5 * 60_000);
      scanTimer.unref?.();
      powerMonitor?.on('resume', () => finder.scan().catch(() => undefined));
      return first;
    },
    stop: () => {
      registry.stop();
      clearInterval(scanTimer);
    },
  };
}

module.exports = { createPrintService, createEngine, describeStatus };
