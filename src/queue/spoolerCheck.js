"use strict";

const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

// Polling constants
const PRINTER_IDLE_POLL_INTERVAL = 5000; // Check every 5 seconds
const PRINTER_IDLE_TIMEOUT = 600000; // Max wait 10 minutes

/**
 * Windows spooler job status filter — only count genuinely active jobs:
 *   Include: Normal, Spooling, Printing, "Printing, Retained"
 *   Exclude: Retained (without Printing/Spooling), Printed, Complete, Deleted
 */
const ACTIVE_FILTER = `$s = $_.JobStatus; $s -ne 'Complete' -and $s -ne 'Deleted' -and $s -ne 'Printed' -and $s -notlike 'Printed*' -and (-not ($s -like '*Retained*' -and $s -notlike '*Printing*' -and $s -notlike '*Spooling*'))`;

/**
 * Check if the printer spooler has any active print jobs.
 * Returns { idle, jobCount, details }
 */
async function isPrinterIdle() {
  try {
    if (process.platform === "win32") {
      return await _checkWindowsSpooler();
    } else {
      return await _checkUnixSpooler();
    }
  } catch (error) {
    console.warn("⚠️ Error checking printer spooler:", error);
    return {
      idle: false,
      jobCount: -1,
      details: "Error checking spooler (treating as busy for safety)",
    };
  }
}

/**
 * Wait for the printer to become idle (no active print jobs in spooler).
 * Polls until idle or timeout.
 */
async function waitForPrinterIdle() {
  console.log(
    "🔍 Checking if printer is idle before sending next job..."
  );
  const startTime = Date.now();
  let checkCount = 0;

  while (true) {
    checkCount++;
    const status = await isPrinterIdle();

    if (status.idle) {
      if (checkCount > 1) {
        console.log(
          `✅ Printer is now idle after ${checkCount} checks (waited ${Math.round((Date.now() - startTime) / 1000)}s)`
        );
      } else {
        console.log(`✅ Printer is idle - ready to accept next job`);
      }
      return;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= PRINTER_IDLE_TIMEOUT) {
      console.warn(
        `⚠️ Printer idle timeout after ${Math.round(elapsed / 1000)}s - proceeding anyway`
      );
      console.warn(
        `   Active jobs in spooler: ${status.jobCount} - ${status.details}`
      );
      return;
    }

    console.log(
      `⏳ Printer is busy (${status.jobCount} jobs in spooler: ${status.details}) - waiting ${PRINTER_IDLE_POLL_INTERVAL / 1000}s... [Check ${checkCount}, elapsed: ${Math.round(elapsed / 1000)}s]`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, PRINTER_IDLE_POLL_INTERVAL)
    );
  }
}

// ─── Private Helpers ───────────────────────────────────────────────────

async function _checkWindowsSpooler() {
  const printerName = process.env.PRINTER_NAME || "";

  // PRIMARY: Query the SPECIFIC printer
  if (printerName) {
    const escapedName = printerName.replace(/'/g, "''");
    const command = `powershell -Command "$jobs = Get-PrintJob -PrinterName '${escapedName}' -ErrorAction SilentlyContinue; if ($jobs) { $active = @($jobs | Where-Object { ${ACTIVE_FILTER} }); Write-Output ('COUNT:' + $active.Count + '|DETAILS:' + (($active | ForEach-Object { $_.DocumentName + '(' + $_.JobStatus + ')' } | Select-Object -First 5) -join ', ')) } else { Write-Output 'COUNT:0|DETAILS:No jobs' }"`;

    try {
      const { stdout } = await execAsync(command, { timeout: 15000 });
      return _parseSpoolerOutput(stdout);
    } catch (specificError) {
      console.warn(
        `⚠️ Failed to query specific printer '${printerName}': ${specificError.message}`
      );
      // Fall through to ALL printers check
    }
  }

  // FALLBACK: Check ALL printers for active jobs
  try {
    const allPrintersCommand = `powershell -Command "$totalActive = 0; $allDetails = @(); Get-Printer -ErrorAction SilentlyContinue | ForEach-Object { $pName = $_.Name; $jobs = Get-PrintJob -PrinterName $pName -ErrorAction SilentlyContinue; if ($jobs) { $active = @($jobs | Where-Object { ${ACTIVE_FILTER} }); if ($active.Count -gt 0) { $totalActive += $active.Count; $active | ForEach-Object { $allDetails += ($_.DocumentName + '(' + $_.JobStatus + ')') } } } }; if ($totalActive -gt 0) { Write-Output ('COUNT:' + $totalActive + '|DETAILS:' + (($allDetails | Select-Object -First 5) -join ', ')) } else { Write-Output 'COUNT:0|DETAILS:No jobs' }"`;
    const { stdout } = await execAsync(allPrintersCommand, {
      timeout: 20000,
    });
    return _parseSpoolerOutput(stdout);
  } catch (allError) {
    console.warn(
      `⚠️ Failed to query all printers: ${allError.message}`
    );
    console.warn(
      "⚠️ Cannot determine printer spooler status - treating as BUSY to prevent overlap"
    );
    return {
      idle: false,
      jobCount: -1,
      details:
        "Could not check spooler (treating as busy for safety)",
    };
  }
}

async function _checkUnixSpooler() {
  try {
    const { stdout } = await execAsync(
      'lpstat -o 2>/dev/null || echo "IDLE"',
      { timeout: 5000 }
    );
    const output = stdout.trim();
    if (output === "IDLE" || output === "") {
      return {
        idle: true,
        jobCount: 0,
        details: "No active print jobs",
      };
    }
    const jobCount = output.split("\n").length;
    return { idle: false, jobCount, details: output };
  } catch {
    return {
      idle: true,
      jobCount: 0,
      details: "Could not check spooler (assuming idle)",
    };
  }
}

function _parseSpoolerOutput(stdout) {
  const output = stdout.trim();
  const countMatch = output.match(/COUNT:(\d+)/);
  const detailsMatch = output.match(/DETAILS:(.*)/);
  const jobCount = countMatch ? parseInt(countMatch[1], 10) : 0;
  const details = detailsMatch ? detailsMatch[1].trim() : "Unknown";
  return { idle: jobCount === 0, jobCount, details };
}

module.exports = { isPrinterIdle, waitForPrinterIdle };
