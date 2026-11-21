'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { buildRequest } = require('./request');
const { pageCount, withSummary } = require('./pdf');

/**
 * Builds what to send to the printer for one file of a job: the PDF path and the request
 * (settings + colour runs). The cached download is never modified; when the cover sheet is
 * added, the merged PDF is written to `workDir`.
 *
 * @param {object} args
 * @param {object} args.file          the server job file
 * @param {string} args.cachedPath    the downloaded print-ready PDF
 * @param {string} args.workDir
 * @param {string} args.name          unique base name for files in workDir (e.g. jobId-fileIndex)
 * @param {Buffer} [args.summary]     cover sheet PDF to put first (first file of an order only)
 * @returns {Promise<{ sourcePath: string, request: object, cleanup: () => Promise<void> }>}
 */
async function prepareFile({ file, cachedPath, workDir, name, summary }) {
  const bytes = await fsp.readFile(cachedPath);
  if (!summary) {
    const request = buildRequest(file, { pageCount: await pageCount(bytes) });
    return { sourcePath: cachedPath, request, cleanup: async () => {} };
  }
  const duplex = file.sided === 'double';
  const merged = await withSummary(bytes, summary, { duplex, media: file.pageSize === 'A3' ? 'A3' : 'A4' });
  await fsp.mkdir(workDir, { recursive: true });
  const sourcePath = path.join(workDir, `${name.replace(/[^\w.-]+/g, '_')}.pdf`);
  await fsp.writeFile(sourcePath, merged.bytes);
  const request = buildRequest(file, { pageCount: merged.docPages, prefixPages: merged.prefixPages });
  return { sourcePath, request, cleanup: () => fsp.rm(sourcePath, { force: true }) };
}

module.exports = { prepareFile };
