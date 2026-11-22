'use strict';

const { CODES, PrintError } = require('./engine');

/**
 * Follows print runs in the OS queue until they finish. "Printed" is reported only after
 * this resolves, so a job that is stuck (no paper, offline) or deleted is never reported as done.
 *
 * Resolves when every run has completed. Rejects with a PrintError when a run fails, is
 * cancelled on this computer, waits on the printer longer than `attentionTimeoutMs`, or the
 * whole file takes longer than `timeoutMs`. `onUpdate` receives progress and attention
 * messages ({ state: 'printing' | 'attention' | 'ok', reason }) for the UI.
 *
 * Runs already queued when something fails are cancelled, so a failed file never prints
 * half of itself later.
 */
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

async function trackRuns(engine, printer, sent, opts = {}) {
  const {
    onUpdate = () => {},
    pollMs = 1000,
    timeoutMs = 15 * 60_000,
    attentionTimeoutMs = 20 * 60_000,
    unknownPolls = 3,
    describePending,
    sleep = sleepReal,
    now = Date.now,
  } = opts;
  const started = now();
  const done = new Set();
  const unknown = new Map();
  let attentionSince = null;
  let lastNote = null;

  const note = (state, reason) => {
    const key = `${state}|${reason || ''}`;
    if (key !== lastNote) {
      lastNote = key;
      onUpdate({ state, reason });
    }
  };

  const abort = async (err) => {
    await Promise.all(sent.filter((s) => !done.has(s.jobRef)).map((s) => engine.cancel(printer, s.jobRef).catch(() => undefined)));
    throw err;
  };

  while (done.size < sent.length) {
    if (now() - started > timeoutMs) {
      return abort(new PrintError('The printer took too long to print this file.', CODES.TIMEOUT));
    }
    let needsAttention = null;
    let anyPrinting = false;
    for (const s of sent) {
      if (done.has(s.jobRef)) continue;
      let st;
      try {
        st = await engine.jobStatus(printer, s.jobRef);
      } catch (err) {
        // The print system may be restarting; keep trying until the timeout
        note('attention', `Can't read the print queue: ${err.message}`);
        continue;
      }
      if (st.state === 'completed') {
        done.add(s.jobRef);
        unknown.delete(s.jobRef);
      } else if (st.state === 'failed') {
        return abort(new PrintError(st.reason || 'The printer could not print this file.', st.cancelled ? CODES.CANCELLED : CODES.DRIVER_FAILED));
      } else if (st.state === 'unknown') {
        // Finished jobs can be purged from the queue history before we look
        const n = (unknown.get(s.jobRef) || 0) + 1;
        unknown.set(s.jobRef, n);
        if (n >= unknownPolls) done.add(s.jobRef);
      } else if (st.state === 'held') {
        needsAttention = st.reason || 'The printer needs attention.';
      } else {
        unknown.delete(s.jobRef);
        if (st.state === 'printing') anyPrinting = true;
      }
    }
    if (done.size >= sent.length) break;

    if (needsAttention) {
      attentionSince ??= now();
      note('attention', needsAttention);
      if (now() - attentionSince > attentionTimeoutMs) {
        return abort(new PrintError(needsAttention, CODES.NEEDS_ATTENTION));
      }
    } else {
      attentionSince = null;
      if (anyPrinting) note('printing');
      else if (describePending && now() - started > 45_000) {
        // Waiting a long time without printing: the printer may be off or out of paper
        const why = await Promise.resolve(describePending()).catch(() => null);
        if (why) note('attention', why);
      }
    }
    await sleep(pollMs);
  }
  note('ok');
  return { runs: sent.length };
}

module.exports = { trackRuns };
