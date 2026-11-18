/**
 * Settings page: account, printer, printing / notification / appearance /
 * startup options, updates, developer mode and clearing app data.
 * Options are stored in the main process (src/main/prefs.js).
 */

function initSettings({ getPrefs, setPrefs }) {
  const $ = (id) => document.getElementById(id);
  const printersList = $('printers-list');
  let printers = [];

  // ── Printers ────────────────────────────────────────────────────────

  function statusText(p) {
    // Electron reports a numeric status on some systems; 0 means ready
    if (typeof p.status === 'number' && p.status !== 0) return 'May be offline or busy';
    return p.isDefault ? 'System default' : '';
  }

  function renderPrinters() {
    const active = getPrefs().printerName;
    if (!printers.length) {
      printersList.innerHTML = `<div class="row"><div class="row-main"><div class="row-title">No printers found</div><div class="row-sub">Connect a printer and add it in your system settings, then click Refresh.</div></div></div>`;
      return;
    }
    printersList.innerHTML = printers
      .map((p) => {
        const checked = p.name === active;
        const sub = statusText(p);
        return `<button class="printer" role="radio" aria-checked="${checked}" data-printer="${esc(p.name)}">
          <span class="radio"></span>
          ${icon('printer')}
          <span class="row-main"><span class="row-title" style="display:block">${esc(p.displayName || p.name)}</span>${sub ? `<span class="row-sub" style="display:block">${esc(sub)}</span>` : ''}</span>
          ${checked ? pill('In use', 'primary') : ''}
        </button>`;
      })
      .join('');
  }

  async function loadPrinters() {
    printersList.innerHTML = `<div class="row"><div class="row-main muted">Looking for printers…</div></div>`;
    try {
      printers = (await window.electronAPI.getPrinters()) || [];
    } catch {
      printers = [];
    }
    let active = getPrefs().printerName;
    // From the earlier app version
    const legacy = localStorage.getItem('activePrinterName');
    if (!active && legacy) {
      active = legacy;
      localStorage.removeItem('activePrinterName');
    }
    // The chosen printer was removed: fall back to the system default
    if (active && !printers.some((p) => p.name === active)) active = null;
    if (!active) active = (printers.find((p) => p.isDefault) || printers[0] || {}).name || null;
    if (active !== getPrefs().printerName) await setPrefs({ printerName: active });
    renderPrinters();
  }

  printersList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-printer]');
    if (!btn) return;
    const p = printers.find((x) => x.name === btn.dataset.printer);
    if (p && typeof p.status === 'number' && p.status !== 0) {
      const go = await ask({ title: `Use ${p.displayName || p.name}?`, message: 'This printer reports it may be offline, out of paper or busy. Jobs wait and retry until it is ready.', ok: 'Use it' });
      if (!go) return;
    }
    window.electronAPI.setActivePrinter(btn.dataset.printer);
  });
  $('refresh-printers-btn').addEventListener('click', loadPrinters);

  // ── Switch options ──────────────────────────────────────────────────

  document.querySelectorAll('[data-pref]').forEach((input) => {
    input.addEventListener('change', () => setPrefs({ [input.dataset.pref]: input.checked }));
  });

  $('theme-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme]');
    if (btn) setPrefs({ theme: btn.dataset.theme });
  });

  $('test-sound-btn').addEventListener('click', playChime);

  // Open at login: macOS and Windows only
  if (!/platform-(mac|win)/.test(document.documentElement.className)) $('row-login').classList.add('hidden');

  function renderPrefs(p) {
    document.querySelectorAll('[data-pref]').forEach((input) => {
      input.checked = Boolean(p[input.dataset.pref]);
    });
    $('theme-picker')
      .querySelectorAll('[data-theme]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === p.theme)));
    renderPrinters();
  }

  // ── Account and app ─────────────────────────────────────────────────

  $('logout-btn').addEventListener('click', async () => {
    const ok = await ask({ title: 'Sign this computer out?', message: 'It stops printing your shop\'s orders until you sign in again. A job being printed goes back to your queue.', ok: 'Sign out', danger: true });
    if (ok) await window.electronAPI.signOut();
  });

  $('open-devices-btn').addEventListener('click', () => {
    window.electronAPI.openDashboard();
  });

  $('check-update-btn').addEventListener('click', () => window.electronAPI.checkUpdates());
  window.electronAPI.onUpdateMessage((msg) => {
    $('update-btn-text').textContent = msg;
  });
  window.electronAPI.getVersion().then((v) => {
    $('app-version').textContent = v;
  });

  $('clear-data-btn').addEventListener('click', async () => {
    const ok = await ask({
      title: 'Clear all app data?',
      message: 'This signs the computer out and empties the local print queue. A job being printed is handed back to your shop\'s queue.',
      ok: 'Clear data',
      danger: true,
    });
    if (!ok) return;
    localStorage.clear();
    const db = getDB();
    if (db) db.transaction(getStoreName(), 'readwrite').objectStore(getStoreName()).clear();
    await window.electronAPI.clearData();
    window.location.reload();
  });

  return { renderPrefs, loadPrinters };
}
