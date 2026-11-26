/**
 * Orders page: every order for the shop, with search and Open / Done / All.
 * Printing is driven by print jobs (jobs.js); here orders are looked up, opened
 * in their own window and moved on after printing. The last list is cached
 * (IndexedDB) so it still shows when offline.
 */

const DONE_STATUSES = new Set(['completed', 'delivered', 'cancelled', 'refunded']);

function statusTone(status) {
  if (status === 'completed' || status === 'delivered') return 'success';
  if (status === 'ready_for_pickup' || status === 'printed' || status === 'pending_cod_approval') return 'warning';
  if (status === 'printing' || status === 'processing') return 'info';
  if (status === 'cancelled' || status === 'refunded') return 'danger';
  return 'neutral';
}

function initOrders() {
  const tbody = document.getElementById('orders-tbody');
  const codBox = document.getElementById('orders-cod-pending');
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
    const toApproveCod = orders.filter((o) => o.paymentMethod === 'cod' && o.status === 'pending_cod_approval');
    if (codBox) {
      codBox.innerHTML = toApproveCod.length
        ? `<div class="card card-pad" style="border-left:4px solid var(--warning);margin-bottom:12px">
            <div style="font-weight:650;margin-bottom:4px">Cash on Pickup awaiting chat approval (${toApproveCod.length})</div>
            <div class="muted small" style="margin-bottom:10px">Confirm with the customer in Messages before printing.</div>
            ${toApproveCod
              .map(
                (o) => `
              <div class="row" style="padding:8px 0">
                <div class="row-main">
                  <div class="row-title"><span class="mono">#${esc(o.orderId)}</span> · Cash ₹${esc(Math.round(o.amount || 0))}</div>
                  <div class="row-sub">${esc(o.customerInfo?.name || 'Customer')} (${esc(o.customerInfo?.phone || 'no phone')}) · ${esc(o.originalFileName || o.originalFileNames?.[0] || 'Document')}</div>
                </div>
                <div class="actions">
                  <button class="btn btn-sm" data-cod="decline" data-order="${esc(o.orderId)}">Decline</button>
                  <button class="btn btn-sm btn-primary" data-cod="approve" data-order="${esc(o.orderId)}">Approve &amp; Print</button>
                </div>
              </div>`
              )
              .join('')}
          </div>`
        : '';
    }

    const rows = visible();
    tbody.innerHTML = rows
      .map((o) => {
        const next = nextStatuses(o);
        const name = o.originalFileName || o.originalFileNames?.[0] || 'Document';
        const files = o.originalFileNames?.length || 1;
        const canNoShow =
          o.paymentMethod === 'cod' &&
          o.paymentStatus !== 'completed' &&
          !DONE_STATUSES.has(o.status) &&
          o.status !== 'pending_cod_approval';
        const slot = o.deliveryOption?.scheduledSlot;
        const action = [
          canBookCourier(o)
            ? `<button class="btn btn-sm" data-book="${esc(o.orderId)}">${icon('truck', 'icon-sm')}Book courier</button>`
            : next.map((s) => `<button class="btn btn-sm" data-move="${esc(o.orderId)}" data-status="${esc(s)}">${esc(ORDER_STATUS_LABEL[s] || s)}</button>`).join(' '),
          canNoShow ? `<button class="btn btn-sm btn-plain" style="color:var(--danger)" data-cod="no_show" data-order="${esc(o.orderId)}">No-show</button>` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `
          <tr>
            <td><button class="btn btn-plain mono" data-open="${esc(o.orderId)}" title="Open order">${esc(o.orderId)}</button></td>
            <td class="muted">${esc(new Date(o.createdAt).toLocaleDateString())}</td>
            <td class="truncate" title="${esc(name)}">${esc(name)}${files > 1 ? ` <span class="muted">+${files - 1}</span>` : ''}${printedOn(o) ? `<div class="muted small truncate">Printed on ${esc(printedOn(o))}</div>` : ''}</td>
            <td class="truncate">${esc(o.customerInfo?.name || '')}</td>
            <td class="muted">
              ${esc(o.deliveryOption?.partnerDeliveryPoint ? `Point: ${o.deliveryOption.partnerDeliveryPoint}` : fulfilmentLabel(o))}
              ${slot?.date ? `<div class="small muted">${esc(slot.date)} · ${esc(slot.label || '')}</div>` : ''}
            </td>
            <td class="num">
              ${esc(money(partnerShare(o), 2))}
              ${o.paymentMethod === 'cod' ? `<div class="small">${o.paymentStatus === 'completed' ? 'Cash paid' : 'Cash COD'}</div>` : ''}
            </td>
            <td>${pill(ORDER_STATUS_LABEL[o.status] || o.status, statusTone(o.status))}</td>
            <td style="width:190px">${action}</td>
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

  codBox?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cod]');
    if (!btn) return;
    const order = orders.find((o) => o.orderId === btn.dataset.order);
    if (!order) return;
    setBusy(btn, true);
    const updated = await codActionFor(order, btn.dataset.cod);
    setBusy(btn, false);
    if (updated) await load();
  });

  tbody.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      const order = orders.find((o) => o.orderId === open.dataset.open);
      if (order) window.electronAPI.openOrderWindow(order);
      return;
    }
    const codBtn = e.target.closest('[data-cod]');
    if (codBtn) {
      const order = orders.find((o) => o.orderId === codBtn.dataset.order);
      if (!order) return;
      setBusy(codBtn, true);
      const updated = await codActionFor(order, codBtn.dataset.cod);
      setBusy(codBtn, false);
      if (updated) await load();
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
