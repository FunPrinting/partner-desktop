'use strict';

/**
 * Splits one file into an ordered list of print runs, each run all colour or all B&W.
 *
 * - Single-sided: consecutive pages with the same colour form one run.
 * - Double-sided: the unit is a sheet (pages 1-2, 3-4, ...). A sheet with a colour page on
 *   either side prints in colour, so a run never starts on the back of a sheet.
 * - Copies: a file that is one run prints as one job with `copies`. A file with several runs
 *   repeats the whole sequence once per copy (each run 1 copy), so the stacks come out collated.
 *
 * Pages are 1-based, as the server sends them.
 */

/**
 * @param {object} input
 * @param {number} input.pageCount
 * @param {'color'|'bw'|'mixed'} input.colour
 * @param {number[]} [input.colorPages] pages printed in colour when colour is 'mixed'
 * @param {boolean} input.duplex
 * @param {number} input.copies
 * @param {boolean} [input.cohesive=false] send mixed documents as one single continuous job
 * @returns {{ pages: number[], colour: 'color'|'bw', copies: number }[]}
 */
function planRuns({ pageCount, colour, colorPages = [], duplex, copies, cohesive = false }) {
  const total = Math.max(1, Math.floor(pageCount) || 1);
  const count = Math.max(1, Math.floor(copies) || 1);
  const all = Array.from({ length: total }, (_, i) => i + 1);

  if (colour !== 'mixed') return [{ pages: all, colour: colour === 'color' ? 'color' : 'bw', copies: count }];

  const inColour = new Set(colorPages.filter((p) => Number.isInteger(p) && p >= 1 && p <= total));
  if (inColour.size === 0) return [{ pages: all, colour: 'bw', copies: count }];
  if (inColour.size === total) return [{ pages: all, colour: 'color', copies: count }];

  if (cohesive) {
    // One Cohesive Print Job: all pages (color and B&W) sent in natural document order as one single run.
    // The printer feeds paper continuously without paper ejects or multi-part job interruptions.
    return [{ pages: all, colour: 'color', copies: count }];
  }

  // Units: single pages, or sheets of two pages for double-sided
  const size = duplex ? 2 : 1;
  const runs = [];
  for (let start = 1; start <= total; start += size) {
    const pages = all.slice(start - 1, start - 1 + size);
    const unitColour = pages.some((p) => inColour.has(p)) ? 'color' : 'bw';
    const last = runs[runs.length - 1];
    if (last && last.colour === unitColour) last.pages.push(...pages);
    else runs.push({ pages, colour: unitColour });
  }

  if (runs.length === 1) return [{ ...runs[0], copies: count }];
  const sequence = [];
  for (let c = 0; c < count; c++) for (const r of runs) sequence.push({ pages: [...r.pages], colour: r.colour, copies: 1 });
  return sequence;
}

/** Number of sheets one run uses per copy (for progress and reporting). */
function sheetsFor(run, duplex) {
  return duplex ? Math.ceil(run.pages.length / 2) : run.pages.length;
}

module.exports = { planRuns, sheetsFor };
