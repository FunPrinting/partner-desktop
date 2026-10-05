/**
 * Orders modal — fetch, render, cache sync, status updates
 */

// Track which orders have already been injected to the print queue this session
const injectedOrderIds = new Set();

function initOrders() {
  const ordersModal = document.getElementById('orders-modal');
  const openOrdersBtn = document.getElementById('open-orders-btn');
  const closeOrdersBtn = document.getElementById('close-orders-btn');
  const ordersTbody = document.getElementById('orders-tbody');
  const ordersLoading = document.getElementById('orders-loading');
  const ordersEmpty = document.getElementById('orders-empty');

  openOrdersBtn.addEventListener('click', async () => {
    ordersModal.classList.remove('hidden');
    await loadOrders();
  });

  closeOrdersBtn.addEventListener('click', () => {
    ordersModal.classList.add('hidden');
  });

  // Auto-update order status on print completion
  if (window.electronAPI.onJobCompleted) {
    window.electronAPI.onJobCompleted((job) => {
      const orderId = job.orderId || job.jobId;
      if (orderId) {
        console.log(`[Auto-Update] Setting order ${orderId} to ready_for_pickup after successful print`);
        window.updateOrderStatus(orderId, 'ready_for_pickup');
      }
    });
  }

  // Handle job cancellation — remove from local cache
  if (window.electronAPI.onJobCancelled) {
    window.electronAPI.onJobCancelled((jobId) => {
      console.log(`[Cancel] Removing cancelled order ${jobId} from local cache`);
      const db = getDB();
      if (db) {
        const transaction = db.transaction([getStoreName()], 'readwrite');
        const store = transaction.objectStore(getStoreName());
        store.delete(jobId);
      }
      if (!ordersModal.classList.contains('hidden')) {
        loadOrders();
      }
    });
  }

  // ── Load & Render ──────────────────────────────────────────────────

  async function loadOrders() {
    const token = document.getElementById('access-token').value;
    if (!token) return;

    ordersTbody.innerHTML = '';

    // Show cached data instantly
    try {
      const cachedOrders = await getAllCachedOrders();
      if (cachedOrders && cachedOrders.length > 0) {
        cachedOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        renderOrdersToTable(cachedOrders);
      } else {
        ordersLoading.classList.remove('hidden');
      }
    } catch (e) {
      ordersLoading.classList.remove('hidden');
    }

    ordersEmpty.classList.add('hidden');

    try {
      const res = await fetch('https://www.funprinting.store/api/partner/orders', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();

      ordersLoading.classList.add('hidden');

      if (data.success && data.orders.length > 0) {
        processFetchedOrdersForQueue(data.orders);
        renderOrdersToTable(data.orders);
        ordersEmpty.classList.add('hidden');
      } else {
        // Server returned 0 orders — clear all cached orders
        const cachedOrders = await getAllCachedOrders();
        const db = getDB();
        if (cachedOrders && db) {
          const transaction = db.transaction([getStoreName()], 'readwrite');
          const store = transaction.objectStore(getStoreName());
          cachedOrders.forEach(o => {
            store.delete(o.orderId);
            injectedOrderIds.delete(o.orderId);
            if (window.electronAPI.cancelJob) {
              window.electronAPI.cancelJob(o.orderId);
            }
          });
        }
        ordersTbody.innerHTML = '';
        ordersEmpty.classList.remove('hidden');
      }
    } catch (e) {
      console.error("Network fetch failed, attempting to load from cache:", e);
      try {
        const cachedOrders = await getAllCachedOrders();
        if (cachedOrders && cachedOrders.length > 0) {
          ordersLoading.classList.add('hidden');
          ordersEmpty.classList.add('hidden');
          cachedOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          renderOrdersToTable(cachedOrders);
        } else {
          ordersLoading.classList.add('hidden');
          ordersEmpty.classList.remove('hidden');
          ordersEmpty.innerText = 'Offline and no cached orders found.';
        }
      } catch (cacheErr) {
        ordersLoading.classList.add('hidden');
        ordersEmpty.classList.remove('hidden');
        ordersEmpty.innerText = 'Failed to load orders (Offline).';
      }
    }
  }

  function renderOrdersToTable(orders) {
    ordersTbody.innerHTML = '';
    orders.forEach(order => {
      const tr = document.createElement('tr');
      tr.className = "hover:bg-white/50 transition-colors";

      let statusBadgeHtml = '';
      if (order.status === 'completed') statusBadgeHtml = '<span class="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">Completed</span>';
      else if (order.status === 'ready_for_pickup') statusBadgeHtml = '<span class="px-2 py-1 bg-yellow-900/50 text-yellow-400 rounded-full text-xs">Ready</span>';
      else if (order.status === 'printing') statusBadgeHtml = '<span class="px-2 py-1 bg-blue-900/50 text-blue-400 rounded-full text-xs">Printing</span>';
      else statusBadgeHtml = '<span class="px-2 py-1 bg-gray-100 text-gray-600 rounded-full text-xs">' + order.status + '</span>';

      let actionHtml = '';
      if (order.status !== 'completed') {
        actionHtml = `
          <select class="bg-white border border-gray-600 rounded px-2 py-1 text-xs focus:ring-indigo-500 focus:border-blue-500 text-gray-900" onchange="updateOrderStatus('${order.orderId}', this.value)">
            <option value="${order.status}" selected disabled>${order.status}</option>
            <option value="pending">Pending</option>
            <option value="printing">Printing</option>
            <option value="ready_for_pickup">Ready for Pickup</option>
            <option value="completed">Completed</option>
          </select>
        `;
      }

      const encodedOrder = encodeURIComponent(JSON.stringify(order));
      tr.innerHTML = `
        <td class="px-4 py-3 font-mono text-gray-600 cursor-pointer" onclick="openOrderDetails('${encodedOrder}')">${order.orderId.substring(0,8)}</td>
        <td class="px-4 py-3 font-mono text-gray-600">${order.orderId.substring(0,8)}</td>
        <td class="px-4 py-3 text-gray-500">${new Date(order.createdAt).toLocaleDateString()}</td>
        <td class="px-4 py-3 text-gray-600 max-w-[150px] truncate" title="${order.originalFileName || 'Doc'}">${order.originalFileName || 'Doc'}</td>
        <td class="px-4 py-3 font-bold text-green-700">₹${(order.amount * 0.9).toFixed(2)}</td>
        <td class="px-4 py-3">${statusBadgeHtml}</td>
        <td class="px-4 py-3">${actionHtml}</td>
      `;
      ordersTbody.appendChild(tr);
    });
  }

  // ── Queue Injection ────────────────────────────────────────────────

  async function processFetchedOrdersForQueue(orders) {
    const db = getDB();
    if (!db) await initDB();

    const validOrderIds = new Set(orders.map(o => o.orderId));

    // Cleanup stale orders
    const cachedOrders = await getAllCachedOrders();
    if (cachedOrders && db) {
      const transaction = db.transaction([getStoreName()], 'readwrite');
      const store = transaction.objectStore(getStoreName());
      cachedOrders.forEach(o => {
        if (!validOrderIds.has(o.orderId)) {
          store.delete(o.orderId);
          injectedOrderIds.delete(o.orderId);
          if (window.electronAPI.cancelJob) {
            window.electronAPI.cancelJob(o.orderId);
          }
        }
      });
    }

    orders.forEach(async (order) => {
      await cacheOrder(order);
      if (!injectedOrderIds.has(order.orderId) &&
          (order.status === 'paid' || order.status === 'processing' || order.status === 'printing')) {
        injectedOrderIds.add(order.orderId);
        const job = {
          jobId: order.orderId,
          orderId: order.orderId,
          url: order.fileURL || (order.fileURLs ? order.fileURLs[0] : null),
          options: order.printingOptions,
          customer: order.customerInfo,
          orderDetails: order
        };
        window.electronAPI.injectJob(job);
      }
    });
  }

  // ── Global Helpers ─────────────────────────────────────────────────

  window.openOrderDetails = async function(encodedOrder) {
    const order = JSON.parse(decodeURIComponent(encodedOrder));
    await cacheOrder(order);
    window.electronAPI.openOrderWindow(order);
  };

  window.updateOrderStatus = async function(orderId, newStatus) {
    const token = document.getElementById('access-token').value;
    if (!token) return;
    try {
      const res = await fetch(`https://www.funprinting.store/api/partner/orders/${orderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        loadOrders();
      } else {
        alert('Failed to update status');
      }
    } catch (e) {
      alert('Network error');
    }
  };
}
