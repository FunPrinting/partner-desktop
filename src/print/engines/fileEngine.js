'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { CODES, PrintError } = require('../engine');

/**
 * A fake printer that writes each job (the PDF and a JSON file with its settings) to a folder.
 * Used by tests, and by the "Save print jobs to a folder" developer option, to see exactly
 * what would be sent to a real printer.
 */
function createFileEngine({ dir, printers = [{ name: 'Test Printer', displayName: 'Test Printer', isDefault: true }], capabilities } = {}) {
  let seq = 0;
  const jobs = new Map();
  const caps = capabilities || { color: true, duplex: true, media: ['A4', 'A3'] };

  return {
    name: 'file',
    jobs,
    async listPrinters() {
      return printers.map((p) => ({ ...p }));
    },
    async capabilities(printerName) {
      if (!printers.some((p) => p.name === printerName)) throw new PrintError(`Printer "${printerName}" not found`, CODES.PRINTER_NOT_FOUND);
      return { ...caps };
    },
    async print(job) {
      if (!printers.some((p) => p.name === job.printer)) throw new PrintError(`Printer "${job.printer}" not found`, CODES.PRINTER_NOT_FOUND);
      const jobRef = String(++seq);
      const base = path.join(dir, `${jobRef.padStart(3, '0')}-${(job.title || 'job').replace(/[^\w.-]+/g, '_')}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(job.file, `${base}.pdf`);
      const settings = { printer: job.printer, copies: job.copies, collate: job.collate, media: job.media, duplex: job.duplex, colour: job.colour };
      await fs.writeFile(`${base}.json`, JSON.stringify(settings, null, 2));
      jobs.set(jobRef, { ...settings, file: `${base}.pdf`, state: 'completed' });
      return { jobRef };
    },
    async jobStatus(_printer, jobRef) {
      const j = jobs.get(String(jobRef));
      return j ? { state: j.state } : { state: 'unknown' };
    },
    async cancel(_printer, jobRef) {
      const j = jobs.get(String(jobRef));
      if (j) j.state = 'failed';
    },
  };
}

module.exports = { createFileEngine };
