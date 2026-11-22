'use strict';

const defaultIpp = require('../ipp');
const { run: defaultRun } = require('../exec');
const { CODES, PrintError } = require('../engine');
const { worstReason } = require('../reasons');
const setup = require('./cupsSetup');

/**
 * macOS and Linux engine: CUPS.
 *
 * - Printing: one `lp` call per run with every option. CUPS reads the PDF natively, so
 *   nothing is rasterised here; driverless (IPP Everywhere / AirPrint) printers receive
 *   the PDF or the printer's own raster format, and driver queues use their filter.
 * - Printers, capabilities, printer and job state: IPP to the local CUPS server, which
 *   answers for every queue from its PPD or from the printer. Exact job states
 *   (completed / aborted / held) come from here, not from parsing command output.
 * - Only options the printer supports are sent, so CUPS never holds a job over an
 *   option it can't apply. A3/A4 use the IPP media names; PPD-only colour and duplex
 *   choices are added when the queue's PPD has them.
 */

const MEDIA_KEYWORD = { A4: 'iso_a4_210x297mm', A3: 'iso_a3_297x420mm' };
const PAPER_OF = (keyword) => (/^iso_a4_/.test(keyword) ? 'A4' : /^iso_a3_/.test(keyword) ? 'A3' : null);
const CAPS_TTL_MS = 5 * 60_000;

/** `lpoptions -p NAME -l` → { ColorModel: { choices: [...], default } } */
function parsePpdOptions(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([^/:\s]+)(?:\/[^:]*)?:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const choices = m[2].split(/\s+/).filter(Boolean);
    const def = choices.find((c) => c.startsWith('*'));
    out[m[1]] = { choices: choices.map((c) => c.replace(/^\*/, '')), default: def ? def.slice(1) : undefined };
  }
  return out;
}

const GRAY = /^(gray|grey|grayscale|greyscale|mono|monochrome|kgray|black|blackonly|cmygray|bw)$/i;
const COLOUR = /^(rgb|cmyk|color|colour|rgbcolor|cmy|rgbk)$/i;

/** PPD choices that match the request, for queues whose PPD doesn't map the IPP options. */
function ppdExtras(ppd, { colour, duplex }) {
  const extra = [];
  const model = ppd.ColorModel || ppd.ColorMode || ppd.OutputMode;
  if (model) {
    const key = ppd.ColorModel ? 'ColorModel' : ppd.ColorMode ? 'ColorMode' : 'OutputMode';
    const want = model.choices.find((c) => (colour === 'bw' ? GRAY : COLOUR).test(c));
    if (want) extra.push(`${key}=${want}`);
  }
  if (ppd.Duplex) {
    // Long-edge binding for portrait pages ("DuplexNoTumble"), or explicitly off
    const want = ppd.Duplex.choices.find((c) => (duplex ? /^DuplexNoTumble$/i : /^None$/i).test(c));
    if (want) extra.push(`Duplex=${want}`);
  }
  return extra;
}

function capabilitiesFrom(a) {
  const sides = a['sides-supported'] || [];
  const colourModes = a['print-color-mode-supported'] || [];
  const media = [...new Set((a['media-supported'] || []).map(PAPER_OF).filter(Boolean))];
  return {
    color: a['color-supported']?.[0] === true || colourModes.includes('color'),
    duplex: sides.some((s) => String(s).startsWith('two-sided')),
    media,
    sides,
    colourModes,
    mediaKeywords: a['media-supported'] || [],
  };
}

function printerFrom(a, defaultName) {
  const name = a['printer-name']?.[0];
  const reasons = (a['printer-state-reasons'] || []).filter((r) => r && r !== 'none');
  const state = defaultIpp.PRINTER_STATE[a['printer-state']?.[0]] || 'unknown';
  const accepting = a['printer-is-accepting-jobs']?.[0] !== false;
  const problem = worstReason(reasons);
  return {
    name,
    displayName: a['printer-info']?.[0] || name,
    isDefault: name === defaultName,
    // Stable across renames: the printer's UUID, else where it is connected
    id: a['printer-uuid']?.[0] || a['device-uri']?.[0] || name,
    uri: a['device-uri']?.[0],
    driver: a['printer-make-and-model']?.[0],
    location: a['printer-location']?.[0] || undefined,
    status: {
      state: !accepting || state === 'stopped' ? 'stopped' : state,
      online: accepting && state !== 'stopped' && problem?.severity !== 'offline',
      reasons,
      message: problem?.message || (!accepting ? 'The printer is not accepting jobs.' : state === 'stopped' ? 'The printer is paused.' : undefined),
    },
  };
}

