"use strict";

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { execAsync } = require("./execHelper");
const { findLibreOfficePath } = require("./browserFinder");

/**
 * Download file from URL with redirect support
 */
async function downloadFile(fileUrl, outputPath, { timeoutMs = 120000 } = {}) {
  const { Readable } = require("stream");
  const { pipeline } = require("stream/promises");

  if (!/^https?:\/\//i.test(String(fileUrl))) {
    throw new Error("Failed to download file: unsupported URL");
  }
  // fetch follows every redirect type, unlike the old http.get version
  const res = await fetch(fileUrl, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download file: ${res.status}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outputPath));
  } catch (err) {
    fs.rmSync(outputPath, { force: true });
    throw new Error(`Failed to download file: ${err.message}`);
  }
}

/**
 * Convert Word file (DOCX/DOC) to PDF using LibreOffice
 */
async function convertWordToPdf(wordFilePath) {
  try {
    console.log(
      `🔄 Converting Word file to PDF using LibreOffice: ${wordFilePath}`
    );
    const { app: elApp } = require("electron");
    const tempDir = path.join(
      elApp ? elApp.getPath("temp") : process.cwd(),
      "funprinting-print"
    );
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fileExt = path.extname(wordFilePath).toLowerCase();
    const baseName = path.basename(wordFilePath, fileExt);
    const pdfPath = path.join(tempDir, `${baseName}_${uuidv4()}.pdf`);

    // Find LibreOffice executable
    let sofficeCommand = "soffice";
    if (process.platform === "win32") {
      const libreOfficePath = findLibreOfficePath();
      if (libreOfficePath) {
        sofficeCommand = `"${libreOfficePath}"`;
      } else {
        console.warn(
          "⚠️ LibreOffice not found in standard locations, trying PATH..."
        );
      }
    }

    const command = `${sofficeCommand} --headless --convert-to pdf --outdir "${tempDir}" "${wordFilePath}"`;
    console.log(`Running LibreOffice command: ${command}`);

    const { stdout, stderr } = await execAsync(command);
    if (stderr && !stderr.includes("Warning") && !stderr.includes("Info")) {
      console.warn("LibreOffice stderr:", stderr);
    }
    console.log("LibreOffice stdout:", stdout);

    const expectedPdfPath = path.join(tempDir, `${baseName}.pdf`);
    if (!fs.existsSync(expectedPdfPath)) {
      throw new Error(
        "LibreOffice conversion failed - no PDF file created"
      );
    }
    if (expectedPdfPath !== pdfPath) {
      fs.renameSync(expectedPdfPath, pdfPath);
    }

    console.log(`✅ Word to PDF conversion successful: ${pdfPath}`);
    return pdfPath;
  } catch (error) {
    console.error(
      `❌ Error converting Word to PDF with LibreOffice: ${error.message}`
    );
    throw new Error(`Word to PDF conversion failed: ${error.message}`);
  }
}

/**
 * Normalize pageColors structure (handles both array and single object formats)
 * For single file printing, extracts the first element if it's an array
 */
function normalizePageColors(pageColors) {
  if (!pageColors) return undefined;

  // Handle array format (per-file) - extract first element for single file
  if (Array.isArray(pageColors)) {
    return pageColors.length > 0 ? pageColors[0] : undefined;
  }

  // Handle single object format (legacy)
  return pageColors;
}

module.exports = { downloadFile, convertWordToPdf, normalizePageColors };
