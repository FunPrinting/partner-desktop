/**
 * Print jobs from the web API (/api/partner/v1/jobs, see FunPrinting-Web
 * docs/PRINT_JOBS.md).
 *
 * The app takes one job at a time: it claims the oldest queued job, puts its
 * files in the local print queue, reports "printing" every 2 minutes (keeps the
 * 5-minute lease), and reports "printed" or "failed" when the files are done.
 * Taking one job at a time lets several computers share a shop's queue.
 *
 * The job list is fetched on start-up, on every socket (re)connect, when the
 * socket says jobs:available, and every minute, so an offline period loses nothing.
 * The server is the source of truth: a job that disappears from the active list
 * (cancelled, refunded, taken over) is removed from the local queue.
 *
 * The current job and unsent reports are saved to job-state.json, so a restart
 * resumes the job (after checking it is still ours) and still sends the report.
 */

const fs = require('fs');
const path = require('path');
const { app, Notification } = require('electron');
const session = require('./session');
const queue = require('../queue/queueManager');
const { reportError } = require('./errorReporter');
const prefs = require('./prefs');

const STATE_FILE = path.join(app.getPath('userData'), 'job-state.json');
const POLL_MS = 60_000;
const HEARTBEAT_MS = 2 * 60_000;
const FAILURE_COOLDOWN_MS = 2 * 60_000;

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

// state.current: { job, done: number[], summary?: { orderDetails, customerInfo } }
let state = { current: null, pendingReports: [] };
let running = false; // the current job's files are in the local queue
let serverJobs = [];
let lastSyncAt = null;
let lastError = null;
let syncing = null;
let rerun = false;
let pollTimer = null;
let heartbeatTimer = null;
let cooldownUntil = 0;
let paused = false;
let printerName = null;
const notifiedPending = new Set();
let onChange = () => {};
let onNewOrder = () => {};

// ── State file ─────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    state = {
      current: saved.current && saved.current.job ? { ...saved.current, done: saved.current.done || [] } : null,
      pendingReports: Array.isArray(saved.pendingReports) ? saved.pendingReports : [],
    };
  } catch (err) {
    console.warn('Could not read job-state.json:', err.message);
  }
}

function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('Could not save job-state.json:', err.message);
  }
}

// ── UI snapshot ────────────────────────────────────────────────────────

function snapshot() {
  const cur = state.current;
  return {
    jobs: serverJobs,
    current: cur
      ? {
          jobId: cur.job.jobId,
          orderId: cur.job.orderId,
          deliveryNumber: cur.job.deliveryNumber,
          files: cur.job.files.map((f, i) => ({ name: f.name, done: cur.done.includes(i) })),
        }
      : null,
    deviceId: session.getDeviceId() || null,
    paused,
    printerName,
    cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : null,
    lastSyncAt,
    lastError,
    pendingReports: state.pendingReports.length,
  };
}

function emit() {
  try {
    onChange(snapshot());
  } catch (err) {
    console.error('Job state listener failed:', err);
  }
}

// ── API helpers ────────────────────────────────────────────────────────

function jobPath(jobId) {
  return `/api/partner/v1/jobs/${encodeURIComponent(jobId)}`;
}

function report(jobId, status, error) {
  return session.apiFetch(jobPath(jobId), {
    method: 'POST',
    body: { action: 'report', status, ...(error ? { error: String(error).slice(0, 500) } : {}) },
  });
}

function extensionFor(file) {
  const fromName = path.extname(file.name || '').replace('.', '').toLowerCase();
  if (fromName) return fromName;
  const mime = String(file.mime || '').toLowerCase();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  if (mime && !mime.includes('/')) return mime.replace('.', '');
  try {
    const fromUrl = path.extname(new URL(file.url).pathname).replace('.', '').toLowerCase();
    if (fromUrl) return fromUrl;
  } catch {
    // not a URL we can parse
  }
  return 'pdf';
}

