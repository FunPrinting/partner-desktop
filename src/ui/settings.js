/**
 * Settings page: account, printer, printing / notification / appearance /
 * startup options, updates, developer mode and clearing app data.
 * Options are stored in the main process (src/main/prefs.js).
 */

function initSettings({ getPrefs, setPrefs }) {
  const $ = (id) => document.getElementById(id);
  const printersList = $('printers-list');
  let printers = [];
  let lastError = null; // the printer system could not be read

  // ── Printers ────────────────────────────────────────────────────────

  function badges(p) {
    const c = p.caps;
    if (!c) return '';
    const out = [c.color ? pill('Colour', 'primary') : pill('B&W only'), c.duplex ? pill('Double-sided') : pill('Single-sided')];
    if ((c.media || []).includes('A3')) out.push(pill('A3'));
    // Security: encrypted (ipps://, https://), not encrypted (ipp://, socket://, lpd://), or USB
    const scheme = (p.uri || '').split(':')[0].toLowerCase();
    if (scheme === 'ipps' || scheme === 'https') out.push(pill('Encrypted', 'success'));
    else if (scheme === 'ipp' || scheme === 'socket' || scheme === 'lpd') out.push(pill('Not encrypted', 'warning'));
    else if (scheme === 'usb') out.push(pill('USB'));
    return out.join(' ');
  }

  function renderPrinters() {
    const problem = lastError ? `<div class="row"><div class="row-main"><div class="row-title" style="color:var(--danger,#c0392b)">The printer system could not be read</div><div class="row-sub">${esc(lastError)}</div><div class="row-sub">Click Refresh to try again. If this keeps happening, send the Logs page to FunPrinting support.</div></div></div>` : '';
    if (!printers.length) {
      printersList.innerHTML =
        problem ||
        `<div class="row"><div class="row-main"><div class="row-title">No printers found</div><div class="row-sub">Connect a printer by USB or Wi-Fi, add it in your system settings (or with Add below), then click Refresh.</div></div></div>`;
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
          <button class="btn btn-plain" data-remove="${esc(p.id)}" title="Remove this printer from the computer">Remove</button>
          <label class="switch"><input type="checkbox" data-printer="${esc(p.id)}" aria-label="Use ${esc(p.displayName || p.name)}" ${p.enabled ? 'checked' : ''} ${p.needsTest ? 'disabled' : ''}><span></span></label>
        </div>`;
      })
      .join('') + problem;
  }

  const foundList = $('found-list');
  let found = [];
  let scanStats = null;
  let networkBlocked = false;
  let moves = [];
  let scanning = false;
  let addingId = null;
  const addErrors = {};

  const platform = /platform-win/.test(document.documentElement.className) ? 'win' : /platform-mac/.test(document.documentElement.className) ? 'mac' : 'linux';

  /** One line saying what the last search did, so "nothing found" is never a mystery. */
  function searchSummary(stats) {
    if (!stats) return '';
    const nets = (stats.adapters || []).length;
    const parts = [`Searched ${nets} network${nets === 1 ? '' : 's'}`];
    parts.push(`${stats.mdnsFound || 0} printer${stats.mdnsFound === 1 ? '' : 's'} announced`);
    if (stats.swept) parts.push(`${(stats.swept.open || []).length} device(s) answered on the printing port`);
    return parts.join(' · ');
  }

  function nothingFoundHelp() {
    if (platform === 'win') return 'Check the printer is on and on the same network. In Windows Settings → Network, set this Wi-Fi to Private. If Windows asked whether to allow FunPrinting on networks, allow it.';
    if (platform === 'mac') return 'Check the printer is on and on the same Wi-Fi. In System Settings → Privacy & Security → Local Network, switch FunPrinting Partner on.';
    return 'Check the printer is on and on the same network, and that a firewall is not blocking port 5353 (mDNS).';
  }

  function renderFound() {
    $('scan-printers-btn').disabled = scanning;
    const stats = scanStats;
    const summary = searchSummary(stats);
    const blockedBanner = networkBlocked
      ? `<div class="row"><div class="row-main">${banner(
          'warning',
          'This computer is not letting the app check printers on the network',
          platform === 'mac'
            ? 'Open System Settings → Privacy & Security → Local Network and switch FunPrinting Partner on. Printing still works; the app just cannot tell whether a Wi-Fi printer is switched off.'
            : 'A firewall is blocking the app. Allow FunPrinting Partner on private networks. Printing still works.'
        )}</div></div>`
      : '';
    if (!found.length) {
      foundList.innerHTML =
        blockedBanner +
        (scanning
          ? `<div class="row"><div class="row-main"><div class="row-title">Searching…</div><div class="row-sub">Asking printers on your network. This takes a few seconds.</div></div></div>`
          : `<div class="row"><div class="row-main"><div class="row-title">No printers found on the network</div>${summary ? `<div class="row-sub">${esc(summary)}</div>` : ''}<div class="row-sub">${esc(nothingFoundHelp())}</div></div></div>`);
      return;
    }
    // Printers not set up yet first; ones already set up are shown so a search never looks empty
    const ordered = [...found].sort((a, b) => Number(Boolean(a.setUpAs)) - Number(Boolean(b.setUpAs)));
    foundList.innerHTML =
      blockedBanner +
      ordered
        .map((f) => {
          const c = f.caps;
          const abilities = c ? [c.color ? pill('Colour', 'primary') : pill('B&W only'), c.duplex ? pill('Double-sided') : pill('Single-sided'), (c.media || []).includes('A3') ? pill('A3') : ''].join(' ') : '';
          // Security indicator based on the protocol used
          const securityPill = f.security === 'encrypted' ? pill('Encrypted', 'success') : f.security === 'not-encrypted' ? pill('Not encrypted', 'warning') : '';
          const where = f.address ? `Network · ${f.address}` : 'Network';
          const sub = f.setUpAs
            ? `Already set up on this computer as "${f.setUpAs}" · ${where}`
            : !f.reachable
              ? (f.status && f.status.message) || 'Not answering'
              : f.estimated
                ? 'Abilities are estimated from what the printer announced. Print a test page after adding it.'
                : where;
          const busy = addingId === f.id;
          const action = f.setUpAs ? pill('Set up', 'success') : `<button class="btn btn-primary" data-add="${esc(f.id)}" ${busy || addingId ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add'}</button>`;
          return `<div class="row">
          ${icon('printer')}
          <div class="row-main"><div class="row-title">${esc(f.name)}</div><div class="row-sub">${esc(sub)}</div><div class="row-sub">${abilities} ${securityPill}</div>${addErrors[f.id] ? `<div class="row-sub" style="color:var(--danger,#c0392b)">${esc(addErrors[f.id])}</div>` : ''}</div>
          ${action}
        </div>`;
        })
        .join('') +
      (summary ? `<div class="row"><div class="row-main"><div class="row-sub">${esc(summary)}</div></div></div>` : '');
  }
  function setPrinters(snap) {
    printers = (snap && snap.printers) || [];
    lastError = (snap && snap.lastError) || null;
    found = (snap && snap.available) || [];
    moves = (snap && snap.moves) || [];
    scanning = Boolean(snap && snap.scan && snap.scan.scanning);
    scanStats = (snap && snap.scan && snap.scan.stats) || null;
    networkBlocked = Boolean(snap && snap.networkBlocked);
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
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const p = printers.find((x) => x.id === rm.dataset.remove);
      const name = p ? p.displayName || p.name : 'this printer';
      const ok = await ask({
        title: `Remove ${name}?`,
        message: `It is deleted from this computer's printers, not only from FunPrinting.${platform === 'win' ? ' Windows asks for permission.' : ''} You can add it again from "Found on your network".`,
        ok: 'Remove',
        danger: true,
      });
      if (!ok) return;
      rm.disabled = true;
      const r = await window.electronAPI.removePrinter(rm.dataset.remove);
      if (r.ok) {
        setPrinters(r.snapshot);
        toast(`${r.name} was removed.`);
      } else {
        rm.disabled = false;
        await ask({ title: 'Could not remove the printer', message: r.error, cancel: null });
      }
      return;
    }
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
