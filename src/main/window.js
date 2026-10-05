/**
 * Window creation + console log interception
 */

const { BrowserWindow } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, '..', '..', 'assets', 'logo.jpg'),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    title: "FunPrinting Partner Desktop",
    backgroundColor: '#111827'
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'));
  _interceptConsoleLogs();
  return mainWindow;
}

function getMainWindow() {
  return mainWindow;
}

/**
 * Forward console.log/error/warn to the renderer's Live Logs panel
 */
function _interceptConsoleLogs() {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  function sendLogToFrontend(level, ...args) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      ).join(' ');
      try {
        mainWindow.webContents.send('system-log', { level, message, timestamp: new Date().toISOString() });
      } catch (e) {}
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

module.exports = { createWindow, getMainWindow };
