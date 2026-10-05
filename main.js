const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');
const { autoUpdater } = require('electron-updater');

// Configure Auto Updater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow;
let socket;
let token; // For storing auth token
let oauthServer = null;


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
  
  // Intercept console.log to send to frontend Live Logs
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  
  function sendLogToFrontend(level, ...args) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Format args as string
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      ).join(' ');
      
      try {
        mainWindow.webContents.send('system-log', { level, message, timestamp: new Date().toISOString() });
      } catch(e) {}
    }
  }

  console.log = (...args) => {
    originalLog.apply(console, args);
    sendLogToFrontend('info', ...args);
  };
  
  console.error = (...args) => {
    originalError.apply(console, args);
    sendLogToFrontend('error', ...args);
  };
  
  console.warn = (...args) => {
    originalWarn.apply(console, args);
    sendLogToFrontend('warn', ...args);
  };
}

app.whenReady().then(() => {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'geolocation') {
      callback(true);
    } else {
      callback(false);
    }
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'geolocation') {
      return true;
    }
    return false;
  });


  createWindow();

  try {
    const printQueue = require('./chrome-queue');
    printQueue.setOnJobCompleteCallback((job) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('job-completed', job);
      }
    });
  } catch(e) {
    console.error("Failed to set up job complete callback", e);
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  
  // Phase 1: Recover Jobs on Boot (Server side processing)
  // chrome-queue auto-recovers on require()
});

ipcMain.handle('get-queue', async () => {
  try {
    const printQueue = require('./chrome-queue');
    const status = printQueue.getQueueStatus();
    return status.jobs.map(qj => ({
      jobId: qj.job?.orderId || qj.id,
      orderId: qj.job?.orderId || qj.id,
      url: qj.job?.fileUrl,
      options: qj.job?.printingOptions,
      status: qj.status
    }));
  } catch (e) {
    console.error("Failed to read queue for UI", e);
  }
  return [];
});

