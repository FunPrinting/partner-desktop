"use strict";

const { execAsync } = require("../utils/execHelper");
const {
  forceGrayscaleMode,
  forceColorMode,
} = require("../core/printerConfig");

/**
 * Print PDF using Windows print spooler API directly (fastest method)
 * Bypasses application rendering and sends PDF directly to printer driver
 */
async function printPdfWithWindowsSpooler(
  filePath,
  printerName,
  isMonochrome,
  copies
) {
  if (process.platform !== "win32") {
    throw new Error("Windows print spooler only works on Windows");
  }

  try {
    console.log(
      `⚡ Using Windows print spooler API for fastest printing (monochrome=${isMonochrome})`
    );

    // Force printer driver to appropriate mode BEFORE printing
    if (isMonochrome) {
      console.log(
        `🎨 Forcing printer driver to grayscale mode before printing...`
      );
      await forceGrayscaleMode(printerName);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      console.log(
        `🎨 Forcing printer driver to color mode before printing...`
      );
      await forceColorMode(printerName);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const escapedPrinterName = printerName
      .replace(/'/g, "''")
      .replace(/"/g, '\\"');
    const escapedFilePath = filePath
      .replace(/'/g, "''")
      .replace(/\\/g, "\\\\");

    // Build print command
    let printCmd = `powershell -Command "$ErrorActionPreference = 'Stop'; `;
    if (isMonochrome) {
      printCmd += `try { Set-PrintConfiguration -PrinterName '${escapedPrinterName}' -ColorMode Grayscale -ErrorAction SilentlyContinue | Out-Null } catch {}; `;
    } else {
      printCmd += `try { Set-PrintConfiguration -PrinterName '${escapedPrinterName}' -ColorMode Color -ErrorAction SilentlyContinue | Out-Null } catch {}; `;
    }
    printCmd += `$proc = Start-Process -FilePath '${escapedFilePath}' -Verb Print -WindowStyle Hidden -PassThru -ErrorAction Stop; `;
    printCmd += `Start-Sleep -Seconds 1; `;
    printCmd += `if (-not $proc.HasExited) { Write-Host 'Print job queued' } else { Write-Host 'Print process completed' }"`;

    console.log(
      `Executing Windows print spooler command (monochrome=${isMonochrome}, copies=${copies})`
    );
    console.log(
      `   Printer driver is in ${isMonochrome ? "grayscale mode for fast B&W printing" : "color mode"}`
    );

    // Print all copies
    for (let i = 0; i < copies; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      try {
        const { stdout, stderr } = await execAsync(printCmd);
        if (stdout && stdout.trim()) {
          console.log(`Print spooler output: ${stdout.trim()}`);
        }
        if (stderr && !stderr.includes("request id")) {
          const stderrLower = stderr.toLowerCase();
          if (
            stderrLower.includes("error") ||
            stderrLower.includes("exception")
          ) {
            if (i === 0) {
              throw new Error(
                `Windows print spooler error: ${stderr.trim()}`
              );
            }
            console.warn(
              `⚠️ Failed to print copy ${i + 1}: ${stderr.trim()}`
            );
          }
        }
      } catch (error) {
        if (i === 0) throw error;
        console.warn(
          `⚠️ Failed to print copy ${i + 1}: ${error.message}`
        );
      }
    }

    console.log(
      `✅ Windows print spooler command completed successfully (${copies} copy/copies)`
    );
    console.log(
      `   Mode: ${isMonochrome ? "Grayscale/B&W (fast mode - direct spooler)" : "Color"}`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(
      `❌ Windows print spooler error: ${error.message}`
    );
    throw error;
  }
}

module.exports = { printPdfWithWindowsSpooler };
