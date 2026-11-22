'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { run: defaultRun } = require('../exec');
const { CODES, PrintError } = require('../engine');
const setup = require('./windowsSetup');
const { worstReason } = require('../reasons');

/**
 * Windows engine: the fp-print native add-on (native/fp-print), which draws PDFs onto the
 * printer through GDI like Chrome does. This file maps its data to the engine interface.
 *
 * The add-on is loaded lazily and injected in tests, so the mapping is tested on any OS.
 */

// PRINTER_STATUS_* (winspool.h)
const PS = {
  PAUSED: 0x1,
  ERROR: 0x2,
  PENDING_DELETION: 0x4,
  PAPER_JAM: 0x8,
  PAPER_OUT: 0x10,
  PAPER_PROBLEM: 0x40,
  OFFLINE: 0x80,
  OUTPUT_BIN_FULL: 0x800,
  NOT_AVAILABLE: 0x1000,
  NO_TONER: 0x40000,
  USER_INTERVENTION: 0x100000,
  DOOR_OPEN: 0x400000,
  TONER_LOW: 0x20000,
};
const PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x400;

// JOB_STATUS_* (winspool.h)
const JS = { PAUSED: 0x1, ERROR: 0x2, DELETING: 0x4, SPOOLING: 0x8, PRINTING: 0x10, OFFLINE: 0x20, PAPEROUT: 0x40, PRINTED: 0x80, DELETED: 0x100, USER_INTERVENTION: 0x400, COMPLETE: 0x1000 };

const DMPAPER = { 8: 'A3', 9: 'A4' };

/** Printer status flags -> the same keywords the CUPS engine reports, so one list of messages serves both. */
function reasonsFromStatus(status, attributes = 0) {
  const r = [];
  if (status & PS.PAPER_OUT) r.push('media-empty-error');
  if (status & PS.PAPER_JAM) r.push('media-jam-error');
  if (status & PS.PAPER_PROBLEM) r.push('media-needed-error');
  if (status & PS.NO_TONER) r.push('toner-empty-error');
  if (status & PS.DOOR_OPEN) r.push('door-open-error');
  if (status & PS.OUTPUT_BIN_FULL) r.push('output-area-full-error');
  if (status & (PS.OFFLINE | PS.NOT_AVAILABLE) || attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) r.push('offline-error');
  if (status & PS.PAUSED) r.push('paused');
  if (status & PS.ERROR || status & PS.USER_INTERVENTION) r.push('other-error');
  if (status & PS.TONER_LOW) r.push('toner-low-warning');
  return r;
}

function printerFrom(p) {
  const reasons = reasonsFromStatus(p.status, p.attributes);
  const problem = worstReason(reasons);
  const stopped = Boolean(p.status & PS.PAUSED);
  return {
    name: p.name,
    displayName: p.name,
    isDefault: p.isDefault,
    // Where it is connected plus the driver: survives a rename in Windows
    id: `${p.port}|${p.driver}`,
    uri: p.port,
    driver: p.driver,
    location: p.location || undefined,
    status: {
      state: stopped ? 'stopped' : p.jobs > 0 ? 'processing' : 'idle',
      online: !stopped && problem?.severity !== 'offline',
      reasons,
      message: problem?.message || (p.status & PS.ERROR ? 'The printer reports an error. Check it.' : undefined),
    },
  };
}

/** "CODE: message" from the add-on -> PrintError. */
function toPrintError(err) {
  const m = /^([A-Z_]+): ([\s\S]*)$/.exec(String(err?.message || ''));
  if (m && CODES[m[1]]) return new PrintError(m[2], CODES[m[1]]);
  return new PrintError(`The Windows print system failed: ${err?.message || err}`, CODES.DRIVER_FAILED);
}

