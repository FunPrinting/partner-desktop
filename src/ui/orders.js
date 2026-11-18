/**
 * Orders modal: the shop's orders with their status. Printing is driven by
 * print jobs (jobs.js); this view is for looking up orders and moving them on
 * after printing (ready for pickup, delivered, completed).
 */

const NEXT_STATUSES = {
  paid: ['printing', 'printed'],
  processing: ['printing', 'printed'],
  printing: ['printed'],
  printed: ['ready_for_pickup', 'delivered', 'completed'],
  ready_for_pickup: ['delivered', 'completed'],
  dispatched: ['delivered', 'completed'],
  delivered: ['completed'],
};

const STATUS_LABEL = {
  printing: 'Printing',
  printed: 'Printed',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  completed: 'Completed',
};

function initOrders() {
  const ordersModal = document.getElementById('orders-modal');
  const ordersTbody = document.getElementById('orders-tbody');
  const ordersLoading = document.getElementById('orders-loading');
  const ordersEmpty = document.getElementById('orders-empty');
  let lastOrders = [];

  document.getElementById('open-orders-btn').addEventListener('click', async () => {
    ordersModal.classList.remove('hidden');
    await loadOrders();
  });
  document.getElementById('close-orders-btn').addEventListener('click', () => ordersModal.classList.add('hidden'));

  async function loadOrders() {
    ordersTbody.innerHTML = '';
    ordersEmpty.classList.add('hidden');

    const cached = await getAllCachedOrders().catch(() => []);
    if (cached && cached.length) {
      cached.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      renderOrders(cached);
    } else {
      ordersLoading.classList.remove('hidden');
    }

    const { ok, status, data } = await window.electronAPI.api('GET', '/api/partner/orders');
    ordersLoading.classList.add('hidden');
    if (!ok) {
      if (!cached || !cached.length) {
        ordersEmpty.classList.remove('hidden');
        ordersEmpty.querySelector('h3').innerText = status === 401 ? 'Please sign in' : 'Offline and no saved orders';
      }
      return;
    }
    const orders = data.orders || [];
    // Keep the local cache to what the server has
    const db = getDB();
    if (db && cached) {
      const keep = new Set(orders.map((o) => o.orderId));
      const store = db.transaction([getStoreName()], 'readwrite').objectStore(getStoreName());
      cached.forEach((o) => {
        if (!keep.has(o.orderId)) store.delete(o.orderId);
      });
    }
    for (const o of orders) await cacheOrder(o);
    if (!orders.length) {
      ordersTbody.innerHTML = '';
      ordersEmpty.classList.remove('hidden');
      return;
    }
    renderOrders(orders);
  }

  function statusBadge(status) {
    const colours = {
      completed: 'bg-green-100 text-green-700',
      delivered: 'bg-green-100 text-green-700',
      ready_for_pickup: 'bg-yellow-100 text-yellow-800',
      printed: 'bg-teal-100 text-teal-700',
      printing: 'bg-blue-100 text-blue-700',
      cancelled: 'bg-red-100 text-red-600',
      refunded: 'bg-red-100 text-red-600',
    };
    return `<span class="px-2 py-1 rounded-full text-xs ${colours[status] || 'bg-gray-100 text-gray-600'}">${esc(STATUS_LABEL[status] || status)}</span>`;
  }

  function renderOrders(orders) {
    lastOrders = orders;
    ordersTbody.innerHTML = orders
      .map((order, i) => {
        const next = NEXT_STATUSES[order.status] || [];
        const action = next.length
          ? `<select data-order="${esc(order.orderId)}" class="order-status bg-white border border-gray-300 rounded px-2 py-1 text-xs text-gray-900">
               <option value="" selected disabled>Move to…</option>
               ${next.map((s) => `<option value="${esc(s)}">${esc(STATUS_LABEL[s] || s)}</option>`).join('')}
             </select>`
          : '';
        const name = order.originalFileName || order.originalFileNames?.[0] || 'Document';
        return `
          <tr class="hover:bg-white/50 transition-colors">
            <td class="px-4 py-3 font-mono text-blue-600 cursor-pointer underline" data-open="${i}">${esc(String(order.orderId).slice(0, 10))}</td>
            <td class="px-4 py-3 text-gray-500">${esc(new Date(order.createdAt).toLocaleDateString())}</td>
            <td class="px-4 py-3 text-gray-600 max-w-[180px] truncate" title="${esc(name)}">${esc(name)}</td>
            <td class="px-4 py-3 font-bold text-green-700">₹${esc((Number(order.amount || 0) * 0.9).toFixed(2))}</td>
            <td class="px-4 py-3">${statusBadge(order.status)}</td>
            <td class="px-4 py-3">${action}</td>
          </tr>`;
      })
      .join('');
  }

  ordersTbody.addEventListener('click', async (e) => {
    const cell = e.target.closest('[data-open]');
    if (!cell) return;
    const order = lastOrders[Number(cell.dataset.open)];
    if (order) window.electronAPI.openOrderWindow(order);
  });

  ordersTbody.addEventListener('change', async (e) => {
    const select = e.target.closest('select.order-status');
    if (!select || !select.value) return;
    const result = await window.electronAPI.updateOrderStatus(select.dataset.order, select.value);
    if (!result.ok) alert(`Could not update the order: ${result.data.error || result.status}`);
    await loadOrders();
  });
}
