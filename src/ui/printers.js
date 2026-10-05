/**
 * Printer detection UI + live logs + dev mode toggle
 */

function initPrinters() {
  let activePrinterName = null;
  let printersCache = null;

  window.togglePrinter = function(printerName) {
    if (!printersCache) return;

    const printer = printersCache.find(p => p.name === printerName);
    if (printer) {
      if (typeof printer.status === 'number' && printer.status !== 0) {
        const proceed = confirm(`Warning: The printer "${printer.name}" returned a non-ready status code (${printer.status}). It might be offline, out of paper, or currently busy.\n\nDo you still want to make it the active printer?`);
        if (!proceed) return;
      }
    }

    activePrinterName = printerName;
    localStorage.setItem('activePrinterName', printerName);
    window.electronAPI.setActivePrinter(printerName);
    loadPrinters(printersCache);
  };

  async function loadPrinters(cached = null) {
    const listEl = document.getElementById('printers-list');
    if (!listEl) return;

    if (!activePrinterName) {
      activePrinterName = localStorage.getItem('activePrinterName');
    }

    if (!cached) {
      listEl.innerHTML = '<div class="text-sm text-gray-500 text-center py-2">Scanning printers...</div>';
    }

    try {
      const printers = cached || await window.electronAPI.getPrinters();
      printersCache = printers;
      listEl.innerHTML = '';

      if (!printers || printers.length === 0) {
        listEl.innerHTML = '<div class="text-sm text-red-600 text-center py-2">No printers found on this system.</div>';
        return;
      }

      printers.forEach(printer => {
        if (!activePrinterName && printer.isDefault) {
          activePrinterName = printer.name;
          localStorage.setItem('activePrinterName', printer.name);
          window.electronAPI.setActivePrinter(printer.name);
        } else if (activePrinterName === printer.name) {
          window.electronAPI.setActivePrinter(printer.name);
        }

        const isActive = (activePrinterName === printer.name);
        const bgClass = isActive ? 'bg-indigo-900/40 border-blue-500' : 'bg-white/50 border-gray-200';
        const statusText = isActive ? 'Active Server' : 'Inactive';
        const statusColor = isActive ? 'text-green-700' : 'text-gray-500';
        const dotColor = isActive ? 'bg-green-500' : 'bg-gray-600';

        listEl.innerHTML += `
          <div onclick="window.togglePrinter('${printer.name.replace(/'/g, "\\'")}')" class="flex items-center justify-between p-3 rounded-lg border cursor-pointer hover:bg-gray-100 transition-colors ${bgClass}">
            <div class="flex items-center gap-3">
              <svg class="w-5 h-5 ${isActive ? 'text-blue-600' : 'text-gray-500'} shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
              <div class="overflow-hidden">
                <p class="font-medium text-sm truncate" title="${printer.name}">${printer.name}</p>
                <p class="text-xs ${statusColor} font-semibold">${statusText}</p>
              </div>
            </div>
            <div class="w-3 h-3 rounded-full ${dotColor} shrink-0"></div>
          </div>
        `;
      });
    } catch (err) {
      console.error(err);
      listEl.innerHTML = '<div class="text-sm text-red-600 text-center py-2">Failed to scan printers.</div>';
    }
  }

  // Expose for the Refresh button onclick
  window.loadPrinters = loadPrinters;

  // Load on startup
  loadPrinters();
}

function initLiveLogs() {
  const liveLogs = document.getElementById('live-logs');
  const clearLogsBtn = document.getElementById('clear-logs-btn');

  if (window.electronAPI.onSystemLog) {
    window.electronAPI.onSystemLog((logData) => {
      const div = document.createElement('div');
      const time = new Date(logData.timestamp).toLocaleTimeString();

      let colorClass = 'text-gray-300';
      if (logData.level === 'error') colorClass = 'text-red-400';
      if (logData.level === 'warn') colorClass = 'text-yellow-400';

      div.innerHTML = `<span class="text-gray-500">[${time}]</span> <span class="${colorClass}">${logData.message}</span>`;
      liveLogs.appendChild(div);

      if (liveLogs.scrollHeight - liveLogs.scrollTop <= liveLogs.clientHeight + 100) {
        liveLogs.scrollTop = liveLogs.scrollHeight;
      }
    });
  }

  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', () => {
      liveLogs.innerHTML = '<div class="text-gray-500 italic">Logs cleared.</div>';
    });
  }
}

function initDevMode() {
  const liveLogsContainer = document.getElementById('live-logs-container');
  const isDevMode = localStorage.getItem('devMode') === 'true';
  if (isDevMode && liveLogsContainer) {
    liveLogsContainer.classList.remove('hidden');
  }

  document.getElementById('set-dev-mode').checked = isDevMode;
  document.getElementById('set-dev-mode').addEventListener('change', (e) => {
    const checked = e.target.checked;
    localStorage.setItem('devMode', checked);
    if (liveLogsContainer) {
      if (checked) {
        liveLogsContainer.classList.remove('hidden');
      } else {
        liveLogsContainer.classList.add('hidden');
      }
    }
  });
}
