/**
 * main.js — Electron entry point.
 *
 *   src/main/config.js        server addresses (FP_WEB_URL, FP_WSS_URL)
 *   src/main/session.js       sign-in (code + PKCE), token refresh, API calls
 *   src/main/tokenStore.js    tokens encrypted with the OS keychain
 *   src/main/connection.js    socket to the relay (change notifications only)
 *   src/main/jobSync.js       print jobs from the API -> local print queue
 *   src/main/errorReporter.js errors -> web app error log
 *   src/main/ipcHandlers.js   IPC for the windows
 *   src/main/window.js, orderWindow.js, updater.js
 *   src/queue/                local print queue (one file at a time)
 *   src/printer/              printing
 */
const { app, BrowserWindow, session: electronSession } = require('electron');
const { createWindow, getMainWindow } = require('./src/main/window');
const errorReporter = require('./src/main/errorReporter');

errorReporter.installGlobalHandlers();

// One instance only: two would fight over the sign-in port and the print queue
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const session = require('./src/main/session');
    const connection = require('./src/main/connection');
    const jobSync = require('./src/main/jobSync');
    const queue = require('./src/queue/queueManager');
    const { initAutoUpdater } = require('./src/main/updater');
    const { registerIpcHandlers } = require('./src/main/ipcHandlers');

    // The shop map in settings uses geolocation; nothing else is granted
    electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'geolocation');
    });
    electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'geolocation');

    createWindow();
    const send = (channel, data) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    };

    errorReporter.setTokenProvider(() => session.getAccessTokenSync());

    const goOnline = () => {
      connection.connect();
      jobSync.start();
    };

    connection.setHandlers({
      onStatus: (status) => send('status', status),
      onConnected: () => jobSync.sync('connected'),
      onJobsChanged: (reason) => jobSync.sync(reason),
      onRemoteControl: (action) => jobSync.setPaused(action === 'pause'),
    });

    session.events.on('changed', (state) => send('session-changed', state));
    session.events.on('signed-out', ({ reason }) => {
      connection.disconnect();
      jobSync.stop();
      send('status', { connected: false, message: 'Signed out' });
      send('signed-out', { reason });
    });

    jobSync.init((snapshot) => send('jobs-changed', snapshot));

    registerIpcHandlers(getMainWindow, { onSignedIn: goOnline });
    initAutoUpdater(getMainWindow, {
      busy: () => {
        const q = queue.getQueueStatus();
        return q.total > 0 || Boolean(jobSync.snapshot().current);
      },
    });

    if (session.restore().signedIn) goOnline();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
