"use strict";

const fs = require("fs");
const path = require("path");
const { execAsync } = require("./utils/execHelper");
const { getPrinterName } = require("./core/printerDetection");
const { checkPrinterStatus } = require("./core/printerConfig");
const { convertWordToPdf, normalizePageColors } = require("./utils/fileUtils");
const { printPdfWithChrome } = require("./methods/chromePrint");
const { printPdfWithSumatra } = require("./methods/sumatraPrint");
const {
  printPdfWithWindowsSpooler,
} = require("./methods/windowsSpooler");
const {
  tryFallbackPrintMethod,
} = require("./methods/fallbackPrint");
const {
  printPdfWithMixedColorInSequence,
} = require("./methods/mixedColorPrint");

// ─── Reusable cascade helper ──────────────────────────────────────────

/**
 * Try printing with cascade: Chrome → SumatraPDF → Windows spooler
 * Throws only if all three methods fail.
 */
async function printWithCascade(
  filePath,
  printerName,
  isMonochrome,
  copies,
  label = ""
) {
  try {
    await printPdfWithChrome(filePath, printerName, isMonochrome, copies);
    console.log(
      `✅ Print job sent successfully using Chrome${label ? ` (${label})` : ""}`
    );
    return;
  } catch (chromeErr) {
    console.warn(`⚠️ Chrome failed: ${chromeErr.message}`);
    console.log(`🔄 Falling back to SumatraPDF...`);
  }

  try {
    await printPdfWithSumatra(filePath, printerName, isMonochrome, copies);
    console.log(
      `✅ Print job sent successfully using SumatraPDF${label ? ` (${label} fallback)` : " (fallback)"}`
    );
    return;
  } catch (sumatraErr) {
    console.warn(`⚠️ SumatraPDF failed: ${sumatraErr.message}`);
    console.log(`🔄 Falling back to Windows print spooler...`);
  }

  try {
    await printPdfWithWindowsSpooler(
      filePath,
      printerName,
      isMonochrome,
      copies
    );
    console.log(
      `✅ Print job sent successfully using Windows print spooler${label ? ` (${label} last resort)` : " (last resort)"}`
    );
  } catch (spoolerErr) {
    console.error(`❌ All print methods failed`);
    throw new Error(
      `Print failed: All methods exhausted. Last error: ${spoolerErr.message}`
    );
  }
}

// ─── printFile ─────────────────────────────────────────────────────────

/**
 * Print file using system printer command.
 * Orchestrates which print method to use based on file type, OS, and color mode.
 */
