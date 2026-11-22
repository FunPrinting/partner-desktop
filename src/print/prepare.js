'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { buildRequest } = require('./request');
const { pageCount, withSummary, load, reversePageIndices, PDFDocument } = require('./pdf');

/**
 * Builds what to send to the printer for one file of a job: the PDF path and the request
 * (settings + colour runs). The cached download is never modified; when the cover sheet is
 * added or pages are reversed for face-up LIFO trays, the processed PDF is written to `workDir`.
 *
 * @param {object} args
 * @param {object} args.file          the server job file
 * @param {string} args.cachedPath    the downloaded print-ready PDF
 * @param {string} args.workDir
 * @param {string} args.name          unique base name for files in workDir (e.g. jobId-fileIndex)
 * @param {Buffer} [args.summary]     cover sheet PDF to include
 * @param {boolean} [args.cohesive=false] send mixed documents as one single continuous job
 * @param {boolean} [args.reverseOrder=false] print pages in LIFO stack order (Page N to 1) for face-up trays
 * @param {'fit'|'shrink'|'none'|'fill'} [args.scaling='fit'] page scaling mode
 * @returns {Promise<{ sourcePath: string, request: object, cleanup: () => Promise<void> }>}
 */
async function prepareFile({ file, cachedPath, workDir, name, summary, cohesive = false, reverseOrder = false, scaling = 'fit' }) {
  const bytes = await fsp.readFile(cachedPath);
  const duplex = file.sided === 'double';
  if (!summary) {
    let sourcePath = cachedPath;
    let cleanup = async () => {};
    const count = await pageCount(bytes);
    if (reverseOrder && count > 1) {
      const reversedDoc = await PDFDocument.create();
      const doc = await load(bytes);
      const indices = reversePageIndices(count, duplex);
      for (const p of await reversedDoc.copyPages(doc, indices)) reversedDoc.addPage(p);
      await fsp.mkdir(workDir, { recursive: true });
      sourcePath = path.join(workDir, `${name.replace(/[^\w.-]+/g, '_')}.rev.pdf`);
      await fsp.writeFile(sourcePath, await reversedDoc.save({ useObjectStreams: true }));
      cleanup = () => fsp.rm(sourcePath, { force: true });
    }
    const request = buildRequest(file, { pageCount: count, cohesive, scaling });
    return { sourcePath, request, cleanup };
  }
  const position = reverseOrder ? 'suffix' : 'prefix';
  const merged = await withSummary(bytes, summary, { duplex, media: file.pageSize === 'A3' ? 'A3' : 'A4', position, reverseOrder });
  await fsp.mkdir(workDir, { recursive: true });
  const sourcePath = path.join(workDir, `${name.replace(/[^\w.-]+/g, '_')}.pdf`);
  await fsp.writeFile(sourcePath, merged.bytes);
  const request = buildRequest(file, {
    pageCount: merged.docPages,
    prefixPages: merged.prefixPages || 0,
    suffixPages: merged.suffixPages || 0,
    cohesive,
    scaling,
  });
  return { sourcePath, request, cleanup: () => fsp.rm(sourcePath, { force: true }) };
}

module.exports = { prepareFile };
