/**
 * main.js — Electron entry point (orchestrator)
 *
 * The actual implementation lives in:
 *   src/main/window.js        — BrowserWindow creation + console log interception
 *   src/main/updater.js       — Auto-updater event wiring
 *   src/main/jobProcessor.js  — Incoming job dedup/normalization/dispatch
 *   src/main/orderWindow.js   — Order detail window + PDF header interception
 *   src/main/auth.js          — OAuth server + WSS login + remote control
 *   src/main/ipcHandlers.js   — All IPC handler registrations
 */

const { app, BrowserWindow } = require('electron');
const { createWindow, getMainWindow } = require('./src/main/window');
const { initAutoUpdater } = require('./src/main/updater');
const { registerIpcHandlers } = require('./src/main/ipcHandlers');

app.whenReady().then(() => {
  // Grant geolocation permission for map
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'geolocation');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'geolocation';
  });

  createWindow();

  // Wire up auto-updater events
  initAutoUpdater(getMainWindow);

  // Register all IPC handlers
  registerIpcHandlers(getMainWindow);

  // Set up job completion callback for UI notification
  try {
    const printQueue = require('./chrome-queue');
    printQueue.setOnJobCompleteCallback((job) => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('job-completed', job);
      }
    });
  } catch (e) {
    console.error("Failed to set up job complete callback", e);
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
