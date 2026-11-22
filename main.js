/**
 * main.js — Electron entry point.
 *
 *   src/main/config.js        server addresses (FP_WEB_URL, FP_WSS_URL)
 *   src/main/prefs.js         user preferences (theme, notifications, printer…)
 *   src/main/session.js       sign-in (code + PKCE), token refresh, API calls
 *   src/main/tokenStore.js    tokens encrypted with the OS keychain
 *   src/main/connection.js    socket to the relay (change notifications only)
 *   src/main/jobSync.js       print jobs from the API -> local print queue
 *   src/main/errorReporter.js errors -> web app error log
 *   src/main/ipcHandlers.js   IPC for the windows
 *   src/main/window.js, orderWindow.js, updater.js, tray.js
 *   src/print/                print engine (Windows: native add-on, macOS/Linux: CUPS)
 */
const { app, BrowserWindow, nativeTheme, session: electronSession } = require('electron');
const { createWindow, getMainWindow } = require('./src/main/window');
const errorReporter = require('./src/main/errorReporter');

errorReporter.installGlobalHandlers();

let quitting = false;
let onNewWindow = () => {};

// Diagnostics: check printers and the print engine, print a report, exit
if (process.argv.includes('--self-test')) {
  app.whenReady().then(async () => app.exit(await require('./src/main/selfTest').runSelfTest(app)));
} else if (!app.requestSingleInstanceLock()) {
  // One instance only: two would fight over the sign-in port and the print queue
  app.quit();
} else {
  const showWindow = () => {
    let win = getMainWindow();
    if (!win) {
      win = createWindow();
      onNewWindow(win);
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });

  app.whenReady().then(async () => {
    // On macOS, register this app with the application firewall so printer
    // discovery (mDNS, IPP sweeps) isn't silently blocked with EHOSTUNREACH.
    // This must run before any network I/O (printer scans, relay connection).
    if (process.platform === 'darwin') {
      const { ensureFirewallAccess } = require('./src/main/firewall');
      const fw = await ensureFirewallAccess().catch((err) => ({ action: 'error', reason: err.message }));
      console.log('Firewall check:', JSON.stringify(fw));
    }

    const prefs = require('./src/main/prefs');
    const session = require('./src/main/session');
    const connection = require('./src/main/connection');
    const jobSync = require('./src/main/jobSync');
    const { createPrintService } = require('./src/print/service');
    const { powerMonitor } = require('electron');
    const tray = require('./src/main/tray');
    const { initAutoUpdater } = require('./src/main/updater');
    const { registerIpcHandlers } = require('./src/main/ipcHandlers');

    // The shop map in settings uses geolocation; nothing else is granted
    electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'geolocation');
    });
    electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'geolocation');

    const trayActions = {
      show: showWindow,
      isPaused: () => jobSync.snapshot().paused,
      setPaused: (v) => jobSync.setPaused(v),
    };

    // ── Preferences that act in the main process ────────────────────
    const applyPrefs = (p, changed = p) => {
      if ('theme' in changed) nativeTheme.themeSource = p.theme;
      if ('openAtLogin' in changed && (process.platform === 'darwin' || process.platform === 'win32') && app.getLoginItemSettings().openAtLogin !== p.openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: p.openAtLogin });
      }
      if ('keepRunningInTray' in changed) (p.keepRunningInTray ? tray.enableTray(trayActions) : tray.disableTray());
    };

    const send = (channel, data) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    };

    const printService = createPrintService({
      prefs,
      dataDir: app.getPath('userData'),
      powerMonitor,
      onStatus: (status) => {
        jobSync.onRunnerStatus(status);
        send('print_status', status);
      },
    });
    printService.registry.events.on('changed', (printers) => send('printers-changed', printers));
    printService.registry.events.on('available', (printers) => send('printers-changed', printers));

    const printerReporter = require('./src/main/printerReport').createPrinterReporter({ registry: printService.registry });

    const wireWindow = (win) => {
      // "Keep printing when the window is closed": hide instead of closing
      win.on('close', (event) => {
        if (!quitting && prefs.get().keepRunningInTray) {
          event.preventDefault();
          win.hide();
        }
      });
    };

    onNewWindow = wireWindow;
    wireWindow(createWindow());
    errorReporter.setTokenProvider(() => session.getAccessTokenSync());

    const goOnline = () => {
      connection.connect();
      jobSync.start();
      printerReporter.reset();
      printerReporter.schedule();
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

    jobSync.init(
      (snapshot) => {
        send('jobs-changed', snapshot);
        tray.refreshTray(trayActions);
      },
      { newOrder: (job) => send('new-order', { jobId: job.jobId, orderId: job.orderId }), printService }
    );

    applyPrefs(prefs.get());
    prefs.events.on('changed', (p, changed) => {
      applyPrefs(p, changed);
      send('prefs-changed', p);
    });

    registerIpcHandlers(getMainWindow, { onSignedIn: goOnline, printService });
    printService.start().catch((err) => errorReporter.reportError(err));
    initAutoUpdater(getMainWindow, {
      busy: () => Boolean(jobSync.snapshot().current),
    });

    if (session.restore().signedIn) goOnline();

    app.on('activate', () => {
      showWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