/** One local queue entry per file, in the shape src/printer/printJob.js expects. */
function queueEntryFor(cur, file, index) {
  const ext = extensionFor(file);
  const baseName = file.name || `File ${index + 1}`;
  const isLast = index === cur.job.files.length - 1;
  return {
    jobId: cur.job.jobId,
    fileIndex: index,
    orderId: cur.job.orderId,
    deliveryNumber: cur.job.deliveryNumber,
    fileUrl: file.url,
    fileName: path.extname(baseName) ? baseName : `${baseName}.${ext}`,
    fileType: ext,
    printingOptions: {
      pageSize: file.pageSize || 'A4',
      color: file.color || 'bw',
      sided: file.sided || 'single',
      copies: file.copies || 1,
      pageCount: file.pages,
      // Pages not listed as colour print in B&W
      pageColors: file.color === 'mixed' ? { colorPages: file.colorPages || [], bwPages: [] } : undefined,
    },
    // The order summary sheet prints once, on top of the last file (optional)
    ...(isLast && cur.summary && prefs.get().printSummarySheet ? cur.summary : {}),
  };
}

async function fetchSummary(orderId) {
  try {
    const res = await session.apiFetch(`/api/partner/orders/${encodeURIComponent(orderId)}`);
    const order = res.ok ? res.data.order : null;
    if (!order || !order.customerInfo) return undefined;
    return {
      orderDetails: {
        orderType: order.orderType,
        printingOptions: order.printingOptions,
        pages: order.printingOptions?.pageCount,
        amount: order.amount,
        serviceOptions: order.printingOptions?.serviceOptions,
        expectedDelivery: order.expectedDate,
      },
      customerInfo: { name: order.customerInfo.name, phone: order.customerInfo.phone, email: order.customerInfo.email },
    };
  } catch {
    return undefined;
  }
}

