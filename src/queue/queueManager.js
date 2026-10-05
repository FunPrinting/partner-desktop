"use strict";

const { loadQueue, saveQueue } = require("./queueStore");
const { processQueue } = require("./queueProcessor");

// ─── State ─────────────────────────────────────────────────────────────
let printQueue = [];
let isProcessing = false;
let onJobCompleteCallback = null;

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Add job to queue (saved to print-queue.json, picked up by processor)
 */
function addToQueue(job, printerIndex) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const queuedJob = {
    id: jobId,
    job,
    printerIndex,
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
  };

  printQueue.push(queuedJob);
  saveQueue(printQueue);

  console.log(
    `✅ Added job ${jobId} to queue as PENDING transaction (Total: ${printQueue.length} jobs)`
  );
  console.log(
    `📄 Job details: ${job.fileName} (Delivery: ${job.deliveryNumber || "pending"})`
  );
  console.log(
    `💾 Queue saved to print-queue.json - job will wait for printer to be idle`
  );

  // Start processing if not already running
  if (!isProcessing) {
    console.log(`🔄 Starting queue processor...`);
    _startProcessing();
  } else {
    console.log(
      `⏳ Queue processor is already running - job will be processed when printer finishes current work`
    );
  }

  return jobId;
}

/**
 * Get queue status snapshot
 */
function getQueueStatus() {
  const pendingJobs = printQueue.filter((j) => j.status === "pending");
  const printingJob =
    printQueue.find((j) => j.status === "printing") || null;
  return {
    total: printQueue.length,
    pending: pendingJobs.length,
    printing: printingJob ? 1 : 0,
    currentJob: printingJob,
    jobs: [...printQueue],
  };
}

/**
 * Remove a specific job by ID
 */
function removeJob(jobId) {
  const initialLength = printQueue.length;
  printQueue = printQueue.filter(
    (j) =>
      j.id !== jobId && (j.job && j.job.orderId !== jobId)
  );
  if (printQueue.length < initialLength) {
    saveQueue(printQueue);
    console.log(`🗑️ Removed job ${jobId} from queue`);
  }
}

/**
 * Clear entire queue
 */
function clearQueue() {
  printQueue = [];
  saveQueue(printQueue);
  console.log("Queue cleared");
}

/**
 * Register a callback invoked when a job completes successfully
 */
function setOnJobCompleteCallback(callback) {
  onJobCompleteCallback = callback;
}

// ─── Internal ──────────────────────────────────────────────────────────

function _startProcessing() {
  if (isProcessing) return;
  isProcessing = true;
  processQueue(
    printQueue,
    () => onJobCompleteCallback,
    (val) => {
      isProcessing = val;
    }
  );
}

// ─── Startup ───────────────────────────────────────────────────────────

// Load persisted queue on require()
printQueue = loadQueue();

// Auto-resume processing if there are pending jobs
const pendingOnStartup = printQueue.filter(
  (j) => j.status === "pending"
);
if (pendingOnStartup.length > 0) {
  console.log(
    `📋 Found ${pendingOnStartup.length} pending jobs on startup, starting queue processor...`
  );
  _startProcessing();
}

module.exports = {
  addToQueue,
  getQueueStatus,
  clearQueue,
  removeJob,
  setOnJobCompleteCallback,
};
