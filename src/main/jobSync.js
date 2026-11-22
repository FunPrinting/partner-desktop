/**
 * Print jobs from the web API (/api/partner/v1/jobs, see FunPrinting-Web
 * docs/PRINT_JOBS.md).
 *
 * The app takes one job at a time: it claims the oldest queued job, prints its
 * files with the print runner (src/print), reports "printing" every 2 minutes (keeps
 * the 5-minute lease), and reports "printed" or "failed" when the files are done.
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
const { jobIsPossible } = require('../print/router');
const { reportError } = require('./errorReporter');
const prefs = require('./prefs');

const STATE_FILE = path.join(app.getPath('userData'), 'job-state.json');
const POLL_MS = 60_000;
const HEARTBEAT_MS = 2 * 60_000;
const FAILURE_COOLDOWN_MS = 2 * 60_000;

// state.current: { job, done: number[], printers: { [fileIndex]: printerName }, order?: partner order (customer, amount) }
let state = { current: null, pendingReports: [] };
let running = false; // the runner is printing the current job
let print = null; // { registry, runner } from src/print/service.js
let activity = ''; // what the runner is doing now, for the Jobs page
let serverJobs = [];
let lastSyncAt = null;
let lastError = null;
let syncing = null;
let rerun = false;
let pollTimer = null;
let heartbeatTimer = null;
let cooldownUntil = 0;
let paused = false;
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
          files: cur.job.files.map((f, i) => ({ name: f.name, done: cur.done.includes(i), printer: cur.printers?.[i] })),
        }
      : null,
    activity,
    deviceId: session.getDeviceId() || null,
    paused,
    printersReady: printersReady(),
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

/** Names of the printers that printed the current job's files, for the shop's records. */
function printersUsed(cur) {
  return [...new Set(Object.values(cur?.printers || {}))].join(', ');
}

function report(jobId, status, error, printer) {
  return session.apiFetch(jobPath(jobId), {
    method: 'POST',
    // The printer name lets the shop see where each order was printed
    body: { action: 'report', status, ...(error ? { error: String(error).slice(0, 500) } : {}), ...(printer ? { printer: String(printer).slice(0, 200) } : {}) },
  });
}

