/**
 * Messages & Pickup-Point Broadcasts page for Partner Desktop.
 * Calls /api/chat/* and /api/partner/* through window.electronAPI.api (Bearer JWT in main process).
 */
function initMessages({ onBadgeChange }) {
  const $ = (id) => document.getElementById(id);
  const convListEl = $('msg-conv-list');
  const threadEmptyEl = $('msg-thread-empty');
  const threadPaneEl = $('msg-thread-pane');
  const threadHeadEl = $('msg-thread-head');
  const threadBannerEl = $('msg-thread-banner');
  const threadMessagesEl = $('msg-thread-messages');
  const msgDraftEl = $('msg-draft');
  const msgSendBtn = $('msg-send-btn');
  const pointFilterEl = $('msg-point-filter');
  const refreshBtn = $('msg-refresh-btn');

  // Broadcast controls
  const bpPointEl = $('bp-point');
  const bpDateEl = $('bp-date');
  const bpPreviewEl = $('bp-preview');
  const bpMessageEl = $('bp-message');
  const bpSendBtn = $('bp-send-btn');
  const bpHistoryEl = $('bp-history');

  let conversations = [];
  let selectedId = null;
  let pollTimer = null;

  function updateBadge() {
    const count = conversations.reduce((sum, c) => sum + (c.unreadPartner || 0) + (c.needsHumanAttention ? 1 : 0), 0);
    onBadgeChange?.(count);
  }

  async function loadConversations() {
    const point = pointFilterEl?.value || '__all__';
    const qs = new URLSearchParams({ role: 'partner' });
    if (point !== '__all__') qs.set('pickupPoint', point);
    const { ok, data } = await window.electronAPI.api('GET', `/api/chat/conversations?${qs.toString()}`);
    if (!ok || !data?.success) return;
    conversations = data.conversations || [];
    if (!selectedId || !conversations.some((c) => c.conversationId === selectedId)) {
      selectedId = conversations[0]?.conversationId || null;
    }
    updateBadge();
    renderConversations();
    if (selectedId) await loadThread(selectedId);
    else renderThreadEmpty();
  }

  function renderConversations() {
    if (!conversations.length) {
      convListEl.innerHTML = `<div class="muted small" style="padding:24px;text-align:center">No customer conversations yet.</div>`;
      return;
    }
    convListEl.innerHTML = conversations
      .map((c) => {
        const active = c.conversationId === selectedId;
        const badges = [
          c.needsHumanAttention ? pill('Needs reply', 'danger') : '',
          c.orderSummary?.status === 'pending_cod_approval' ? pill('COD Approval', 'warning') : '',
          c.unreadPartner > 0 ? pill(`${c.unreadPartner} new`, 'info') : '',
        ].join(' ');
        return `
          <button type="button" class="chat-conv-item ${active ? 'active' : ''}" data-conv="${esc(c.conversationId)}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <strong>${esc(c.customerName)}</strong>
              <span>${badges}</span>
            </div>
            <div class="muted small" style="margin-top:2px">
              ${c.orderId ? `<span class="mono">#${esc(c.orderId)}</span>` : 'General chat'}
              ${c.pickupPointName ? ` · ${esc(c.pickupPointName)}` : ''}
            </div>
            <div class="muted small truncate" style="margin-top:4px">${esc(c.lastMessagePreview || '')}</div>
          </button>`;
      })
      .join('');
  }

  function renderThreadEmpty() {
    threadPaneEl.classList.add('hidden');
    threadEmptyEl.classList.remove('hidden');
  }

  async function loadThread(conversationId) {
    const conv = conversations.find((c) => c.conversationId === conversationId);
    if (!conv) return renderThreadEmpty();
    threadEmptyEl.classList.add('hidden');
    threadPaneEl.classList.remove('hidden');

    const aiPaused = Boolean(conv.aiPausedUntil && new Date(conv.aiPausedUntil).getTime() > Date.now());
    threadHeadEl.innerHTML = `
      <div>
        <strong>${esc(conv.customerName)}</strong>
        <span class="muted small" style="margin-left:8px">${esc(conv.customerPhone || conv.customerEmail)}</span>
        <div class="muted small">
          ${conv.orderId ? `<span class="mono">#${esc(conv.orderId)}</span>` : 'Shop chat'}
          ${conv.scheduledSlot?.date ? ` · ${esc(conv.scheduledSlot.date)} (${esc(conv.scheduledSlot.label)})` : ''}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-sm" id="msg-ai-toggle" data-action="${aiPaused ? 'resume' : 'pause'}">
          ${aiPaused ? 'Resume AI' : 'Pause AI'}
        </button>
      </div>`;

    const banners = [];
    if (conv.needsHumanAttention) {
      banners.push(banner('danger', 'Needs your reply', `${conv.escalationReason || 'Escalated for partner review'}. Replying pauses AI automatically.`));
    }
    if (conv.orderId && conv.orderSummary?.paymentMethod === 'cod' && conv.orderSummary?.status === 'pending_cod_approval') {
      banners.push(`
        <div class="banner banner-warning" style="justify-content:space-between;align-items:center">
          <div>
            <strong>Cash on Pickup · ₹${Math.round(conv.orderSummary.amount || 0)} due at pickup</strong>
            <div class="small muted">Confirm with the customer below before clicking Approve & Print.</div>
          </div>
          <div class="actions">
            <button type="button" class="btn btn-sm" data-cod-action="decline" data-order="${esc(conv.orderId)}">Decline COD</button>
            <button type="button" class="btn btn-sm btn-primary" data-cod-action="approve" data-order="${esc(conv.orderId)}">Approve &amp; Print</button>
          </div>
        </div>`);
    }
    threadBannerEl.innerHTML = banners.join('');

    const { ok, data } = await window.electronAPI.api('GET', `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages?role=partner`);
    if (!ok || !data?.success) return;
    const msgs = data.messages || [];
    threadMessagesEl.innerHTML = msgs.length
      ? msgs
          .map((m) => {
            if (m.senderType === 'system') {
              return `<div class="chat-bubble system"><div class="small"><strong>${esc(m.senderName)}</strong> · ${esc(new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div><div>${esc(m.body)}</div></div>`;
            }
            const own = m.senderType === 'partner' || m.senderType === 'ai_bot';
            const who = m.senderType === 'ai_bot' ? `${m.senderName} (AI)` : own ? 'You' : m.senderName;
            return `
              <div class="chat-row ${own ? 'own' : 'peer'}">
                <div class="muted small">${esc(who)} · ${esc(new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>
                <div class="chat-bubble ${own ? 'own' : 'peer'}">${esc(m.body)}</div>
              </div>`;
          })
          .join('')
      : `<p class="muted small" style="text-align:center;padding:24px">No messages yet.</p>`;
    threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
  }

  async function loadBroadcasts() {
    const { ok, data } = await window.electronAPI.api('GET', '/api/partner/broadcasts');
    if (!ok || !data?.success) return;
    const pts = data.deliveryPoints || [];
    const current = bpPointEl.value;
    bpPointEl.innerHTML = pts.length
      ? pts.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')
      : '<option value="">No pickup points configured</option>';
    if (current && pts.some((p) => p.name === current)) bpPointEl.value = current;

    // Sync filter options too
    const filterCur = pointFilterEl.value;
    pointFilterEl.innerHTML = ['<option value="__all__">All locations</option>', ...pts.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`)].join('');
    if (filterCur) pointFilterEl.value = filterCur;

    bpSendBtn.disabled = !pts.length;
    const list = data.broadcasts || [];
    bpHistoryEl.innerHTML = list.length
      ? list
          .slice(0, 4)
          .map((b) => `<div class="small muted"><strong>${esc(b.pickupPointName)}</strong> (${b.recipientCount} notified): ${esc(b.message)}</div>`)
          .join('')
      : '';
    await updatePreview();
  }

  async function updatePreview() {
    const pt = bpPointEl.value;
    if (!pt) {
      bpPreviewEl.textContent = 'Add a delivery point in Shop settings first.';
      return;
    }
    const qs = new URLSearchParams({ preview: '1', pickupPoint: pt });
    if (bpDateEl.value) qs.set('date', bpDateEl.value);
    const { ok, data } = await window.electronAPI.api('GET', `/api/partner/broadcasts?${qs.toString()}`);
    if (ok && data?.success) {
      bpPreviewEl.textContent = `${data.recipientCount || 0} active order(s) will be notified`;
    }
  }

  async function sendMessage() {
    const body = msgDraftEl.value.trim();
    if (!selectedId || !body) return;
    setBusy(msgSendBtn, true, 'Sending');
    const { ok, data } = await window.electronAPI.api('POST', `/api/chat/conversations/${encodeURIComponent(selectedId)}/messages?role=partner`, { body });
    setBusy(msgSendBtn, false);
    if (!ok || !data?.success) {
      toast(data?.error || 'Could not send message.');
      return;
    }
    msgDraftEl.value = '';
    await loadThread(selectedId);
    await loadConversations();
  }

  convListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-conv]');
    if (!btn) return;
    selectedId = btn.dataset.conv;
    renderConversations();
    loadThread(selectedId);
  });

  threadHeadEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('#msg-ai-toggle');
    if (!btn || !selectedId) return;
    setBusy(btn, true);
    const { ok } = await window.electronAPI.api('POST', `/api/chat/conversations/${encodeURIComponent(selectedId)}/ai?role=partner`, { action: btn.dataset.action });
    setBusy(btn, false);
    if (ok) await loadConversations();
  });

  threadBannerEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cod-action]');
    if (!btn) return;
    setBusy(btn, true);
    await codActionFor({ orderId: btn.dataset.order }, btn.dataset.codAction);
    setBusy(btn, false);
    await loadConversations();
  });

  document.querySelectorAll('[data-bp-tpl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pt = bpPointEl.value;
      if (!pt) return;
      bpMessageEl.value = btn.dataset.bpTpl.replace(/\{point\}/g, pt);
    });
  });

  bpPointEl.addEventListener('change', updatePreview);
  bpDateEl.addEventListener('change', updatePreview);
  pointFilterEl.addEventListener('change', loadConversations);
  refreshBtn.addEventListener('click', () => { loadBroadcasts(); loadConversations(); });
  msgSendBtn.addEventListener('click', sendMessage);
  msgDraftEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  bpSendBtn.addEventListener('click', async () => {
    const pickupPointName = bpPointEl.value;
    const message = bpMessageEl.value.trim();
    if (!pickupPointName || message.length < 3) return toast('Choose a pickup point and enter a message.');
    setBusy(bpSendBtn, true, 'Sending');
    const { ok, data } = await window.electronAPI.api('POST', '/api/partner/broadcasts', {
      pickupPointName,
      ...(bpDateEl.value ? { scheduledDate: bpDateEl.value } : {}),
      message,
    });
    setBusy(bpSendBtn, false);
    if (!ok || !data?.success) return toast(data?.error || 'Could not send broadcast.');
    toast(`Broadcast sent to ${data.recipientCount} order(s).`);
    bpMessageEl.value = '';
    await loadBroadcasts();
    await loadConversations();
  });

  async function load() {
    await Promise.all([loadBroadcasts(), loadConversations()]);
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (document.getElementById('page-messages') && !document.getElementById('page-messages').classList.contains('hidden')) {
          loadConversations();
        }
      }, 6000);
    }
  }

  function onSocketMessage(payload) {
    loadConversations();
    if (selectedId && payload?.conversationId === selectedId) loadThread(selectedId);
  }

  return { load, onSocketMessage };
}
