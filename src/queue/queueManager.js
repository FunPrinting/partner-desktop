"use strict";

/**
 * Local print queue: one entry per file, printed one at a time, saved to
 * print-queue.json so a restart doesn't lose it.
 *
 * Entries from the job API carry `job.jobId` and `job.fileIndex`; the job sync
 * (src/main/jobSync.js) decides what goes in and is told when each file is done.
 *
 * The queue array is shared with the processor and is only ever mutated in place.
 */

const { loadQueue, saveQueue } = require("./queueStore");
const { processQueue } = require("./queueProcessor");

const printQueue = [];
let isProcessing = false;
let isPaused = false;
let started = false;
const hooks = { onComplete: null, onFailed: null };

function newId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Load the saved queue. Call once at startup, before start(). */
function init() {
  printQueue.splice(0, printQueue.length, ...loadQueue());
  return getQueueStatus();
}

/** Begin processing (and keep processing whatever is added later). */
function start() {
  started = true;
  _kick();
}

function addToQueue(job, printerIndex = 0) {
  const queuedJob = {
    id: newId(),
    job,
    printerIndex,
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
  };
  printQueue.push(queuedJob);
  saveQueue(printQueue);
  console.log(`✅ Queued ${job.fileName} (${printQueue.length} in queue)`);
  _kick();
  return queuedJob.id;
}

function getQueueStatus() {
  const printingJob = printQueue.find((j) => j.status === "printing") || null;
  return {
    total: printQueue.length,
    pending: printQueue.filter((j) => j.status === "pending").length,
    printing: printingJob ? 1 : 0,
    currentJob: printingJob,
    paused: isPaused,
    jobs: [...printQueue],
  };
}

/**
 * Remove entries matching `predicate`. A file that is printing right now can't
 * be stopped; it is marked cancelled so its completion is ignored.
 * Returns the number of entries removed or marked.
 */
function removeWhere(predicate) {
  let count = 0;
  for (let i = printQueue.length - 1; i >= 0; i--) {
    const entry = printQueue[i];
    if (!predicate(entry)) continue;
    count++;
    if (entry.status === "printing") entry.cancelled = true;
    else printQueue.splice(i, 1);
  }
  if (count) saveQueue(printQueue);
  return count;
}

/** Remove by queue entry id or order id (older callers). */
function removeJob(id) {
  return removeWhere((j) => j.id === id || (j.job && j.job.orderId === id));
}

function clearQueue() {
  removeWhere(() => true);
  console.log("Queue cleared");
}

function setPaused(paused) {
  isPaused = Boolean(paused);
  console.log(isPaused ? "⏸️ Queue paused" : "▶️ Queue resumed");
  if (!isPaused) _kick();
}

/** onComplete(entry) after a file printed; onFailed(entry, error) after it gave up. */
function setHooks(next) {
  Object.assign(hooks, next);
}

// Kept for older callers
function setOnJobCompleteCallback(callback) {
  hooks.onComplete = callback ? (entry) => callback(entry.job) : null;
}

function _kick() {
  if (!started || isProcessing || isPaused) return;
  if (!printQueue.some((j) => j.status === "pending")) return;
  isProcessing = true;
  processQueue(printQueue, {
    onComplete: (entry) => hooks.onComplete && hooks.onComplete(entry),
    onFailed: (entry, error) => hooks.onFailed && hooks.onFailed(entry, error),
    isPaused: () => isPaused,
  })
    .catch((err) => console.error("Queue processor crashed:", err))
    .finally(() => {
      isProcessing = false;
      // Something may have been added while the processor was finishing
      _kick();
    });
}

module.exports = {
  init,
  start,
  addToQueue,
  getQueueStatus,
  clearQueue,
  removeJob,
  removeWhere,
  setPaused,
  setHooks,
  setOnJobCompleteCallback,
};
