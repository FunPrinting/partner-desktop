"use strict";

const { execAsync } = require("../utils/execHelper");

/**
 * Fallback print method using rundll32 to set default printer, then print
 */
async function tryFallbackPrintMethod(filePath, printerName, options) {
  console.log(`🔄 Using fallback print method: rundll32 + Start-Process`);

  const escapedPrinterName = printerName.replace(/"/g, '\\"');
  const escapedFilePath = filePath.replace(/"/g, '\\"');

  // Set printer as default using rundll32, then print using Start-Process
  const setDefaultCmd = `rundll32 printui.dll,PrintUIEntry /y /n "${escapedPrinterName}"`;
  const printCmd = `powershell -Command "Start-Process -FilePath '${escapedFilePath}' -Verb Print -WindowStyle Hidden -ErrorAction Stop"`;
  const fallbackCommand = `${setDefaultCmd} && ${printCmd}`;

  console.log(`Executing fallback print command: ${fallbackCommand}`);

  try {
    const { stdout, stderr } = await execAsync(fallbackCommand);

    if (stdout) {
      const stdoutTrimmed = stdout.trim();
      if (stdoutTrimmed) {
        console.log(
          `✅ Fallback print command output: ${stdoutTrimmed}`
        );
      }
    }

    if (stderr) {
      const stderrTrimmed = stderr.trim();
      const stderrLower = stderrTrimmed.toLowerCase();
      if (
        stderrLower.includes("error") ||
        stderrLower.includes("exception") ||
        stderrLower.includes("failed")
      ) {
        console.error(
          `❌ Fallback print command error: ${stderrTrimmed}`
        );
        throw new Error(
          `Fallback print method failed: ${stderrTrimmed}`
        );
      }
      if (stderrTrimmed && !stderrLower.includes("request id")) {
        console.warn("Fallback print command stderr:", stderrTrimmed);
      }
    }

    // Wait for print job to be queued
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (fallbackError) {
    const msg =
      fallbackError.message ||
      fallbackError.stdout ||
      fallbackError.stderr ||
      String(fallbackError);
    console.error(`❌ Fallback print method also failed: ${msg}`);
    throw new Error(
      `Both COM object and fallback print methods failed. Last error: ${msg}`
    );
  }
}

module.exports = { tryFallbackPrintMethod };
