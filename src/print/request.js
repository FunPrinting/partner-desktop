'use strict';

const { planRuns } = require('./colourRuns');

const MEDIA = new Set(['A4', 'A3']);
const MAX_COPIES = 100;

/**
 * Turns one order file into a print request: the settings for the whole file and the
 * ordered runs to send. Pure; no I/O.
 *
 * Page numbers in runs refer to the PDF that is printed, which is the summary pages (if any)
 * followed by the document. The summary prints once, in B&W, before all copies.
 *
 * @param {object} file  server job file: { pageSize, color, sided, copies, pages, colorPages }
 * @param {object} [opts]
 * @param {number} [opts.pageCount]   real page count of the downloaded PDF (wins over file.pages)
 * @param {number} [opts.prefixPages] summary pages placed before the document (0, 1, or 2 for duplex)
 */
function buildRequest(file, { pageCount, prefixPages = 0 } = {}) {
  const media = MEDIA.has(file.pageSize) ? file.pageSize : 'A4';
  const duplex = file.sided === 'double';
  const copies = Math.min(MAX_COPIES, Math.max(1, Math.floor(Number(file.copies)) || 1));
  const colour = file.color === 'color' || file.color === 'mixed' ? file.color : 'bw';
  const docPages = Math.max(1, Math.floor(pageCount || file.pages) || 1);
  const prefix = Math.max(0, Math.floor(prefixPages) || 0);

  const docRuns = planRuns({
    pageCount: docPages,
    colour,
    colorPages: colour === 'mixed' ? (file.colorPages || []) : [],
    duplex,
    copies,
  }).map((r) => ({ ...r, pages: r.pages.map((p) => p + prefix) }));

  const runs = prefix > 0 ? [{ pages: Array.from({ length: prefix }, (_, i) => i + 1), colour: 'bw', copies: 1, summary: true }, ...docRuns] : docRuns;
  return { media, duplex, copies, colour, totalPages: prefix + docPages, prefixPages: prefix, runs };
}

/** Pages the summary takes: one, or two for double-sided so the document starts on a new sheet. */
function summaryPrefixPages(duplex) {
  return duplex ? 2 : 1;
}

module.exports = { buildRequest, summaryPrefixPages, MAX_COPIES };
