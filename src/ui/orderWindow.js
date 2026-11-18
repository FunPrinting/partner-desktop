/**
 * Order window: summary, customer, file preview, status moves, download and
 * "Print again here" (local only; the order's status does not change).
 */
(function orderWindow() {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  document.documentElement.classList.add(params.get('platform') || 'platform-other');

  const NEXT = {
    paid: ['printing', 'printed'],
    processing: ['printing', 'printed'],
    printing: ['printed'],
    printed: ['ready_for_pickup', 'delivered', 'completed'],
    ready_for_pickup: ['delivered', 'completed'],
    dispatched: ['delivered', 'completed'],
    delivered: ['completed'],
  };
  const LABEL = {
    pending_payment: 'Awaiting payment', paid: 'Paid', processing: 'Processing', printing: 'Printing', printed: 'Printed',
    ready_for_pickup: 'Ready for pickup', dispatched: 'Dispatched', delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded',
  };
  const TONE = { completed: 'success', delivered: 'success', ready_for_pickup: 'warning', printed: 'warning', printing: 'info', processing: 'info', cancelled: 'danger', refunded: 'danger' };

  let order = null;
  let fileIndex = 0;

  const kv = (rows) => rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  function files() {
    const urls = order.fileURLs?.length ? order.fileURLs : order.fileURL ? [order.fileURL] : [];
    return urls.map((url, i) => {
      let name = order.originalFileNames?.[i] || (i === 0 ? order.originalFileName : '') || `File ${i + 1}`;
      const type = String(order.fileTypes?.[i] || order.fileType || '').split('/').pop() || 'pdf';
      if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = `${name}.${type}`;
      return { url, name, type: name.split('.').pop().toLowerCase() };
    });
  }

  function renderPreview() {
    const list = files();
    const f = list[fileIndex];
    $('doc-files').innerHTML = list.length > 1 ? list.map((x, i) => `<button class="btn btn-plain" data-file="${i}" aria-pressed="${i === fileIndex}" style="${i === fileIndex ? 'background:var(--primary-soft)' : ''}">${esc(x.name)}</button>`).join('') : '';
    $('doc-name').textContent = f ? f.name : 'No file';
    const box = $('preview');
    if (!f || !/^https:\/\//i.test(f.url)) {
      box.innerHTML = emptyState('info', 'No preview', 'This order has no file to show.');
      return;
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(f.type)) {
      box.innerHTML = `<img alt="${esc(f.name)}">`;
      box.querySelector('img').src = f.url;
    } else if (f.type === 'pdf') {
      box.innerHTML = `<iframe title="${esc(f.name)}"></iframe>`;
      box.querySelector('iframe').src = f.url;
    } else {
      box.innerHTML = emptyState('info', 'No preview for this file type', 'Download the file to open it.');
    }
  }

  function render() {
    document.title = `Order ${order.orderId}`;
    $('title').textContent = `Order ${order.orderId}`;
    $('pills').innerHTML = pill(LABEL[order.status] || order.status, TONE[order.status] || 'neutral') + pill(order.deliveryOption?.type === 'delivery' ? 'Delivery' : 'Pickup');
    const o = order.printingOptions || {};
    $('summary').innerHTML = kv([
      ['Placed', order.createdAt ? new Date(order.createdAt).toLocaleString() : ''],
      ['Type', order.orderType === 'template' ? 'Template' : 'File upload'],
      ['Paper', o.pageSize || 'A4'],
      ['Colour', o.color === 'color' ? 'Colour' : o.color === 'mixed' ? 'Mixed colour' : 'Black & white'],
      ['Sides', o.sided === 'double' ? 'Double-sided' : 'Single-sided'],
      ['Copies', o.copies || 1],
      ['Pages', o.pageCount],
      ['Order total', typeof order.amount === 'number' ? money(order.amount, 2) : ''],
      ['Your share (90%)', typeof order.amount === 'number' ? money(order.amount * 0.9, 2) : ''],
    ]);
    $('customer').innerHTML = kv([
      ['Name', order.customerInfo?.name || 'Unknown'],
      ['Phone', order.customerInfo?.phone],
      ['Email', order.customerInfo?.email],
    ]);
    const next = NEXT[order.status] || [];
    $('status-actions').innerHTML = next.length
      ? next.map((s, i) => `<button class="btn ${i === 0 ? 'btn-primary' : ''}" data-status="${esc(s)}">${i === 0 ? icon('check', 'icon-sm') : ''}${esc(LABEL[s])}</button>`).join('')
      : '<p class="muted">Nothing more to do for this order.</p>';
    renderPreview();
  }

  $('doc-files').addEventListener('click', (e) => {
    const b = e.target.closest('[data-file]');
    if (!b) return;
    fileIndex = Number(b.dataset.file);
    renderPreview();
  });

  $('status-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-status]');
    if (!b || !order) return;
    setBusy(b, true);
    const result = await window.electronAPI.updateOrderStatus(order.orderId, b.dataset.status);
    setBusy(b, false);
    if (result.ok) {
      order.status = b.dataset.status;
      render();
      toast(`Moved to ${LABEL[order.status]}.`);
    } else {
      await ask({ title: 'Could not update the order', message: result.data.error || `Error ${result.status}`, cancel: null });
    }
  });

  $('print-again-btn').addEventListener('click', async () => {
    if (!order) return;
    const go = await ask({ title: 'Print this order again here?', message: 'All its files go to this computer\'s printer. The order\'s status does not change.', ok: 'Print again' });
    if (!go) return;
    const result = await window.electronAPI.printAgain(order);
    if (result.ok) toast(`Sent ${result.files} file(s) to the printer.`);
    else await ask({ title: 'Could not print', message: result.error, cancel: null });
  });

  $('download-btn').addEventListener('click', () => {
    const f = files()[fileIndex];
    if (f && /^https:\/\//i.test(f.url)) window.open(f.url, '_blank');
  });

  window.electronAPI.onOrderData((data) => {
    order = data;
    fileIndex = 0;
    render();
  });
})();
