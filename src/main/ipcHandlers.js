/**
 * All IPC handlers — registers ipcMain.on/handle listeners
 */

const { ipcMain } = require('electron');
const { processIncomingJob } = require('./jobProcessor');
const { openOrderWindow } = require('./orderWindow');
const { checkForUpdates } = require('./updater');
const { startOAuth, login, getToken, getActiveJobs } = require('./auth');

let activePrinterName = null;

function registerIpcHandlers(getMainWindow) {
  // ── Queue ──────────────────────────────────────────────────────────

  ipcMain.handle('get-queue', async () => {
    try {
      const printQueue = require('../../chrome-queue');
      const status = printQueue.getQueueStatus();
      return status.jobs.map(qj => ({
        jobId: qj.job?.orderId || qj.id,
        orderId: qj.job?.orderId || qj.id,
        url: qj.job?.fileUrl,
        options: qj.job?.printingOptions,
        status: qj.status
      }));
    } catch (e) {
      console.error("Failed to read queue for UI", e);
    }
    return [];
  });

  ipcMain.on('clear-data', () => {
    try {
      const printQueue = require('../../chrome-queue');
      printQueue.clearQueue();
      const { getSocket } = require('./auth');
      const socket = getSocket();
      if (socket) socket.disconnect();
      console.log("App data and queue cleared successfully");
    } catch (e) {
      console.error("Failed to clear app data", e);
    }
  });

  // ── Job Injection ──────────────────────────────────────────────────

  ipcMain.on('inject_job', async (event, job) => {
    processIncomingJob(job, 'Local UI', getMainWindow);
  });

  ipcMain.on('cancel_job', async (event, jobId) => {
    console.log(`🛑 Cancelling job from Local UI: ${jobId}`);
    try {
      const printQueue = require('../../chrome-queue');
      printQueue.removeJob(jobId);
    } catch (err) {
      console.error('Failed to remove job from queue:', err);
    }
  });

  // ── Order Window ───────────────────────────────────────────────────

  ipcMain.on('open-order-window', (event, order) => {
    openOrderWindow(order);
  });

  // ── Updates ────────────────────────────────────────────────────────

  ipcMain.on('check-updates', () => {
    checkForUpdates(getMainWindow);
  });

  // ── Printers ───────────────────────────────────────────────────────

  ipcMain.handle('get-printers', async () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      return await mainWindow.webContents.getPrintersAsync();
    }
    return [];
  });

  ipcMain.on('set_active_printer', (event, printerName) => {
    activePrinterName = printerName;
    process.env.PRINTER_NAME = printerName;
    console.log(`🖨️ Active printer set to: ${activePrinterName}`);
  });

  // ── OAuth + Login ──────────────────────────────────────────────────

  ipcMain.on('start-oauth', () => {
    startOAuth(getMainWindow);
  });

  ipcMain.on('login', (event, { token: authToken, partnerId }) => {
    login(authToken, partnerId, getMainWindow);
  });

  // ── Order Status ───────────────────────────────────────────────────

  ipcMain.handle('update_order_status', async (event, { jobId, status }) => {
    try {
      console.log(`Phase 4: Updating order ${jobId} to ${status}`);
      const res = await fetch(`https://www.funprinting.store/api/partner/orders/${jobId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`
        },
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      return data;
    } catch (error) {
      console.error('Failed to update status:', error);
      return { success: false };
    }
  });

  // ── Resume Print ───────────────────────────────────────────────────

  ipcMain.on('resume_print', (event, { jobId }) => {
    console.log(`Phase 7: Manual Resume triggered for Job ${jobId}`);
    const activeJobs = getActiveJobs();
    const jobState = activeJobs.get(jobId);
    if (jobState && jobState.resumeFn) {
      jobState.resumeFn();
    }
  });
}

module.exports = { registerIpcHandlers };
