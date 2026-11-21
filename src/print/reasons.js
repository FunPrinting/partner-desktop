'use strict';

/**
 * Printer alerts, from IPP printer-state-reasons keywords (CUPS, IPP printers) and the
 * Windows spooler status flags, in words a shop worker understands.
 * `severity`: 'offline' (can't print at all), 'attention' (a person must act), 'info'.
 */
const REASONS = [
  [/^media-(empty|needed)/, 'Out of paper. Load paper in the printer.', 'attention'],
  [/^media-jam/, 'Paper jam. Clear the jam in the printer.', 'attention'],
  [/^(toner|marker-supply|marker-ink-almost)-?(empty|out)/, 'Out of ink or toner.', 'attention'],
  [/^(door|cover|interlock)-open/, 'A printer cover is open.', 'attention'],
  [/^(input-tray|output-tray)-missing/, 'A paper tray is missing.', 'attention'],
  [/^output-area-full/, 'The output tray is full. Remove the printed paper.', 'attention'],
  [/^(offline|shutdown|connecting-to-device|timed-out|printer-restarted|cups-missing-filter)/, 'The printer is offline. Check that it is on and connected.', 'offline'],
  [/^paused/, 'The printer is paused.', 'attention'],
  [/^(toner|marker-supply)-low/, 'Ink or toner is low.', 'info'],
  [/^media-low/, 'Paper is low.', 'info'],
];

/** Strips the "-error"/"-warning"/"-report" suffix and keeps the reason itself. */
const base = (keyword) => String(keyword).replace(/-(error|warning|report)$/, '');

function describeReasons(keywords = []) {
  const out = [];
  for (const k of keywords) {
    if (!k || k === 'none') continue;
    const b = base(k);
    const hit = REASONS.find(([re]) => re.test(b));
    // Unknown "-error" reasons stop printing; unknown warnings are informational
    if (hit) out.push({ keyword: k, message: hit[1], severity: hit[2] });
    else if (/-error$/.test(k)) out.push({ keyword: k, message: `Printer problem: ${b.replace(/-/g, ' ')}.`, severity: 'attention' });
  }
  return out;
}

/** The most serious problem, or null. */
function worstReason(keywords) {
  const all = describeReasons(keywords);
  return all.find((r) => r.severity === 'offline') || all.find((r) => r.severity === 'attention') || null;
}

module.exports = { describeReasons, worstReason };
