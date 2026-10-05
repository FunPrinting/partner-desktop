/**
 * OAuth local callback server + login + WebSocket connection
 */

const http = require('http');
const { shell } = require('electron');
const { io } = require('socket.io-client');
const { processIncomingJob } = require('./jobProcessor');

let oauthServer = null;
let socket = null;
let token = null;

// Store active print jobs for resumption (Phase 5/7)
const activeJobs = new Map();
let isQueuePaused = false;

function startOAuth(getMainWindow) {
  if (oauthServer) {
    oauthServer.close();
  }

  oauthServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = new URL(req.url, 'http://localhost:4321');
    if (url.pathname === '/callback') {
      const partnerId = url.searchParams.get('partnerId');
      const authToken = url.searchParams.get('token');

      if (partnerId && authToken) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="background:#111827;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;"><h2>Authentication successful!</h2><p>You can close this window and return to the FunPrinting Partner App.</p><script>window.close()</script></body></html>');

        const mainWindow = getMainWindow();
        mainWindow.webContents.send('oauth-success', { partnerId, token: authToken });

        // Bring app to front
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }

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
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  oauthServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('Port 4321 is already in use. Opening browser anyway.');
      shell.openExternal('https://www.funprinting.store/partner/desktop-auth?callback=http://localhost:4321/callback');
    } else {
      console.error('OAuth Server Error:', e);
      getMainWindow().webContents.send('oauth-error', 'Internal server error: ' + e.message);
    }
  });

  oauthServer.listen(4321, () => {
    console.log('Started local OAuth callback server on port 4321');
    shell.openExternal('https://www.funprinting.store/partner/desktop-auth?callback=http://localhost:4321/callback');
  });
}

function login(authToken, partnerId, getMainWindow) {
  const mainWindow = getMainWindow();
  console.log('Authenticating with Cloud Engine...', partnerId);
  token = authToken;

  mainWindow.webContents.send('auth-success', { partnerId });

  if (socket) {
    socket.disconnect();
  }

  const wssUrl = process.env.WSS_URL || 'https://funprinting-wss.onrender.com';
  console.log(`Connecting to WebSocket server at ${wssUrl}`);

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

  // Remove previous listeners to prevent duplicates
  socket.off('new_print_job');
  socket.off('connect_error');
  socket.off('remote_control_action');
  socket.off('reconnect_failed');
  socket.off('cancel_print_job');

  socket.on('new_print_job', async (job) => {
    processIncomingJob(job, 'WSS Cloud', getMainWindow);
  });

  socket.on('cancel_print_job', async (data) => {
    console.log(`🛑 Received cancel request for job ${data.jobId}`);
    try {
      const printQueue = require('../../chrome-queue');
      printQueue.removeJob(data.jobId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('job-cancelled', data.jobId);
      }
    } catch (e) {
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

  // Phase 5: Remote Control
  socket.on('remote_control_action', (data) => {
    console.log(`📱 Received Remote Control Command: ${data.action}`);
    if (data.action === 'pause') {
      isQueuePaused = true;
      mainWindow.webContents.send('status', { connected: true, message: 'Queue Paused Remotely.' });
    } else if (data.action === 'resume') {
      isQueuePaused = false;
      mainWindow.webContents.send('status', { connected: true, message: 'Online and waiting for print jobs.' });
      for (let [jobId, jobState] of activeJobs.entries()) {
        if (jobState.resumeFn) {
          console.log(`▶️ Resuming job ${jobId} from remote command...`);
          jobState.resumeFn();
        }
      }
    }
  });
}

function getToken() { return token; }
function getSocket() { return socket; }
function getActiveJobs() { return activeJobs; }

module.exports = { startOAuth, login, getToken, getSocket, getActiveJobs };
