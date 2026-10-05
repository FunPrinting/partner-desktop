"use strict";

const { execAsync } = require("../utils/execHelper");
const { getPrinterName } = require("./printerDetection");

// ─── Color Mode Control ────────────────────────────────────────────────

/**
 * Force printer to grayscale mode using Windows PowerShell
 */
async function forceGrayscaleMode(printerName) {
  return _setColorMode(printerName, "Grayscale");
}

/**
 * Force printer to color mode using Windows PowerShell
 */
async function forceColorMode(printerName) {
  return _setColorMode(printerName, "Color");
}

/**
 * Internal: set printer color mode via Set-PrintConfiguration (two methods)
 */
async function _setColorMode(printerName, mode) {
  if (process.platform !== "win32") return true;

  const label = mode === "Grayscale" ? "grayscale" : "color";

  try {
    console.log(
      `🎨 Attempting to force ${label} mode for printer: ${printerName}`
    );

    // Method 1: Direct Set-PrintConfiguration
    const directCmd = `powershell -Command "$printer = Get-Printer -Name '${printerName}' -ErrorAction SilentlyContinue; if ($printer) { Set-PrintConfiguration -PrinterName '${printerName}' -ColorMode ${mode} -ErrorAction SilentlyContinue; if ($?) { Write-Output 'SUCCESS' } else { Write-Output 'FAILED' } } else { Write-Output 'PRINTER_NOT_FOUND' }"`;

    try {
      const { stdout } = await execAsync(directCmd);
      const result = stdout.trim();
      if (result === "SUCCESS") {
        console.log(
          `✅ Successfully set printer to ${label} mode via Set-PrintConfiguration`
        );
        return true;
      } else if (result === "PRINTER_NOT_FOUND") {
        console.warn(
          `⚠️ Printer not found for ${label} configuration: ${printerName}`
        );
      } else {
        console.warn(`⚠️ Set-PrintConfiguration returned: ${result}`);
      }
    } catch (error) {
      console.warn(
        `⚠️ Set-PrintConfiguration failed: ${error.message}`
      );
    }

    // Method 2: COM object approach
    const comCmd = `powershell -Command "$printer = Get-Printer -Name '${printerName}' -ErrorAction SilentlyContinue; if ($printer) { $printerConfig = Get-PrintConfiguration -PrinterName '${printerName}' -ErrorAction SilentlyContinue; if ($printerConfig) { $printerConfig.ColorMode = '${mode}'; Set-PrintConfiguration -InputObject $printerConfig -ErrorAction SilentlyContinue; if ($?) { Write-Output 'SUCCESS' } else { Write-Output 'FAILED' } } else { Write-Output 'NO_CONFIG' } } else { Write-Output 'PRINTER_NOT_FOUND' }"`;

    try {
      const { stdout } = await execAsync(comCmd);
      if (stdout.trim() === "SUCCESS") {
        console.log(
          `✅ Successfully set printer to ${label} mode via COM object`
        );
        return true;
      }
    } catch (error) {
      console.warn(
        `⚠️ COM object ${label} configuration failed: ${error.message}`
      );
    }

    console.warn(
      `⚠️ Could not force ${label} mode via automated methods, will rely on print job settings`
    );
    return false;
  } catch (error) {
    console.warn(`⚠️ Error forcing ${label} mode: ${error.message}`);
    return false;
  }
}

// ─── Default Printer Control ───────────────────────────────────────────

/**
 * Get current default printer name (Windows only)
 */
