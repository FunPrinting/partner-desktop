'use strict';

const { CODES, PrintError } = require('./engine');
const { choosePrinter } = require('./router');
const { prepareFile } = require('./prepare');
const { sendRequest } = require('./sendRequest');
const { trackRuns } = require('./tracker');

/**
 * Prints the files of one job, one file at a time, in order.
 *
 * For each file: download (cached) -> cover sheet (first file only) -> choose a printer ->
 * send the runs -> follow them in the OS queue until the printer has them. Returns the printer
 * used per file, so the shop sees where each file was printed.
 *
 * Failures:
 *  - printer problem (offline, out of paper, driver error): try another capable printer;
 *    if none is ready the file waits (up to `waitTimeoutMs`), then fails.
 *  - other errors: retried with a growing pause, up to `attempts` times.
 *  - bad file or cancelled on this computer: fails at once.
 *  - no enabled printer can ever do the file: fails at once with the reason.
 */
const DEFAULTS = { attempts: 4, backoffMs: 5000, waitTimeoutMs: 30 * 60_000, waitPollMs: 5000 };
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class JobCancelled extends Error {
  constructor() {
    super('The job was taken off this computer');
    this.name = 'JobCancelled';
  }
}

function createRunner({ engine, registry, cache, renderSummary, workDir, onStatus = () => {}, sleep = realSleep, now = Date.now, ...opts }) {
  const cfg = { ...DEFAULTS, ...opts };
  const cancelled = new Set();
  const say = (ctx, state, reason, extra = {}) => onStatus({ jobId: ctx.jobId, fileIndex: ctx.index, fileName: ctx.fileName, state, reason, ...extra });

  const checkCancelled = (ctx) => {
    if (cancelled.has(ctx.jobId)) throw new JobCancelled();
  };

  async function fetchPdf(ctx, file) {
    const url = file.printUrl;
    if (!url) throw Object.assign(new PrintError('The file is still being prepared on the server', CODES.UNKNOWN), { notReady: true });
    try {
      return await cache.get(url);
    } catch (err) {
      throw new PrintError(`Could not download the file: ${err.message}`, err.retryable === false ? CODES.FILE_UNREADABLE : CODES.UNKNOWN);
    }
  }

  async function printOne(ctx, file) {
    say(ctx, 'preparing');
    const cachedPath = await fetchPdf(ctx, file);
    checkCancelled(ctx);

    let summary;
    if (ctx.coverSheet) {
      try {
        summary = await renderSummary(ctx.job, ctx.order);
      } catch {
        summary = undefined; // the order prints without a cover sheet rather than not at all
      }
    }
    const currentPrefs = typeof cfg.getPrefs === 'function' ? cfg.getPrefs() : (cfg.prefs || {});
    const cohesive = Boolean(currentPrefs.cohesiveJobs);
    const reverseOrder = Boolean(currentPrefs.lifoStackOrder);
    const prepared = await prepareFile({ file, cachedPath, workDir, name: `${ctx.jobId}-${ctx.index}`, summary, cohesive, reverseOrder }).catch((err) => {
      throw new PrintError(`The PDF could not be read: ${err.message}`, CODES.FILE_UNREADABLE);
    });

    try {
      const waitStart = now();
      const excluded = [];
      let attempt = 0;
      for (;;) {
        checkCancelled(ctx);
        await registry.refresh().catch(() => undefined);
        const choice = choosePrinter(file, registry.snapshot().printers, { exclude: excluded });
        if (choice.impossible) throw Object.assign(new PrintError(choice.reason, CODES.NEEDS_ATTENTION), { fatal: true });
        if (choice.wait) {
          if (now() - waitStart > cfg.waitTimeoutMs) throw new PrintError(choice.reason, CODES.NEEDS_ATTENTION);
          say(ctx, 'attention', choice.reason);
          excluded.length = 0; // a printer that failed earlier may be back
          await sleep(cfg.waitPollMs);
          continue;
        }
        const target = choice.printer;
        try {
          say(ctx, 'printing', undefined, { printer: target.name });
          const sent = await sendRequest(engine, { printer: target.name, sourcePath: prepared.sourcePath, request: prepared.request, title: `${ctx.job.orderId} ${ctx.job.deliveryNumber || ''}`.trim() });
          await trackRuns(engine, target.name, sent, {
            onUpdate: (u) => say(ctx, u.state === 'ok' ? 'printing' : u.state, u.reason, { printer: target.name }),
            sleep,
            now,
            describePending: () => registry.get(target.id)?.status?.message,
          });
          registry.notePrinted?.(target.name);
          return { printer: target.name, printerId: target.id };
        } catch (err) {
          if (err instanceof JobCancelled) throw err;
          if (!(err instanceof PrintError)) throw err;
          // Anything already queued for this attempt was cancelled by the tracker or sendRequest's caller
          if (err.sent?.length) await Promise.all(err.sent.map((s) => engine.cancel(target.name, s.jobRef).catch(() => undefined)));
          if (!err.retryable) throw err;
          if (err.printerIssue) {
            excluded.push(target.id);
            say(ctx, 'attention', `${target.displayName || target.name}: ${err.message}`);
            continue; // another printer, or wait for this one
          }
          if (++attempt >= cfg.attempts) throw err;
          say(ctx, 'retrying', err.message);
          await sleep(Math.min(cfg.backoffMs * 2 ** (attempt - 1), 60_000));
        }
      }
    } finally {
      await prepared.cleanup();
    }
  }

  /**
   * @param {object} job   server job
   * @param {object} opts  { order, done: number[], coverSheet, onFile(index, result) }
   * @returns {Promise<void>} resolves when every remaining file is printed
   */
  async function runJob(job, { order, done = [], coverSheet = false, onFile = () => {} } = {}) {
    cancelled.delete(job.jobId);
    for (let index = 0; index < job.files.length; index++) {
      if (done.includes(index)) continue;
      const file = job.files[index];
      const ctx = { job, order, jobId: job.jobId, index, fileName: file.name, coverSheet: coverSheet && index === firstUndone(job, done) };
      let result;
      try {
        result = await printOne(ctx, file);
      } catch (err) {
        if (err instanceof JobCancelled) return;
        say(ctx, 'failed', err.message);
        throw err;
      }
      say(ctx, 'done', undefined, { printer: result.printer });
      onFile(index, result);
    }
  }

  // The cover sheet goes on the first file of the order, once (not again when a job resumes)
  const firstUndone = (job, done) => (done.length ? -1 : 0);

  return { runJob, cancel: (jobId) => cancelled.add(jobId) };
}

module.exports = { createRunner, JobCancelled };
