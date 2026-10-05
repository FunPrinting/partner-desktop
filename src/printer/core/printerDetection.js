"use strict";

const { execAsync } = require("../utils/execHelper");

// Cache for detected printer name
let detectedPrinterName = null;
let lastPrinterDetection = 0;
const PRINTER_DETECTION_CACHE_MS = 60000; // Cache for 1 minute

/**
 * Detect available printers automatically
 */
async function detectPrinter() {
  const now = Date.now();

  // Return cached printer if still valid
  if (
    detectedPrinterName &&
    now - lastPrinterDetection < PRINTER_DETECTION_CACHE_MS
  ) {
    return detectedPrinterName;
  }

  try {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const isLinux = process.platform === "linux";

    if (isWindows) {
      const result = await detectWindowsPrinter(now);
      if (result) return result;
    } else if (isMac || isLinux) {
      const result = await detectUnixPrinter(now);
      if (result) return result;
    }
  } catch (error) {
    console.error("Error detecting printer:", error);
  }

  return null;
}

/**
 * Detect printer on Windows using PowerShell / wmic fallbacks
 */
async function detectWindowsPrinter(now) {
  const strategies = [
    // Strategy 1: Default printer via Get-Printer
    {
      cmd: `powershell -Command "$printer = Get-Printer | Where-Object {$_.Default -eq $true} | Select-Object -First 1; if ($printer) { Write-Output $printer.Name }"`,
      label: "default",
      reject: ["Get-Printer", "Where-Object"],
    },
    // Strategy 2: First available printer
    {
      cmd: `powershell -Command "$printer = Get-Printer | Select-Object -First 1; if ($printer) { Write-Output $printer.Name }"`,
      label: "available",
      reject: ["Get-Printer", "Select-Object"],
    },
    // Strategy 3: ForEach-Object pipe
    {
      cmd: `powershell -Command "Get-Printer | Select-Object -First 1 | ForEach-Object { Write-Output $_.Name }"`,
      label: "list",
      reject: ["Get-Printer", "ForEach-Object"],
    },
    // Strategy 4: Simplest form
    {
      cmd: `powershell -Command "(Get-Printer).Name | Select-Object -First 1"`,
      label: "simple",
      reject: ["Get-Printer", "Select-Object"],
    },
  ];

  for (const strategy of strategies) {
    try {
      const { stdout } = await execAsync(strategy.cmd);
      const printerName = stdout.trim();
      console.log(
        `🔍 ${strategy.label} printer detection result: "${printerName}"`
      );

      if (
        printerName &&
        printerName.length > 0 &&
        !strategy.reject.some((r) => printerName.includes(r))
      ) {
        detectedPrinterName = printerName;
        lastPrinterDetection = now;
        console.log(
          `✅ Auto-detected printer (${strategy.label}): ${printerName}`
        );
        return printerName;
      }
    } catch (err) {
      console.log(
        `⚠️ ${strategy.label} printer detection failed: ${err.message}`
      );
    }
  }

  // wmic fallback
  return detectWindowsPrinterWmic(now);
}

/**
 * Fallback detection using wmic (older Windows)
 */
async function detectWindowsPrinterWmic(now) {
  try {
    const wmicCmd = `wmic printer where "Default='TRUE'" get Name /value | findstr "Name="`;
    const { stdout } = await execAsync(wmicCmd);
    const match = stdout.match(/Name=(.+)/);
    if (match && match[1]) {
      const printerName = match[1].trim();
      detectedPrinterName = printerName;
      lastPrinterDetection = now;
      console.log(`✅ Auto-detected printer (wmic): ${printerName}`);
      return printerName;
    }
  } catch {
    // Try listing all printers
    try {
      const wmicListCmd = `wmic printer get Name /value | findstr "Name=" | findstr /v "Name="`;
      const { stdout } = await execAsync(wmicListCmd);
      const lines = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0);
      if (lines.length > 0) {
        const printerName = lines[0].replace("Name=", "").trim();
        detectedPrinterName = printerName;
        lastPrinterDetection = now;
        console.log(
          `✅ Auto-detected printer (wmic list): ${printerName}`
        );
        return printerName;
      }
    } catch {
      console.warn("⚠️ Could not detect printer automatically");
    }
  }
  return null;
}

/**
 * Detect printer on macOS / Linux using lpstat
 */
async function detectUnixPrinter(now) {
  try {
    const { stdout } = await execAsync(
      `lpstat -p 2>/dev/null | head -1 | awk '{print $2}' | sed 's/^printer //'`
    );
    const printerName = stdout.trim();
    if (printerName && printerName.length > 0) {
      detectedPrinterName = printerName;
      lastPrinterDetection = now;
      console.log(`✅ Auto-detected printer: ${printerName}`);
      return printerName;
    }
  } catch {
    try {
      const { stdout } = await execAsync(
        `lpstat -a 2>/dev/null | head -1 | awk '{print $1}'`
      );
      const printerName = stdout.trim();
      if (printerName && printerName.length > 0) {
        detectedPrinterName = printerName;
        lastPrinterDetection = now;
        console.log(
          `✅ Auto-detected printer (lpstat -a): ${printerName}`
        );
        return printerName;
      }
    } catch {
      console.warn("⚠️ Could not detect printer automatically");
    }
  }
  return null;
}

/**
 * Get printer name (from env, detected, or default)
 */
async function getPrinterName() {
  if (process.env.PRINTER_NAME) {
    console.log(
      `🖨️ Using printer from environment: ${process.env.PRINTER_NAME}`
    );
    return process.env.PRINTER_NAME;
  }

  console.log(
    "🔍 No PRINTER_NAME in environment, attempting auto-detection..."
  );
  const detected = await detectPrinter();
  if (detected) {
    console.log(`✅ Using auto-detected printer: ${detected}`);
    return detected;
  }

  console.log(`⚠️ No printer detected, using default: HP_Deskjet_525`);
  return "HP_Deskjet_525";
}

module.exports = { detectPrinter, getPrinterName };
