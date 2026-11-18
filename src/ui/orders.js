/**
 * Orders page: every order for the shop, with search and Open / Done / All.
 * Printing is driven by print jobs (jobs.js); here orders are looked up, opened
 * in their own window and moved on after printing. The last list is cached
 * (IndexedDB) so it still shows when offline.
 */

const DONE_STATUSES = new Set(['completed', 'delivered', 'cancelled', 'refunded']);

function statusTone(status) {
  if (status === 'completed' || status === 'delivered') return 'success';
  if (status === 'ready_for_pickup' || status === 'printed') return 'warning';
  if (status === 'printing' || status === 'processing') return 'info';
  if (status === 'cancelled' || status === 'refunded') return 'danger';
  return 'neutral';
}

function initOrders() {
  const tbody = document.getElementById('orders-tbody');
  const empty = document.getElementById('orders-empty');
  const bannerBox = document.getElementById('orders-banner');
  const search = document.getElementById('orders-search');
  const filterBox = document.getElementById('orders-filter');
  const refreshBtn = document.getElementById('refresh-orders-btn');
  let orders = [];
  let filter = 'open';
  let loading = false;

  function visible() {
    const q = search.value.trim().toLowerCase();
    return orders.filter((o) => {
      if (filter === 'open' && (DONE_STATUSES.has(o.status) || o.status === 'pending_payment')) return false;
      if (filter === 'done' && !DONE_STATUSES.has(o.status)) return false;
      if (!q) return true;
      const hay = [o.orderId, o.originalFileName, ...(o.originalFileNames || []), o.customerInfo?.name, o.customerInfo?.phone].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function render() {
    const rows = visible();
    tbody.innerHTML = rows
      .map((o) => {
        const next = nextStatuses(o);
        const name = o.originalFileName || o.originalFileNames?.[0] || 'Document';
        const files = o.originalFileNames?.length || 1;
        const action = canBookCourier(o)
          ? `<button class="btn btn-sm" data-book="${esc(o.orderId)}">${icon('truck', 'icon-sm')}Book courier</button>`
          : next.map((s) => `<button class="btn btn-sm" data-move="${esc(o.orderId)}" data-status="${esc(s)}">${esc(ORDER_STATUS_LABEL[s] || s)}</button>`).join(' ');
        return `
          <tr>
            <td><button class="btn btn-plain mono" data-open="${esc(o.orderId)}" title="Open order">${esc(o.orderId)}</button></td>
            <td class="muted">${esc(new Date(o.createdAt).toLocaleDateString())}</td>
            <td class="truncate" title="${esc(name)}">${esc(name)}${files > 1 ? ` <span class="muted">+${files - 1}</span>` : ''}</td>
            <td class="truncate">${esc(o.customerInfo?.name || '')}</td>
            <td class="muted">${esc(fulfilmentLabel(o))}</td>
            <td class="num">${esc(money(partnerShare(o), 2))}</td>
            <td>${pill(ORDER_STATUS_LABEL[o.status] || o.status, statusTone(o.status))}</td>
            <td style="width:170px">${action}</td>
          </tr>`;
      })
      .join('');
    const none = !rows.length && !loading;
    empty.classList.toggle('hidden', !none);
    if (none) {
      empty.innerHTML = search.value.trim()
        ? emptyState('search', 'No matching orders', 'Try another order number, file name or customer.')
        : emptyState('inbox', filter === 'open' ? 'No open orders' : 'No orders here', 'Paid orders for your shop appear here.');
    }
  }

  async function load() {
    loading = true;
    // Saved copy first, so the page fills instantly (and offline)
    try {
      const cached = await getAllCachedOrders();
      if (cached && cached.length && !orders.length) {
        orders = cached.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        render();
      }
    } catch {
      // no cache yet
    }
    setBusy(refreshBtn, true, 'Refreshing');
    const { ok, status, data } = await window.electronAPI.api('GET', '/api/partner/orders');
    setBusy(refreshBtn, false);
    loading = false;
    if (!ok) {
      bannerBox.innerHTML = banner('warning', status === 401 ? 'Please sign in again' : 'Showing saved orders', status === 401 ? '' : 'Can\'t reach FunPrinting right now.');
      render();
      return;
    }
    bannerBox.innerHTML = '';
    orders = data.orders || [];
    // Keep the local cache to what the server has
    const db = getDB();
    if (db) {
      const keep = new Set(orders.map((o) => o.orderId));
      const cached = await getAllCachedOrders().catch(() => []);
      const store = db.transaction([getStoreName()], 'readwrite').objectStore(getStoreName());
      cached.forEach((o) => {
        if (!keep.has(o.orderId)) store.delete(o.orderId);
      });
    }
    for (const o of orders) await cacheOrder(o).catch(() => undefined);
    render();
  }

  filterBox.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    filterBox.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    render();
  });
  search.addEventListener('input', render);
  refreshBtn.addEventListener('click', load);

  tbody.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      const order = orders.find((o) => o.orderId === open.dataset.open);
      if (order) window.electronAPI.openOrderWindow(order);
      return;
    }
    const btn = e.target.closest('[data-move], [data-book]');
    if (!btn) return;
    const order = orders.find((o) => o.orderId === (btn.dataset.move || btn.dataset.book));
    if (!order) return;
    setBusy(btn, true);
    const updated = btn.dataset.book ? await bookCourierFor(order) : await moveOrder(order, btn.dataset.status);
    setBusy(btn, false);
    if (updated) await load();
  });

  return { load };
}
