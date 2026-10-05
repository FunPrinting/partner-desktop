"use strict";

const { printJob } = require("../printer/printJob");
const { generateDeliveryNumber } = require("../../deliveryNumber");
const { waitForPrinterIdle } = require("./spoolerCheck");
const { saveQueue } = require("./queueStore");

/**
 * Classify whether a print error is a printer-hardware issue
 */
function _isPrinterIssue(errorMessage) {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes("printer not connected") ||
    lower.includes("printer is offline") ||
    lower.includes("printer not found") ||
    lower.includes("unable to initialize device") ||
    lower.includes("powered off")
  );
}

/**
 * Calculate retry wait time with exponential backoff (max 5 minutes)
 */
function _retryWaitMs(attempts, errorMessage) {
  const base = _isPrinterIssue(errorMessage) ? 30000 : 10000;
  return Math.min(attempts * base, 300000);
}

/**
 * Process queue sequentially — waits for printer to be fully idle between jobs.
 *
 * Each job is a "transaction":
 *   1. Status → 'printing', saved to file
 *   2. Wait for printer spooler idle
 *   3. Send job to printer
 *   4. Wait for printer to finish physically
 *   5. Status → 'completed', removed from queue
 *
 * @param {Array} printQueue  — mutable queue array (shared with queueManager)
 * @param {Function} getCallback — returns the current onJobComplete callback (or null)
 * @param {Function} setProcessing — setter for the isProcessing flag
 */
async function processQueue(printQueue, getCallback, setProcessing) {
  console.log(
    "🖨️ Queue processor started - will process jobs one at a time, waiting for printer idle between jobs"
  );

  while (printQueue.length > 0) {
    // Find first pending job
    const queuedJob = printQueue.find((j) => j.status === "pending");
    if (!queuedJob) {
      // No pending jobs left — clean up and exit
      const remaining = printQueue.filter(
        (j) => j.status === "pending"
      );
      printQueue.length = 0;
      remaining.forEach((j) => printQueue.push(j));
      saveQueue(printQueue);
      break;
    }

    // STEP 1: Wait for printer idle
    try {
      await waitForPrinterIdle();
    } catch (idleError) {
      console.warn(
        `⚠️ Error waiting for printer idle, proceeding anyway:`,
        idleError
      );
    }

    // STEP 2: Mark as 'printing'
    queuedJob.status = "printing";
    queuedJob.attempts++;
    queuedJob.lastAttemptAt = new Date();
    saveQueue(printQueue);

    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `🖨️ PRINTING JOB: ${queuedJob.id} (Attempt ${queuedJob.attempts})`
    );
    console.log(`📄 File: ${queuedJob.job.fileName}`);
    console.log(
      `📋 Delivery: ${queuedJob.job.deliveryNumber || "pending"}`
    );
    console.log(
      `📊 Queue position: 1 of ${printQueue.filter((j) => j.status === "pending").length + 1} jobs`
    );
    console.log(`${"=".repeat(60)}\n`);

    try {
      // Generate delivery number if not present
      if (!queuedJob.job.deliveryNumber) {
        queuedJob.job.deliveryNumber = generateDeliveryNumber(
          queuedJob.printerIndex
        );
      }

      // STEP 3: Send to printer
      const result = await printJob(
        queuedJob.job,
        queuedJob.printerIndex
      );

      if (result.success) {
        // STEP 4: Wait for printer to finish physically
        console.log(
          `⏳ Job sent to printer successfully. Waiting for printer to finish physically printing...`
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await waitForPrinterIdle();

        // STEP 5: Mark completed & remove
        queuedJob.status = "completed";
        queuedJob.completedAt = new Date();
        const idx = printQueue.findIndex(
          (j) => j.id === queuedJob.id
        );
        if (idx !== -1) printQueue.splice(idx, 1);
        saveQueue(printQueue);

        console.log(
          `\n✅ Job ${queuedJob.id} COMPLETED successfully`
        );
        console.log(`📄 File: ${queuedJob.job.fileName}`);
        console.log(
          `📋 Remaining jobs in queue: ${printQueue.length}`
        );
        console.log(`${"─".repeat(60)}\n`);

        const cb = getCallback();
        if (cb) {
          try {
            cb(queuedJob.job);
          } catch (err) {
            console.error("Error in onJobCompleteCallback:", err);
          }
        }
      } else {
        await _handleJobFailure(
          queuedJob,
          result.error || result.message || "Unknown error",
          printQueue
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `❌ Error processing job ${queuedJob.id}:`,
        errorMessage
      );
      await _handleJobFailure(queuedJob, errorMessage, printQueue);
    }
  }

  setProcessing(false);
  console.log(
    "🏁 Queue processor finished - all jobs processed"
  );
}

/**
 * Handle a failed job — retry or mark permanently failed
 */
async function _handleJobFailure(queuedJob, errorMessage, printQueue) {
  if (queuedJob.attempts >= 10) {
    queuedJob.status = "failed";
    queuedJob.error = `Max retries (10) reached. Last error: ${errorMessage}`;
    saveQueue(printQueue);
    console.log(
      `❌ Job ${queuedJob.id} FAILED PERMANENTLY (Max 10 attempts reached): ${errorMessage}`
    );
  } else {
    queuedJob.status = "pending";
    queuedJob.error = errorMessage;
    saveQueue(printQueue);
    console.log(
      `❌ Job ${queuedJob.id} FAILED (Attempt ${queuedJob.attempts}): ${errorMessage}`
    );
    console.log(`📋 Job will be retried.`);
  }

  if (_isPrinterIssue(errorMessage)) {
    console.warn(`⚠️ Printer issue detected: ${errorMessage}`);
    console.warn(
      `⚠️ Job ${queuedJob.id} will be retried when printer is available`
    );
  }

  const waitTime = _retryWaitMs(queuedJob.attempts, errorMessage);
  console.log(`⏳ Waiting ${waitTime / 1000}s before retry...`);
  await new Promise((resolve) => setTimeout(resolve, waitTime));
}

module.exports = { processQueue };
