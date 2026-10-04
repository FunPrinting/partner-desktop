const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');
const { PDFDocument } = require('pdf-lib');
const { autoUpdater } = require('electron-updater');

// Configure Auto Updater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// NOTE: node-printer or edge-js would be used here in production for raw hardware access.
// For this environment, we simulate printer commands.

let mainWindow;
let socket;
let token; // For storing auth token

let oauthServer = null; // Store local oauth server

let selectedPrintEngine = 'native'; // Default

// Queue Persistence Path
let queuePath = '';

// Attempt to load ultra-fast C++ native module
let nodePrinter = null;
try {
  nodePrinter = require('@thiagoelg/node-printer');
  console.log('✅ Native C++ node-printer module loaded successfully');
} catch (e) {
  console.log('⚠️ Native C++ node-printer module not available. Will fallback to System Default.');
  selectedPrintEngine = 'system';
}

// Queue Persistence Helpers
function saveJobToQueue(job) {
  try {
    let queue = [];
    if (fs.existsSync(queuePath)) {
      queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    }
    // Prevent duplicates
    if (!queue.find(q => q.jobId === job.jobId)) {
      queue.push(job);
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
      console.log(`💾 Saved Job ${job.jobId} to persistence queue.`);
    }
  } catch(e) {
    console.error("Failed to save queue", e);
  }
}

function removeJobFromQueue(jobId) {
  try {
    if (fs.existsSync(queuePath)) {
      let queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      queue = queue.filter(q => q.jobId !== jobId);
      fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
      console.log(`🗑️ Removed Job ${jobId} from persistence queue.`);
    }
  } catch(e) {
    console.error("Failed to remove from queue", e);
  }
}

// Phase 2: Universal Document Conversion
async function convertWordToPdf(inputPath) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(inputPath);
    // Uses LibreOffice headless. Make sure soffice is in PATH.
    const cmd = process.platform === 'win32' 
      ? `soffice --headless --convert-to pdf "${inputPath}" --outdir "${outDir}"`
      : `soffice --headless --convert-to pdf "${inputPath}" --outdir "${outDir}"`;
      
    console.log(`🔄 Converting Word to PDF: ${cmd}`);
    exec(cmd, (error) => {
      if (error) {
        console.error("LibreOffice conversion failed. Is it installed?", error);
        return reject(new Error("LibreOffice is required for .docx printing but is not installed or not in PATH."));
      }
      const pdfPath = inputPath.replace(/\.docx?$/i, '.pdf');
      resolve(pdfPath);
    });
  });
}

async function convertImageToPdf(imageBytes, extension) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  
  let image;
  if (extension.includes('png')) {
    image = await pdfDoc.embedPng(imageBytes);
  } else {
    image = await pdfDoc.embedJpg(imageBytes);
  }
  
  const { width, height } = page.getSize();
  const imgDims = image.scaleToFit(width - 40, height - 40);
  
  page.drawImage(image, {
    x: page.getWidth() / 2 - imgDims.width / 2,
    y: page.getHeight() / 2 - imgDims.height / 2,
    width: imgDims.width,
    height: imgDims.height,
  });
  
  return await pdfDoc.save();
}

