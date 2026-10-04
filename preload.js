const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  login: (credentials) => ipcRenderer.send('login', credentials),
  onStatus: (callback) => ipcRenderer.on('status', (_event, data) => callback(data)),
  onIncomingJob: (callback) => ipcRenderer.on('incoming_job', (_event, data) => callback(data)),
  onPrintStatus: (callback) => ipcRenderer.on('print_status', (_event, data) => callback(data)),
  updateOrderStatus: (jobId, status) => ipcRenderer.invoke('update_order_status', { jobId, status }),
  resumePrint: (jobId) => ipcRenderer.send('resume_print', { jobId }),
  startOAuth: () => ipcRenderer.send('start-oauth'),
  onOAuthSuccess: (callback) => ipcRenderer.on('oauth-success', (_event, data) => callback(data)),
  checkUpdates: () => ipcRenderer.send('check-updates'),
  onUpdateMessage: (callback) => ipcRenderer.on('update-message', (_event, data) => callback(data)),
  setPrintEngine: (engine) => ipcRenderer.send('set_engine', engine),
  onAuthSuccess: (callback) => ipcRenderer.on('auth-success', (_event, data) => callback(data)),
  getPrinters: () => ipcRenderer.invoke('get-printers')
});