function createWindowsEngine({ native, pdfiumPath, run = defaultRun, tmpDir = os.tmpdir() } = {}) {
  let mod = native;
  let ready = false;
  const lastSeen = new Map(); // `${printer}:${job}` -> last job status flags

  function load() {
    if (!mod) {
      try {
        mod = require(path.join(__dirname, '..', '..', '..', 'native', 'fp-print', 'fp-print.node'));
      } catch (err) {
        throw new PrintError(`The print engine could not be loaded: ${err.message}`, CODES.DRIVER_FAILED);
      }
    }
    if (!ready) {
      try {
        mod.init(pdfiumPath || path.join(__dirname, '..', '..', '..', 'native', 'fp-print', 'pdfium.dll'));
      } catch (err) {
        throw toPrintError(err);
      }
      ready = true;
    }
    return mod;
  }

  const guard = (fn) => {
    try {
      return fn(load());
    } catch (err) {
      throw err instanceof PrintError ? err : toPrintError(err);
    }
  };

  return {
    name: 'windows',

    async listPrinters() {
      return guard((m) => m.listPrinters().map(printerFrom));
    },

    async capabilities(name) {
      const c = guard((m) => m.capabilities(name));
      return { color: c.color, duplex: c.duplex, media: c.papers.map((p) => DMPAPER[p]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i) };
    },

    async print(job) {
      const m = guard((x) => x);
      try {
        const out = await m.print({ printer: job.printer, file: job.file, title: String(job.title || 'FunPrinting').slice(0, 200), copies: job.copies, duplex: Boolean(job.duplex), color: job.colour === 'color', paper: job.media === 'A3' ? 'A3' : 'A4' });
        return { jobRef: String(out.jobId), mode: out.mode, pages: out.pages };
      } catch (err) {
        throw toPrintError(err);
      }
    },

    async jobStatus(printer, jobRef) {
      const key = `${printer}:${jobRef}`;
      const s = guard((m) => m.jobStatus(printer, Number(jobRef)));
      if (!s.found) {
        // Leaves the queue when finished, or when someone deletes it
        const seen = lastSeen.get(key) ?? 0;
        lastSeen.delete(key);
        if (seen & (JS.DELETING | JS.DELETED)) return { state: 'failed', reason: 'The print job was cancelled on this computer.', cancelled: true };
        return { state: 'completed' };
      }
      lastSeen.set(key, s.status);
      if (s.status & (JS.DELETING | JS.DELETED)) return { state: 'failed', reason: 'The print job was cancelled on this computer.', cancelled: true };
      if (s.status & (JS.COMPLETE | JS.PRINTED)) return { state: 'completed' };
      if (s.status & (JS.PAPEROUT | JS.OFFLINE | JS.USER_INTERVENTION | JS.ERROR | JS.PAUSED)) {
        // The job is stuck on the printer: say what it needs
        let reason;
        try {
          const p = guard((m) => m.listPrinters()).find((x) => x.name === printer);
          reason = p ? printerFrom(p).status.message : undefined;
        } catch {
          reason = undefined;
        }
        const fallback = s.status & JS.PAPEROUT ? 'Out of paper. Load paper in the printer.' : s.status & JS.OFFLINE ? 'The printer is offline. Check that it is on and connected.' : s.status & JS.PAUSED ? 'The print job is paused.' : 'The job needs attention. Check the printer.';
        return { state: 'held', reason: reason || fallback };
      }
      if (s.status & (JS.PRINTING)) return { state: 'printing', pages: s.pagesPrinted, total: s.totalPages };
      return { state: 'pending' };
    },

    async cancel(printer, jobRef) {
      try {
        guard((m) => m.cancelJob(printer, Number(jobRef)));
      } catch {
        // already gone
      }
    },

    /**
     * Sets up a printer found on the network (see windowsSetup.js). Shows one Windows
     * permission prompt (UAC) unless the user is already running as administrator.
     * @param {object} device  from discovery/merge.js
     * @returns {Promise<{ name: string, via: string }>}
     */
    async addPrinter(device) {
      const existing = guard((m) => m.listPrinters()).map((p) => p.name);
      const params = setup.buildParams(device, existing);
      if (!params) throw new PrintError('This printer did not say how to reach it.', CODES.ADD_FAILED);
      if (params.mode === 'raw') {
        // Look for an installed driver first, so a missing one doesn't cost the user a permission prompt
        let names = [];
        try {
          const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-PrinterDriver | ForEach-Object { $_.Name } | ConvertTo-Json -Compress'], { timeoutMs: 30_000 });
          const parsed = JSON.parse(r.stdout.trim() || '[]');
          names = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          names = [];
        }
        const driver = setup.chooseInstalledDriver(names, params);
        if (!driver) {
          throw new PrintError(
            `Windows has no driver for ${device.name || 'this printer'}. Install the manufacturer's printer software (or run Windows Update), then add the printer again.`,
            CODES.NEEDS_DRIVER
          );
        }
        params.driver = driver;
      }
      const dir = await fs.mkdtemp(path.join(tmpDir, 'fp-add-'));
      const files = { script: path.join(dir, 'add-printer.ps1'), params: path.join(dir, 'params.json'), result: path.join(dir, 'result.json') };
      try {
        await fs.writeFile(files.script, `\ufeff${setup.ADD_PRINTER_SCRIPT}`, 'utf8');
        await fs.writeFile(files.params, JSON.stringify(params), 'utf8');
        let launch;
        try {
          launch = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setup.launcherCommand(files.script, files.params, files.result)], { timeoutMs: 240_000 });
        } catch (err) {
          throw new PrintError(`Could not start the printer setup: ${err.message}`, CODES.ADD_FAILED);
        }
        let result;
        try {
          result = JSON.parse((await fs.readFile(files.result, 'utf8')).replace(/^\ufeff/, ''));
        } catch {
          // No result: the permission prompt was declined, or the script could not start
          throw new PrintError(
            /cancel|denied|elevat/i.test(launch.stderr) || launch.code !== 0
              ? 'Windows asked for permission to add the printer and it was not given. Choose Yes in the Windows prompt, or ask the person who manages this computer.'
              : 'The printer setup did not finish.',
            CODES.NEEDS_ADMIN
          );
        }
        if (!result.ok) {
          if (result.code === 'NEEDS_DRIVER') throw new PrintError(`Windows has no driver for ${device.name || 'this printer'}.`, CODES.NEEDS_DRIVER);
          throw new PrintError(`The printer could not be set up: ${String(result.message || 'Windows refused').slice(0, 300)}`, CODES.ADD_FAILED);
        }
        return { name: result.name, via: result.via };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

module.exports = { createWindowsEngine, printerFrom, reasonsFromStatus, toPrintError, PS, JS };
