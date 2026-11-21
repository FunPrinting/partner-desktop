'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { extractPages } = require('./pdf');

/**
 * Sends every run of a print request to the engine, in order, back to back to one printer.
 * The OS queue keeps them in order. Returns the queue job refs, one per run.
 *
 * A run that covers the whole file prints the file itself; other runs print a PDF with just
 * their pages, written next to the source and deleted by the caller via `cleanup()`.
 *
 * @param {object} engine
 * @param {object} args
 * @param {string} args.printer
 * @param {string} args.sourcePath  the PDF to print (already merged with the summary, if any)
 * @param {object} args.request     from buildRequest()
 * @param {string} args.title       job title shown in the OS queue
 */
async function sendRequest(engine, { printer, sourcePath, request, title }) {
  const created = [];
  const sent = [];
  let bytes;
  try {
    for (let i = 0; i < request.runs.length; i++) {
      const run = request.runs[i];
      const whole = run.pages.length === request.totalPages && run.pages.every((p, k) => p === k + 1);
      let file = sourcePath;
      if (!whole) {
        bytes ??= await fs.readFile(sourcePath);
        file = path.join(path.dirname(sourcePath), `${path.basename(sourcePath, '.pdf')}.run${i + 1}.pdf`);
        await fs.writeFile(file, await extractPages(bytes, run.pages));
        created.push(file);
      }
      const { jobRef } = await engine.print({
        printer,
        file,
        title: request.runs.length > 1 ? `${title} (${i + 1}/${request.runs.length})` : title,
        copies: run.copies,
        collate: true,
        media: request.media,
        duplex: request.duplex,
        colour: run.colour,
      });
      sent.push({ jobRef, run });
    }
  } catch (err) {
    err.sent = sent; // runs already in the queue, so the caller can cancel or track them
    throw err;
  } finally {
    // Engines copy the file into the OS queue before print() resolves
    await Promise.all(created.map((f) => fs.rm(f, { force: true })));
  }
  return sent;
}

module.exports = { sendRequest };
