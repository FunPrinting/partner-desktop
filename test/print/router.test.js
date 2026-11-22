'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { choosePrinter, jobIsPossible } = require('../../src/print/router');

const printer = (id, over = {}) => ({
  id,
  name: id,
  enabled: true,
  preferredBw: false,
  isDefault: false,
  status: { online: true },
  caps: { color: false, duplex: false, media: ['A4'] },
  ...over,
});
const laser = printer('laser', { caps: { color: false, duplex: true, media: ['A4', 'A3'] } });
const inkjet = printer('inkjet', { caps: { color: true, duplex: false, media: ['A4'] } });
const bw = { color: 'bw', sided: 'single', pageSize: 'A4' };
const colour = { color: 'color', sided: 'single', pageSize: 'A4' };

test('one printer: everything goes to it', () => {
  assert.equal(choosePrinter(bw, [laser]).printer.id, 'laser');
});

test('colour and mixed files need a colour printer', () => {
  assert.equal(choosePrinter(colour, [laser, inkjet]).printer.id, 'inkjet');
  assert.equal(choosePrinter({ ...colour, color: 'mixed' }, [laser, inkjet]).printer.id, 'inkjet');
});

test('A3 and double-sided go to a printer that can', () => {
  assert.equal(choosePrinter({ ...bw, pageSize: 'A3' }, [inkjet, laser]).printer.id, 'laser');
  assert.equal(choosePrinter({ ...bw, sided: 'double' }, [inkjet, laser]).printer.id, 'laser');
});

test('B&W prefers the printer marked for B&W, then a printer without colour', () => {
  const preferred = { ...inkjet, preferredBw: true };
  assert.equal(choosePrinter(bw, [laser, preferred]).printer.id, 'inkjet');
  assert.equal(choosePrinter(bw, [inkjet, laser]).printer.id, 'laser'); // keeps colour ink for colour jobs
  // The preference never sends a colour file to a B&W printer
  assert.equal(choosePrinter(colour, [{ ...laser, preferredBw: true }, inkjet]).printer.id, 'inkjet');
});

test('the system default breaks ties, then the name', () => {
  assert.equal(choosePrinter(bw, [printer('b'), printer('a', { isDefault: false }), printer('c', { isDefault: true })]).printer.id, 'c');
  assert.equal(choosePrinter(bw, [printer('b'), printer('a')]).printer.id, 'a');
});

test('disabled printers are never used', () => {
  assert.equal(choosePrinter(bw, [{ ...laser, enabled: false }, inkjet]).printer.id, 'inkjet');
  assert.match(choosePrinter(bw, [{ ...laser, enabled: false }]).reason, /No printer is switched on/);
});

test('an offline printer is skipped; if it is the only capable one the job waits with the reason', () => {
  const off = { ...laser, status: { online: false, message: 'Out of paper. Load paper in the printer.' } };
  assert.equal(choosePrinter(bw, [off, inkjet]).printer.id, 'inkjet');
  assert.deepEqual(choosePrinter({ ...bw, pageSize: 'A3' }, [off, inkjet]), { wait: true, reason: 'Out of paper. Load paper in the printer.' });
});

test('no printer can ever do it: impossible, naming what is missing', () => {
  const r = choosePrinter({ ...colour, sided: 'double' }, [laser, printer('plain')]);
  assert.equal(r.impossible, true);
  assert.match(r.reason, /None of your printers can do/);
  assert.equal(choosePrinter({ ...bw, pageSize: 'A3' }, [inkjet]).impossible, true);
});

test('a printer that failed this file can be excluded to try another', () => {
  assert.equal(choosePrinter(bw, [laser, printer('second')], { exclude: ['laser'] }).printer.id, 'second');
  assert.equal(choosePrinter(bw, [laser], { exclude: ['laser'] }).wait, true);
});

test('unknown capabilities are not held against a printer', () => {
  assert.equal(choosePrinter(colour, [{ ...laser, caps: null }]).printer.id, 'laser');
});

test('jobIsPossible ignores who is offline, and checks every file', () => {
  const off = { ...inkjet, status: { online: false } };
  assert.equal(jobIsPossible([bw, colour], [laser, off]).ok, true);
  const r = jobIsPossible([bw, { ...colour, sided: 'double' }], [laser, inkjet]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No single printer can do colour and double-sided printing together/);
});
