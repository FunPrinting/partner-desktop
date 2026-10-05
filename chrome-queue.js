"use strict";

/**
 * chrome-queue.js — Backwards-compatible shim
 *
 * The actual implementation lives in:
 *   src/queue/queueStore.js      — load/save queue persistence
 *   src/queue/spoolerCheck.js    — printer spooler idle checking
 *   src/queue/queueProcessor.js  — sequential job processing loop
 *   src/queue/queueManager.js    — public API + state management
 *
 * Consumers (e.g. main.js) can continue to require("./chrome-queue")
 * without any changes.
 */

const {
  addToQueue,
  getQueueStatus,
  clearQueue,
  removeJob,
  setOnJobCompleteCallback,
} = require("./src/queue/queueManager");

Object.defineProperty(exports, "__esModule", { value: true });

exports.addToQueue = addToQueue;
exports.getQueueStatus = getQueueStatus;
exports.clearQueue = clearQueue;
exports.removeJob = removeJob;
exports.setOnJobCompleteCallback = setOnJobCompleteCallback;
