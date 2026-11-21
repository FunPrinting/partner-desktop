'use strict';

const { PDFDocument } = require('pdf-lib');

/** ISO page sizes in PDF points. */
const SIZES = { A4: [595.28, 841.89], A3: [841.89, 1190.55] };

async function load(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

async function pageCount(bytes) {
  return (await load(bytes)).getPageCount();
}

/** A new PDF with only `pages` (1-based, in order) of the source. */
async function extractPages(bytes, pages) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map((p) => p - 1));
  copied.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save({ useObjectStreams: true }));
}

/**
 * The summary sheet followed by the document. For double-sided printing a blank page
 * follows the summary, so the document starts on the front of a new sheet.
 * Returns the merged bytes and how many pages come before the document.
 */
async function withSummary(docBytes, summaryBytes, { duplex, media = 'A4' }) {
  const out = await PDFDocument.create();
  const summary = await load(summaryBytes);
  for (const p of await out.copyPages(summary, summary.getPageIndices())) out.addPage(p);
  let prefixPages = summary.getPageCount();
  if (duplex && prefixPages % 2 === 1) {
    out.addPage(SIZES[media] || SIZES.A4);
    prefixPages += 1;
  }
  const doc = await load(docBytes);
  for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
  return { bytes: Buffer.from(await out.save({ useObjectStreams: true })), prefixPages, docPages: doc.getPageCount() };
}

module.exports = { SIZES, pageCount, extractPages, withSummary };