// ── Current job ────────────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    const cur = state.current;
    if (!cur) return stopHeartbeat();
    try {
      const res = await report(cur.job.jobId, 'printing');
      // Cancelled or taken over: let the sync decide what to do
      if (!res.ok && (res.status === 404 || res.status === 409)) sync('heartbeat refused');
    } catch {
      // Offline: the next heartbeat or sync tries again
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function removeLocalFiles(jobId) {
  queue.removeWhere((e) => e.job && e.job.jobId === jobId);
}

/** Put the current job's remaining files in the local queue (once). */
function ensureRunning(serverJob) {
  const cur = state.current;
  cur.job = { ...cur.job, ...serverJob };
  if (running) return;
  running = true;
  cur.job.files.forEach((file, i) => {
    if (!cur.done.includes(i)) queue.addToQueue(queueEntryFor(cur, file, i), 0);
  });
  startHeartbeat();
  saveState();
}

function dropCurrent(reason) {
  const cur = state.current;
  if (!cur) return;
  console.log(`🗑️ Job ${cur.job.jobId} removed from this computer: ${reason}`);
  stopHeartbeat();
  removeLocalFiles(cur.job.jobId);
  state.current = null;
  running = false;
  saveState();
}

async function beginJob(job) {
  if (!Array.isArray(job.files) || job.files.length === 0) {
    await report(job.jobId, 'failed', 'Job has no files').catch(() => undefined);
    return;
  }
  console.log(`📥 Took job ${job.jobId} (${job.files.length} file(s), #${job.deliveryNumber || '-'})`);
  state.current = { job, done: [], summary: await fetchSummary(job.orderId) };
  running = false;
  saveState();
  try {
    await report(job.jobId, 'printing');
  } catch {
    // The heartbeat retries; the claim lease lasts 5 minutes
  }
  ensureRunning(job);
}

/** Make the saved current job match the server's view. */
async function reconcileCurrent() {
  const cur = state.current;
  if (!cur) return;
  const me = session.getDeviceId();
  const sj = serverJobs.find((j) => j.jobId === cur.job.jobId);
  if (!sj) return dropCurrent('no longer active (printed, cancelled or refunded)');
  if ((sj.status === 'claimed' || sj.status === 'printing') && sj.claimedBy === me) return ensureRunning(sj);
  if (sj.status === 'queued' || sj.status === 'failed') {
    // The lease ran out while this computer was away; take it back if nobody else has
    const res = await session.apiFetch(jobPath(sj.jobId), { method: 'POST', body: { action: 'claim' } });
    if (res.ok && res.data.job) return ensureRunning(res.data.job);
  }
  dropCurrent(sj.claimedBy && sj.claimedBy !== me ? 'taken by another device' : `status is ${sj.status}`);
}

function canClaim() {
  return !paused && Boolean(printerName) && Date.now() >= cooldownUntil && Boolean(session.getDeviceId());
}

async function claimNext() {
  if (state.current || !canClaim()) return;
  const res = await session.apiFetch('/api/partner/v1/jobs/claim', { method: 'POST' });
  if (!res.ok) throw new Error(res.data.error || `Could not take a job (${res.status})`);
  if (res.data.job) await beginJob(res.data.job);
}

/** Send saved "printed"/"failed" reports. Stops at the first network/server error. */
async function flushReports() {
  while (state.pendingReports.length) {
    const pr = state.pendingReports[0];
    let res;
    try {
      res = await report(pr.jobId, pr.status, pr.error);
    } catch (err) {
      if (err instanceof session.NotSignedInError) throw err;
      return; // offline: try again on the next sync
    }
    if (!res.ok && (res.status >= 500 || res.status === 429 || res.status === 401)) return;
    state.pendingReports.shift();
    saveState();
    if (!res.ok) {
      // The job is gone (e.g. refunded while printing). Nothing to retry; tell an admin.
      console.warn(`Report "${pr.status}" for ${pr.jobId} refused: ${res.data.error || res.status}`);
      reportError(new Error(`Job report refused: ${res.data.error || res.status}`), {
        level: 'warning',
        context: { jobId: pr.jobId, orderId: pr.orderId, status: pr.status },
      });
      continue;
    }
    console.log(`📤 Reported ${pr.jobId} as ${pr.status}`);
    // Same as the earlier app: pickup orders are marked ready once printed
    if (pr.status === 'printed' && pr.deliveryType === 'pickup' && pr.orderId && prefs.get().autoReadyForPickup) {
      session
        .apiFetch(`/api/partner/orders/${encodeURIComponent(pr.orderId)}`, { method: 'PATCH', body: { status: 'ready_for_pickup' } })
        .catch(() => undefined);
    }
  }
}

function finishCurrent(status, error) {
  const cur = state.current;
  if (!cur) return;
  stopHeartbeat();
  removeLocalFiles(cur.job.jobId);
  state.pendingReports.push({
    jobId: cur.job.jobId,
    orderId: cur.job.orderId,
    deliveryType: cur.job.deliveryType,
    status,
    ...(error ? { error } : {}),
  });
  state.current = null;
  running = false;
  saveState();
  emit();
  sync(`job ${status}`);
}

// ── Local queue hooks ──────────────────────────────────────────────────

function onFileComplete(entry) {
  const j = entry.job || {};
  // "Print again" entries have no job and change nothing on the server
  if (!j.jobId) return;
  const cur = state.current;
  if (!cur || cur.job.jobId !== j.jobId) return;
  if (!cur.done.includes(j.fileIndex)) cur.done.push(j.fileIndex);
  saveState();
  emit();
  if (cur.done.length >= cur.job.files.length) finishCurrent('printed');
}

function onFileFailed(entry, error) {
  const j = entry.job || {};
  reportError(new Error(`Print failed: ${error}`), {
    level: 'warning',
    context: { jobId: j.jobId, orderId: j.orderId, file: j.fileName },
  });
  const cur = state.current;
  if (!j.jobId || !cur || cur.job.jobId !== j.jobId) return;
  // The job goes back to the shop's queue; wait before taking another so a
  // broken printer doesn't burn through jobs
  cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
  setTimeout(() => sync('cooldown over'), FAILURE_COOLDOWN_MS + 1000);
  finishCurrent('failed', error);
}

// ── Notifications for manual-acceptance shops ─────────────────────────

function notifyNewPending() {
  const pending = serverJobs.filter((j) => j.status === 'pending_acceptance');
  for (const j of pending) {
    if (notifiedPending.has(j.jobId)) continue;
    notifiedPending.add(j.jobId);
    onNewOrder(j);
    try {
      if (prefs.get().notifyNewOrders && Notification.isSupported()) {
        new Notification({ title: 'New order to accept', body: `Order ${j.orderId} is waiting for you to accept it.` }).show();
      }
    } catch {
      // notifications are optional
    }
  }
}

// ── Sync ───────────────────────────────────────────────────────────────

async function syncOnce() {
  try {
    await flushReports();
    const res = await session.apiFetch('/api/partner/v1/jobs?scope=active');
    if (!res.ok) throw new Error(res.data.error || `Could not load jobs (${res.status})`);
    serverJobs = Array.isArray(res.data.jobs) ? res.data.jobs : [];
    lastSyncAt = Date.now();
    lastError = null;
    notifyNewPending();
    await reconcileCurrent();
    await claimNext();
  } catch (err) {
    if (err instanceof session.NotSignedInError) return;
    lastError = err.message;
    console.warn(`Job sync failed: ${err.message}`);
  }
}

/** Fetch the job list and act on it. Calls during a sync run one more sync after it. */
function sync(reason = 'sync') {
  if (!session.getDeviceId()) return Promise.resolve();
  if (syncing) {
    rerun = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      rerun = false;
      await syncOnce(reason);
      emit();
    } while (rerun);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// ── Public API ─────────────────────────────────────────────────────────

function init(listener, { newOrder } = {}) {
  onChange = listener || onChange;
  if (newOrder) onNewOrder = newOrder;
  loadState();
  queue.init();
  queue.setHooks({ onComplete: onFileComplete, onFailed: onFileFailed });
  // Nothing prints on start-up by itself. Job files go back in only after the
  // server confirms the job is still this computer's. Entries left by the earlier
  // app version and "Print again" entries are dropped: they may be weeks old, and
  // the order is still listed (and can be printed again) under Manage Orders.
  const leftovers = queue
    .getQueueStatus()
    .jobs.filter((e) => !(e.job && e.job.jobId))
    .map((e) => e.job && e.job.orderId)
    .filter(Boolean);
  if (leftovers.length) console.log(`🧹 Not printing ${leftovers.length} old local queue entr(ies): ${[...new Set(leftovers)].join(', ')}`);
  queue.removeWhere(() => true);
  queue.start();
}

function start() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => sync('poll'), POLL_MS);
  return sync('start');
}