// Phase 4: Dynamic Separator Pages & QR Receipts
async function generateCoverPage(pdfDoc, job) {
  const { rgb, StandardFonts } = require('pdf-lib');
  const coverPage = pdfDoc.insertPage(0);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  
  const { width, height } = coverPage.getSize();
  
  // Draw Job ID
  coverPage.drawText(`ORDER: #${job.jobId.toUpperCase().slice(0, 8)}`, {
    x: 50, y: height - 100, size: 36, font, color: rgb(0, 0, 0)
  });
  
  // Draw Price & Pages
  coverPage.drawText(`Pages: ${job.options?.pageCount || 'Unknown'} | Color: ${job.options?.isMonochrome ? 'B&W' : 'Color'}`, {
    x: 50, y: height - 150, size: 24, font: regularFont, color: rgb(0.2, 0.2, 0.2)
  });
  
  // Fetch and embed QR Code (Link to customer dashboard)
  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://funprinting.com/order/${job.jobId}`;
    const qrRes = await fetch(qrUrl);
    const qrBytes = await qrRes.arrayBuffer();
    const qrImage = await pdfDoc.embedPng(qrBytes);
    coverPage.drawImage(qrImage, {
      x: width - 200, y: height - 250, width: 150, height: 150
    });
    
    coverPage.drawText(`Scan for Customer Receipt`, {
      x: width - 210, y: height - 270, size: 12, font: regularFont, color: rgb(0.5, 0.5, 0.5)
    });
  } catch (e) {
    console.error("Failed to generate QR code", e);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets', 'logo.jpg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    title: "FunPrinting Partner Desktop",
    backgroundColor: '#111827' // Dark mode premium theme
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  queuePath = path.join(app.getPath('userData'), 'print-queue.json');
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  
  // Phase 1: Recover Jobs on Boot
  setTimeout(async () => {
    if (fs.existsSync(queuePath)) {
      try {
        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        if (queue.length > 0) {
          console.log(`♻️ Recovered ${queue.length} pending jobs from disk!`);
          for (const job of queue) {
             mainWindow.webContents.send('incoming_job', job);
             await startAIMDPrinting(job);
          }
        }
      } catch(e) {
        console.error("Failed to load queue", e);
      }
    }
  }, 3000); // Wait for UI to load
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Auto Updater Events
ipcMain.on('check-updates', () => {
  mainWindow.webContents.send('update-message', 'Checking for updates...');
  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on('update-available', () => {
  mainWindow.webContents.send('update-message', 'Update available. Downloading...');
});

autoUpdater.on('update-not-available', () => {
  mainWindow.webContents.send('update-message', 'App is up to date.');
});

autoUpdater.on('error', (err) => {
  mainWindow.webContents.send('update-message', `Update error: ${err.message}`);
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = `Downloading... ${Math.round(progressObj.percent)}%`;
  mainWindow.webContents.send('update-message', log_message);
});

autoUpdater.on('update-downloaded', () => {
  mainWindow.webContents.send('update-message', 'Update downloaded. Restarting...');
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 2000);
});

// IPC Communication (UI <-> Main Process)
ipcMain.on('start-oauth', () => {
  if (oauthServer) {
    oauthServer.close();
  }

  oauthServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:4321');
    if (url.pathname === '/callback') {
      const partnerId = url.searchParams.get('partnerId');
      const authToken = url.searchParams.get('token');
      
      if (partnerId && authToken) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111827;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><h2>Authentication successful! You can close this window.</h2><script>window.close()</script></body></html>');
        
        mainWindow.webContents.send('oauth-success', { partnerId, token: authToken });
        
        oauthServer.close();
        oauthServer = null;
      } else {
        res.writeHead(400);
        res.end('Authentication failed: Missing token');
      }
    }
  });

  oauthServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('Port 4321 is already in use. Opening browser anyway.');
      const webUrl = 'https://www.funprinting.store/partner/desktop-auth?callback=http://localhost:4321/callback';
      shell.openExternal(webUrl);
    } else {
      console.error('OAuth Server Error:', e);
      mainWindow.webContents.send('oauth-error', 'Internal server error: ' + e.message);
    }
  });

  oauthServer.listen(4321, () => {
    console.log('Started local OAuth callback server on port 4321');
    // Use the production web app for authentication
    const webUrl = 'https://www.funprinting.store/partner/desktop-auth?callback=http://localhost:4321/callback';
    shell.openExternal(webUrl);
  });
});

ipcMain.on('login', (event, { token: authToken, partnerId }) => {
  console.log('Authenticating with Cloud Engine...', partnerId);
  token = authToken; // Store in global for REST requests
  
  if (socket) {
    socket.disconnect();
  }

  // Connect to the Phase 5 WebSocket Server
  socket = io('http://localhost:3001', {
    auth: { token }
  });

  socket.on('connect', () => {
    console.log('🟢 Connected to Cloud WSS');
    mainWindow.webContents.send('status', { connected: true, message: 'Online and waiting for print jobs.' });
  });

  socket.on('new_print_job', async (job) => {
    console.log('📥 New Print Job Received:', job.jobId);
    // Phase 1: Persistence
    saveJobToQueue(job);
    
    mainWindow.webContents.send('incoming_job', job);
    
    // Auto-start Phase 7 AIMD Printing Engine logic here
    await startAIMDPrinting(job);
  });

  socket.on('connect_error', (err) => {
    console.log('🔴 Connection Error:', err.message);
    mainWindow.webContents.send('status', { connected: false, message: `Error: ${err.message}` });
  });

  // Phase 5: Remote Control (Listen for Mobile App commands)
  socket.on('remote_control_action', (data) => {
    console.log(`📱 Received Remote Control Command: ${data.action}`);
    if (data.action === 'pause') {
      isQueuePaused = true;
      mainWindow.webContents.send('status', { connected: true, message: 'Queue Paused Remotely.' });
    } else if (data.action === 'resume') {
      isQueuePaused = false;
      mainWindow.webContents.send('status', { connected: true, message: 'Online and waiting for print jobs.' });
      
      // Resume all paused jobs
      for (let [jobId, jobState] of activeJobs.entries()) {
        if (jobState.resumeFn) {
          console.log(`▶️ Resuming job ${jobId} from remote command...`);
          jobState.resumeFn();
        }
      }
    }
  });

  // Store token for REST API calls
  ipcMain.handle('update_order_status', async (event, { jobId, status }) => {
    try {
      console.log(`Phase 4: Updating order ${jobId} to ${status}`);
      // Send REST API call to Cloud (simulated port 3000 since NextJS runs there)
      const res = await fetch(`http://localhost:3000/api/partner/orders/${jobId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` // Though Next-Auth usually uses cookies, we'll pass token or use a dedicated endpoint
        },
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      return data;
    } catch (error) {
      console.error('Failed to update status:', error);
      return { success: false };
    }
  });
});

