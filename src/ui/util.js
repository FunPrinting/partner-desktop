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

// ── Order fulfilment (same rules as the server, src/lib/partnerOrderTransitions.ts) ──

const ORDER_STATUS_LABEL = {
  pending_payment: 'Awaiting payment', pending_cod_approval: 'Confirm COD in chat', paid: 'Paid', processing: 'Processing', printing: 'Printing', printed: 'Printed',
  ready_for_pickup: 'Ready for pickup', dispatched: 'Out for delivery', delivered: 'Delivered', completed: 'Collected',
  cancelled: 'Cancelled', refunded: 'Refunded',
};
const STATUS_RANK = { paid: 0, processing: 1, printing: 2, printed: 3, ready_for_pickup: 4, dispatched: 5, delivered: 6, completed: 7 };

/** 'pickup' | 'shop' (the shop delivers) | 'courier' */
function fulfilmentOf(order) {
  if (order?.deliveryOption?.type !== 'delivery') return 'pickup';
  return order.deliveryOption.method === 'shop' ? 'shop' : 'courier';
}

function fulfilmentLabel(order) {
  const how = fulfilmentOf(order);
  if (how === 'shop') return `You deliver${order.deliveryOption?.distance ? ` · ${order.deliveryOption.distance} km` : ''}`;
  if (how === 'courier') return order.shiprocket?.awbCode ? `Courier · ${order.shiprocket.courierName || 'booked'}` : 'Courier';
  return 'Pickup';
}

/** The next step(s) to offer for this order. */
function nextStatuses(order) {
  const rank = STATUS_RANK[order?.status] ?? -1;
  if (rank < 0) return [];
  if (rank < STATUS_RANK.printed) return ['printing', 'printed'].filter((s) => STATUS_RANK[s] > rank);
  const steps = { pickup: ['ready_for_pickup', 'completed'], shop: ['dispatched', 'delivered'], courier: [] }[fulfilmentOf(order)];
  return steps.filter((s) => STATUS_RANK[s] > rank).slice(0, 1);
}

/** Printed courier order without a booking yet. */
function canBookCourier(order) {
  return fulfilmentOf(order) === 'courier' && order.status === 'printed' && !order.shiprocket?.awbCode;
}

/** 90% of printing on online orders (plus self delivery fee), or 100% cash kept for COD orders. */
function partnerShare(order) {
  const amount = Number(order?.amount || 0);
  if (order?.paymentMethod === 'cod') return Math.round(amount * 100) / 100;
  const delivery = order?.deliveryOption?.type === 'delivery' ? Number(order.deliveryOption.deliveryCharge || 0) : 0;
  return Math.round(((amount - delivery) * 0.9 + (fulfilmentOf(order) === 'shop' ? delivery : 0)) * 100) / 100;
}

/**
 * Moves an order, asking for the customer's delivery code or COD cash confirmation when needed.
 * Resolves the updated order, or null if cancelled or failed (the error is shown).
 */
async function moveOrder(order, status) {
  let code;
  let cashCollected = false;
  if (status === 'delivered' && fulfilmentOf(order) === 'shop') {
    code = await ask({ title: `Delivered order ${order.orderId}?`, message: 'Ask the customer for the 4-digit delivery code shown in their order.', ok: 'Confirm delivery', input: { label: 'Delivery code', placeholder: '0000' } });
    if (code === null) return null;
    code = code.replace(/\D/g, '');
  }
  if (status === 'completed' && order?.paymentMethod === 'cod' && order?.paymentStatus !== 'completed') {
    const confirmed = await ask({
      title: `Confirm cash payment for ${order.orderId}`,
      message: `Ask the customer to scan the Order Summary QR slip to auto-complete, or confirm you collected ₹${Math.round(order.amount || 0)} cash at the counter.`,
      ok: `Cash ₹${Math.round(order.amount || 0)} received`,
    });
    if (!confirmed) return null;
    cashCollected = true;
  }
  for (;;) {
    const result = await window.electronAPI.updateOrderStatus(order.orderId, status, code, cashCollected);
    if (result.ok) {
      toast(`Order ${order.orderId}: ${ORDER_STATUS_LABEL[status] || status}.`);
      return result.data.order || { ...order, status };
    }
    if (code !== undefined && result.data?.code === 'handover_wrong') {
      code = await ask({ title: 'Wrong code', message: result.data.error, ok: 'Try again', input: { label: 'Delivery code', placeholder: '0000' } });
      if (code === null) return null;
      code = code.replace(/\D/g, '');
      continue;
    }
    await ask({ title: 'Could not update the order', message: result.data?.error || `Error ${result.status}`, cancel: null });
    return null;
  }
}

async function bookCourierFor(order) {
  const go = await ask({ title: `Book a courier for order ${order.orderId}?`, message: 'A courier will come to your shop to collect the parcel. Pack it with the order number on it.', ok: 'Book courier' });
  if (!go) return null;
  const result = await window.electronAPI.bookCourier(order.orderId);
  if (!result.ok) {
    await ask({ title: 'Could not book the courier', message: result.data?.error || `Error ${result.status}`, cancel: null });
    return null;
  }
  toast(`Courier booked: ${result.data.courierName}, AWB ${result.data.awbCode}.`);
  return result.data.order || order;
}

async function codActionFor(order, action, reason) {
  if (action === 'no_show') {
    const ok = await ask({
      title: `Mark ${order.orderId} as No-Show?`,
      message: 'This cancels the COD order and automatically blocks future Cash on Pickup for this customer.',
      ok: 'Mark No-Show',
    });
    if (!ok) return null;
  }
  const result = await window.electronAPI.api('POST', `/api/partner/orders/${encodeURIComponent(order.orderId)}/cod`, reason ? { action, reason } : { action });
  if (!result.ok || !result.data?.success) {
    await ask({ title: 'COD action failed', message: result.data?.error || `Error ${result.status}`, cancel: null });
    return null;
  }
  toast(
    action === 'approve'
      ? `COD #${order.orderId} approved & queued to print.`
      : action === 'no_show'
        ? `Order #${order.orderId} marked No-Show.`
        : `COD request #${order.orderId} declined.`
  );
  return result.data.order || order;
}

/** "Front desk PC · HP LaserJet", or '' if not printed yet. */
function printedOn(order) {
  const p = order?.job?.printedBy;
  if (p) return [p.deviceName, p.printer].filter(Boolean).join(' · ') || 'A shop device';
  return '';
}
