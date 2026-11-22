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
 * Reverse page ordering for LIFO face-up printer output:
 * For single-sided: [N, N-1, ..., 1]
 * For duplex: sheets are [1, 2], [3, 4] ... reversed by sheet unit so Sheet 1 lands on top with Page 1 facing up.
 */
function reversePageIndices(total, duplex) {
  const indices = Array.from({ length: total }, (_, i) => i);
  if (!duplex || total <= 1) return indices.reverse();
  const sheets = [];
  for (let i = 0; i < total; i += 2) {
    sheets.push(i + 1 < total ? [indices[i], indices[i + 1]] : [indices[i]]);
  }
  return sheets.reverse().flat();
}

/**
 * The summary sheet combined with the document.
 * - position: 'prefix' (default): Summary sheet placed before document (for face-down laser output).
 * - position: 'suffix': Summary sheet placed after document (for face-up inkjet trays so it lands on top).
 * When reverseOrder is true, document pages are ordered N to 1.
 */
async function withSummary(docBytes, summaryBytes, { duplex, media = 'A4', position = 'prefix', reverseOrder = false } = {}) {
  const out = await PDFDocument.create();
  const summary = await load(summaryBytes);
  const doc = await load(docBytes);
  const docTotal = doc.getPageCount();
  const docIndices = reverseOrder ? reversePageIndices(docTotal, duplex) : doc.getPageIndices();

  if (position === 'suffix') {
    for (const p of await out.copyPages(doc, docIndices)) out.addPage(p);
    let docPages = docTotal;
    if (duplex && docPages % 2 === 1) {
      out.addPage(SIZES[media] || SIZES.A4);
    }
    for (const p of await out.copyPages(summary, summary.getPageIndices())) out.addPage(p);
    return { bytes: Buffer.from(await out.save({ useObjectStreams: true })), prefixPages: 0, suffixPages: summary.getPageCount(), docPages };
  }

  for (const p of await out.copyPages(summary, summary.getPageIndices())) out.addPage(p);
  let prefixPages = summary.getPageCount();
  if (duplex && prefixPages % 2 === 1) {
    out.addPage(SIZES[media] || SIZES.A4);
    prefixPages += 1;
  }
  for (const p of await out.copyPages(doc, docIndices)) out.addPage(p);
  return { bytes: Buffer.from(await out.save({ useObjectStreams: true })), prefixPages, suffixPages: 0, docPages: docTotal };
}

module.exports = { SIZES, load, pageCount, extractPages, withSummary, reversePageIndices, PDFDocument };
