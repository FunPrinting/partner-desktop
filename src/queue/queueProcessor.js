"use strict";

const { printJob } = require("../printer/printJob");
const { generateDeliveryNumber } = require("../../deliveryNumber");
const { waitForPrinterIdle } = require("./spoolerCheck");
const { saveQueue } = require("./queueStore");

const MAX_ATTEMPTS = 5;

/** Whether a print error means the printer itself is unavailable. */
function isPrinterIssue(errorMessage) {
  const lower = String(errorMessage).toLowerCase();
  return (
    lower.includes("printer not connected") ||
    lower.includes("printer is offline") ||
    lower.includes("printer not found") ||
    lower.includes("printer is not available") ||
    lower.includes("unable to initialize device") ||
    lower.includes("powered off")
  );
}

/** Linear backoff, longer for printer problems, at most 5 minutes. */
function retryWaitMs(attempts, errorMessage) {
  const base = isPrinterIssue(errorMessage) ? 30000 : 10000;
  return Math.min(attempts * base, 300000);
}

function removeEntry(printQueue, entry) {
  const idx = printQueue.indexOf(entry);
  if (idx !== -1) printQueue.splice(idx, 1);
  saveQueue(printQueue);
}

/**
 * Prints pending entries one at a time, waiting for the printer to be idle
 * before and after each one. Returns when nothing is pending or the queue is paused.
 *
 * @param {Array} printQueue shared queue array (mutated in place only)
 * @param {{ onComplete: Function, onFailed: Function, isPaused: Function }} hooks
 */
async function processQueue(printQueue, hooks) {
  while (!hooks.isPaused()) {
    const entry = printQueue.find((j) => j.status === "pending");
    if (!entry) break;

    try {
      await waitForPrinterIdle();
    } catch (idleError) {
      console.warn("⚠️ Could not check printer idle state, continuing:", idleError);
    }
    // Removed (cancelled) while we waited
    if (!printQueue.includes(entry) || entry.status !== "pending") continue;

    entry.status = "printing";
    entry.attempts++;
    entry.lastAttemptAt = new Date();
    saveQueue(printQueue);
    console.log(`🖨️ Printing ${entry.job.fileName} (attempt ${entry.attempts}/${MAX_ATTEMPTS})`);

    let errorMessage = null;
    try {
      if (!entry.job.deliveryNumber) {
        entry.job.deliveryNumber = generateDeliveryNumber(entry.printerIndex);
      }
      const result = await printJob(entry.job, entry.printerIndex);
      if (result.success) {
        // Let the spooler pick the job up, then wait until it has finished
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await waitForPrinterIdle();
      } else {
        errorMessage = result.error || result.message || "Unknown error";
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    if (entry.cancelled) {
      console.log(`🛑 ${entry.job.fileName} was cancelled while printing`);
      removeEntry(printQueue, entry);
      continue;
    }

    if (!errorMessage) {
      entry.status = "completed";
      entry.completedAt = new Date();
      removeEntry(printQueue, entry);
      console.log(`✅ Printed ${entry.job.fileName} (${printQueue.length} left in queue)`);
      try {
        hooks.onComplete(entry);
      } catch (err) {
        console.error("Error in onComplete hook:", err);
      }
      continue;
    }

    entry.error = errorMessage;
    console.log(`❌ ${entry.job.fileName} failed (attempt ${entry.attempts}): ${errorMessage}`);
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.status = "failed";
      removeEntry(printQueue, entry);
      try {
        hooks.onFailed(entry, `Gave up after ${MAX_ATTEMPTS} attempts: ${errorMessage}`);
      } catch (err) {
        console.error("Error in onFailed hook:", err);
      }
      continue;
    }

    entry.status = "pending";
    saveQueue(printQueue);
    const waitTime = retryWaitMs(entry.attempts, errorMessage);
    console.log(`⏳ Retrying in ${waitTime / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
}

module.exports = { processQueue, isPrinterIssue, MAX_ATTEMPTS };
