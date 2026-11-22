const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to a main-process event; returns an unsubscribe function. */
function listen(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Sign-in
  getSession: () => ipcRenderer.invoke('session:get'),
  signIn: () => ipcRenderer.invoke('session:sign-in'),
  signOut: () => ipcRenderer.invoke('session:sign-out'),
  onSessionChanged: (cb) => listen('session-changed', cb),
  onSignedOut: (cb) => listen('signed-out', cb),
  onStatus: (cb) => listen('status', cb),

  // Partner web API (/api/partner/... only); resolves { ok, status, data }
  api: (method, path, body) => ipcRenderer.invoke('api:request', { method, path, body }),
  // code: the customer's 4-digit delivery code, needed when the shop delivers itself
  updateOrderStatus: (orderId, status, code) =>
    ipcRenderer.invoke('api:request', { method: 'PATCH', path: `/api/partner/orders/${encodeURIComponent(orderId)}`, body: code === undefined ? { status } : { status, code } }),
  bookCourier: (orderId) =>
    ipcRenderer.invoke('api:request', { method: 'POST', path: `/api/partner/orders/${encodeURIComponent(orderId)}/ship` }),

  // Print jobs
  getJobs: () => ipcRenderer.invoke('jobs:get'),
  syncJobs: () => ipcRenderer.invoke('jobs:sync'),
  jobAction: (jobId, action, reason) => ipcRenderer.invoke('jobs:action', { jobId, action, reason }),
  setPaused: (paused) => ipcRenderer.invoke('jobs:set-paused', paused),
  onJobsChanged: (cb) => listen('jobs-changed', cb),
  onPrintStatus: (cb) => listen('print_status', cb),

  // Print again, printers
  printAgain: (order) => ipcRenderer.invoke('queue:print-again', order),
  getPrinters: () => ipcRenderer.invoke('printers:list'),
  refreshPrinters: () => ipcRenderer.invoke('printers:refresh'),
  updatePrinter: (id, patch) => ipcRenderer.invoke('printers:update', id, patch),
  onPrintersChanged: (cb) => listen('printers-changed', cb),
  // Preferences
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  onPrefsChanged: (cb) => listen('prefs-changed', cb),
  onNewOrder: (cb) => listen('new-order', cb),

  // Windows, updates, logs, errors
  openOrderWindow: (order) => ipcRenderer.send('open-order-window', order),
  onOrderData: (cb) => listen('order-data', cb),
  checkUpdates: () => ipcRenderer.send('check-updates'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  onUpdateMessage: (cb) => listen('update-message', cb),
  onSystemLog: (cb) => listen('system-log', cb),
  reportError: (report) => ipcRenderer.send('report-error', report),
  clearData: () => ipcRenderer.invoke('clear-data'),
});

// Renderer errors go to the error log too
window.addEventListener('error', (e) => {
  ipcRenderer.send('report-error', { name: e.error?.name, message: String(e.message || e.error?.message || 'Error'), stack: e.error?.stack, url: location.href });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  ipcRenderer.send('report-error', { name: r?.name, message: String(r?.message || r || 'Unhandled rejection'), stack: r?.stack, url: location.href });
});