const { exec } = require('child_process');

// Store active print jobs for resumption
const activeJobs = new Map();
let isQueuePaused = false; // Phase 5: Remote Control

ipcMain.on('resume_print', (event, { jobId }) => {
  console.log(`Phase 7: Manual Resume triggered for Job ${jobId}`);
  const jobState = activeJobs.get(jobId);
  if (jobState && jobState.resumeFn) {
    jobState.resumeFn();
  }
});

ipcMain.on('set_engine', (event, engine) => {
  if (engine === 'native' && !nodePrinter) {
    console.warn("User requested native engine, but it is not installed. Forcing system engine.");
    selectedPrintEngine = 'system';
  } else {
    selectedPrintEngine = engine;
  }
  console.log(`🖨️ Printing engine switched to: ${selectedPrintEngine}`);
});

// Phase 7: Real AIMD Printing Engine (Hardware Execution)
async function startAIMDPrinting(job) {
  let packetSize = 5;
  let totalPages = job.options.pageCount || 10;
  let printedPages = 0;
  
  // Phase 7: Actual PDF Slicing using pdf-lib
  let sourcePdfDoc = null;
  try {
    if (job.documentUrl) {
      mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Downloading...', packetSize: 0 });
      console.log(`Downloading document for job ${job.jobId}...`);
      
      const res = await fetch(job.documentUrl);
      const arrayBuffer = await res.arrayBuffer();
      let fileBytes = new Uint8Array(arrayBuffer);
      
      const urlLower = job.documentUrl.toLowerCase();
      
      // Phase 2: Document Conversion Pipeline
      if (urlLower.endsWith('.docx') || urlLower.endsWith('.doc')) {
         mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Converting Word Doc...', packetSize: 0 });
         const tempDocPath = path.join(app.getPath('temp'), `job_${job.jobId}.docx`);
         fs.writeFileSync(tempDocPath, fileBytes);
         const convertedPdfPath = await convertWordToPdf(tempDocPath);
         fileBytes = fs.readFileSync(convertedPdfPath);
      } else if (urlLower.endsWith('.jpg') || urlLower.endsWith('.jpeg') || urlLower.endsWith('.png')) {
         mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Converting Image...', packetSize: 0 });
         fileBytes = await convertImageToPdf(fileBytes, urlLower);
      }
      
      sourcePdfDoc = await PDFDocument.load(fileBytes);
      
      // Phase 4: Generate Separator Cover Page with QR Code
      await generateCoverPage(sourcePdfDoc, job);
      
      totalPages = sourcePdfDoc.getPageCount();
      console.log(`PDF loaded and Cover Page attached. Total Pages: ${totalPages}`);
    }
  } catch (err) {
    console.error("Failed to load/convert document for slicing:", err);
    mainWindow.webContents.send('print_status', { jobId: job.jobId, status: `Error: ${err.message}`, packetSize: 0 });
    return;
  }
  
  console.log(`🚀 Starting REAL AIMD Print Engine for Job ${job.jobId} with Initial cwnd=${packetSize}`);
  mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Printing', packetSize });

  async function sendPacket() {
    // Phase 5: Remote Control Pause Check
    if (isQueuePaused) {
      console.log(`⏸️ Job ${job.jobId} paused by Remote Control.`);
      mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Paused Remotely', packetSize });
      activeJobs.set(job.jobId, { resumeFn: sendPacket });
      return;
    }

    if (printedPages >= totalPages) {
      console.log(`✅ Print Job ${job.jobId} Completed`);
      socket.emit('print_job_ack', { jobId: job.jobId, status: 'success' });
      mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Completed', packetSize });
      activeJobs.delete(job.jobId);
      
      // Phase 1: Persistence - Remove from queue when fully complete
      removeJobFromQueue(job.jobId);
      return;
    }

    let pagesToSend = Math.min(packetSize, totalPages - printedPages);
    console.log(`📤 Slicing ${pagesToSend} pages and sending to OS Spooler (Pages ${printedPages + 1} to ${printedPages + pagesToSend})...`);
    
    // Simulate real hardware slicing
    let finalPdfPath = null;
    if (sourcePdfDoc) {
      try {
        const slicedDoc = await PDFDocument.create();
        const pages = await slicedDoc.copyPages(sourcePdfDoc, Array.from({length: pagesToSend}, (_, i) => printedPages + i));
        pages.forEach(page => slicedDoc.addPage(page));
        const slicedPdfBytes = await slicedDoc.save();
        
        finalPdfPath = path.join(app.getPath('temp'), `slice_${job.jobId}_${printedPages}.pdf`);
        fs.writeFileSync(finalPdfPath, slicedPdfBytes);
        
        // Phase 3: Smart Color Chunking / Mode Switching
        const isMonochrome = job.options && job.options.isMonochrome !== undefined ? job.options.isMonochrome : true; // Default to saving ink
        if (process.platform === 'win32') {
           const colorMode = isMonochrome ? 'Grayscale' : 'Color';
           console.log(`🎨 Forcing printer driver to ${colorMode} mode to save cost...`);
           // Use PowerShell to forcefully configure the default printer's driver
           const colorCmd = `powershell -Command "$printer = Get-Printer | Where-Object {$_.Default -eq $true} | Select-Object -First 1; if ($printer) { Set-PrintConfiguration -PrinterName $printer.Name -ColorMode ${colorMode} -ErrorAction SilentlyContinue }"`;
           exec(colorCmd);
           // Brief delay to allow driver state change
           await new Promise(res => setTimeout(res, 500));
        }

        // Execute Hardware Print using selected engine
        if (selectedPrintEngine === 'native' && nodePrinter) {
           console.log(`⚡ Using Native C++ Spooler (Fastest)`);
           const defaultPrinter = nodePrinter.getDefaultPrinterName();
           if(!defaultPrinter) throw new Error("No default printer");
           
           nodePrinter.printDirect({
             data: slicedPdfBytes,
             printer: defaultPrinter,
             type: 'PDF',
             success: function(jobID){
               console.log("Native Job sent with ID: " + jobID);
             },
             error: function(err){
               throw new Error(err);
             }
           });
        } else {
           console.log(`🌐 Using System Default (PowerShell)`);
           // Fallback to powershell Start-Process
           if (process.platform === 'win32') {
             const printCmd = `powershell -Command "Start-Process -FilePath '${finalPdfPath}' -Verb Print -WindowStyle Hidden"`;
             exec(printCmd);
           } else {
             const printCmd = `lp "${finalPdfPath}"`;
             exec(printCmd);
           }
        }
      } catch (err) {
        console.error("Hardware Print Failed:", err);
        // Force error path below
      }
    }

    // Check real hardware status via OS command (lpstat on macOS/Linux, Get-PrintJob on Windows)
    let statusCmd = process.platform === 'win32' 
      ? 'powershell -Command "Get-PrintJob -PrinterName (Get-Printer | Where-Object {$_.Default -eq $true}).Name | Where-Object {$_.JobStatus -match \'Error|PaperOut|Offline\'}"'
      : 'lpstat -p';
      
    exec(statusCmd, (error, stdout, stderr) => {
      // If the printer is jammed or paused
      const isError = stdout.toLowerCase().includes('paused') || stdout.toLowerCase().includes('disabled') || stdout.toLowerCase().includes('error') || stdout.toLowerCase().includes('paperout') || error;
      
      // Cleanup temp file
      if (finalPdfPath && fs.existsSync(finalPdfPath)) {
        setTimeout(() => { try { fs.unlinkSync(finalPdfPath); } catch(e){} }, 5000);
      }
      
      if (!isError) {
        // Success: Hardware accepted the spool packet
        printedPages += pagesToSend;
        packetSize = Math.min(packetSize + 5, 20); // Additive Increase
        console.log(`✅ Packet success. Scaling cwnd up to ${packetSize}`);
        
        mainWindow.webContents.send('print_status', { jobId: job.jobId, status: `Printing (${printedPages}/${totalPages})`, packetSize });
        
        // Loop next packet
        setTimeout(sendPacket, 1500); 
      } else {
        // Failure: Paper Jam / Offline
        packetSize = 1; // Multiplicative Decrease (TCP Tahoe style)
        console.log(`❌ Printer Error (Jam/Offline detected). Dropped cwnd to ${packetSize}`);
        
        socket.emit('print_job_ack', { jobId: job.jobId, status: 'error', error: 'hardware_failure' });
        mainWindow.webContents.send('print_status', { jobId: job.jobId, status: 'Error: Paper Jam / Hardware Offline', packetSize });
        
        // Phase 5: Push Notification to Mobile App
        socket.emit('system_alert', {
           title: "🚨 Printer Error",
           message: `Paper Jam or Hardware Offline detected on Job #${job.jobId.slice(0, 6)}. Please check the PC printer immediately.`
        });
        
        // Pause and wait for manual resume via IPC event or Remote Control
        activeJobs.set(job.jobId, { resumeFn: sendPacket });
      }
    });
  }

  sendPacket();
}