ipcMain.on('clear-data', (event) => {
  try {
    const printQueue = require('./chrome-queue');
    printQueue.clearQueue();
    if (socket) socket.disconnect();
    token = null;
    console.log("App data and queue cleared successfully");
  } catch(e) {
    console.error("Failed to clear app data", e);
  }
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Auto Updater Events
// Helper function to process an incoming job, handling multiple files
function processIncomingJob(job, source) {
  const printQueue = require('./chrome-queue');
  
  // Check if this order is already in the queue to prevent duplicates
  const queueStatus = printQueue.getQueueStatus();
  const alreadyQueued = queueStatus.jobs.some(qj => 
    qj.job && qj.job.orderId === (job.orderId || job.jobId)
  );
  if (alreadyQueued) {
    console.log(`⏭️ Job ${job.jobId} already in queue, skipping duplicate injection.`);
    return;
  }

  console.log(`📥 Job Injected to Advanced Queue (${source}):`, job.jobId);
  
  const hasMultipleFiles = job.fileURLs && job.fileURLs.length > 0;
  
  if (hasMultipleFiles) {
    for (let i = 0; i < job.fileURLs.length; i++) {
      const apiJob = {
        orderId: job.orderId || job.jobId,
        fileUrl: job.fileURLs[i],
        fileName: job.originalFileNames ? job.originalFileNames[i] : `File ${i + 1}`,
        fileType: job.fileTypes ? job.fileTypes[i] : 'pdf',
        printingOptions: job.options || {
          pageSize: 'A4',
          color: 'bw',
          sided: 'single',
          copies: 1
        },
        orderDetails: job.orderDetails,
        customerInfo: job.customer
      };
      
      if (job.options && job.options.isMonochrome) {
        apiJob.printingOptions.color = 'bw';
      } else if (job.options && job.options.isMonochrome === false) {
        apiJob.printingOptions.color = 'color';
      }
      
      printQueue.addToQueue(apiJob, 0); // 0 is default printer index
      
      // Update UI for each file as a separate print job
      if (mainWindow && !mainWindow.isDestroyed()) {
        const uiJob = {
          ...job,
          jobId: `${job.jobId}-${i+1}`
        };
        // Safely set options so UI doesn't crash if options were undefined
        uiJob.options = apiJob.printingOptions;
        mainWindow.webContents.send('incoming_job', uiJob);
      }
    }
  } else {
    // Legacy: Single file mode
    const fileUrl = job.url || job.documentUrl;
    const apiJob = {
      orderId: job.orderId || job.jobId,
      fileUrl: fileUrl,
      fileName: job.originalFileName || (fileUrl ? fileUrl.split('/').pop().split('?')[0] : 'document.pdf'),
      fileType: 'pdf',
      printingOptions: job.options || {
        pageSize: 'A4',
        color: 'bw',
        sided: 'single',
        copies: 1
      },
      orderDetails: job.orderDetails,
      customerInfo: job.customer
    };
    
    if (job.options && job.options.isMonochrome) {
      apiJob.printingOptions.color = 'bw';
    } else if (job.options && job.options.isMonochrome === false) {
      apiJob.printingOptions.color = 'color';
    }
    
    printQueue.addToQueue(apiJob, 0);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Safely set options so UI doesn't crash if options were undefined
      job.options = apiJob.printingOptions;
      mainWindow.webContents.send('incoming_job', job);
    }
  }
}

// Local UI Event
ipcMain.on('inject_job', async (event, job) => {
  processIncomingJob(job, 'Local UI');
});

ipcMain.on('cancel_job', async (event, jobId) => {
  console.log(`🛑 Cancelling job from Local UI: ${jobId}`);
  try {
    const printQueue = require('./chrome-queue');
    printQueue.removeJob(jobId);
  } catch (err) {
    console.error('Failed to remove job from queue:', err);
  }
});

let orderWindows = {};

ipcMain.on('open-order-window', (event, order) => {
  if (orderWindows[order.orderId]) {
    orderWindows[order.orderId].focus();
    return;
  }
  
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: `Order #${order.orderId}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      plugins: true
    },
    backgroundColor: '#f9fafb'
  });

  // Force PDFs to display inline in the preview iframe, but allow downloads in new tabs
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url;
    let headers = details.responseHeaders;
    
    // Only intercept for likely document URLs
    if (url.includes('cloudinary.com') || url.includes('firebasestorage') || url.includes('r2.cloudflarestorage') || url.includes('.pdf') || url.includes('storage')) {
      if (headers) {
        // If loaded inside the preview iframe, force inline
        if (details.resourceType === 'subFrame') {
          if (headers['content-disposition']) headers['content-disposition'] = ['inline'];
          if (headers['Content-Disposition']) headers['Content-Disposition'] = ['inline'];
          
          // Force content-type to application/pdf to ensure browser viewer loads it
          if (headers['content-type'] && headers['content-type'][0].includes('octet-stream')) {
             headers['content-type'] = ['application/pdf'];
          }
          if (headers['Content-Type'] && headers['Content-Type'][0].includes('octet-stream')) {
             headers['Content-Type'] = ['application/pdf'];
          }
        } 
        // If loaded in a new tab (Download button), force attachment and proper filename
        else if (details.resourceType === 'mainFrame' && !url.includes('order-window.html')) {
          const contentDispStr = `attachment; filename="document.pdf"`;
          if (headers['content-disposition']) headers['content-disposition'] = [contentDispStr];
          else if (headers['Content-Disposition']) headers['Content-Disposition'] = [contentDispStr];
          else headers['Content-Disposition'] = [contentDispStr];
        }
      }
    }
    callback({ responseHeaders: headers });
  });
  
  win.loadFile('order-window.html');
  
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('order-data', order);
  });
  
  win.on('closed', () => {
    delete orderWindows[order.orderId];
  });
  
  orderWindows[order.orderId] = win;
});

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
  console.error('Update error:', err.message);
  // Send a clean, short message to the UI instead of the massive HTTP header dump
  mainWindow.webContents.send('update-message', 'Update check failed. You may be on the latest version.');
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
ipcMain.handle('get-printers', async () => {
  if (mainWindow) {
    return await mainWindow.webContents.getPrintersAsync();
  }
  return [];
});

ipcMain.on('start-oauth', () => {
  if (oauthServer) {
    oauthServer.close();
  }

  oauthServer = http.createServer((req, res) => {
    // Add basic CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const url = new URL(req.url, 'http://localhost:4321');
    if (url.pathname === '/callback') {
      const partnerId = url.searchParams.get('partnerId');
      const authToken = url.searchParams.get('token');
      
      if (partnerId && authToken) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111827;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;"><h2>Authentication successful!</h2><p>You can close this window and return to the FunPrinting Partner App.</p><script>window.close()</script></body></html>');
        
        mainWindow.webContents.send('oauth-success', { partnerId, token: authToken });
        
        // Automatically bring the desktop app to the front
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
        
        // Schedule server shutdown gracefully after giving the browser time to receive the HTML
        setTimeout(() => {
          if (oauthServer) {
            oauthServer.close();
            oauthServer = null;
          }
        }, 1500);
      } else {
        res.writeHead(400);
        res.end('Authentication failed: Missing token');
      }
    } else {
      // Immediately return 404 for ghost requests like /favicon.ico to prevent hanging connections
      res.writeHead(404);
      res.end('Not Found');
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
  
  // Immediately notify UI that authentication succeeded
  mainWindow.webContents.send('auth-success', { partnerId });
  
  if (socket) {
    socket.disconnect();
  }

  // Determine WSS URL: use env var if set, otherwise fall back to production URL
  const wssUrl = process.env.WSS_URL || 'https://funprinting-wss.onrender.com';
  console.log(`Connecting to WebSocket server at ${wssUrl}`);

  // Connect to the WebSocket Server with reconnection settings
  socket = io(wssUrl, {
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
    timeout: 10000
  });

  socket.on('connect', () => {
    console.log('🟢 Connected to Cloud WSS');
    mainWindow.webContents.send('status', { connected: true, message: 'Online and waiting for print jobs.' });
  });

  // Remove previous listeners to prevent duplicates if user logs in multiple times
  socket.off('new_print_job');
  socket.off('connect_error');
  socket.off('remote_control_action');
  socket.off('reconnect_failed');

  socket.off('cancel_print_job');

  socket.on('new_print_job', async (job) => {
    processIncomingJob(job, 'WSS Cloud');
  });

  socket.on('cancel_print_job', async (data) => {
    console.log(`🛑 Received cancel request for job ${data.jobId}`);
    try {
      const printQueue = require('./chrome-queue');
      printQueue.removeJob(data.jobId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('job-cancelled', data.jobId);
      }
    } catch(e) {
      console.error("Failed to cancel job", e);
    }
  });

  socket.on('connect_error', (err) => {
    console.log('🔴 Connection Error:', err.message);
    mainWindow.webContents.send('status', { connected: false, message: `Engine offline. Retrying... (${err.message})` });
  });

  socket.on('reconnect_failed', () => {
    console.log('🔴 All reconnection attempts exhausted');
    mainWindow.webContents.send('status', { connected: false, message: 'Engine unreachable. Click Reconnect to try again.' });
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
});

// Store token for REST API calls (Moved OUTSIDE of login event to prevent duplicate handlers)
ipcMain.handle('update_order_status', async (event, { jobId, status }) => {
  try {
    console.log(`Phase 4: Updating order ${jobId} to ${status}`);
    // Send REST API call to Cloud (NextJS runs on Vercel)
    const res = await fetch(`https://www.funprinting.store/api/partner/orders/${jobId}`, {
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

const { exec } = require('child_process');

// Store active print jobs for resumption
const activeJobs = new Map();
let isQueuePaused = false; // Phase 5: Remote Control
let activePrinterName = null; // Store the user-selected printer

ipcMain.on('set_active_printer', (event, printerName) => {
  activePrinterName = printerName;
  process.env.PRINTER_NAME = printerName;
  console.log(`🖨️ Active printer set to: ${activePrinterName}`);
});

ipcMain.on('resume_print', (event, { jobId }) => {
  console.log(`Phase 7: Manual Resume triggered for Job ${jobId}`);
  const jobState = activeJobs.get(jobId);
  if (jobState && jobState.resumeFn) {
    jobState.resumeFn();
  }
});



