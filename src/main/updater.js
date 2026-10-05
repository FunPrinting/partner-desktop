/**
 * Auto-updater event wiring
 */

const { autoUpdater } = require('electron-updater');

// Configure
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function initAutoUpdater(getMainWindow) {
  autoUpdater.on('update-available', () => {
    getMainWindow().webContents.send('update-message', 'Update available. Downloading...');
  });

  autoUpdater.on('update-not-available', () => {
    getMainWindow().webContents.send('update-message', 'App is up to date.');
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err.message);
    getMainWindow().webContents.send('update-message', 'Update check failed. You may be on the latest version.');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    getMainWindow().webContents.send('update-message', `Downloading... ${Math.round(progressObj.percent)}%`);
  });

  autoUpdater.on('update-downloaded', () => {
    getMainWindow().webContents.send('update-message', 'Update downloaded. Restarting...');
    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 2000);
  });
}

function checkForUpdates(getMainWindow) {
  getMainWindow().webContents.send('update-message', 'Checking for updates...');
  autoUpdater.checkForUpdatesAndNotify();
}

module.exports = { initAutoUpdater, checkForUpdates };
