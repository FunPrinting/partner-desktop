/**
 * Order detail window — separate BrowserWindow with PDF header interception
 */

const { BrowserWindow, nativeTheme } = require('electron');
const path = require('path');

const orderWindows = {};

function openOrderWindow(order) {
  if (orderWindows[order.orderId]) {
    orderWindows[order.orderId].focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 820,
    minHeight: 600,
    autoHideMenuBar: true,
    title: `Order #${order.orderId}`,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      plugins: true
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111113' : '#f4f4f5'
  });

  // Force PDFs to display inline in preview iframe, allow downloads in new tabs
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url;
    let headers = details.responseHeaders;

    if (url.includes('cloudinary.com') || url.includes('firebasestorage') ||
        url.includes('r2.cloudflarestorage') || url.includes('.pdf') || url.includes('storage')) {
      if (headers) {
        if (details.resourceType === 'subFrame') {
          // Inside preview iframe — force inline display
          if (headers['content-disposition']) headers['content-disposition'] = ['inline'];
          if (headers['Content-Disposition']) headers['Content-Disposition'] = ['inline'];
          if (headers['content-type'] && headers['content-type'][0].includes('octet-stream')) {
            headers['content-type'] = ['application/pdf'];
          }
          if (headers['Content-Type'] && headers['Content-Type'][0].includes('octet-stream')) {
            headers['Content-Type'] = ['application/pdf'];
          }
        }
        else if (details.resourceType === 'mainFrame' && !url.includes('order-window.html')) {
          // Download button — force attachment
          const contentDispStr = `attachment; filename="document.pdf"`;
          if (headers['content-disposition']) headers['content-disposition'] = [contentDispStr];
          else if (headers['Content-Disposition']) headers['Content-Disposition'] = [contentDispStr];
          else headers['Content-Disposition'] = [contentDispStr];
        }
      }
    }
    callback({ responseHeaders: headers });
  });

  const platform = process.platform === 'darwin' ? 'platform-mac' : process.platform === 'win32' ? 'platform-win' : 'platform-linux';
  win.loadFile(path.join(__dirname, '..', '..', 'order-window.html'), { query: { platform } });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('order-data', order);
  });

  win.on('closed', () => {
    delete orderWindows[order.orderId];
  });

  orderWindows[order.orderId] = win;
}

module.exports = { openOrderWindow };