async function getDefaultPrinter() {
  if (process.platform !== "win32") return null;

  try {
    const { stdout } = await execAsync(
      `powershell -Command "$printer = Get-Printer | Where-Object {$_.Default -eq $true} | Select-Object -First 1; if ($printer) { Write-Output $printer.Name }"`
    );
    const name = stdout.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Set default printer temporarily (Windows only)
 */
async function setDefaultPrinter(printerName) {
  if (process.platform !== "win32") return false;

  try {
    const escaped = printerName
      .replace(/'/g, "''")
      .replace(/"/g, '\\"');
    await execAsync(
      `powershell -Command "rundll32 printui.dll,PrintUIEntry /y /n '${escaped}'"`
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Printer Status ────────────────────────────────────────────────────

/**
 * Check if printer is available and return status info
 */
async function checkPrinterStatus() {
  const printerName = await getPrinterName();

  try {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const isLinux = process.platform === "linux";

    let checkCommand;
    let parseCommand = null;

    if (isWindows) {
      checkCommand = `powershell -Command "Get-Printer -Name '${printerName}' -ErrorAction SilentlyContinue | Select-Object Name, PrinterStatus | Format-List"`;
    } else if (isMac || isLinux) {
      checkCommand = `lpstat -p "${printerName}"`;
      parseCommand = `lpstat -p "${printerName}" -l`;
    } else {
      return { available: false, message: "Unsupported platform" };
    }

    let stdout = "";
    let stderr = "";

    try {
      const result = await execAsync(checkCommand);
      stdout = result.stdout || "";
      stderr = result.stderr || "";
    } catch (error) {
      if (isWindows) {
        // Fallback to wmic
        try {
          const wmicCmd = `wmic printer where name="${printerName}" get name,status`;
          const wmicResult = await execAsync(wmicCmd);
          stdout = wmicResult.stdout || "";
          stderr = wmicResult.stderr || "";
        } catch (wmicError) {
          stderr =
            wmicError.stderr ||
            wmicError.message ||
            error.message ||
            "";
          stdout = error.stdout || "";
        }
      } else {
        stderr = error.stderr || error.message || "";
        stdout = error.stdout || "";
      }
    }

    // Check for errors in stderr
    if (stderr) {
      const stderrLower = stderr.toLowerCase();
      if (
        stderrLower.includes("printer not found") ||
        stderrLower.includes("unable to connect") ||
        stderrLower.includes("no such file or directory")
      ) {
        return {
          available: false,
          message: `Printer not connected: ${printerName}`,
          details:
            "Please check USB connection and ensure printer is powered on",
        };
      }
    }

    // Check if printer was found
    if (!stdout || stdout.trim().length === 0) {
      return {
        available: false,
        message: `Printer not found: ${printerName}`,
        details:
          "Printer may not be installed or connected. Please check USB connection and ensure printer is powered on.",
      };
    }

    const outputLower = stdout.toLowerCase();

    // Check for available status
    if (
      outputLower.includes("normal") ||
      outputLower.includes("idle") ||
      outputLower.includes("printing") ||
      outputLower.includes("ready") ||
      outputLower.includes("online")
    ) {
      if (parseCommand) {
        try {
          const { stdout: details } = await execAsync(parseCommand);
          return {
            available: true,
            message: "Printer is available",
            details: details.trim(),
          };
        } catch {
          // Ignore parse command errors
        }
      }
      return { available: true, message: "Printer is available" };
    }

    // Check for offline/stopped/error status
    if (
      outputLower.includes("offline") ||
      outputLower.includes("stopped") ||
      outputLower.includes("disabled") ||
      outputLower.includes("error") ||
      outputLower.includes("warning")
    ) {
      return {
        available: false,
        message: `Printer is offline: ${printerName}`,
        details:
          "Printer may be powered off or disconnected. Please check power and USB connection.",
      };
    }

    // Status unclear but printer exists
    return {
      available: true,
      message: "Printer is available (status unclear)",
    };
  } catch (error) {
    const errorMessage = error.message || error.stderr || String(error);
    const errorLower = errorMessage.toLowerCase();

    if (
      errorLower.includes("printer not found") ||
      errorLower.includes("unable to connect") ||
      errorLower.includes("no such file or directory") ||
      errorLower.includes("printer does not exist")
    ) {
      return {
        available: false,
        message: `Printer not connected: ${printerName}`,
        details:
          "Please check USB connection and ensure printer is powered on",
      };
    }

    if (
      errorLower.includes("printer is not available") ||
      errorLower.includes("printer is offline")
    ) {
      return {
        available: false,
        message: `Printer is offline: ${printerName}`,
        details:
          "Printer may be powered off. Please turn on the printer.",
      };
    }

    return {
      available: false,
      message:
        error instanceof Error
          ? error.message
          : "Printer check failed",
      details:
        "Unable to determine printer status. Please check printer connection and power.",
    };
  }
}

module.exports = {
  forceGrayscaleMode,
  forceColorMode,
  getDefaultPrinter,
  setDefaultPrinter,
  checkPrinterStatus,
};