function lpError(stderr, printer) {
  const s = stderr.trim();
  if (/does not exist|not found|unknown destination/i.test(s)) return new PrintError(`Printer "${printer}" was not found`, CODES.PRINTER_NOT_FOUND, s);
  if (/not accepting/i.test(s)) return new PrintError(`Printer "${printer}" is not accepting jobs`, CODES.PRINTER_OFFLINE, s);
  if (/unable to access|no such file|unsupported document-format|document format/i.test(s)) return new PrintError('The file could not be printed (unreadable)', CODES.FILE_UNREADABLE, s);
  return new PrintError(`Printing failed: ${s || 'lp exited with an error'}`, CODES.DRIVER_FAILED, s);
}

function createCupsEngine({ ipp = defaultIpp, run = defaultRun, ippOptions = {}, lpPath = 'lp', lpstatPath = 'lpstat', lpoptionsPath = 'lpoptions', lpadminPath = 'lpadmin', lpinfoPath = 'lpinfo', platform = process.platform, pkexecPath = 'pkexec' } = {}) {
  const capsCache = new Map(); // name -> { at, caps, ppd }

  async function defaultPrinter() {
    const r = await run(lpstatPath, ['-d'], { timeoutMs: 5000 }).catch(() => null);
    const m = r && /destination:\s*(\S+)/.exec(r.stdout);
    return m ? m[1] : null;
  }

  async function ppdOptions(name) {
    const r = await run(lpoptionsPath, ['-p', name, '-l'], { timeoutMs: 5000 }).catch(() => null);
    return r && r.code === 0 ? parsePpdOptions(r.stdout) : {};
  }

  async function caps(name, { fresh = false } = {}) {
    const hit = capsCache.get(name);
    if (hit && !fresh && Date.now() - hit.at < CAPS_TTL_MS) return hit;
    let a;
    try {
      a = await ipp.getPrinterAttributes(name, ippOptions);
    } catch (err) {
      if (err.ipp === 0x0406) throw new PrintError(`Printer "${name}" was not found`, CODES.PRINTER_NOT_FOUND);
      throw new PrintError(`Could not reach the print system: ${err.message}`, CODES.DRIVER_FAILED);
    }
    const entry = { at: Date.now(), attrs: a, caps: capabilitiesFrom(a), ppd: await ppdOptions(name) };
    capsCache.set(name, entry);
    return entry;
  }

  return {
    name: 'cups',

    async listPrinters() {
      const [all, def] = await Promise.all([ipp.getPrinters(ippOptions), defaultPrinter()]);
      return all.map((a) => printerFrom(a, def)).filter((p) => p.name);
    },

    async capabilities(name) {
      const { caps: c } = await caps(name, { fresh: true });
      return { color: c.color, duplex: c.duplex, media: c.media };
    },

    async status(name) {
      const { attrs } = await caps(name, { fresh: true });
      return printerFrom(attrs, null).status;
    },

    /** The `lp` arguments for a job (exported for tests). */
    async argsFor(job) {
      const { caps: c, ppd } = await caps(job.printer);
      const args = ['-d', job.printer, '-t', String(job.title || 'FunPrinting').slice(0, 200)];
      const copies = Math.max(1, Math.floor(job.copies) || 1);
      if (copies > 1) args.push('-n', String(copies), '-o', 'collate=true');
      const media = MEDIA_KEYWORD[job.media];
      if (media && c.mediaKeywords.includes(media)) args.push('-o', `media=${media}`);
      else if (media) args.push('-o', `media=${job.media}`); // PPD PageSize names (A4/A3)
      if (c.sides.length) {
        const sides = job.duplex && c.duplex ? 'two-sided-long-edge' : 'one-sided';
        if (c.sides.includes(sides)) args.push('-o', `sides=${sides}`);
      }
      const colourMode = job.colour === 'color' ? 'color' : 'monochrome';
      if (c.colourModes.includes(colourMode)) args.push('-o', `print-color-mode=${colourMode}`);
      for (const kv of ppdExtras(ppd, { colour: job.colour, duplex: job.duplex && c.duplex })) args.push('-o', kv);
      if (job.fit) args.push('-o', 'fit-to-page');
      args.push('--', job.file);
      return args;
    },

    async print(job) {
      const args = await this.argsFor(job);
      let r;
      try {
        r = await run(lpPath, args, { timeoutMs: 60_000 });
      } catch (err) {
        throw new PrintError(err.code === 'ETIMEDOUT' ? 'The print system did not respond' : `Could not start printing: ${err.message}`, err.code === 'ETIMEDOUT' ? CODES.TIMEOUT : CODES.DRIVER_FAILED);
      }
      if (r.code !== 0) throw lpError(r.stderr, job.printer);
      const m = /request id is \S+-(\d+)/.exec(r.stdout);
      if (!m) throw new PrintError(`Unexpected answer from lp: ${r.stdout.trim() || r.stderr.trim()}`, CODES.UNKNOWN);
      return { jobRef: m[1] };
    },

    async jobStatus(printer, jobRef) {
      const a = await ipp.getJobAttributes(printer, Number(jobRef), ippOptions);
      if (!a) return { state: 'unknown' };
      const state = defaultIpp.JOB_STATE[a['job-state']?.[0]];
      const reasons = a['job-state-reasons'] || [];
      const message = a['job-printer-state-message']?.[0] || undefined;
      if (state === 'completed') return { state: 'completed' };
      if (state === 'canceled') return { state: 'failed', reason: 'The print job was cancelled on this computer.', cancelled: true };
      if (state === 'aborted') return { state: 'failed', reason: message || `The printer stopped the job (${reasons.join(', ') || 'aborted'}).` };
      if (state === 'processing') return { state: 'printing', reason: message };
      if (state === 'held' || state === 'stopped') {
        // Waiting on the printer: say what it needs
        let problem;
        try {
          problem = worstReason(printerFrom((await caps(printer, { fresh: true })).attrs, null).status.reasons);
        } catch {
          problem = null;
        }
        return { state: 'held', reason: problem?.message || message || 'The job is held. Check the printer.' };
      }
      return { state: 'pending', reason: message };
    },

    async cancel(printer, jobRef) {
      await ipp.cancelJob(printer, Number(jobRef), ippOptions).catch(() => undefined);
    },

    /**
     * Sets up a printer found on the network as a CUPS queue.
     *   IPP printers (nearly all Wi-Fi printers): driverless (`-m everywhere`), connected by
     *     the printer's .local name so a new IP address doesn't break it.
     *   Raw 9100 / LPD printers: need the manufacturer's PPD, picked from `lpinfo -m`.
     * @param {object} device  from discovery/merge.js
     * @returns {Promise<{ name: string, via: string }>}
     */
    async addPrinter(device) {
      const existing = (await ipp.getPrinters(ippOptions).catch(() => [])).map((a) => a['printer-name']?.[0]).filter(Boolean);
      const name = setup.queueName(device, existing);
      const common = ['-p', name, '-E', '-D', String(device.name || name).slice(0, 120)];
      if (device.location) common.push('-L', String(device.location).slice(0, 120));
      const attempts = [];
      if (device.protocols.ipp || device.protocols.ipps) {
        for (const url of setup.ippCandidates(device)) attempts.push({ via: url, args: [...common, '-v', url, '-m', 'everywhere'] });
      } else {
        const uri = setup.rawUri(device);
        if (!uri) throw new PrintError('This printer did not say how to reach it.', CODES.ADD_FAILED);
        let drivers = [];
        try {
          drivers = setup.parseDrivers((await run(lpinfoPath, ['-m'], { timeoutMs: 60_000 })).stdout);
        } catch {
          // fall through to "no driver"
        }
        const driver = setup.pickDriver(drivers, { make: device.make, model: device.model });
        if (!driver) {
          throw new PrintError(
            `This computer has no driver for ${device.name || 'this printer'}. Install the manufacturer's printer software, then add the printer again.`,
            CODES.NEEDS_DRIVER
          );
        }
        attempts.push({ via: uri, args: [...common, '-v', uri, '-m', driver.id] });
      }
      let last = '';
      for (const a of attempts) {
        let r = await run(lpadminPath, a.args, { timeoutMs: 60_000 }).catch((err) => ({ code: 1, stdout: '', stderr: err.message }));
        if (r.code !== 0 && setup.isPermissionError(r.stderr) && platform === 'linux') {
          r = await run(pkexecPath, [lpadminPath, ...a.args], { timeoutMs: 120_000 }).catch((err) => ({ code: 1, stdout: '', stderr: err.message }));
        }
        if (r.code === 0) return { name, via: a.via };
        if (setup.isPermissionError(r.stderr)) {
          throw new PrintError('Adding a printer needs an administrator account on this computer. Ask the person who manages it, or add the printer in System Settings.', CODES.NEEDS_ADMIN);
        }
        last = r.stderr.trim() || last;
      }
      throw new PrintError(`The printer could not be set up: ${last || 'the print system refused'}`, CODES.ADD_FAILED);
    },
  };
}

module.exports = { createCupsEngine, parsePpdOptions, ppdExtras, capabilitiesFrom, printerFrom };
