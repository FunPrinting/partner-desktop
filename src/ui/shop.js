/**
 * Shop page: earnings, taking orders, acceptance mode, business details,
 * prices, phone numbers, map location and delivery points.
 */

function initShop() {
  const form = document.getElementById('shop-form');
  const saveBtn = document.getElementById('save-shop-btn');
  const bannerBox = document.getElementById('shop-banner');
  const subtitle = document.getElementById('shop-subtitle');
  const $ = (id) => document.getElementById(id);
  let partner = null;
  let dirty = false;
  let map = null;
  let marker = null;

  function setDirty(v) {
    dirty = v;
    saveBtn.disabled = !v;
    saveBtn.textContent = v ? 'Save changes' : 'Saved';
  }

  function updateDynamicVisibility() {
    // 1. Paper size & printing modes
    const isA3 = $('set-max-paper-size')?.value === 'a3';
    const cardA3 = $('card-price-a3');
    if (cardA3) cardA3.classList.toggle('hidden', !isA3);

    const supportsDuplex = Boolean($('set-supports-duplex')?.checked);
    document.querySelectorAll('.col-duplex').forEach((el) => el.classList.toggle('hidden', !supportsDuplex));

    const supportsColor = Boolean($('set-supports-color')?.checked);
    document.querySelectorAll('.row-color').forEach((el) => el.classList.toggle('hidden', !supportsColor));

    const supportsBW = Boolean($('set-supports-bw')?.checked);
    document.querySelectorAll('.row-bw').forEach((el) => el.classList.toggle('hidden', !supportsBW));

    // 2. Binding service
    const bindingOn = Boolean($('set-binding-enabled')?.checked);
    const bindingBody = $('binding-options-body');
    if (bindingBody) bindingBody.classList.toggle('hidden', !bindingOn);
    $('wrap-binding-spiral')?.classList.toggle('hidden', !$('set-binding-spiral')?.checked);
    $('wrap-binding-perfect')?.classList.toggle('hidden', !$('set-binding-perfect')?.checked);
    $('wrap-binding-staple')?.classList.toggle('hidden', !$('set-binding-staple')?.checked);

    // 3. Lamination
    const lamOn = Boolean($('set-lamination-enabled')?.checked);
    const lamBody = $('lamination-body');
    if (lamBody) lamBody.classList.toggle('hidden', !lamOn);
    const lamA3 = $('set-lamination-max-size')?.value === 'a3';
    $('wrap-lamination-a3')?.classList.toggle('hidden', !lamA3);

    // 4. Scanning
    const scanBody = $('scanning-body');
    if (scanBody) scanBody.classList.toggle('hidden', !$('set-scanning-enabled')?.checked);

    // 5. Photocopying
    const photoBody = $('photocopying-body');
    if (photoBody) photoBody.classList.toggle('hidden', !$('set-photocopying-enabled')?.checked);
    $('wrap-photocopying-color')?.classList.toggle('hidden', !$('set-photocopying-color')?.checked);

    // 6. Plastic files
    const plasticBody = $('plastic-files-body');
    if (plasticBody) plasticBody.classList.toggle('hidden', !$('set-plastic-files-enabled')?.checked);

    // 7. Delivery
    const delivSelfBody = $('delivery-self-body');
    if (delivSelfBody) delivSelfBody.classList.toggle('hidden', !$('set-delivery-self-enabled')?.checked);
    const delivCourierBody = $('delivery-courier-body');
    if (delivCourierBody) delivCourierBody.classList.toggle('hidden', !$('set-delivery-courier-enabled')?.checked);

    // 8. COD
    const codBody = $('cod-body');
    if (codBody) codBody.classList.toggle('hidden', !$('set-cod-enabled')?.checked);
  }

  form.addEventListener('input', () => setDirty(true));
  form.addEventListener('change', () => {
    updateDynamicVisibility();
    setDirty(true);
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  // ── Dynamic lists ───────────────────────────────────────────────────

  function removeButton(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-icon btn-plain';
    b.setAttribute('aria-label', label);
    b.style.color = 'var(--danger)';
    b.innerHTML = icon('minus-circle');
    b.addEventListener('click', () => {
      onClick();
      setDirty(true);
    });
    return b;
  }

  function addPhone(value = '') {
    const box = $('phones-container');
    box.querySelector('.hint')?.remove();
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';
    const input = document.createElement('input');
    input.className = 'input shop-phone';
    input.type = 'tel';
    input.placeholder = '+91 98765 43210';
    input.setAttribute('aria-label', 'Phone number');
    input.value = value;
    row.append(input, removeButton('Remove phone number', () => row.remove()));
    box.appendChild(row);
  }

  let activePinTarget = null;

  function populatePointSelect(sel, preferred) {
    const current = preferred !== undefined ? preferred : sel.value || '*';
    const names = [...document.querySelectorAll('#dp-container .dp .dp-name')]
      .map((el) => el.value.trim())
      .filter(Boolean);
    const unique = [...new Set(names)];
    const opts = [{ value: '*', label: 'All pickup points' }, ...unique.map((n) => ({ value: n, label: n }))];
    if (current && current !== '*' && !unique.includes(current)) {
      opts.push({ value: current, label: `${current} (custom)` });
    }
    sel.innerHTML = opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    sel.value = current || '*';
  }

  function syncSlotPointDropdowns() {
    document.querySelectorAll('#slots-container .slot-point').forEach((sel) => populatePointSelect(sel));
  }

  function setActivePinTarget(next) {
    activePinTarget = next;
    if (next) {
      const lat = parseFloat(next.card.querySelector('.dp-lat').value);
      const lng = parseFloat(next.card.querySelector('.dp-lng').value);
      if (map && !isNaN(lat) && !isNaN(lng)) {
        marker.setLatLng([lat, lng]);
        map.setView([lat, lng], Math.max(map.getZoom(), 15));
      }
      toast(`Map clicks now update "${next.nameEl.value.trim() || 'this pickup point'}". Click "Done" when finished.`);
      $('shop-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const lat = parseFloat($('set-lat').value);
      const lng = parseFloat($('set-lng').value);
      if (map && !isNaN(lat) && !isNaN(lng)) {
        marker.setLatLng([lat, lng]);
      }
    }
    document.querySelectorAll('#dp-container .dp-pick').forEach((btn) => {
      const isMe = activePinTarget && btn.closest('.dp') === activePinTarget.card;
      btn.textContent = isMe ? 'Done picking' : 'Pick on map';
    });
  }

  function addDeliveryPoint(dp = {}) {
    const box = $('dp-container');
    const card = document.createElement('div');
    card.className = 'card card-pad dp';
    card.innerHTML = `
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div class="field" style="flex:1"><label>Name</label><input class="input dp-name" placeholder="Campus gate"></div>
        <div class="field" style="flex:1"><label>Contact number (optional)</label><input class="input dp-contact" type="tel"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Latitude</label><input class="input dp-lat" type="number" step="any"></div>
        <div class="field"><label>Longitude</label><input class="input dp-lng" type="number" step="any"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-plain dp-pick">${icon('pin', 'icon-sm')}Pick on map</button>
        <button type="button" class="btn btn-plain dp-here">Use the shop's map pin</button>
      </div>`;
    const nameEl = card.querySelector('.dp-name');
    nameEl.value = dp.name || '';
    card.querySelector('.dp-contact').value = dp.contactNumber || '';
    card.querySelector('.dp-lat').value = dp.location?.coordinates?.[1] ?? $('set-lat').value;
    card.querySelector('.dp-lng').value = dp.location?.coordinates?.[0] ?? $('set-lng').value;
    nameEl.addEventListener('input', syncSlotPointDropdowns);
    card.querySelector('.dp-pick').addEventListener('click', () => {
      if (activePinTarget?.card === card) setActivePinTarget(null);
      else setActivePinTarget({ card, nameEl });
    });
    card.querySelector('.dp-here').addEventListener('click', () => {
      card.querySelector('.dp-lat').value = $('set-lat').value;
      card.querySelector('.dp-lng').value = $('set-lng').value;
      setDirty(true);
    });
    card.firstElementChild.appendChild(
      removeButton('Remove delivery point', () => {
        if (activePinTarget?.card === card) setActivePinTarget(null);
        card.remove();
        syncSlotPointDropdowns();
      })
    );
    box.appendChild(card);
    syncSlotPointDropdowns();
  }

  $('add-phone-btn').addEventListener('click', () => {
    addPhone();
    setDirty(true);
  });
  $('add-dp-btn').addEventListener('click', () => {
    addDeliveryPoint();
    setDirty(true);
  });

  function addSlot(slot = {}) {
    const box = $('slots-container');
    box.querySelector('.hint')?.remove();
    const card = document.createElement('div');
    card.className = 'card card-pad slot-item';
    card.dataset.slotId = slot.id || `slot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    card.innerHTML = `
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div class="field" style="flex:1"><label>Target</label><select class="select slot-target"><option value="store">Main Store</option><option value="pickup_point">Pickup Point</option></select></div>
        <div class="field slot-point-wrap" style="flex:1"><label>Pickup point</label><select class="select slot-point"></select></div>
      </div>
      <div class="grid-3">
        <div class="field"><label>Start (HH:MM)</label><input class="input slot-start" placeholder="10:00"></div>
        <div class="field"><label>End (HH:MM)</label><input class="input slot-end" placeholder="12:00"></div>
        <div class="field"><label>Label (optional)</label><input class="input slot-label" placeholder="10:00 AM – 12:00 PM"></div>
      </div>
      <div class="row" style="padding:4px 0 0"><div class="row-main"><div class="row-title">Active</div></div><label class="switch"><input type="checkbox" class="slot-active"><span></span></label></div>`;
    const targetSel = card.querySelector('.slot-target');
    const pointWrap = card.querySelector('.slot-point-wrap');
    const pointSel = card.querySelector('.slot-point');
    targetSel.value = slot.target === 'pickup_point' ? 'pickup_point' : 'store';
    populatePointSelect(pointSel, slot.pickupPointName || '*');
    card.querySelector('.slot-start').value = slot.startTime || '10:00';
    card.querySelector('.slot-end').value = slot.endTime || '12:00';
    card.querySelector('.slot-label').value = slot.label || '';
    card.querySelector('.slot-active').checked = slot.isActive !== false;
    const syncPointVis = () => pointWrap.classList.toggle('hidden', targetSel.value !== 'pickup_point');
    targetSel.addEventListener('change', syncPointVis);
    syncPointVis();
    card.firstElementChild.appendChild(removeButton('Remove slot', () => card.remove()));
    box.appendChild(card);
  }

  $('add-slot-btn')?.addEventListener('click', () => {
    addSlot();
    setDirty(true);
  });

  // ── Map ─────────────────────────────────────────────────────────────

  function setPin(lat, lng, zoom) {
    const fLat = Number(lat).toFixed(6);
    const fLng = Number(lng).toFixed(6);
    if (activePinTarget) {
      activePinTarget.card.querySelector('.dp-lat').value = fLat;
      activePinTarget.card.querySelector('.dp-lng').value = fLng;
    } else {
      $('set-lat').value = fLat;
      $('set-lng').value = fLng;
    }
    if (map) {
      marker.setLatLng([lat, lng]);
      map.setView([lat, lng], zoom || map.getZoom());
    }
  }

  function initMap() {
    if (map || typeof L === 'undefined') return;
    // Leaflet looks for its marker images next to its own script
    L.Icon.Default.imagePath = 'node_modules/leaflet/dist/images/';
    map = L.map('shop-map').setView([28.6139, 77.209], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 19 }).addTo(map);
    marker = L.marker([28.6139, 77.209], { draggable: true, keyboard: true, title: 'Shop location' }).addTo(map);
    map.on('click', (e) => {
      setPin(e.latlng.lat, e.latlng.lng);
      setDirty(true);
    });
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      setPin(p.lat, p.lng);
      setDirty(true);
    });
    const follow = () => {
      const lat = parseFloat($('set-lat').value);
      const lng = parseFloat($('set-lng').value);
      if (!isNaN(lat) && !isNaN(lng)) {
        marker.setLatLng([lat, lng]);
        map.setView([lat, lng]);
      }
    };
    $('set-lat').addEventListener('input', follow);
    $('set-lng').addEventListener('input', follow);
  }

  async function searchPlace() {
    const q = $('map-search').value.trim();
    if (!q) return;
    const btn = $('map-search-btn');
    setBusy(btn, true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data && data.length) {
        setPin(parseFloat(data[0].lat), parseFloat(data[0].lon), 15);
        setDirty(true);
      } else toast('Place not found.');
    } catch {
      toast('Search failed. Check your connection.');
    } finally {
      setBusy(btn, false);
    }
  }
  $('map-search-btn').addEventListener('click', searchPlace);
  $('map-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchPlace();
    }
  });

  $('locate-me-btn').addEventListener('click', () => {
    const btn = $('locate-me-btn');
    setBusy(btn, true, 'Locating');
    const ipFallback = async () => {
      try {
        const data = await (await fetch('https://ipwho.is/')).json();
        if (data && data.success) {
          setPin(data.latitude, data.longitude, 15);
          setDirty(true);
          toast('Approximate location from your internet connection. Drag the pin to adjust.');
        } else toast('Could not find your location. Click the map instead.');
      } catch {
        toast('Could not find your location. Click the map instead.');
      } finally {
        setBusy(btn, false);
      }
    };
    if (!navigator.geolocation) return ipFallback();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPin(pos.coords.latitude, pos.coords.longitude, 16);
        setDirty(true);
        setBusy(btn, false);
      },
      () => ipFallback(),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });

  // ── Load and save ───────────────────────────────────────────────────

  function populate(p) {
    $('set-business-name').value = p.businessName || '';
    $('set-street').value = p.address?.street || '';
    $('set-city').value = p.address?.city || '';
    $('set-state').value = p.address?.state || '';
    $('set-zip').value = p.address?.zipCode || '';
    
    // Printing service
    $('set-printing-enabled').checked = p.servicesOffered?.printing?.enabled ?? true;
    $('set-max-paper-size').value = p.servicesOffered?.printing?.maxPaperSize || 'a4';
    $('set-supports-color').checked = p.servicesOffered?.printing?.supportsColor ?? true;
    $('set-supports-bw').checked = p.servicesOffered?.printing?.supportsBlackAndWhite ?? true;
    $('set-supports-duplex').checked = p.servicesOffered?.printing?.supportsDoubleSided ?? false;
    
    // Printing prices (defaults according to standard rate card)
    $('set-price-a4-bw-single').value = p.pricing?.printing?.a4?.blackAndWhite?.singleSided ?? 2;
    $('set-price-a4-bw-double').value = p.pricing?.printing?.a4?.blackAndWhite?.doubleSided ?? 3;
    $('set-price-a4-color-single').value = p.pricing?.printing?.a4?.color?.singleSided ?? 5;
    $('set-price-a4-color-double').value = p.pricing?.printing?.a4?.color?.doubleSided ?? 8;
    $('set-price-a3-bw-single').value = p.pricing?.printing?.a3?.blackAndWhite?.singleSided ?? 4;
    $('set-price-a3-bw-double').value = p.pricing?.printing?.a3?.blackAndWhite?.doubleSided ?? 6;
    $('set-price-a3-color-single').value = p.pricing?.printing?.a3?.color?.singleSided ?? 10;
    $('set-price-a3-color-double').value = p.pricing?.printing?.a3?.color?.doubleSided ?? 15;
    
    // Binding service
    $('set-binding-enabled').checked = p.servicesOffered?.binding?.enabled ?? false;
    $('set-binding-spiral').checked = p.servicesOffered?.binding?.types?.spiral ?? false;
    $('set-binding-perfect').checked = p.servicesOffered?.binding?.types?.perfect ?? false;
    $('set-binding-staple').checked = p.servicesOffered?.binding?.types?.staple ?? false;
    $('set-price-binding-spiral').value = p.pricing?.binding?.spiral ?? 30;
    $('set-price-binding-perfect').value = p.pricing?.binding?.perfect ?? 50;
    $('set-price-binding-staple').value = p.pricing?.binding?.staple ?? 10;
    
    // Other services
    $('set-lamination-enabled').checked = p.servicesOffered?.lamination?.enabled ?? false;
    $('set-lamination-max-size').value = p.servicesOffered?.lamination?.maxSize || 'a4';
    $('set-price-lamination-a4').value = p.pricing?.lamination?.a4 ?? 20;
    $('set-price-lamination-a3').value = p.pricing?.lamination?.a3 ?? 40;
    
    $('set-scanning-enabled').checked = p.servicesOffered?.scanning?.enabled ?? false;
    $('set-price-scanning').value = p.pricing?.scanning ?? 5;
    
    $('set-photocopying-enabled').checked = p.servicesOffered?.photocopying?.enabled ?? false;
    $('set-photocopying-color').checked = p.servicesOffered?.photocopying?.supportsColor ?? false;
    $('set-price-photocopying-bw').value = p.pricing?.photocopying?.blackAndWhite ?? 2;
    $('set-price-photocopying-color').value = p.pricing?.photocopying?.color ?? 10;
    
    $('set-plastic-files-enabled').checked = p.servicesOffered?.plasticFiles?.enabled ?? false;
    $('set-price-plastic-files').value = p.pricing?.plasticFiles ?? 10;
    
    // Delivery (Self delivery + Courier)
    $('set-delivery-self-enabled').checked = p.delivery?.self?.enabled ?? p.servicesOffered?.delivery?.enabled ?? false;
    $('set-delivery-radius').value = p.delivery?.self?.radiusKm ?? 3;
    $('set-delivery-fee').value = p.delivery?.self?.fee ?? 30;
    $('set-delivery-eta').value = p.delivery?.self?.etaMinutes ?? 120;
    $('set-delivery-courier-enabled').checked = p.delivery?.courier?.enabled ?? false;
    $('set-delivery-enabled').checked = $('set-delivery-self-enabled').checked || $('set-delivery-courier-enabled').checked;
    
    $('set-is-online').checked = Boolean(p.isOnline);
    $('set-is-online').disabled = !p.isActive;
    $('set-acceptance-mode').value = p.acceptanceMode === 'manual' ? 'manual' : 'auto';
    $('phones-container').innerHTML = '';
    (p.phoneNumbers || []).forEach((ph) => addPhone(ph));
    if (!(p.phoneNumbers || []).length) $('phones-container').innerHTML = '<p class="hint">No phone numbers yet.</p>';
    const coords = p.location?.coordinates;
    if (coords && (coords[0] || coords[1])) {
      $('set-lng').value = coords[0];
      $('set-lat').value = coords[1];
    }
    $('dp-container').innerHTML = '';
    (p.deliveryPoints || []).forEach((dp) => addDeliveryPoint(dp));

    // COD, AI Assistant & Schedule Slots
    if ($('set-cod-enabled')) $('set-cod-enabled').checked = Boolean(p.cod?.enabled);
    if ($('set-cod-allow-points')) $('set-cod-allow-points').checked = Boolean(p.cod?.allowAtPickupPoints);
    if ($('set-cod-max-amount')) $('set-cod-max-amount').value = p.cod?.maxOrderAmount ?? 200;
    if ($('set-cod-cash-fee')) $('set-cod-cash-fee').value = p.cod?.cashFee ?? 0;
    if ($('set-ai-enabled')) $('set-ai-enabled').checked = p.aiAssistant?.enabled !== false;
    if ($('set-ai-pause-mins')) $('set-ai-pause-mins').value = p.aiAssistant?.autoPauseMinutes ?? 45;
    if ($('set-ai-faq-notes')) $('set-ai-faq-notes').value = p.aiAssistant?.faqNotes || '';
    if ($('slots-container')) {
      $('slots-container').innerHTML = '';
      (p.scheduleSlots || []).forEach((s) => addSlot(s));
      if (!(p.scheduleSlots || []).length) $('slots-container').innerHTML = '<p class="hint">Default store windows are active. Click Add slot to customize.</p>';
    }

    subtitle.textContent = p.businessName ? `${p.businessName} · what customers see` : 'Profile, prices and location customers see.';

    // Synchronise capability-driven visibility
    updateDynamicVisibility();
  }

  async function loadFinancials() {
    const { ok, data } = await window.electronAPI.api('GET', '/api/partner/financials');
    if (!ok || !data.success || !data.financials) return;
    const f = data.financials;
    $('financials').classList.remove('hidden');
    $('today-earnings').textContent = money(f.todayEarnings);
    $('total-earnings').textContent = money(f.totalEarnings);
    $('total-orders').textContent = String(f.completedOrdersCount ?? 0);
  }

  async function load() {
    loadFinancials();
    if (dirty) return; // don't overwrite unsaved edits
    const { ok, data } = await window.electronAPI.api('GET', '/api/partner/profile');
    if (!ok || !data.partner) {
      bannerBox.innerHTML = banner('warning', 'Could not load your shop', 'Check your connection and open this page again.');
      return;
    }
    partner = data.partner;
    bannerBox.innerHTML = partner.isActive ? '' : banner('info', 'Waiting for approval', 'FunPrinting is reviewing your shop. You can take orders once it is approved.');
    populate(partner);
    setDirty(false);
    initMap();
    setTimeout(() => {
      map.invalidateSize();
      const lat = parseFloat($('set-lat').value);
      const lng = parseFloat($('set-lng').value);
      if (!isNaN(lat) && !isNaN(lng)) setPin(lat, lng, 15);
    }, 50);
  }

  saveBtn.addEventListener('click', async () => {
    const num = (id, fallback) => {
      const n = parseFloat($(id).value);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const point = (lat, lng) => ({ type: 'Point', coordinates: [parseFloat(lng) || 0, parseFloat(lat) || 0] });
    const payload = {
      businessName: $('set-business-name').value.trim(),
      location: point($('set-lat').value, $('set-lng').value),
      address: { street: $('set-street').value.trim(), city: $('set-city').value.trim(), state: $('set-state').value.trim(), zipCode: $('set-zip').value.trim() },
      servicesOffered: {
        printing: {
          enabled: $('set-printing-enabled').checked,
          maxPaperSize: $('set-max-paper-size').value,
          supportsColor: $('set-supports-color').checked,
          supportsBlackAndWhite: $('set-supports-bw').checked,
          supportsDoubleSided: $('set-supports-duplex').checked,
        },
        binding: {
          enabled: $('set-binding-enabled').checked,
          types: {
            spiral: $('set-binding-spiral').checked,
            perfect: $('set-binding-perfect').checked,
            staple: $('set-binding-staple').checked,
          },
        },
        lamination: {
          enabled: $('set-lamination-enabled').checked,
          maxSize: $('set-lamination-max-size').value,
        },
        scanning: {
          enabled: $('set-scanning-enabled').checked,
        },
        photocopying: {
          enabled: $('set-photocopying-enabled').checked,
          supportsColor: $('set-photocopying-color').checked,
        },
        plasticFiles: {
          enabled: $('set-plastic-files-enabled').checked,
        },
        delivery: {
          enabled: Boolean($('set-delivery-self-enabled')?.checked || $('set-delivery-courier-enabled')?.checked),
        },
        customServices: [],
      },
      delivery: {
        self: {
          enabled: Boolean($('set-delivery-self-enabled')?.checked),
          radiusKm: num('set-delivery-radius', 3),
          fee: num('set-delivery-fee', 30),
          etaMinutes: num('set-delivery-eta', 120),
        },
        courier: {
          enabled: Boolean($('set-delivery-courier-enabled')?.checked),
        },
      },
      pricing: {
        printing: {
          a4: {
            blackAndWhite: { singleSided: num('set-price-a4-bw-single', 2), doubleSided: num('set-price-a4-bw-double', 3) },
            color: { singleSided: num('set-price-a4-color-single', 5), doubleSided: num('set-price-a4-color-double', 8) },
          },
          a3: {
            blackAndWhite: { singleSided: num('set-price-a3-bw-single', 4), doubleSided: num('set-price-a3-bw-double', 6) },
            color: { singleSided: num('set-price-a3-color-single', 10), doubleSided: num('set-price-a3-color-double', 15) },
          },
          letter: {
            blackAndWhite: { singleSided: num('set-price-a4-bw-single', 2), doubleSided: num('set-price-a4-bw-double', 3) },
            color: { singleSided: num('set-price-a4-color-single', 5), doubleSided: num('set-price-a4-color-double', 8) },
          },
          legal: {
            blackAndWhite: { singleSided: num('set-price-a4-bw-single', 2), doubleSided: num('set-price-a4-bw-double', 3) },
            color: { singleSided: num('set-price-a4-color-single', 5), doubleSided: num('set-price-a4-color-double', 8) },
          },
        },
        binding: {
          spiral: num('set-price-binding-spiral', 30),
          perfect: num('set-price-binding-perfect', 50),
          staple: num('set-price-binding-staple', 10),
        },
        lamination: {
          a4: num('set-price-lamination-a4', 20),
          a3: num('set-price-lamination-a3', 40),
        },
        scanning: num('set-price-scanning', 5),
        photocopying: {
          blackAndWhite: num('set-price-photocopying-bw', 2),
          color: num('set-price-photocopying-color', 10),
        },
        plasticFiles: num('set-price-plastic-files', 10),
        customServices: [],
      },
      isOnline: $('set-is-online').checked,
      acceptanceMode: $('set-acceptance-mode').value === 'manual' ? 'manual' : 'auto',
      phoneNumbers: [...document.querySelectorAll('.shop-phone')].map((i) => i.value.trim()).filter(Boolean),
      deliveryPoints: [...document.querySelectorAll('#dp-container .dp')]
        .map((c) => ({
          name: c.querySelector('.dp-name').value.trim(),
          contactNumber: c.querySelector('.dp-contact').value.trim(),
          location: point(c.querySelector('.dp-lat').value, c.querySelector('.dp-lng').value),
        }))
        .filter((d) => d.name),
      cod: {
        enabled: Boolean($('set-cod-enabled')?.checked),
        allowAtPickupPoints: Boolean($('set-cod-allow-points')?.checked),
        maxOrderAmount: Math.min(1000, Math.max(50, Math.round(num('set-cod-max-amount', 200)))),
        cashFee: Math.min(50, Math.max(0, Math.round(num('set-cod-cash-fee', 0)))),
      },
      aiAssistant: {
        enabled: $('set-ai-enabled') ? Boolean($('set-ai-enabled').checked) : true,
        autoPauseMinutes: Math.min(240, Math.max(5, Math.round(num('set-ai-pause-mins', 45)))),
        faqNotes: ($('set-ai-faq-notes')?.value || '').trim(),
      },
      scheduleSlots: [...document.querySelectorAll('#slots-container .slot-item')]
        .map((c) => {
          const target = c.querySelector('.slot-target').value === 'pickup_point' ? 'pickup_point' : 'store';
          const pickupPointName = c.querySelector('.slot-point').value.trim();
          const startTime = c.querySelector('.slot-start').value.trim();
          const endTime = c.querySelector('.slot-end').value.trim();
          const label = c.querySelector('.slot-label').value.trim();
          return {
            id: c.dataset.slotId,
            target,
            ...(target === 'pickup_point' && pickupPointName ? { pickupPointName } : {}),
            ...(label ? { label } : {}),
            startTime,
            endTime,
            cutoffMinutes: 30,
            isActive: c.querySelector('.slot-active').checked,
          };
        })
        .filter((s) => /^\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}$/.test(s.endTime) && s.endTime > s.startTime),
    };
    setBusy(saveBtn, true, 'Saving');
    const { data } = await window.electronAPI.api('POST', '/api/partner/profile', payload);
    setBusy(saveBtn, false);
    if (!data.success) {
      await ask({ title: 'Could not save', message: data.error || 'Check your connection and try again.', cancel: null });
      setDirty(true);
      return;
    }
    toast('Shop saved.');
    setDirty(false);
    window.electronAPI.syncJobs();
    load();
  });

  return { load, isDirty: () => dirty };
}
