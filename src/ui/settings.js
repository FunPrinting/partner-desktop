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
        const sub = p.needsTest ? 'Print a test page to switch it on. This printer\'s abilities are not confirmed yet.' : offline ? p.status.message || 'Not ready' : p.status?.message || (p.isDefault ? 'System default' : 'Ready');
        const bwBtn =
          p.enabled && enabledCount > 1 && p.caps?.color
            ? `<button class="btn btn-plain" data-bw="${esc(p.id)}" aria-pressed="${p.preferredBw}">${p.preferredBw ? 'Preferred for B&amp;W ✓' : 'Prefer for B&amp;W'}</button>`
            : '';
        const move = moves.find((m) => m.printerId === p.id);
        const moveBtn = move ? `<button class="btn btn-primary" data-move="${esc(p.id)}" title="Found at ${esc(move.address || 'a new address')}">Update address</button>` : '';
        const moveNote = move ? `<div class="row-sub">This printer has a new address (${esc(move.address || 'new')}). Update the address to use it again.</div>` : '';
        return `<div class="row">
          ${icon('printer')}
          <div class="row-main"><div class="row-title">${esc(p.displayName || p.name)}</div><div class="row-sub">${esc(sub)}</div>${moveNote}<div class="row-sub">${badges(p)}</div></div>
          ${moveBtn}
          ${bwBtn}
          <button class="btn btn-plain" data-test="${esc(p.id)}">Test page</button>
          <label class="switch"><input type="checkbox" data-printer="${esc(p.id)}" aria-label="Use ${esc(p.displayName || p.name)}" ${p.enabled ? 'checked' : ''} ${p.needsTest ? 'disabled' : ''}><span></span></label>
        </div>`;
      })
      .join('');
  }

  const foundList = $('found-list');
  let found = [];
  let moves = [];
  let scanning = false;
  let addingId = null;
  const addErrors = {};

  function renderFound() {
    $('scan-printers-btn').disabled = scanning;
    if (!found.length) {
      foundList.innerHTML = `<div class="row"><div class="row-main"><div class="row-title">${scanning ? 'Searching…' : 'No new printers found'}</div></div></div>`;
      return;
    }
    foundList.innerHTML = found
      .map((f) => {
        const c = f.caps;
        const abilities = c ? [c.color ? pill('Colour', 'primary') : pill('B&W only'), c.duplex ? pill('Double-sided') : pill('Single-sided'), (c.media || []).includes('A3') ? pill('A3') : ''].join(' ') : '';
        const sub = !f.reachable ? (f.status && f.status.message) || 'Not answering' : f.estimated ? 'Abilities are estimated from what the printer announced. Print a test page after adding it.' : f.address ? `Wi-Fi · ${f.address}` : 'Wi-Fi';
        const busy = addingId === f.id;
        return `<div class="row">
          ${icon('printer')}
          <div class="row-main"><div class="row-title">${esc(f.name)}</div><div class="row-sub">${esc(sub)}</div><div class="row-sub">${abilities}</div>${addErrors[f.id] ? `<div class="row-sub" style="color:var(--danger,#c0392b)">${esc(addErrors[f.id])}</div>` : ''}</div>
          <button class="btn btn-primary" data-add="${esc(f.id)}" ${busy || addingId ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add'}</button>
        </div>`;
      })
      .join('');
  }

  function setPrinters(snap) {
    printers = (snap && snap.printers) || [];
    found = (snap && snap.available) || [];
    moves = (snap && snap.moves) || [];
    scanning = Boolean(snap && snap.scan && snap.scan.scanning);
    renderPrinters();
    renderFound();
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
    const mv = e.target.closest('[data-move]');
    if (mv) {
      mv.disabled = true;
      const r = await window.electronAPI.movePrinter(mv.dataset.move);
      if (r.ok) {
        setPrinters(r.snapshot);
        toast('The printer address was updated.');
      } else {
        mv.disabled = false;
        await ask({ title: 'Could not update the address', message: r.error, cancel: null });
      }
      return;
    }
    const test = e.target.closest('[data-test]');
    if (test) {
      test.disabled = true;
      test.textContent = 'Printing…';
      const r = await window.electronAPI.testPrinter(test.dataset.test);
      test.disabled = false;
      test.textContent = 'Test page';
      if (r.ok) toast(`Test page printed in ${r.seconds} s.`);
      else await ask({ title: 'Test page failed', message: r.error, cancel: null });
      return;
    }
    const btn = e.target.closest('[data-bw]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    setPrinters(await window.electronAPI.updatePrinter(btn.dataset.bw, { preferredBw: on }));
  });
  foundList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn || addingId) return;
    const id = btn.dataset.add;
    const item = found.find((f) => f.id === id);
    delete addErrors[id];
    addingId = id;
    renderFound();
    const r = await window.electronAPI.addPrinter(id);
    addingId = null;
    if (r.ok) {
      setPrinters(r.snapshot);
      toast(r.enabled ? `${r.name} is ready to print.` : `${r.name} was added. Print a test page to switch it on.`);
    } else {
      addErrors[id] = r.error || 'The printer could not be added.';
      renderFound();
      if (r.code === 'NEEDS_DRIVER') await ask({ title: `Install the driver for ${item ? item.name : 'this printer'}`, message: r.error, cancel: null });
    }
  });
  $('scan-printers-btn').addEventListener('click', async () => {
    scanning = true;
    renderFound();
    try {
      setPrinters(await window.electronAPI.scanPrinters());
    } catch {
      scanning = false;
      renderFound();
    }
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
