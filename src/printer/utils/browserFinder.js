"use strict";

const fs = require("fs");
const { execAsync } = require("./execHelper");

/**
 * Find Chrome executable path (Windows only)
 */
async function findChromePath() {
  if (process.platform !== "win32") return null;

  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env["PROGRAMFILES"] +
      "\\Google\\Chrome\\Application\\chrome.exe",
    process.env["PROGRAMFILES(X86)"] +
      "\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\" +
      process.env.USERNAME +
      "\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    "chrome.exe", // Try PATH
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      console.log(`✅ Found Chrome at: ${p}`);
      return p;
    }
  }

  try {
    const { stdout } = await execAsync("where chrome.exe");
    if (stdout && stdout.trim()) {
      const found = stdout.trim().split("\n")[0].trim();
      if (found && fs.existsSync(found)) {
        console.log(`✅ Found Chrome in PATH: ${found}`);
        return found;
      }
    }
  } catch {
    // Not in PATH
  }

  return null;
}

/**
 * Find Edge executable path (Windows only)
 */
async function findEdgePath() {
  if (process.platform !== "win32") return null;

  const possiblePaths = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env["PROGRAMFILES(X86)"] +
      "\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env["PROGRAMFILES"] +
      "\\Microsoft\\Edge\\Application\\msedge.exe",
    "msedge.exe", // Try PATH
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      console.log(`✅ Found Edge at: ${p}`);
      return p;
    }
  }

  try {
    const { stdout } = await execAsync("where msedge.exe");
    if (stdout && stdout.trim()) {
      const found = stdout.trim().split("\n")[0].trim();
      if (found && fs.existsSync(found)) {
        console.log(`✅ Found Edge in PATH: ${found}`);
        return found;
      }
    }
  } catch {
    // Not in PATH
  }

  return null;
}

/**
 * Find SumatraPDF executable path (Windows only)
 */
async function findSumatraPdfPath() {
  if (process.platform !== "win32") return null;

  const possiblePaths = [
    "C:\\Program Files\\SumatraPDF\\SumatraPDF.exe",
    "C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe",
    process.env["PROGRAMFILES"] + "\\SumatraPDF\\SumatraPDF.exe",
    process.env["PROGRAMFILES(X86)"] + "\\SumatraPDF\\SumatraPDF.exe",
    "C:\\Users\\" +
      process.env.USERNAME +
      "\\AppData\\Local\\SumatraPDF\\SumatraPDF.exe",
    "SumatraPDF.exe", // Try PATH
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      console.log(`✅ Found SumatraPDF at: ${p}`);
      return p;
    }
  }

  try {
    const { stdout } = await execAsync("where SumatraPDF.exe");
    if (stdout && stdout.trim()) {
      const found = stdout.trim().split("\n")[0].trim();
      if (found && fs.existsSync(found)) {
        console.log(`✅ Found SumatraPDF in PATH: ${found}`);
        return found;
      }
    }
  } catch {
    // Not in PATH
  }

  return null;
}

/**
 * Find LibreOffice executable path (Windows only)
 */
function findLibreOfficePath() {
  if (process.platform !== "win32") return null;

  const possiblePaths = [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    process.env["PROGRAMFILES"] + "\\LibreOffice\\program\\soffice.exe",
    process.env["PROGRAMFILES(X86)"] +
      "\\LibreOffice\\program\\soffice.exe",
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      console.log(`✅ Found LibreOffice at: ${p}`);
      return p;
    }
  }

  return null;
}

module.exports = {
  findChromePath,
  findEdgePath,
  findSumatraPdfPath,
  findLibreOfficePath,
};