/** Signed out: forget the job locally (its lease runs out on the server). */
function stop() {
  clearInterval(pollTimer);
  pollTimer = null;
  dropCurrent('signed out');
  state.pendingReports = [];
  saveState();
  serverJobs = [];
  emit();
}

/** Before signing out: give the current job back so another device can print it. */
async function releaseCurrent() {
  const cur = state.current;
  if (!cur) return;
  await report(cur.job.jobId, 'release').catch(() => undefined);
  dropCurrent('released');
}

function setPaused(value) {
  paused = Boolean(value);
  queue.setPaused(paused);
  emit();
  if (!paused) sync('resumed');
}

function setPrinter(name) {
  const changed = name !== printerName;
  printerName = name || null;
  if (printerName) process.env.PRINTER_NAME = printerName;
  else delete process.env.PRINTER_NAME;
  emit();
  if (changed && printerName) sync('printer selected');
}

/** accept | reject from the UI (manual-acceptance shops). */
async function jobAction(jobId, action, reason) {
  if (action !== 'accept' && action !== 'reject') throw new Error('Unknown action');
  const res = await session.apiFetch(jobPath(jobId), {
    method: 'POST',
    body: action === 'reject' ? { action, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) } : { action },
  });
  sync(`job ${action}`);
  return { ok: res.ok, error: res.ok ? undefined : res.data.error || `Request failed (${res.status})` };
}

module.exports = { init, start, stop, sync, releaseCurrent, setPaused, setPrinter, jobAction, snapshot };
