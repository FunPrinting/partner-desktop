'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planRuns } = require('../../src/print/colourRuns');

const brief = (runs) => runs.map((r) => `${r.colour}:${r.pages.join(',')}x${r.copies}`);

test('B&W and colour files are one run with all copies', () => {
  assert.deepEqual(brief(planRuns({ pageCount: 3, colour: 'bw', duplex: false, copies: 2 })), ['bw:1,2,3x2']);
  assert.deepEqual(brief(planRuns({ pageCount: 3, colour: 'color', duplex: true, copies: 1 })), ['color:1,2,3x1']);
});

test('mixed with no colour pages, or all colour pages, is one run', () => {
  assert.deepEqual(brief(planRuns({ pageCount: 3, colour: 'mixed', colorPages: [], duplex: false, copies: 1 })), ['bw:1,2,3x1']);
  assert.deepEqual(brief(planRuns({ pageCount: 2, colour: 'mixed', colorPages: [1, 2], duplex: false, copies: 3 })), ['color:1,2x3']);
});

test('single-sided mixed groups consecutive pages of the same colour', () => {
  assert.deepEqual(brief(planRuns({ pageCount: 6, colour: 'mixed', colorPages: [2, 3, 6], duplex: false, copies: 1 })), [
    'bw:1x1',
    'color:2,3x1',
    'bw:4,5x1',
    'color:6x1',
  ]);
});

test('double-sided mixed splits by sheet; a colour back makes the sheet colour', () => {
  // Sheets: [1,2] [3,4] [5,6] [7]; page 4 is colour, so sheet [3,4] prints in colour
  assert.deepEqual(brief(planRuns({ pageCount: 7, colour: 'mixed', colorPages: [4], duplex: true, copies: 1 })), [
    'bw:1,2x1',
    'color:3,4x1',
    'bw:5,6,7x1',
  ]);
});

test('every run in double-sided mode starts on an odd page (front of a sheet)', () => {
  const runs = planRuns({ pageCount: 11, colour: 'mixed', colorPages: [2, 5, 9, 10], duplex: true, copies: 1 });
  for (const r of runs) assert.equal(r.pages[0] % 2, 1, `run ${r.pages} starts on a back page`);
  assert.deepEqual(runs.flatMap((r) => r.pages), Array.from({ length: 11 }, (_, i) => i + 1));
});

test('several runs with copies repeat the sequence once per copy, so stacks are collated', () => {
  assert.deepEqual(brief(planRuns({ pageCount: 3, colour: 'mixed', colorPages: [2], duplex: false, copies: 2 })), [
    'bw:1x1',
    'color:2x1',
    'bw:3x1',
    'bw:1x1',
    'color:2x1',
    'bw:3x1',
  ]);
});

test('colour pages outside the document are ignored', () => {
  assert.deepEqual(brief(planRuns({ pageCount: 2, colour: 'mixed', colorPages: [0, 5, 2.5, 2], duplex: false, copies: 1 })), ['bw:1x1', 'color:2x1']);
});
