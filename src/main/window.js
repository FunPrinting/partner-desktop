/**
 * Main window + console log forwarding.
 *
 * Uses the platform window materials: a translucent sidebar on macOS
 * (vibrancy, inset traffic lights) and Mica on Windows 11. Elsewhere the window
 * is opaque. The page draws its own surfaces on top (see src/ui/styles.css).
 */
const { BrowserWindow, nativeTheme, shell } = require('electron');
const os = require('os');
const path = require('path');

let mainWindow = null;

function isWindows11() {
  if (process.platform !== 'win32') return false;
  const build = Number(String(os.release()).split('.')[2] || 0);
  return build >= 22621; // 22H2: first build with setBackgroundMaterial
}

function platformClass() {
  if (process.platform === 'darwin') return 'platform-mac';
  if (isWindows11()) return 'platform-win11';
  return process.platform === 'win32' ? 'platform-win' : 'platform-linux';
}

function windowOptions() {
  const base = {
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'logo.jpg'),
    title: 'FunPrinting Partner',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };
  if (process.platform === 'darwin') {
    return { ...base, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' };
  }
  if (isWindows11()) {
    return { ...base, backgroundMaterial: 'mica', backgroundColor: '#00000000', autoHideMenuBar: true };
  }
  return { ...base, backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181B' : '#F4F4F5', autoHideMenuBar: true };
}

function createWindow() {
  mainWindow = new BrowserWindow(windowOptions());
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());

  // Links open in the browser; the app window never navigates away from the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'), { query: { platform: platformClass() } });
  _interceptConsoleLogs();
  return mainWindow;
}

function getMainWindow() {
  return mainWindow;
}

let intercepted = false;
/** Forward console.log/error/warn to the window's log panel (developer mode). */
function _interceptConsoleLogs() {
  if (intercepted) return;
  intercepted = true;
  const original = { log: console.log, error: console.error, warn: console.warn };
  const send = (level, args) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const message = args.map((a) => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
    try {
      mainWindow.webContents.send('system-log', { level, message, timestamp: new Date().toISOString() });
    } catch {
      // window closing
    }
  };
  console.log = (...args) => {
    original.log.apply(console, args);
    send('info', args);
  };
  console.error = (...args) => {
    original.error.apply(console, args);
    send('error', args);
  };
  console.warn = (...args) => {
    original.warn.apply(console, args);
    send('warn', args);
  };
}

module.exports = { createWindow, getMainWindow };
