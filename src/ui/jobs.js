/**
 * Jobs page: orders to accept (manual shops), the job printing on this
 * computer, the shop's queue and jobs on other devices. Data comes from the
 * main process (src/main/jobSync.js), which follows the web API.
 */

function initJobs() {
  const notes = document.getElementById('jobs-notes');
  const currentBox = document.getElementById('jobs-current');
  const list = document.getElementById('jobs-list');
  const pauseBtn = document.getElementById('pause-btn');
  const refreshBtn = document.getElementById('refresh-jobs-btn');
  const navCount = document.getElementById('nav-jobs-count');
  let snapshot = null;
  let printMessage = '';
  const busy = new Set();

  function fileLine(files) {
    if (!files || !files.length) return '<div class="job-file">No files</div>';
    const f = files[0];
    const copies = f.copies || 1;
    const opts = `${f.pageSize || 'A4'} · ${f.color === 'color' ? 'Colour' : f.color === 'mixed' ? 'Mixed colour' : 'B&W'} · ${f.sided === 'double' ? 'Double-sided' : 'Single-sided'} · ${copies} ${copies === 1 ? 'copy' : 'copies'}`;
    const more = files.length > 1 ? ` <span class="muted">+${files.length - 1} more</span>` : '';
    return `<div class="job-file" title="${esc(f.name)}">${esc(f.name)}${more}</div><div class="job-meta">${esc(opts)}</div>`;
  }

  function jobCard(job, { tone, badge, note = '', actions = '' }) {
    return `
      <div class="card tone-${tone}">
        <div class="job">
          <div class="job-main">
            <div class="job-head">
              <span class="job-id">#${esc(job.deliveryNumber || job.orderId)}</span>
              ${pill(badge, tone === 'neutral' ? 'neutral' : tone)}
              <span class="job-meta">${esc(job.deliveryType === 'delivery' ? 'Delivery' : 'Pickup')} · ${esc(timeAgo(job.createdAt))}</span>
            </div>
            ${fileLine(job.files)}
            ${note}
          </div>
          ${actions ? `<div class="job-actions">${actions}</div>` : ''}
        </div>
      </div>`;
  }

  function section(title, html, foot = '') {
    if (!html) return '';
    return `<div class="section"><div class="section-head"><span class="section-title">${esc(title)}</span></div>${html}${foot ? `<div class="section-foot">${esc(foot)}</div>` : ''}</div>`;
  }

  function render() {
    const s = snapshot;
    if (!s) return;
    pauseBtn.innerHTML = s.paused ? `${icon('play')}<span>Resume printing</span>` : `${icon('pause')}<span>Pause printing</span>`;
    pauseBtn.classList.toggle('btn-primary', Boolean(s.paused));

    const jobs = s.jobs || [];
    const pending = jobs.filter((j) => j.status === 'pending_acceptance');
    navCount.textContent = pending.length > 9 ? '9+' : String(pending.length);
    navCount.classList.toggle('hidden', pending.length === 0);

    // Notes
    const n = [];
    if (s.deviceId) {
      if (!s.printerName) n.push(banner('info', 'Choose a printer to start printing', 'Open Settings and select the printer this computer should use.'));
      if (s.paused) n.push(banner('warning', 'Printing is paused', 'New jobs wait in your shop\'s queue until you resume.'));
      if (s.cooldownUntil) n.push(banner('danger', 'The last job failed', `It went back to your queue. The next job starts in ${timeLeft(s.cooldownUntil)}; check the printer.`));
      if (s.lastError) n.push(banner('warning', 'Can\'t reach FunPrinting', `${s.lastError}. Retrying automatically.`));
      if (s.pendingReports) n.push(banner('info', `${s.pendingReports} finished job(s) will be reported when the connection is back`));
    }
    notes.innerHTML = n.join('');
    notes.classList.toggle('hidden', n.length === 0);

    // Printing here
    const mine = s.current;
    if (mine) {
      const job = jobs.find((j) => j.jobId === mine.jobId) || mine;
      const done = mine.files.filter((f) => f.done).length;
      const pct = Math.round((done / mine.files.length) * 100);
      currentBox.innerHTML = section(
        'Printing on this computer',
        jobCard(job, {
          tone: 'primary',
          badge: 'Printing',
          note: `<div class="job-meta">File ${Math.min(done + 1, mine.files.length)} of ${mine.files.length}${printMessage ? ` · ${esc(printMessage)}` : ''}</div><div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${Math.max(pct, 4)}%"></div></div>`,
        })
      );
    } else {
      currentBox.innerHTML = '';
    }

    const waiting = jobs.filter((j) => j.status === 'queued' || j.status === 'failed');
    const elsewhere = jobs.filter((j) => (j.status === 'claimed' || j.status === 'printing') && j.claimedBy !== s.deviceId);

    const pendingHtml = pending
      .map((j) => {
        const off = busy.has(j.jobId) ? 'disabled' : '';
        const left = j.acceptBy ? timeLeft(j.acceptBy) : '';
        return jobCard(j, {
          tone: 'warning',
          badge: 'Needs your OK',
          note: left ? `<div class="job-note" style="color:var(--warning)">${left === 'now' ? 'The customer has been offered a refund. You can still accept.' : `Accept within ${esc(left)}, or the customer is offered a refund.`}</div>` : '',
          actions: `<button ${off} class="btn btn-danger" data-action="reject" data-job="${esc(j.jobId)}">Decline</button><button ${off} class="btn btn-primary" data-action="accept" data-job="${esc(j.jobId)}">${icon('check', 'icon-sm')}Accept</button>`,
        });
      })
      .join('');

    const waitingHtml = waiting
      .map((j) =>
        jobCard(j, {
          tone: j.status === 'failed' ? 'danger' : 'neutral',
          badge: j.status === 'failed' ? 'Failed, will retry' : 'Waiting',
          note: j.lastError ? `<div class="job-note" style="color:var(--danger)">${esc(j.lastError)}</div>` : '',
        })
      )
      .join('');

    const elsewhereHtml = elsewhere.map((j) => jobCard(j, { tone: 'info', badge: 'On another device' })).join('');

    const html =
      section('Needs your OK', pendingHtml) + section('Waiting to print', waitingHtml) + section('On other devices', elsewhereHtml, 'Another computer or phone of your shop is printing these.');

    list.innerHTML =
      html ||
      (mine
        ? ''
        : emptyState('inbox', s.deviceId ? 'No print jobs right now' : 'Sign in to see your print jobs', 'New paid orders appear here and print automatically. Keep your shop online in the Shop page to receive them.'));
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const jobId = btn.dataset.job;
    const action = btn.dataset.action;
    let reason;
    if (action === 'reject') {
      reason = await ask({
        title: 'Decline this order?',
        message: 'The customer is refunded straight away.',
        ok: 'Decline order',
        cancel: 'Keep order',
        danger: true,
        input: { label: 'Reason (optional, for your records)', placeholder: 'e.g. Printer out of colour ink' },
      });
      if (reason === null) return;
    }
    busy.add(jobId);
    render();
    const result = await window.electronAPI.jobAction(jobId, action, reason || undefined);
    busy.delete(jobId);
    if (!result.ok) await ask({ title: `Could not ${action === 'accept' ? 'accept' : 'decline'} the order`, message: result.error, cancel: null });
    else toast(action === 'accept' ? 'Order accepted. It will print shortly.' : 'Order declined. The customer is being refunded.');
    render();
  });

  pauseBtn.addEventListener('click', async () => {
    snapshot = await window.electronAPI.setPaused(!(snapshot && snapshot.paused));
    render();
  });

  refreshBtn.addEventListener('click', async () => {
    setBusy(refreshBtn, true, 'Refreshing');
    snapshot = await window.electronAPI.syncJobs();
    setBusy(refreshBtn, false);
    render();
  });

  window.electronAPI.onJobsChanged((next) => {
    if (!next.current || (snapshot && snapshot.current && snapshot.current.jobId !== next.current.jobId)) printMessage = '';
    snapshot = next;
    render();
    window.dispatchEvent(new CustomEvent('fp:jobs', { detail: next }));
  });

  window.electronAPI.onPrintStatus((data) => {
    printMessage = data.status || '';
    render();
  });

  window.electronAPI.getJobs().then((s) => {
    snapshot = s;
    render();
    window.dispatchEvent(new CustomEvent('fp:jobs', { detail: s }));
  });

  // Keep countdowns fresh
  setInterval(render, 30000);
}
