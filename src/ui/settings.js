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

  function badges(p) {
    const c = p.caps;
    if (!c) return '';
    const out = [c.color ? pill('Colour', 'primary') : pill('B&W only'), c.duplex ? pill('Double-sided') : pill('Single-sided')];
    if ((c.media || []).includes('A3')) out.push(pill('A3'));
    return out.join(' ');
  }

  function renderPrinters() {
    if (!printers.length) {
      printersList.innerHTML = `<div class="row"><div class="row-main"><div class="row-title">No printers found</div><div class="row-sub">Connect a printer and add it in your system settings, then click Refresh.</div></div></div>`;
      return;
    }
    const enabledCount = printers.filter((p) => p.enabled).length;
    printersList.innerHTML = printers
      .map((p) => {
        const offline = p.status && p.status.online === false;
        const sub = offline ? p.status.message || 'Not ready' : p.status?.message || (p.isDefault ? 'System default' : 'Ready');
        const bwBtn =
          p.enabled && enabledCount > 1 && p.caps?.color
            ? `<button class="btn btn-plain" data-bw="${esc(p.id)}" aria-pressed="${p.preferredBw}">${p.preferredBw ? 'Preferred for B&amp;W ✓' : 'Prefer for B&amp;W'}</button>`
            : '';
        return `<div class="row">
          ${icon('printer')}
          <div class="row-main"><div class="row-title">${esc(p.displayName || p.name)}</div><div class="row-sub">${esc(sub)}</div><div class="row-sub">${badges(p)}</div></div>
          ${bwBtn}
          <label class="switch"><input type="checkbox" data-printer="${esc(p.id)}" aria-label="Use ${esc(p.displayName || p.name)}" ${p.enabled ? 'checked' : ''}><span></span></label>
        </div>`;
      })
      .join('');
  }

  function setPrinters(snap) {
    printers = (snap && snap.printers) || [];
    renderPrinters();
  }

  async function loadPrinters() {
    try {
      setPrinters(await window.electronAPI.getPrinters());
    } catch {
      setPrinters(null);
    }
  }

  async function refreshPrinters() {
    printersList.innerHTML = `<div class="row"><div class="row-main muted">Looking for printers…</div></div>`;
    try {
      setPrinters(await window.electronAPI.refreshPrinters());
    } catch {
      setPrinters(null);
    }
  }

  printersList.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-printer]');
    if (!input) return;
    setPrinters(await window.electronAPI.updatePrinter(input.dataset.printer, { enabled: input.checked }));
  });
  printersList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-bw]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    setPrinters(await window.electronAPI.updatePrinter(btn.dataset.bw, { preferredBw: on }));
  });
  window.electronAPI.onPrintersChanged(setPrinters);
  $('refresh-printers-btn').addEventListener('click', refreshPrinters);

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
