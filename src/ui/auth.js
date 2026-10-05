/**
 * Authentication — OAuth login, auto-login, status badge, financials
 */

function initAuth() {
  const loginBtn = document.getElementById('login-btn');
  const statusBadge = document.getElementById('status-badge');
  let isAuthenticated = false;

  // ── Login Button ───────────────────────────────────────────────────

  loginBtn.addEventListener('click', () => {
    loginBtn.innerHTML = "Opening browser...";
    window.electronAPI.startOAuth();
  });

  // ── OAuth Success ──────────────────────────────────────────────────

  window.electronAPI.onOAuthSuccess(({ partnerId, token }) => {
    if (window.electronAPI.setPaths) {
      const cp = localStorage.getItem('chromePath') || '';
      const lp = localStorage.getItem('librePath') || '';
      window.electronAPI.setPaths({ chromePath: cp, librePath: lp });
    }

    localStorage.setItem('partnerId', partnerId);
    localStorage.setItem('authToken', token);

    document.getElementById('access-token').value = token;
    loginBtn.innerHTML = "Connecting Engine...";
    window.electronAPI.login({ partnerId, token });
  });

  // ── Auto-login on startup ─────────────────────────────────────────

  window.addEventListener('DOMContentLoaded', () => {
    const savedPartnerId = localStorage.getItem('partnerId');
    const savedToken = localStorage.getItem('authToken');
    if (savedPartnerId && savedToken) {
      document.getElementById('access-token').value = savedToken;
      loginBtn.innerHTML = "Connecting Engine...";
      window.electronAPI.login({ partnerId: savedPartnerId, token: savedToken });
    }

    // Recover print queue immediately
    if (window.electronAPI.getQueue) {
      window.electronAPI.getQueue().then(queue => {
        if (queue && queue.length > 0) {
          queue.forEach(job => renderJobCard(job));
        }
      }).catch(err => console.error("Failed to load initial queue", err));
    }
  });

  // ── Auth Success (backend confirmed) ──────────────────────────────

  window.electronAPI.onAuthSuccess(({ partnerId }) => {
    isAuthenticated = true;
    statusBadge.className = "flex items-center gap-2 px-3 py-1 rounded-full bg-yellow-900/50 text-yellow-400 border border-yellow-800/50 text-sm font-medium transition-colors";
    statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span> Authenticated';
    loginBtn.innerText = "Authenticated ✓";
    loginBtn.disabled = true;
    loginBtn.classList.add('opacity-50', 'cursor-not-allowed');

    fetchFinancials();
  });

  // ── Cloud Connection Status ────────────────────────────────────────

  window.electronAPI.onStatus((data) => {
    if (data.connected) {
      statusBadge.className = "flex items-center gap-2 px-3 py-1 rounded-full bg-green-100 text-green-700 border border-green-200 text-sm font-medium transition-colors";
      statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-500"></span> Online';
      loginBtn.innerText = "Connected";
      loginBtn.disabled = true;
      loginBtn.classList.add('opacity-50', 'cursor-not-allowed');
      fetchFinancials();
    } else {
      if (isAuthenticated) {
        statusBadge.className = "flex items-center gap-2 px-3 py-1 rounded-full bg-yellow-900/50 text-yellow-400 border border-yellow-800/50 text-sm font-medium transition-colors";
        statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span> Engine Connecting...';
        loginBtn.innerText = "Authenticated ✓";
        loginBtn.disabled = true;
        loginBtn.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        statusBadge.className = "flex items-center gap-2 px-3 py-1 rounded-full bg-red-100 text-red-600 border border-red-200 text-sm font-medium transition-colors";
        statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span> Offline';
        loginBtn.innerText = "Connect Engine";
        loginBtn.disabled = false;
        loginBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    }
  });

  // ── Financials ─────────────────────────────────────────────────────

  function fetchFinancials() {
    const token = document.getElementById('access-token').value;
    fetch('https://www.funprinting.store/api/partner/financials', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success && resData.financials) {
        document.getElementById('financials-panel').classList.remove('hidden');
        document.getElementById('today-earnings').innerText = `₹${resData.financials.todayEarnings.toLocaleString()}`;
        document.getElementById('total-earnings').innerText = `₹${resData.financials.totalEarnings.toLocaleString()}`;
        document.getElementById('total-orders').innerText = resData.financials.completedOrdersCount;
      }
    })
    .catch(err => console.error("Failed to fetch financials:", err));
  }

  // ── Updates ────────────────────────────────────────────────────────

  const checkUpdateBtn = document.getElementById('check-update-btn');
  const updateBtnText = document.getElementById('update-btn-text');

  checkUpdateBtn.addEventListener('click', () => {
    window.electronAPI.checkUpdates();
  });

  window.electronAPI.onUpdateMessage((msg) => {
    updateBtnText.innerText = msg;
  });

  // ── Clear Data ─────────────────────────────────────────────────────

  document.getElementById('clear-data-btn').addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all app data? This will log you out and permanently clear the local print queue.')) {
      localStorage.clear();
      const db = getDB();
      if (db) {
        const tx = db.transaction(getStoreName(), 'readwrite');
        tx.objectStore(getStoreName()).clear();
      }
      window.electronAPI.clearData();
      window.location.reload();
    }
  });
}
