/**
 * Auto-updates. A downloaded update is installed only when nothing is printing,
 * so a restart never cuts a job in half.
 */
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let isBusy = () => false;
let installTimer = null;

function send(getMainWindow, message) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('update-message', message);
}

function initAutoUpdater(getMainWindow, { busy } = {}) {
  if (busy) isBusy = busy;
  autoUpdater.on('update-available', () => send(getMainWindow, 'Update available. Downloading…'));
  autoUpdater.on('update-not-available', () => send(getMainWindow, 'App is up to date.'));
  autoUpdater.on('error', (err) => {
    console.error('Update error:', err.message);
    send(getMainWindow, 'Update check failed. Try again later.');
  });
  autoUpdater.on('download-progress', (p) => send(getMainWindow, `Downloading… ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', () => {
    const tryInstall = () => {
      if (isBusy()) {
        send(getMainWindow, 'Update ready. It installs when printing finishes.');
        return;
      }
      clearInterval(installTimer);
      send(getMainWindow, 'Installing update and restarting…');
      setTimeout(() => autoUpdater.quitAndInstall(), 2000);
    };
    clearInterval(installTimer);
    installTimer = setInterval(tryInstall, 60_000);
    tryInstall();
  });
}

function checkForUpdates(getMainWindow) {
  send(getMainWindow, 'Checking for updates…');
  autoUpdater.checkForUpdatesAndNotify().catch((err) => console.error('Update check failed:', err.message));
}

module.exports = { initAutoUpdater, checkForUpdates };
