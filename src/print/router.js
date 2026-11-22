'use strict';

/**
 * Chooses which of the shop's printers prints a file.
 *
 * A printer qualifies when the shop enabled it and its capabilities cover the file: colour
 * for colour or mixed files, duplex for double-sided, A3 for A3. A file always goes to one
 * printer (never split across printers).
 *
 * Among qualifying printers that are ready:
 *  1. a B&W file goes to the printer marked "preferred for B&W", if it qualifies;
 *  2. otherwise a B&W file prefers a printer without colour (keeps colour ink for colour jobs);
 *  3. then the system default printer, then the name, so the choice is stable.
 *
 * Result:
 *  { printer }                       print on it now
 *  { wait: true, reason }            a printer could do it, but none is ready: wait
 *  { impossible: true, reason }      no enabled printer can ever do this: give the job back
 *
 * Capabilities that are unknown (not read yet) are not held against a printer.
 */
function needsOf(file) {
  return {
    colour: file.color === 'color' || file.color === 'mixed',
    duplex: file.sided === 'double',
    a3: file.pageSize === 'A3',
  };
}

function lacks(needs, printer) {
  const c = printer.caps;
  if (!c) return [];
  const out = [];
  if (needs.colour && !c.color) out.push('colour');
  if (needs.duplex && !c.duplex) out.push('double-sided printing');
  if (needs.a3 && Array.isArray(c.media) && c.media.length && !c.media.includes('A3')) out.push('A3 paper');
  return out;
}

function choosePrinter(file, printers, { exclude = [] } = {}) {
  const needs = needsOf(file);
  const enabled = printers.filter((p) => p.enabled);
  if (!enabled.length) return { impossible: true, reason: 'No printer is switched on. Choose a printer in Settings.' };

  const capable = enabled.filter((p) => lacks(needs, p).length === 0);
  if (!capable.length) {
    const wanted = [needs.colour && 'colour', needs.duplex && 'double-sided printing', needs.a3 && 'A3 paper'].filter(Boolean);
    const everywhere = wanted.filter((w) => enabled.some((p) => !lacks(needs, p).includes(w)));
    if (wanted.length > 1 && everywhere.length === wanted.length) {
      // Each feature exists on some printer, but no single printer has them all
      return { impossible: true, reason: `No single printer can do ${wanted.join(' and ')} together. A file is printed on one printer.` };
    }
    const missing = wanted.filter((w) => !everywhere.includes(w));
    return { impossible: true, reason: `None of your printers can do ${missing.join(' and ')}. Switch on a printer that can, in Settings.` };
  }

  const ready = capable.filter((p) => p.status?.online && !exclude.includes(p.id));
  if (!ready.length) {
    const why = capable.map((p) => p.status?.message).find(Boolean);
    return { wait: true, reason: why || 'Your printer is not ready. The job waits until it is.' };
  }

  const bw = !needs.colour;
  const rank = (p) => [bw && p.preferredBw ? 0 : 1, bw && p.caps && !p.caps.color ? 0 : 1, p.isDefault ? 0 : 1, p.name];
  ready.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    return 0;
  });
  return { printer: ready[0] };
}

/** Can any enabled printer ever do every file of the job? Used before taking a job. */
function jobIsPossible(files, printers) {
  for (const f of files) {
    const r = choosePrinter(f, printers.map((p) => ({ ...p, status: { ...p.status, online: true } })));
    if (r.impossible) return { ok: false, reason: r.reason };
  }
  return { ok: true };
}

module.exports = { choosePrinter, jobIsPossible, needsOf };
