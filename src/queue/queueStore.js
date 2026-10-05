"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const QUEUE_FILE = path.join(
  app ? app.getPath("userData") : process.cwd(),
  "print-queue.json"
);

/**
 * Load queue from file, normalizing legacy formats and resetting stuck jobs
 */
function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];

    const data = fs.readFileSync(QUEUE_FILE, "utf-8");
    let queue = JSON.parse(data).map((item) => {
      // Legacy job from old main.js queue format (no .job wrapper)
      if (!item.job) {
        return {
          id:
            item.id ||
            `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          job: item,
          printerIndex: 0,
          status: "pending",
          attempts: 0,
          createdAt: new Date(),
        };
      }

      return {
        ...item,
        status: item.status || "pending",
        attempts: item.attempts || 0,
        createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
        lastAttemptAt: item.lastAttemptAt
          ? new Date(item.lastAttemptAt)
          : undefined,
        completedAt: item.completedAt
          ? new Date(item.completedAt)
          : undefined,
      };
    });

    // Reset any jobs that were stuck in 'printing' state (server crashed mid-print)
    let resetCount = 0;
    queue.forEach((job) => {
      if (job.status === "printing") {
        job.status = "pending";
        resetCount++;
      }
    });

    if (resetCount > 0) {
      console.log(
        `⚠️ Reset ${resetCount} jobs from 'printing' back to 'pending' (server was restarted mid-print)`
      );
      _writeQueue(queue);
    }

    // Remove completed jobs from in-memory queue
    const activeJobs = queue.filter(
      (j) => j.status === "pending" || j.status === "failed"
    );
    const completedCount = queue.length - activeJobs.length;
    console.log(
      `📋 Loaded queue: ${activeJobs.length} pending jobs (${completedCount} completed jobs cleared)`
    );

    return activeJobs;
  } catch (error) {
    console.error("Error loading queue:", error);
    return [];
  }
}

/**
 * Save queue array to file
 */
function saveQueue(queue) {
  _writeQueue(queue);
}

/**
 * Internal write helper
 */
function _writeQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (error) {
    console.error("Error saving queue:", error);
  }
}

module.exports = { loadQueue, saveQueue };
