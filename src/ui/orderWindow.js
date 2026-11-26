/**
 * Order window: summary, customer, file preview, status moves, download and
 * "Print again here" (local only; the order's status does not change).
 */
(function orderWindow() {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  document.documentElement.classList.add(params.get('platform') || 'platform-other');

  const LABEL = ORDER_STATUS_LABEL;
  const TONE = { completed: 'success', delivered: 'success', ready_for_pickup: 'warning', printed: 'warning', pending_cod_approval: 'warning', printing: 'info', processing: 'info', cancelled: 'danger', refunded: 'danger' };

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
    $('pills').innerHTML =
      pill(LABEL[order.status] || order.status, TONE[order.status] || 'neutral') +
      pill(fulfilmentLabel(order)) +
      (order.paymentMethod === 'cod' ? pill(order.paymentStatus === 'completed' ? 'Cash paid' : 'Cash COD', order.paymentStatus === 'completed' ? 'success' : 'warning') : '');
    const o = order.printingOptions || {};
    $('summary').innerHTML = kv([
      ['Placed', order.createdAt ? new Date(order.createdAt).toLocaleString() : ''],
      ['Type', order.orderType === 'template' ? 'Template' : 'File upload'],
      ['Paper', o.pageSize || 'A4'],
      ['Colour', o.color === 'color' ? 'Colour' : o.color === 'mixed' ? 'Mixed colour' : 'Black & white'],
      ['Sides', o.sided === 'double' ? 'Double-sided' : 'Single-sided'],
      ['Copies', o.copies || 1],
      ['Pages', o.pageCount],
      ['Payment', order.paymentMethod === 'cod' ? (order.paymentStatus === 'completed' ? 'Cash on Pickup (Paid)' : 'Cash on Pickup (Due)') : 'Razorpay Online'],
      ['Order total', typeof order.amount === 'number' ? money(order.amount, 2) : ''],
      ['Your share', typeof order.amount === 'number' ? money(partnerShare(order), 2) : ''],
      ['Printed on', printedOn(order)],
    ]);
    const d = order.deliveryOption || {};
    const how = fulfilmentOf(order);
    const slotStr = d.scheduledSlot?.date ? `${d.scheduledSlot.date}${d.scheduledSlot.label ? ` · ${d.scheduledSlot.label}` : ''}` : '';
    $('delivery').innerHTML = how === 'pickup'
      ? kv([['How', 'Customer collects from your shop'], ['Delivery point', d.partnerDeliveryPoint], ['Pickup slot', slotStr]])
      : kv([
          ['How', how === 'shop' ? 'You deliver' : 'Courier from your shop'],
          ['Recipient', [d.recipientName, d.recipientPhone].filter(Boolean).join(' · ')],
          ['Address', [d.flatBuilding, d.address, d.landmark ? `near ${d.landmark}` : '', d.city, d.state, d.pinCode].filter(Boolean).join(', ')],
          ['Distance', how === 'shop' && d.distance ? `${d.distance} km` : ''],
          ['Delivery fee', d.deliveryCharge ? `${money(d.deliveryCharge, 2)}${how === 'shop' ? ' (yours)' : ''}` : ''],
          ['Courier', order.shiprocket?.awbCode ? `${order.shiprocket.courierName || ''} · AWB ${order.shiprocket.awbCode}` : ''],
          ['Delivery code', how === 'shop' ? (d.handover?.verified ? 'Accepted' : 'Ask the customer when you hand it over') : ''],
        ]);
    $('customer').innerHTML = kv([
      ['Name', order.customerInfo?.name || 'Unknown'],
      ['Phone', order.customerInfo?.phone],
      ['Email', order.customerInfo?.email],
    ]);
    const next = nextStatuses(order);
    if (order.paymentMethod === 'cod' && order.status === 'pending_cod_approval') {
      $('status-actions').innerHTML = `
        <button class="btn" data-cod="decline">Decline COD</button>
        <button class="btn btn-primary" data-cod="approve">${icon('check', 'icon-sm')}Approve &amp; Print</button>`;
    } else {
      const canNoShow = order.paymentMethod === 'cod' && order.paymentStatus !== 'completed' && !['completed', 'cancelled', 'refunded'].includes(order.status);
      const primary = canBookCourier(order)
        ? `<button class="btn btn-primary" data-book="1">${icon('truck', 'icon-sm')}Book courier pickup</button>`
        : next.length
          ? next.map((s, i) => `<button class="btn ${i === 0 ? 'btn-primary' : ''}" data-status="${esc(s)}">${i === 0 ? icon('check', 'icon-sm') : ''}${esc(LABEL[s])}</button>`).join('')
          : `<p class="muted">${how === 'courier' && order.shiprocket?.awbCode ? 'The courier collects it from your shop. Tracking updates the status.' : 'Nothing more to do for this order.'}</p>`;
      $('status-actions').innerHTML = primary + (canNoShow ? ` <button class="btn btn-danger" data-cod="no_show">Mark No-Show</button>` : '');
    }
    renderPreview();
  }

  $('doc-files').addEventListener('click', (e) => {
    const b = e.target.closest('[data-file]');
    if (!b) return;
    fileIndex = Number(b.dataset.file);
    renderPreview();
  });

  $('status-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-status], [data-book], [data-cod]');
    if (!b || !order) return;
    setBusy(b, true);
    const updated = b.dataset.cod
      ? await codActionFor(order, b.dataset.cod)
      : b.dataset.book
        ? await bookCourierFor(order)
        : await moveOrder(order, b.dataset.status);
    setBusy(b, false);
    if (updated) {
      order = { ...order, ...updated };
      render();
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
