'use strict';

/**
 * The boundary between the shared print code and an OS print engine.
 *
 * An engine implements:
 *   name: string
 *   listPrinters(): Promise<Printer[]>
 *   capabilities(printerName): Promise<Capabilities>
 *   print(job: EngineJob): Promise<{ jobRef: string }>   resolves once the job is in the OS queue
 *   jobStatus(printerName, jobRef): Promise<JobState>
 *   cancel(printerName, jobRef): Promise<void>
 *   addPrinter(device, opts?): Promise<{ name }>   optional: sets up a network printer in the OS
 *
 * Printer      { name, displayName, isDefault, uri?, driver?, location? }
 * Capabilities { color: boolean, duplex: boolean, media: string[], postscript?: boolean, trays?: string[] }
 * EngineJob    { printer, file, title, copies, collate, media, duplex, colour: 'color'|'bw' }
 * JobState     { state: 'pending'|'printing'|'held'|'completed'|'failed'|'unknown', reason?: string }
 *
 * Engines throw PrintError so the queue can decide to retry, wait, or move to another printer.
 */

const CODES = Object.freeze({
  PRINTER_NOT_FOUND: 'PRINTER_NOT_FOUND',
  PRINTER_OFFLINE: 'PRINTER_OFFLINE',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION', // out of paper, jam, door open, toner
  DRIVER_FAILED: 'DRIVER_FAILED',
  FILE_UNREADABLE: 'FILE_UNREADABLE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  NEEDS_DRIVER: 'NEEDS_DRIVER', // adding a printer: no driver for this model on this computer
  NEEDS_ADMIN: 'NEEDS_ADMIN', // adding a printer: the user may not change printers
  ADD_FAILED: 'ADD_FAILED',
  UNKNOWN: 'UNKNOWN',
});

/** Codes where the printer, not the file, is the problem: wait or move to another printer. */
const PRINTER_CODES = new Set([CODES.PRINTER_NOT_FOUND, CODES.PRINTER_OFFLINE, CODES.NEEDS_ATTENTION, CODES.DRIVER_FAILED]);

class PrintError extends Error {
  constructor(message, code = CODES.UNKNOWN, details) {
    super(message);
    this.name = 'PrintError';
    this.code = code;
    this.details = details;
  }
  get printerIssue() {
    return PRINTER_CODES.has(this.code);
  }
  /** A bad file never prints, so retrying it is pointless. */
  get retryable() {
    return this.code !== CODES.FILE_UNREADABLE && this.code !== CODES.CANCELLED;
  }
}

const REQUIRED = ['listPrinters', 'capabilities', 'print', 'jobStatus', 'cancel'];

function assertEngine(engine) {
  const missing = REQUIRED.filter((m) => typeof engine?.[m] !== 'function');
  if (missing.length) throw new TypeError(`Print engine "${engine?.name || '?'}" is missing: ${missing.join(', ')}`);
  return engine;
}

module.exports = { CODES, PrintError, assertEngine };
