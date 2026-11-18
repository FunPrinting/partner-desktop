/**
 * App shell: platform class, sign-in view, sidebar navigation, connection and
 * printer status, preferences, new-order chime and the developer log page.
 */
(function bootstrap() {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  document.documentElement.classList.add(params.get('platform') || 'platform-other');

  let prefs = {};
  let signedIn = null;
  let currentPage = 'jobs';
  const pages = {};

  const getPrefs = () => prefs;
  const setPrefs = async (patch) => {
    prefs = await window.electronAPI.setPrefs(patch);
    applyPrefs();
    return prefs;
  };

  // ── Navigation ──────────────────────────────────────────────────────

  function show(page) {
    if (page === 'logs' && !prefs.developerMode) page = 'jobs';
    currentPage = page;
    document.querySelectorAll('.page').forEach((el) => el.classList.toggle('hidden', el.id !== `page-${page}`));
    document.querySelectorAll('.nav-item').forEach((el) => {
      if (el.dataset.page === page) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    if (page === 'orders') pages.orders.load();
    if (page === 'shop') pages.shop.load();
    if (page === 'settings') pages.settings.loadPrinters();
  }

  $('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (btn) show(btn.dataset.page);
  });
  // Ctrl/Cmd + 1…4 switch pages
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !signedIn) return;
    const target = { 1: 'jobs', 2: 'orders', 3: 'shop', 4: 'settings' }[e.key];
    if (target) {
      e.preventDefault();
      show(target);
    }
  });

  // ── Session ─────────────────────────────────────────────────────────

  function renderSession(state) {
    const next = Boolean(state && state.signedIn);
    if (next === signedIn) return; // 'session-changed' also fires on token refresh
    signedIn = next;
    $('view-signin').classList.toggle('hidden', next);
    $('view-app').classList.toggle('hidden', !next);
    if (next) {
      $('account-sub').textContent = 'This computer prints your shop\'s orders. You can also sign it out from the web dashboard.';
      show(currentPage);
    }
  }

  $('signin-btn').addEventListener('click', async () => {
    const btn = $('signin-btn');
    $('signin-message').innerHTML = '';
    setBusy(btn, true, 'Waiting for the browser…');
    const result = await window.electronAPI.signIn();
    setBusy(btn, false);
    if (!result.ok) $('signin-message').innerHTML = banner('danger', 'Sign-in failed', result.error || 'Please try again.');
  });

  window.electronAPI.onSessionChanged(renderSession);
  window.electronAPI.onSignedOut(({ reason }) => {
    $('signin-message').innerHTML = banner('info', 'Signed out', reason);
  });

  // ── Status ──────────────────────────────────────────────────────────

  function setConnection(kind, text) {
    $('conn-status').innerHTML = `<span class="dot ${kind}"></span><span>${esc(text)}</span>`;
  }
  window.electronAPI.onStatus((data) => {
    if (data.connected) setConnection('ok', 'Online');
    else setConnection(signedIn ? 'warn' : 'bad', data.message || 'Connecting…');
  });
  window.addEventListener('fp:jobs', (e) => {
    const s = e.detail || {};
    const name = s.printerName;
    $('printer-status').innerHTML = `${icon('printer', 'icon-sm')}<span>${esc(name ? (s.paused ? `${name} · paused` : name) : 'No printer selected')}</span>`;
  });

  // ── Preferences ─────────────────────────────────────────────────────

  function applyPrefs() {
    $('nav-logs').classList.toggle('hidden', !prefs.developerMode);
    if (!prefs.developerMode && currentPage === 'logs') show('jobs');
    pages.settings && pages.settings.renderPrefs(prefs);
  }
  window.electronAPI.onPrefsChanged((p) => {
    prefs = p;
    applyPrefs();
  });

  window.electronAPI.onNewOrder(() => {
    if (prefs.soundNewOrders) playChime();
  });

  // ── Logs (developer mode) ──────────────────────────────────────────

  const logs = $('live-logs');
  window.electronAPI.onSystemLog((log) => {
    const line = document.createElement('div');
    const cls = log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : '';
    line.innerHTML = `<span class="t">${esc(new Date(log.timestamp).toLocaleTimeString())}</span> <span class="${cls}">${esc(log.message)}</span>`;
    const atBottom = logs.scrollHeight - logs.scrollTop <= logs.clientHeight + 80;
    logs.appendChild(line);
    while (logs.childElementCount > 1000) logs.firstElementChild.remove();
    if (atBottom) logs.scrollTop = logs.scrollHeight;
  });
  $('clear-logs-btn').addEventListener('click', () => {
    logs.innerHTML = '';
  });

  // ── Start ───────────────────────────────────────────────────────────

  initDB()
    .catch(() => undefined)
    .then(async () => {
      prefs = await window.electronAPI.getPrefs();
      // Developer mode setting from the earlier app version
      if (localStorage.getItem('devMode') === 'true' && !prefs.developerMode) prefs = await window.electronAPI.setPrefs({ developerMode: true });
      localStorage.removeItem('devMode');
      // Tokens from the earlier app version are no longer used
      localStorage.removeItem('authToken');
      localStorage.removeItem('partnerId');

      initJobs();
      pages.orders = initOrders();
      pages.shop = initShop();
      pages.settings = initSettings({ getPrefs, setPrefs });
      applyPrefs();
      renderSession(await window.electronAPI.getSession());
      // Pick up the printer (or the system default) even before Settings is opened
      pages.settings.loadPrinters();
    });
})();
