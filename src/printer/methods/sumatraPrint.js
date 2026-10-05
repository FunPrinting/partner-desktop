"use strict";

const { execAsync } = require("../utils/execHelper");
const {
  forceGrayscaleMode,
  forceColorMode,
} = require("../core/printerConfig");
const { findSumatraPdfPath } = require("../utils/browserFinder");

/**
 * Print PDF using SumatraPDF command-line
 * SumatraPDF provides direct control over print settings and respects printer driver grayscale mode
 */
async function printPdfWithSumatra(
  filePath,
  printerName,
  isMonochrome,
  copies
) {
  if (process.platform !== "win32") {
    throw new Error("SumatraPDF printing only works on Windows");
  }

  const sumatraPath = await findSumatraPdfPath();
  if (!sumatraPath) {
    throw new Error(
      "SumatraPDF not found. Please install SumatraPDF from https://www.sumatrapdfreader.org/download-free-pdf-viewer"
    );
  }

  try {
    console.log(
      `⚡ Using SumatraPDF for optimal printing performance (monochrome=${isMonochrome})`
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

    const escapedPrinterName = printerName.replace(/"/g, '\\"');
    const escapedFilePath = filePath.replace(/"/g, '\\"');

    // Build SumatraPDF command
    let sumatraCmd = `"${sumatraPath}" -print-to "${escapedPrinterName}" -silent`;
    if (isMonochrome) {
      sumatraCmd += ` -print-settings "monochrome"`;
    }
    sumatraCmd += ` "${escapedFilePath}"`;

    console.log(
      `Executing SumatraPDF print command (monochrome=${isMonochrome}, copies=${copies})`
    );

    // Print all copies
    for (let i = 0; i < copies; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      try {
        const { stdout, stderr } = await execAsync(sumatraCmd);
        if (stdout && stdout.trim()) {
          console.log(`SumatraPDF output: ${stdout.trim()}`);
        }
        if (stderr && stderr.trim()) {
          const stderrLower = stderr.toLowerCase();
          if (
            stderrLower.includes("error") &&
            !stderrLower.includes("warning")
          ) {
            throw new Error(`SumatraPDF error: ${stderr.trim()}`);
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
      `✅ SumatraPDF print command completed successfully (${copies} copy/copies)`
    );
    console.log(
      `   Mode: ${isMonochrome ? "Grayscale/B&W (fast mode)" : "Color"}`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`❌ SumatraPDF print error: ${error.message}`);
    throw error;
  }
}

module.exports = { printPdfWithSumatra };
