/**
 * Sign-in panel, connection badge, earnings, updates and "clear data".
 * Tokens live in the main process; this file only sees signed-in / signed-out.
 */

function initAuth() {
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const loginHint = document.getElementById('login-hint');
  const loginError = document.getElementById('login-error');
  const statusBadge = document.getElementById('status-badge');
  let signedIn = false;

  // Tokens from the earlier app version are no longer used
  localStorage.removeItem('authToken');
  localStorage.removeItem('partnerId');

  function setBadge(kind, text) {
    const styles = {
      online: ['bg-green-100 text-green-700 border-green-200', 'bg-green-500'],
      connecting: ['bg-yellow-100 text-yellow-800 border-yellow-200', 'bg-yellow-500 animate-pulse'],
      offline: ['bg-red-100 text-red-600 border-red-200', 'bg-red-500'],
    }[kind];
    statusBadge.className = `flex items-center gap-2 px-3 py-1 rounded-full border text-sm font-medium transition-colors ${styles[0]}`;
    statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full ${styles[1]}"></span> ${esc(text)}`;
  }

  let rendered = null;
  function renderSession(state) {
    const next = Boolean(state && state.signedIn);
    // 'session-changed' also fires on every token refresh; only redraw on a real change
    if (rendered === next && !loginBtn.disabled) return;
    rendered = next;
    signedIn = next;
    loginBtn.classList.toggle('hidden', signedIn);
    logoutBtn.classList.toggle('hidden', !signedIn);
    loginBtn.disabled = false;
    loginBtn.querySelector('span').innerText = 'Sign in with your FunPrinting account';
    loginHint.innerText = signedIn
      ? 'This computer is signed in and prints your shop\'s orders. You can sign it out here or from the web dashboard (Signed-in apps).'
      : 'Sign in with the Google account of your shop. Your browser opens to confirm.';
    if (signedIn) {
      setBadge('connecting', 'Connecting…');
      fetchFinancials();
    } else {
      setBadge('offline', 'Signed out');
      document.getElementById('financials-panel').classList.add('hidden');
    }
  }

  loginBtn.addEventListener('click', async () => {
    loginError.classList.add('hidden');
    loginBtn.disabled = true;
    loginBtn.querySelector('span').innerText = 'Waiting for the browser…';
    const result = await window.electronAPI.signIn();
    if (!result.ok) {
      loginError.innerText = result.error || 'Sign-in failed';
      loginError.classList.remove('hidden');
      renderSession({ signedIn: false });
    }
  });

  logoutBtn.addEventListener('click', async () => {
    if (!confirm('Sign this computer out? It stops printing your shop\'s orders until you sign in again.')) return;
    logoutBtn.disabled = true;
    await window.electronAPI.signOut();
    logoutBtn.disabled = false;
  });

  window.electronAPI.onSessionChanged(renderSession);
  window.electronAPI.onSignedOut(({ reason }) => {
    loginError.innerText = `Signed out: ${reason}`;
    loginError.classList.remove('hidden');
  });
  window.electronAPI.getSession().then(renderSession);

  window.electronAPI.onStatus((data) => {
    if (!signedIn) return setBadge('offline', 'Signed out');
    if (data.connected) {
      setBadge('online', 'Online');
      fetchFinancials();
    } else {
      setBadge('connecting', data.message || 'Connecting…');
    }
  });

  // ── Earnings ───────────────────────────────────────────────────────

  async function fetchFinancials() {
    const { ok, data } = await window.electronAPI.api('GET', '/api/partner/financials');
    if (!ok || !data.success || !data.financials) return;
    const f = data.financials;
    document.getElementById('financials-panel').classList.remove('hidden');
    document.getElementById('today-earnings').innerText = `₹${Number(f.todayEarnings || 0).toLocaleString()}`;
    document.getElementById('total-earnings').innerText = `₹${Number(f.totalEarnings || 0).toLocaleString()}`;
    document.getElementById('total-orders').innerText = String(f.completedOrdersCount ?? 0);
  }

  // ── Updates ────────────────────────────────────────────────────────

  const updateBtnText = document.getElementById('update-btn-text');
  document.getElementById('check-update-btn').addEventListener('click', () => window.electronAPI.checkUpdates());
  window.electronAPI.onUpdateMessage((msg) => {
    updateBtnText.innerText = msg;
  });

  // ── Clear data ─────────────────────────────────────────────────────

  document.getElementById('clear-data-btn').addEventListener('click', async () => {
    if (!confirm('Clear all app data? This signs the computer out and empties the local print queue. A job being printed is handed back to your shop\'s queue.')) return;
    localStorage.clear();
    const db = getDB();
    if (db) {
      const tx = db.transaction(getStoreName(), 'readwrite');
      tx.objectStore(getStoreName()).clear();
    }
    await window.electronAPI.clearData();
    window.location.reload();
  });
}
