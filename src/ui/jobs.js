/**
 * Print jobs panel: orders to accept (manual shops), the job printing on this
 * computer, and the shop's queue. Everything comes from the main process
 * (src/main/jobSync.js), which follows the web API.
 */

function initJobs() {
  const container = document.getElementById('queue-container');
  const toolbar = document.getElementById('jobs-toolbar');
  const pauseBtn = document.getElementById('pause-btn');
  const refreshBtn = document.getElementById('refresh-jobs-btn');
  let snapshot = null;
  let printMessage = '';
  const busy = new Set();

  function fileSummary(files) {
    if (!files || !files.length) return 'No files';
    const f = files[0];
    const opts = `${f.pageSize || 'A4'} · ${f.color === 'color' ? 'Colour' : f.color === 'mixed' ? 'Mixed colour' : 'B&W'} · ${f.sided === 'double' ? 'Double-sided' : 'Single-sided'} · ${f.copies || 1} cop${(f.copies || 1) === 1 ? 'y' : 'ies'}`;
    const more = files.length > 1 ? ` (+${files.length - 1} more file${files.length > 2 ? 's' : ''})` : '';
    return `${esc(f.name)}${esc(more)}<br><span class="text-gray-500">${esc(opts)}</span>`;
  }

  function card(job, { tone = 'indigo', badge, body = '', actions = '' }) {
    return `
      <div class="glass-panel rounded-xl p-4 border-l-4 border-l-${tone}-500 shadow-sm">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="font-bold text-gray-900">#${esc(job.deliveryNumber || job.orderId)}</h3>
              <span class="px-2 py-0.5 rounded text-xs font-medium bg-${tone}-100 text-${tone}-700">${esc(badge)}</span>
              <span class="text-xs text-gray-500">${esc(job.deliveryType === 'delivery' ? 'Delivery' : 'Pickup')} · ${esc(timeAgo(job.createdAt))}</span>
            </div>
            <p class="text-sm text-gray-700 break-words">${fileSummary(job.files)}</p>
            ${body}
          </div>
          <div class="flex flex-col gap-2 shrink-0">${actions}</div>
        </div>
      </div>`;
  }

  function section(title, html) {
    return html ? `<h3 class="text-xs font-bold uppercase tracking-wider text-gray-500 mt-2">${esc(title)}</h3>${html}` : '';
  }

  function render() {
    const s = snapshot;
    if (!s) return;
    pauseBtn.innerText = s.paused ? 'Resume printing' : 'Pause printing';
    pauseBtn.classList.toggle('bg-yellow-500', s.paused);

    const notes = [];
    if (!s.deviceId) notes.push('Sign in to receive print jobs.');
    else {
      if (!s.printerName) notes.push('Choose a printer on the left to start printing jobs.');
      if (s.paused) notes.push('Printing is paused. New jobs wait in your shop\'s queue.');
      if (s.cooldownUntil) notes.push(`The last job failed. The next job starts in ${timeLeft(s.cooldownUntil)}; check the printer.`);
      if (s.lastError) notes.push(`Can't reach FunPrinting: ${s.lastError}`);
      if (s.pendingReports) notes.push(`${s.pendingReports} finished job(s) will be reported when the connection is back.`);
    }
    toolbar.innerHTML = notes.map((n) => `<p class="text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">${esc(n)}</p>`).join('') +
      (s.lastSyncAt ? `<p class="text-xs text-gray-400">Updated ${esc(new Date(s.lastSyncAt).toLocaleTimeString())}</p>` : '');

    const jobs = s.jobs || [];
    const mine = s.current;
    const pending = jobs.filter((j) => j.status === 'pending_acceptance');
    const waiting = jobs.filter((j) => j.status === 'queued' || j.status === 'failed');
    const elsewhere = jobs.filter((j) => (j.status === 'claimed' || j.status === 'printing') && j.claimedBy !== s.deviceId);

    const pendingHtml = pending
      .map((j) => {
        const off = busy.has(j.jobId) ? 'disabled' : '';
        return card(j, {
          tone: 'yellow',
          badge: 'Needs your OK',
          body: j.acceptBy ? `<p class="text-xs text-yellow-700 mt-1">Accept within ${esc(timeLeft(j.acceptBy))}, or the customer is offered a refund.</p>` : '',
          actions: `<button ${off} data-action="accept" data-job="${esc(j.jobId)}" class="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-bold rounded">Accept</button>
                    <button ${off} data-action="reject" data-job="${esc(j.jobId)}" class="px-3 py-1.5 bg-white border border-red-300 text-red-600 hover:bg-red-50 text-xs font-bold rounded">Decline</button>`,
        });
      })
      .join('');

    let currentHtml = '';
    if (mine) {
      const job = jobs.find((j) => j.jobId === mine.jobId) || { ...mine, files: mine.files };
      const done = mine.files.filter((f) => f.done).length;
      currentHtml = card(job, {
        tone: 'blue',
        badge: 'Printing here',
        body: `<p class="text-xs text-gray-600 mt-2">File ${Math.min(done + 1, mine.files.length)} of ${mine.files.length}${printMessage ? ` · ${esc(printMessage)}` : ''}</p>
               <div class="w-full bg-gray-100 rounded-full h-2 mt-1"><div class="bg-blue-500 h-2 rounded-full" style="width:${Math.round((done / mine.files.length) * 100)}%"></div></div>`,
      });
    }

    const waitingHtml = waiting
      .map((j) =>
        card(j, {
          tone: j.status === 'failed' ? 'red' : 'gray',
          badge: j.status === 'failed' ? 'Failed, will retry' : 'Waiting',
          body: j.lastError ? `<p class="text-xs text-red-600 mt-1">${esc(j.lastError)}</p>` : '',
        })
      )
      .join('');

    const elsewhereHtml = elsewhere.map((j) => card(j, { tone: 'purple', badge: 'On another computer' })).join('');

    const html =
      section('Needs your OK', pendingHtml) +
      section('Printing on this computer', currentHtml) +
      section('Waiting', waitingHtml) +
      section('On other computers', elsewhereHtml);

    container.innerHTML =
      html ||
      `<div class="flex flex-col items-center justify-center h-full text-gray-500">
         <p>${s.deviceId ? 'No print jobs right now. New orders appear here automatically.' : 'Sign in to see your print jobs.'}</p>
       </div>`;
  }

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const jobId = btn.dataset.job;
    const action = btn.dataset.action;
    let reason;
    if (action === 'reject') {
      if (!confirm('Decline this order? The customer is refunded straight away.')) return;
      reason = prompt('Reason (optional, shown to the customer):') || undefined;
    }
    busy.add(jobId);
    render();
    const result = await window.electronAPI.jobAction(jobId, action, reason);
    busy.delete(jobId);
    if (!result.ok) alert(`Could not ${action} the order: ${result.error}`);
    render();
  });

  pauseBtn.addEventListener('click', async () => {
    snapshot = await window.electronAPI.setPaused(!(snapshot && snapshot.paused));
    render();
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    snapshot = await window.electronAPI.syncJobs();
    refreshBtn.disabled = false;
    render();
  });

  window.electronAPI.onJobsChanged((next) => {
    if (!next.current || (snapshot && snapshot.current && snapshot.current.jobId !== next.current.jobId)) printMessage = '';
    snapshot = next;
    render();
  });

  window.electronAPI.onPrintStatus((data) => {
    printMessage = data.status || '';
    render();
  });

  window.electronAPI.getJobs().then((s) => {
    snapshot = s;
    render();
  });

  // Keep countdowns fresh
  setInterval(render, 30000);
}