async function printFile(filePath, options) {
  console.log(`🔍 DEBUG - printFile called with:`);
  console.log(`   File: ${filePath}`);
  console.log(`   Color mode: ${options.color}`);
  console.log(`   pageColors:`, JSON.stringify(options.pageColors, null, 2));

  const printerName = await getPrinterName();

  // Check printer availability
  const printerStatus = await checkPrinterStatus();
  if (!printerStatus.available) {
    throw new Error(
      `Printer is not available: ${printerStatus.message}. ${printerStatus.details || ""}`
    );
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  const colorMode =
    options.color === "color"
      ? "color"
      : options.color === "mixed"
        ? "mixed"
        : "bw";
  const copies = options.copies || 1;
  const pageSize = options.pageSize || "A4";
  const sided = options.sided || "single";
  const isMonochrome = colorMode === "bw";
  const fileExt = path.extname(filePath).toLowerCase();

  // ── Windows: specialized handlers ──
  if (isWindows) {
    // PDF, image files
    if (_isPdfOrImage(fileExt)) {
      await _handlePdfOrImage(filePath, fileExt, colorMode, isMonochrome, copies, pageSize, sided, printerName, options);
      return;
    }

    // Word files
    if (fileExt === ".docx" || fileExt === ".doc") {
      await _handleWordFile(filePath, fileExt, colorMode, isMonochrome, copies, pageSize, sided, printerName, options);
      return;
    }
  }

  // ── Generic / cross-platform printing ──
  await _handleGenericPrint(
    filePath,
    fileExt,
    printerName,
    isWindows,
    isMac,
    isLinux,
    options,
    copies,
    sided
  );
}

// ─── Private Handlers ──────────────────────────────────────────────────

function _isPdfOrImage(ext) {
  return [".pdf", ".jpg", ".jpeg", ".png", ".gif", ".bmp"].includes(ext);
}

/**
 * Handle PDF and image files on Windows
 */
async function _handlePdfOrImage(
  filePath,
  fileExt,
  colorMode,
  isMonochrome,
  copies,
  pageSize,
  sided,
  printerName,
  options
) {
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".bmp"].includes(fileExt);
  const isSinglePagePdf =
    fileExt === ".pdf" &&
    typeof options.pageCount === "number" &&
    options.pageCount <= 1;

  // Mixed color printing for PDFs
  if (fileExt === ".pdf" && colorMode === "mixed") {
    await _handleMixedColorPdf(filePath, printerName, copies, pageSize, sided, options);
    return;
  }

  // Simple jobs (images / single-page PDFs): prefer SumatraPDF
  if (isImage || isSinglePagePdf) {
    console.log(
      `🖨️ Simple job detected (${isImage ? "image" : "single-page PDF"}). Using SumatraPDF as primary method.`
    );
    try {
      await printPdfWithSumatra(filePath, printerName, isMonochrome, copies);
      console.log(`✅ Print job sent successfully using SumatraPDF (simple job)`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    } catch (sumatraError) {
      console.warn(`⚠️ SumatraPDF failed: ${sumatraError.message}`);
      try {
        await printPdfWithWindowsSpooler(filePath, printerName, isMonochrome, copies);
        console.log(`✅ Print job sent successfully using Windows print spooler (simple job fallback)`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return;
      } catch (spoolerError) {
        throw new Error(
          `Simple job print failed: SumatraPDF: ${sumatraError.message}, Windows spooler: ${spoolerError.message}`
        );
      }
    }
  }

  // Multi-page PDFs/images: Chrome as primary
  console.log(`🖨️ Printing ${fileExt} file using Chrome (primary method): ${filePath}`);
  console.log(`📋 Options: printer=${printerName}, copies=${copies}, color=${colorMode}, pageSize=${pageSize}, sided=${sided}`);
  await printWithCascade(filePath, printerName, isMonochrome, copies);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

/**
 * Handle mixed color PDF printing
 */
async function _handleMixedColorPdf(filePath, printerName, copies, pageSize, sided, options) {
  console.log(`🔍 DEBUG - PDF file with mixed color mode detected`);

  const normalizedPageColors = normalizePageColors(options.pageColors);
  console.log(`🔍 DEBUG - normalized pageColors:`, JSON.stringify(normalizedPageColors, null, 2));

  // Invalid or missing pageColors -> default to B&W
  if (
    !normalizedPageColors ||
    !Array.isArray(normalizedPageColors.colorPages) ||
    !Array.isArray(normalizedPageColors.bwPages)
  ) {
    console.warn(`⚠️ Mixed color mode requested but pageColors is missing or invalid. Defaulting to B&W mode.`);
    await printWithCascade(filePath, printerName, true, copies, "mixed-fallback-bw");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return;
  }

  // Valid: use mixed color printing
  console.log(`🖨️ Printing PDF with mixed color mode (maintaining page sequence)`);
  console.log(`📋 Color pages: ${normalizedPageColors.colorPages.join(", ")}`);
  console.log(`📋 B&W pages: ${normalizedPageColors.bwPages.join(", ")}`);

  const { app: elApp } = require("electron");
  const tempDir = path.join(
    elApp ? elApp.getPath("temp") : process.cwd(),
    "funprinting-print"
  );
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  await printPdfWithMixedColorInSequence(
    filePath,
    normalizedPageColors.colorPages,
    normalizedPageColors.bwPages,
    printerName,
    copies,
    pageSize,
    sided,
    tempDir
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

/**
 * Handle Word files on Windows (convert to PDF first, then print)
 */
async function _handleWordFile(
  filePath,
  fileExt,
  colorMode,
  isMonochrome,
  copies,
  pageSize,
  sided,
  printerName,
  options
) {
  try {
    console.log(`🔄 Converting Word file to PDF before printing: ${filePath}`);
    const pdfPath = await convertWordToPdf(filePath);
    console.log(`🖨️ Printing converted PDF: ${pdfPath}`);

    if (colorMode === "mixed") {
      await _handleMixedColorPdf(pdfPath, printerName, copies, pageSize, sided, options);
    } else {
      const isSinglePage =
        typeof options.pageCount === "number" && options.pageCount <= 1;

      if (isSinglePage) {
        console.log(`🖨️ Single-page Word job. Using SumatraPDF as primary.`);
        try {
          await printPdfWithSumatra(pdfPath, printerName, isMonochrome, copies);
        } catch (sumatraErr) {
          console.warn(`⚠️ SumatraPDF failed: ${sumatraErr.message}`);
          await printPdfWithWindowsSpooler(pdfPath, printerName, isMonochrome, copies);
        }
      } else {
        await printWithCascade(pdfPath, printerName, isMonochrome, copies, "Word-PDF");
      }
    }

    // Cleanup converted PDF
    try {
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
        console.log(`🗑️ Cleaned up temporary PDF: ${pdfPath}`);
      }
    } catch (cleanupError) {
      console.warn(`⚠️ Could not clean up temporary PDF: ${cleanupError}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log(`✅ Word file printed successfully (converted to PDF first)`);
    return;
  } catch (conversionError) {
    console.error(`❌ Word to PDF conversion failed: ${conversionError.message}`);
    console.log(`⚠️ Falling back to Word COM object printing...`);
    // Fall through to generic handler
  }

  // Fallback: generic COM object printing
  await _handleGenericPrint(
    filePath,
    fileExt,
    printerName,
    true,
    false,
    false,
    options,
    copies,
    options.sided || "single"
  );
}

/**
 * Generic / cross-platform print handler
 */
async function _handleGenericPrint(
  filePath,
  fileExt,
  printerName,
  isWindows,
  isMac,
  isLinux,
  options,
  copies,
  sided
) {
  let printCommand;
  const escapedPrinterName = printerName
    .replace(/'/g, "''")
    .replace(/\\/g, "\\\\");
  const escapedFilePath = filePath
    .replace(/'/g, "''")
    .replace(/\\/g, "\\\\");

  if (isWindows) {
    if (fileExt === ".docx" || fileExt === ".doc") {
      const duplexMode = sided === "double" ? 1 : 0;
      printCommand = `powershell -Command "$word = New-Object -ComObject Word.Application; $word.Visible = $false; $doc = $word.Documents.Open('${escapedFilePath}'); $word.ActivePrinter = '${escapedPrinterName}'; $doc.PrintOut([ref]$false, [ref]$false, [ref]0, [ref]'', [ref]0, [ref]0, [ref]0, [ref]${copies}, [ref]'', [ref]0, [ref]$false, [ref]$true, [ref]'', [ref]'', [ref]${duplexMode}); $doc.Close([ref]$false); $word.Quit([ref]$false)"`;
    } else {
      printCommand = `powershell -Command "$file = '${escapedFilePath}'; Start-Process -FilePath $file -Verb Print -WindowStyle Hidden"`;
    }
  } else if (isMac || isLinux) {
    const colorMode =
      options.color === "color" ? "color" : "grayscale";
    printCommand = `lp -d "${printerName}" -n ${copies} -o ColorModel=${colorMode} "${filePath}"`;
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  console.log(`Executing print command: ${printCommand}`);

  try {
    const { stdout, stderr } = await execAsync(printCommand);

    // Validate stdout
    if (stdout) {
      _checkOutputForErrors(stdout, "stdout");
    }

    // Validate stderr
    if (stderr) {
      _checkStderrForErrors(stderr, printerName);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    await _handlePrintError(error, filePath, printerName, options);
  }
}

/**
 * Check command output for known error patterns
 */
function _checkOutputForErrors(output, source) {
  const lower = output.toLowerCase();
  const trimmed = output.trim();

  const errorPatterns = [
    {
      test: () =>
        lower.includes("new-object") &&
        lower.includes("cannot create type"),
      msg: `COM object error: Shell.Application not available. ${trimmed}`,
    },
    {
      test: () =>
        lower.includes("invokeverbex") &&
        (lower.includes("method invocation failed") ||
          lower.includes("exception")),
      msg: `Print verb failed: ${trimmed || "Unable to invoke print verb"}`,
    },
    {
      test: () =>
        lower.includes("unable to initialize device") ||
        lower.includes("unable to connect") ||
        lower.includes("printer not found") ||
        lower.includes("printer does not exist") ||
        lower.includes("device not found") ||
        lower.includes("cannot connect to printer") ||
        lower.includes("cannot find") ||
        (lower.includes("error") && !lower.includes("request id")) ||
        (lower.includes("exception") && !lower.includes("request id")),
      msg: `Printer error: ${trimmed || "Unable to print"}`,
    },
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test()) {
      console.error(`❌ Error detected in ${source}: ${trimmed}`);
      throw new Error(pattern.msg);
    }
  }

  if (trimmed) {
    console.log(`✅ Print command output: ${trimmed}`);
  }
}

/**
 * Check stderr for printer-specific errors
 */
function _checkStderrForErrors(stderr, printerName) {
  const lower = stderr.toLowerCase();
  const trimmed = stderr.trim();

  if (
    lower.includes("new-object") &&
    (lower.includes("cannot create type") || lower.includes("comobject"))
  ) {
    throw new Error(
      `COM object error: Shell.Application not available. ${trimmed}`
    );
  }

  if (
    lower.includes("invokeverbex") &&
    (lower.includes("method invocation failed") ||
      lower.includes("exception"))
  ) {
    throw new Error(
      `Print verb failed: ${trimmed || "Unable to invoke print verb"}`
    );
  }

  if (
    lower.includes("unable to connect") ||
    lower.includes("printer not found") ||
    lower.includes("no such file or directory") ||
    lower.includes("printer does not exist") ||
    lower.includes("cannot find") ||
    (lower.includes("error") && !lower.includes("request id")) ||
    (lower.includes("exception") && !lower.includes("request id"))
  ) {
    throw new Error(`Printer error: ${trimmed || "Unable to print"}`);
  }

  if (
    lower.includes("printer is not available") ||
    lower.includes("printer is offline") ||
    lower.includes("printer is stopped")
  ) {
    throw new Error(
      `Printer is offline or not available: ${printerName}`
    );
  }

  if (
    !lower.includes("request id") &&
    !lower.includes("request-id") &&
    trimmed
  ) {
    console.warn("Print command stderr:", trimmed);
  }
}

/**
 * Handle errors from generic print, with COM fallback
 */
async function _handlePrintError(error, filePath, printerName, options) {
  const errorMessage =
    error.message || error.stdout || error.stderr || String(error);
  const lower = errorMessage.toLowerCase();

  // COM errors -> try fallback
  if (
    (lower.includes("new-object") &&
      (lower.includes("cannot create type") ||
        lower.includes("comobject"))) ||
    (lower.includes("invokeverbex") &&
      (lower.includes("method invocation failed") ||
        lower.includes("exception")))
  ) {
    console.warn("⚠️ COM method failed, trying fallback method...");
    return await tryFallbackPrintMethod(filePath, printerName, options);
  }

  // Specific printer errors
  if (
    lower.includes("unable to initialize device") ||
    lower.includes("unable to connect") ||
    lower.includes("printer not found") ||
    lower.includes("no such file or directory") ||
    lower.includes("printer does not exist") ||
    lower.includes("device not found") ||
    lower.includes("cannot connect to printer")
  ) {
    throw new Error(
      `Printer not connected: ${printerName}. Please check USB connection.`
    );
  }

  if (
    lower.includes("printer is not available") ||
    lower.includes("printer is offline") ||
    lower.includes("printer is idle") ||
    lower.includes("printer is stopped") ||
    lower.includes("printer is disabled")
  ) {
    throw new Error(
      `Printer is offline: ${printerName}. Please turn on the printer.`
    );
  }

  if (lower.includes("power") && lower.includes("off")) {
    throw new Error(
      `Printer appears to be powered off: ${printerName}. Please turn on the printer.`
    );
  }

  throw error;
}

module.exports = { printFile };