/** The order (customer, amount, due date) for the cover sheet. */
async function fetchOrder(orderId) {
  try {
    const res = await session.apiFetch(`/api/partner/orders/${encodeURIComponent(orderId)}`);
    return res.ok && res.data.order?.customerInfo ? res.data.order : undefined;
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

function stopPrinting(jobId) {
  print?.runner.cancel(jobId);
}

/** Start printing the current job's remaining files (once). */
function ensureRunning(serverJob) {
  const cur = state.current;
  cur.job = { ...cur.job, ...serverJob };
  if (running) return;
  running = true;
  startHeartbeat();
  saveState();
  const { job } = cur;
  print.runner
    .runJob(job, {
      order: cur.order,
      done: cur.done,
      // The cover sheet is printed once, with the first file, when the shop wants it
      coverSheet: prefs.get().printSummarySheet && cur.done.length === 0,
      onFile: (index, result) => onFileComplete(job.jobId, index, result.printer),
    })
    .then(() => {
      // Cancelled (job taken away) leaves the current job cleared by dropCurrent
      if (state.current && state.current.job.jobId === job.jobId && state.current.done.length >= job.files.length) finishCurrent('printed');
    })
    .catch((err) => onJobFailed(job, err));
}

function dropCurrent(reason) {
  const cur = state.current;
  if (!cur) return;
  console.log(`🗑️ Job ${cur.job.jobId} removed from this computer: ${reason}`);
  stopHeartbeat();
  stopPrinting(cur.job.jobId);
  state.current = null;
  running = false;
  activity = '';
  saveState();
}

async function beginJob(job) {
  if (!Array.isArray(job.files) || job.files.length === 0) {
    await report(job.jobId, 'failed', 'Job has no files').catch(() => undefined);
    return;
  }
  console.log(`📥 Took job ${job.jobId} (${job.files.length} file(s), #${job.deliveryNumber || '-'})`);
  state.current = { job, done: [], printers: {}, order: await fetchOrder(job.orderId) };
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

/** At least one printer is switched on and ready. */
function printersReady() {
  return Boolean(print && print.registry.usable().length);
}

function canClaim() {
  return !paused && printersReady() && Date.now() >= cooldownUntil && Boolean(session.getDeviceId());
}

async function claimNext() {
  if (state.current || !canClaim()) return;
  const res = await session.apiFetch('/api/partner/v1/jobs/claim', { method: 'POST' });
  if (!res.ok) throw new Error(res.data.error || `Could not take a job (${res.status})`);
  if (!res.data.job) return;
  // Never keep a job this shop's printers can't print (for example colour with only a B&W printer):
  // give it back at once, so another computer can take it, and say why
  const check = jobIsPossible(res.data.job.files || [], print.registry.snapshot().printers);
  if (!check.ok) {
    await report(res.data.job.jobId, 'release', check.reason).catch(() => undefined);
    lastError = `Order ${res.data.job.orderId} was given back: ${check.reason}`;
    cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    setTimeout(() => sync('cooldown over'), FAILURE_COOLDOWN_MS + 1000);
    reportError(new Error(`Job given back: ${check.reason}`), { level: 'warning', context: { jobId: res.data.job.jobId, orderId: res.data.job.orderId } });
    return;
  }
  await beginJob(res.data.job);
}

/** Send saved "printed"/"failed" reports. Stops at the first network/server error. */
async function flushReports() {
  while (state.pendingReports.length) {
    const pr = state.pendingReports[0];
    let res;
    try {
      res = await report(pr.jobId, pr.status, pr.error, pr.printer);
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
  state.pendingReports.push({
    jobId: cur.job.jobId,
    orderId: cur.job.orderId,
    deliveryType: cur.job.deliveryType,
    status,
    printer: printersUsed(cur),
    ...(error ? { error } : {}),
  });
  state.current = null;
  running = false;
  activity = '';
  saveState();
  emit();
  sync(`job ${status}`);
}

// ── Print runner hooks ─────────────────────────────────────────────────

function onFileComplete(jobId, index, printer) {
  const cur = state.current;
  if (!cur || cur.job.jobId !== jobId) return;
  if (!cur.done.includes(index)) cur.done.push(index);
  cur.printers = { ...(cur.printers || {}), [index]: printer };
  saveState();
  emit();
}

function onJobFailed(job, err) {
  const cur = state.current;
  if (!cur || cur.job.jobId !== job.jobId) return;
  const message = err?.message || String(err);
  reportError(err instanceof Error ? err : new Error(message), {
    level: 'warning',
    context: { jobId: job.jobId, orderId: job.orderId, code: err?.code },
  });
  // The job goes back to the shop's queue; wait before taking another so a
  // broken printer doesn't burn through jobs
  cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
  setTimeout(() => sync('cooldown over'), FAILURE_COOLDOWN_MS + 1000);
  lastError = message;
  finishCurrent('failed', message);
}

/** Progress from the runner (preparing / printing / waiting for the printer…). */
function onRunnerStatus(e) {
  if (e.status !== undefined) activity = e.status;
  emit();
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

function init(listener, { newOrder, printService } = {}) {
  onChange = listener || onChange;
  if (newOrder) onNewOrder = newOrder;
  print = printService;
  loadState();
  print.registry.events.on('changed', () => {
    emit();
    // A printer coming back (or being switched on) may unblock waiting jobs
    if (printersReady()) sync('printers changed');
  });
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
  emit();
  if (!paused) sync('resumed');
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

module.exports = { init, start, stop, sync, releaseCurrent, setPaused, jobAction, snapshot, onRunnerStatus };
