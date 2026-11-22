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
 */
function createPrintService({ prefs, dataDir, powerMonitor, onStatus = () => {}, engine = createEngine() }) {
  const { createRegistry } = require('./registry');
  const { createCache } = require('./cache');
  const { createRunner } = require('./runner');
  const { renderSummary } = require('./summary');

  const registry = createRegistry({
    engine,
    store: {
      get: () => prefs.get().printers || {},
      set: (value) => prefs.set({ printers: value }),
    },
  });
  const cache = createCache({ dir: path.join(dataDir, 'print-cache') });
  const runner = createRunner({ engine, registry, cache, renderSummary, workDir: path.join(dataDir, 'print-work'), onStatus: (e) => onStatus({ ...e, status: describeStatus(e) }) });

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
      return { ms: Date.now() - started };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  return {
    printTestPage,
    engine,
    registry,
    cache,
    runner,
    /** Starts watching printers; enables the printer chosen in the earlier app version. */
    async start() {
      cache.prune().catch(() => undefined);
      return registry.start({ powerMonitor, legacyPrinterName: prefs.get().printerName });
    },
    stop: () => registry.stop(),
  };
}

module.exports = { createPrintService, createEngine, describeStatus };
