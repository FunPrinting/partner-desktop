"use strict";

/**
 * chrome-printer.js — Backwards-compatible shim
 *
 * This file re-exports the public API from the modular src/printer/ modules.
 * The actual implementation lives in:
 *   src/printer/core/      — printerDetection, printerConfig
 *   src/printer/utils/     — execHelper, browserFinder, fileUtils
 *   src/printer/methods/   — chromePrint, sumatraPrint, windowsSpooler, fallbackPrint, mixedColorPrint
 *   src/printer/printFile.js  — file-level print orchestration
 *   src/printer/printJob.js   — top-level job handler
 *
 * Consumers (e.g. chrome-queue.js) can continue to require("./chrome-printer")
 * without any changes.
 */

const { printJob } = require("./src/printer/printJob");
const { checkPrinterStatus } = require("./src/printer/core/printerConfig");
const { printPdfWithChrome } = require("./src/printer/methods/chromePrint");

Object.defineProperty(exports, "__esModule", { value: true });

exports.printJob = printJob;
exports.checkPrinterStatus = checkPrinterStatus;
exports.printPdfWithChrome = printPdfWithChrome;
