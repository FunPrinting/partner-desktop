/**
 * Shared renderer helpers. Text from the server (file names, customer data,
 * printer names) is always escaped before it goes into HTML.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function timeAgo(date) {
  if (!date) return '';
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(date).toLocaleDateString();
}

function timeLeft(date) {
  if (!date) return '';
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.ceil(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function money(n, decimals = 0) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function pill(label, tone = 'neutral') {
  return `<span class="pill tone-bg-${tone}">${esc(label)}</span>`;
}

function banner(tone, title, text) {
  const ic = tone === 'danger' || tone === 'warning' ? 'alert' : tone === 'success' ? 'check-circle' : 'info';
  return `<div class="banner tone-bg-${tone}" role="status">${icon(ic)}<div><div class="banner-title">${esc(title)}</div>${text ? `<div class="banner-text">${esc(text)}</div>` : ''}</div></div>`;
}

function emptyState(ic, title, text) {
  return `<div class="empty"><div class="empty-icon">${icon(ic, 'icon-lg')}</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label ? esc(label) : ''}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
  }
}

/**
 * In-app dialog (Electron has no window.prompt). Resolves true/false, or the
 * typed text (or null when cancelled) if `input` is given.
 */
function ask({ title, message = '', ok = 'OK', cancel = 'Cancel', danger = false, input = null }) {
  const dialog = document.getElementById('dialog');
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-message').textContent = message;
  const okBtn = document.getElementById('dialog-ok');
  const cancelBtn = document.getElementById('dialog-cancel');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  cancelBtn.textContent = cancel;
  cancelBtn.classList.toggle('hidden', cancel === null);
  const wrap = document.getElementById('dialog-input-wrap');
  const field = document.getElementById('dialog-input');
  wrap.classList.toggle('hidden', !input);
  if (input) {
    document.getElementById('dialog-input-label').textContent = input.label || '';
    field.placeholder = input.placeholder || '';
    field.value = '';
  }
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const confirmed = dialog.returnValue === 'ok';
        resolve(input ? (confirmed ? field.value.trim() : null) : confirmed);
      },
      { once: true }
    );
    dialog.returnValue = 'cancel';
    dialog.showModal();
    (input ? field : okBtn).focus();
  });
}

function toast(message, ms = 3200) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Two-note chime (Web Audio; no sound file needed). */
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.16;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // no audio device
  }
}
