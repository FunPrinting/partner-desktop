/**
 * IPC between the windows and the main process.
 *
 * Tokens stay in the main process: the windows call the web API through
 * 'api:request', which only allows the partner API paths.
 */

const { ipcMain } = require('electron');
const session = require('./session');
const jobSync = require('./jobSync');
const queue = require('../queue/queueManager');
const { openOrderWindow } = require('./orderWindow');
const { checkForUpdates } = require('./updater');
const { reportError } = require('./errorReporter');

const API_PATH = /^\/api\/partner\/[A-Za-z0-9/_.?=&%-]*$/;
const API_METHODS = new Set(['GET', 'POST', 'PATCH']);

/** Only our own pages (loaded from disk) may use the IPC API. */
function fromApp(event) {
  const url = event.senderFrame?.url || '';
  return url.startsWith('file://');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromApp(event)) throw new Error('Not allowed');
    return fn(...args);
  });
}

function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!fromApp(event)) return;
    fn(...args);
  });
}

function registerIpcHandlers(getMainWindow, { onSignedIn }) {
  // ── Session ──────────────────────────────────────────────────────────

  handle('session:get', () => session.publicState());

  handle('session:sign-in', async () => {
    try {
      const state = await session.signIn();
      onSignedIn();
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('session:sign-out', async () => {
    await jobSync.releaseCurrent();
    await session.signOut();
    return { ok: true };
  });

  // ── Web API proxy ────────────────────────────────────────────────────

  handle('api:request', async (req) => {
    const method = String(req?.method || 'GET').toUpperCase();
    const path = String(req?.path || '');
    if (!API_METHODS.has(method) || !API_PATH.test(path) || path.includes('..')) {
      return { ok: false, status: 400, data: { error: 'Request not allowed' } };
    }
    try {
      return await session.apiFetch(path, { method, body: req.body });
    } catch (err) {
      if (err instanceof session.NotSignedInError) return { ok: false, status: 401, data: { error: 'Not signed in' } };
      return { ok: false, status: 0, data: { error: 'Network error. Check your internet connection.' } };
    }
  });

  // ── Jobs ─────────────────────────────────────────────────────────────

  handle('jobs:get', () => jobSync.snapshot());
  handle('jobs:sync', () => jobSync.sync('manual').then(() => jobSync.snapshot()));
  handle('jobs:action', async ({ jobId, action, reason } = {}) => {
    if (typeof jobId !== 'string' || !jobId) return { ok: false, error: 'Missing job' };
    try {
      return await jobSync.jobAction(jobId, action, reason);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('jobs:set-paused', (paused) => {
    jobSync.setPaused(Boolean(paused));
    return jobSync.snapshot();
  });

  // ── Local queue ──────────────────────────────────────────────────────

  handle('queue:get', () =>
    queue.getQueueStatus().jobs.map((e) => ({
      id: e.id,
      jobId: e.job?.jobId,
      orderId: e.job?.orderId,
      fileName: e.job?.fileName,
      status: e.status,
      attempts: e.attempts,
      error: e.error,
    }))
  );

  // Print an order's files again on this computer (no job status change)
  handle('queue:print-again', (order) => {
    const urls = Array.isArray(order?.fileURLs) && order.fileURLs.length ? order.fileURLs : order?.fileURL ? [order.fileURL] : [];
    const safe = urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (!safe.length) return { ok: false, error: 'This order has no files' };
    const opts = order.printingOptions || {};
    safe.forEach((url, i) => {
      const fo = opts.fileOptions?.[i] || {};
      queue.addToQueue(
        {
          localOnly: true,
          orderId: String(order.orderId || ''),
          fileUrl: url,
          fileName: String(order.originalFileNames?.[i] || order.originalFileName || `File ${i + 1}`).slice(0, 200),
          fileType: String(order.fileTypes?.[i] || order.fileType || 'pdf').split('/').pop(),
          printingOptions: {
            pageSize: fo.pageSize || opts.pageSize || 'A4',
            color: fo.color || opts.color || 'bw',
            sided: fo.sided || opts.sided || 'single',
            copies: fo.copies || opts.copies || 1,
          },
        },
        0
      );
    });
    return { ok: true, files: safe.length };
  });

  // ── Printers ─────────────────────────────────────────────────────────

  handle('printers:list', async () => {
    const win = getMainWindow();
    return win ? win.webContents.getPrintersAsync() : [];
  });

  on('printers:set-active', (printerName) => {
    jobSync.setPrinter(typeof printerName === 'string' ? printerName : null);
    console.log(`🖨️ Active printer: ${printerName}`);
  });

  // ── Windows, updates, errors ────────────────────────────────────────

  on('open-order-window', (order) => {
    if (order && typeof order.orderId === 'string') openOrderWindow(order);
  });

  on('check-updates', () => checkForUpdates(getMainWindow));

  on('report-error', (report) => {
    if (!report || typeof report.message !== 'string') return;
    const err = new Error(report.message.slice(0, 5000));
    err.name = typeof report.name === 'string' ? report.name.slice(0, 200) : 'RendererError';
    if (typeof report.stack === 'string') err.stack = report.stack.slice(0, 20000);
    reportError(err, { context: { kind: 'renderer', url: String(report.url || '').slice(0, 300) } });
  });

  handle('clear-data', async () => {
    await jobSync.releaseCurrent();
    await session.signOut();
    queue.clearQueue();
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
