"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const { execAsync } = require("../utils/execHelper");
const { findChromePath, findEdgePath } = require("../utils/browserFinder");
const {
  forceGrayscaleMode,
  forceColorMode,
  getDefaultPrinter,
  setDefaultPrinter,
} = require("../core/printerConfig");

/**
 * Print PDF using Chrome/Edge with print dialog (allows color mode control)
 * Opens the browser, loads the PDF via a local HTTP server, then triggers print dialog.
 */
async function printPdfWithChrome(
  filePath,
  printerName,
  isMonochrome,
  copies,
  groupIndex = 0
) {
  if (process.platform !== "win32") {
    throw new Error("Chrome printing only works on Windows");
  }

  // Discover browser
  let browserPath = await findChromePath();
  let browserName = "Chrome";
  if (!browserPath) {
    browserPath = await findEdgePath();
    browserName = "Edge";
  }
  if (!browserPath) {
    throw new Error(
      "Chrome or Edge not found. Please install Google Chrome or Microsoft Edge."
    );
  }

  try {
    console.log(
      `⚡ Using ${browserName} with print dialog for color mode control (monochrome=${isMonochrome})`
    );

    // Force printer driver to appropriate mode
    if (isMonochrome) {
      console.log(
        `🎨 Forcing printer driver to grayscale mode before printing...`
      );
      await forceGrayscaleMode(printerName);
    } else {
      console.log(
        `🎨 Forcing printer driver to color mode before printing...`
      );
      await forceColorMode(printerName);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Save and set default printer
    const originalDefaultPrinter = await getDefaultPrinter();
    console.log(`🖨️ Setting printer as default: ${printerName}`);
    const setDefaultSuccess = await setDefaultPrinter(printerName);
    if (!setDefaultSuccess) {
      console.warn(
        `⚠️ Could not set printer as default, Chrome will use current default printer`
      );
    }

    const escapedBrowserPath = browserPath.replace(/"/g, '\\"');

    // Print all copies
    for (let i = 0; i < copies; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      let server = null;
      try {
        const serverPort = 8765 + groupIndex * 10 + i;
        const fileName = path.basename(filePath);
        const httpUrl = `http://localhost:${serverPort}/${encodeURIComponent(fileName)}`;

        // ── Local HTTP server to serve the PDF ──
        server = _createPdfServer(filePath, fileName, httpUrl);

        await new Promise((resolve, reject) => {
          server.listen(serverPort, "localhost", () => {
            console.log(
              `📡 Started local HTTP server on port ${serverPort} to serve PDF`
            );
            resolve();
          });
          server.on("error", (err) => {
            if (err.code === "EADDRINUSE") {
              resolve(); // Port in use, continue anyway
            } else {
              reject(err);
            }
          });
        });

        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        // Calculate wait time based on file size
        const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
        const totalWaitTime =
          5 + Math.max(0, Math.ceil(fileSizeMB * 2));

        console.log(
          `Executing ${browserName} print command (monochrome=${isMonochrome}, copy ${i + 1}/${copies})`
        );
        console.log(
          `   File size: ${fileSizeMB.toFixed(2)} MB — will wait ${totalWaitTime}s for PDF to load`
        );

        // Verify HTTP server readiness
        await _verifyHttpServer(serverPort);

        // Launch browser
        const procId = await _launchBrowser(
          escapedBrowserPath,
          browserName,
          httpUrl
        );

        // Wait for PDF to load
        console.log(
          `   Waiting ${totalWaitTime}s for PDF to load...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, totalWaitTime * 1000)
        );

        // Verify browser is still running
        await _verifyProcessRunning(procId, browserName);

        // Send print command via SendKeys
        await _sendPrintCommand(procId, isMonochrome);

        // Wait for print job processing
        const printWaitTime = Math.max(
          5,
          Math.ceil(fileSizeMB * 3)
        );
        console.log(
          `   Waiting ${printWaitTime}s for print job to be processed...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, printWaitTime * 1000)
        );

        // Keep Chrome open a bit longer for print job completion
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Close browser process
        await _killProcess(procId);

        // Close HTTP server
        if (server) {
          await new Promise((resolve) => {
            server.close(() => {
              console.log(`   HTTP server closed`);
              resolve();
            });
          });
          server = null;
        }
      } catch (error) {
        // Close server on error
        if (server) {
          try {
            await new Promise((resolve) => {
              server.close(() => {
                console.log(`   HTTP server closed (error cleanup)`);
                resolve();
              });
            });
          } catch {
            // Ignore server close errors
          }
        }
        if (i === 0) throw error;
        console.warn(
          `⚠️ Failed to print copy ${i + 1}: ${error.message}`
        );
      }
    }

    // Restore original default printer
    if (
      originalDefaultPrinter &&
      originalDefaultPrinter !== printerName &&
      setDefaultSuccess
    ) {
      console.log(
        `🔄 Restoring original default printer: ${originalDefaultPrinter}`
      );
      await setDefaultPrinter(originalDefaultPrinter);
    }

    console.log(
      `✅ ${browserName} print command completed successfully (${copies} copy/copies)`
    );
    console.log(
      `   Mode: ${isMonochrome ? "Grayscale/B&W (fast mode - direct printing)" : "Color"}`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(
      `❌ ${browserName} print error: ${error.message}`
    );
    throw error;
  }
}

// ─── Private Helpers ───────────────────────────────────────────────────

/**
 * Create a simple HTTP server that serves a single PDF file
 */
function _createPdfServer(filePath, fileName, httpUrl) {
  return http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url || "/");
    const requestedFile = decodeURIComponent(
      parsedUrl.pathname?.substring(1) || ""
    );

    const matches =
      requestedFile === fileName ||
      requestedFile === encodeURIComponent(fileName) ||
      decodeURIComponent(requestedFile) === fileName;

    if (matches) {
      if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("File not found");
        return;
      }
      try {
        const fileStream = fs.createReadStream(filePath);
        fileStream.on("error", (err) => {
          console.error(`❌ Error reading file: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Error reading file");
          }
        });
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${fileName}"`,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        fileStream.pipe(res);
      } catch (error) {
        console.error(`❌ Error serving file: ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error serving file");
        }
      }
    } else {
      res.writeHead(302, { Location: httpUrl });
      res.end();
    }
  });
}

/**
 * Quick HTTP GET to verify server is ready
 */
async function _verifyHttpServer(serverPort) {
  try {
    await new Promise((resolve) => {
      const testReq = http.get(
        `http://localhost:${serverPort}/`,
        (res) => {
          res.on("data", () => {});
          res.on("end", () => {
            console.log(
              `   HTTP server verification: Ready (status ${res.statusCode})`
            );
            resolve();
          });
        }
      );
      testReq.on("error", () => resolve());
      testReq.setTimeout(2000, () => {
        testReq.destroy();
        resolve();
      });
    });
  } catch {
    console.log(
      `   HTTP server test skipped, proceeding with Chrome launch`
    );
  }
}

/**
 * Launch Chrome/Edge and return the process ID of the browser window
 */
async function _launchBrowser(escapedBrowserPath, browserName, httpUrl) {
  const escapedUrl = httpUrl.replace(/'/g, "''");
  const chromeCmd = `powershell -Command "$ErrorActionPreference = 'Stop'; $url = '${escapedUrl}'; $proc = Start-Process -FilePath '${escapedBrowserPath}' -ArgumentList '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--new-window', $url -PassThru -ErrorAction Stop; $procId = $proc.Id; Write-Output $procId"`;

  console.log(`   Launching ${browserName} with URL: ${httpUrl}`);
  const { stdout } = await execAsync(chromeCmd);
  const initialProcId = stdout.trim();
  console.log(
    `   ${browserName} launcher process started with PID: ${initialProcId}`
  );

  // Wait for browser to fully start
  console.log(
    `   Waiting 3 seconds for ${browserName} to fully initialize...`
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Find the actual browser window process
  const procId = await _findBrowserProcess(
    initialProcId,
    browserName
  );

  if (!procId) {
    throw new Error(
      `${browserName} process exited immediately after launch or could not be found`
    );
  }

  return procId;
}

/**
 * Find the actual browser window process (launcher PID may differ from window PID)
 */
async function _findBrowserProcess(initialProcId, browserName) {
  // Try initial PID first
  try {
    const checkCmd = `powershell -Command "$proc = Get-Process -Id ${initialProcId} -ErrorAction SilentlyContinue; if ($proc -and -not $proc.HasExited) { Write-Output 'RUNNING' } else { Write-Output 'NOT_RUNNING' }"`;
    const { stdout } = await execAsync(checkCmd);
    if (stdout.trim() === "RUNNING") {
      console.log(
        `   Initial ${browserName} process ${initialProcId} is still running`
      );
      return initialProcId;
    }
  } catch {
    // Continue to search
  }

  // Search by process name
  const processName = browserName === "Chrome" ? "chrome" : "msedge";
  const strategies = [
    // Recent processes with windows (last 60 seconds)
    `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' -and $_.StartTime -gt (Get-Date).AddSeconds(-60) } | Sort-Object StartTime -Descending | Select-Object -First 1`,
    // Any process with window
    `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Sort-Object StartTime -Descending | Select-Object -First 1`,
  ];

  for (const strategy of strategies) {
    try {
      const cmd = `powershell -Command "$procs = ${strategy}; if ($procs) { Write-Output $procs.Id } else { Write-Output 'NOT_FOUND' }"`;
      const { stdout } = await execAsync(cmd);
      const pid = stdout.trim();
      if (pid && pid !== "NOT_FOUND" && !isNaN(parseInt(pid))) {
        console.log(
          `   Found ${browserName} window process with PID: ${pid}`
        );
        return pid;
      }
    } catch {
      // Try next strategy
    }
  }

  console.warn(`   Could not find ${browserName} window process`);
  return null;
}

/**
 * Verify a process is still running, with retries
 */
async function _verifyProcessRunning(procId, browserName) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      const checkCmd = `powershell -Command "$proc = Get-Process -Id ${procId} -ErrorAction SilentlyContinue; if ($proc -and -not $proc.HasExited) { Write-Output 'RUNNING' } else { Write-Output 'NOT_RUNNING' }"`;
      const { stdout } = await execAsync(checkCmd);
      if (stdout.trim() === "RUNNING") {
        console.log(
          `   Verified ${browserName} process ${procId} is running`
        );
        return;
      }
    } catch {
      // Retry
    }
    if (retry < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(
    `${browserName} process ${procId} exited while waiting`
  );
}

/**
 * Send Ctrl+P and color mode keystrokes via SendKeys
 */
async function _sendPrintCommand(procId, isMonochrome) {
  try {
    let cmd = `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; Add-Type -AssemblyName System.Windows.Forms; $proc = Get-Process -Id ${procId} -ErrorAction SilentlyContinue; if ($proc -and -not $proc.HasExited) { [Microsoft.VisualBasic.Interaction]::AppActivate(${procId}); Start-Sleep -Milliseconds 1000; `;

    // Open print dialog
    cmd += `[System.Windows.Forms.SendKeys]::SendWait('^p'); Start-Sleep -Seconds 3; `;

    // Tab to Color dropdown
    cmd += `[System.Windows.Forms.SendKeys]::SendWait('{TAB}{TAB}{TAB}{TAB}{TAB}{TAB}{TAB}{TAB}'); Start-Sleep -Milliseconds 500; `;

    // Open dropdown
    cmd += `[System.Windows.Forms.SendKeys]::SendWait('%{DOWN}'); Start-Sleep -Milliseconds 500; `;

    if (isMonochrome) {
      console.log(
        `   Setting Chrome print dialog to Black and white mode...`
      );
      cmd += `[System.Windows.Forms.SendKeys]::SendWait('{UP}'); Start-Sleep -Milliseconds 400; `;
    } else {
      console.log(
        `   Setting Chrome print dialog to Color mode...`
      );
      cmd += `[System.Windows.Forms.SendKeys]::SendWait('{DOWN}'); Start-Sleep -Milliseconds 400; `;
    }

    // Confirm selection
    cmd += `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); Start-Sleep -Milliseconds 400; `;

    // Tab to Print button and press Enter
    cmd += `[System.Windows.Forms.SendKeys]::SendWait('{TAB}{TAB}'); Start-Sleep -Milliseconds 400; `;
    cmd += `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); Write-Output 'Print command sent with color mode set' } else { Write-Output 'Process not found or exited' }"`;

    const result = await execAsync(cmd);
    console.log(`   Print command result: ${result.stdout.trim()}`);
  } catch (printError) {
    console.warn(
      `   ⚠️ Failed to send print command: ${printError.message}`
    );
    // Fallback: just Ctrl+P → Enter
    try {
      const fallbackCmd = `powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; Add-Type -AssemblyName System.Windows.Forms; $proc = Get-Process -Id ${procId} -ErrorAction SilentlyContinue; if ($proc -and -not $proc.HasExited) { [Microsoft.VisualBasic.Interaction]::AppActivate(${procId}); Start-Sleep -Milliseconds 500; [System.Windows.Forms.SendKeys]::SendWait('^p'); Start-Sleep -Seconds 2; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); Write-Output 'Fallback print sent' }"`;
      await execAsync(fallbackCmd);
      console.log(`   Fallback print command sent`);
    } catch (fallbackError) {
      console.warn(
        `   ⚠️ Fallback print also failed: ${fallbackError}`
      );
    }
  }
}

/**
 * Kill a process by PID
 */
async function _killProcess(procId) {
  try {
    await execAsync(
      `powershell -Command "$proc = Get-Process -Id ${procId} -ErrorAction SilentlyContinue; if ($proc -and -not $proc.HasExited) { Stop-Process -Id ${procId} -Force -ErrorAction SilentlyContinue; Write-Output 'Chrome closed' }"`
    );
  } catch {
    // Ignore cleanup errors
  }
}

module.exports = { printPdfWithChrome };
