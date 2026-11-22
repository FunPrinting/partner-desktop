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
  form.addEventListener('input', () => setDirty(true));
  form.addEventListener('change', () => setDirty(true));
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
      <div><button type="button" class="btn btn-plain dp-here">${icon('pin', 'icon-sm')}Use the shop's map pin</button></div>`;
    card.querySelector('.dp-name').value = dp.name || '';
    card.querySelector('.dp-contact').value = dp.contactNumber || '';
    card.querySelector('.dp-lat').value = dp.location?.coordinates?.[1] ?? $('set-lat').value;
    card.querySelector('.dp-lng').value = dp.location?.coordinates?.[0] ?? $('set-lng').value;
    card.querySelector('.dp-here').addEventListener('click', () => {
      card.querySelector('.dp-lat').value = $('set-lat').value;
      card.querySelector('.dp-lng').value = $('set-lng').value;
      setDirty(true);
    });
    card.firstElementChild.appendChild(removeButton('Remove delivery point', () => card.remove()));
    box.appendChild(card);
  }

  $('add-phone-btn').addEventListener('click', () => {
    addPhone();
    setDirty(true);
  });
  $('add-dp-btn').addEventListener('click', () => {
    addDeliveryPoint();
    setDirty(true);
  });

  // ── Map ─────────────────────────────────────────────────────────────

  function setPin(lat, lng, zoom) {
    $('set-lat').value = Number(lat).toFixed(6);
    $('set-lng').value = Number(lng).toFixed(6);
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
    
    // Printing prices
    $('set-price-a4-bw-single').value = p.pricing?.printing?.a4?.blackAndWhite?.singleSided ?? '';
    $('set-price-a4-bw-double').value = p.pricing?.printing?.a4?.blackAndWhite?.doubleSided ?? '';
    $('set-price-a4-color-single').value = p.pricing?.printing?.a4?.color?.singleSided ?? '';
    $('set-price-a4-color-double').value = p.pricing?.printing?.a4?.color?.doubleSided ?? '';
    $('set-price-a3-bw-single').value = p.pricing?.printing?.a3?.blackAndWhite?.singleSided ?? '';
    $('set-price-a3-bw-double').value = p.pricing?.printing?.a3?.blackAndWhite?.doubleSided ?? '';
    $('set-price-a3-color-single').value = p.pricing?.printing?.a3?.color?.singleSided ?? '';
    $('set-price-a3-color-double').value = p.pricing?.printing?.a3?.color?.doubleSided ?? '';
    
    // Binding service
    $('set-binding-enabled').checked = p.servicesOffered?.binding?.enabled ?? false;
    $('set-binding-spiral').checked = p.servicesOffered?.binding?.types?.spiral ?? false;
    $('set-binding-perfect').checked = p.servicesOffered?.binding?.types?.perfect ?? false;
    $('set-binding-staple').checked = p.servicesOffered?.binding?.types?.staple ?? false;
    $('set-price-binding-spiral').value = p.pricing?.binding?.spiral ?? '';
    $('set-price-binding-perfect').value = p.pricing?.binding?.perfect ?? '';
    $('set-price-binding-staple').value = p.pricing?.binding?.staple ?? '';
    
    // Other services
    $('set-lamination-enabled').checked = p.servicesOffered?.lamination?.enabled ?? false;
    $('set-lamination-max-size').value = p.servicesOffered?.lamination?.maxSize || 'a4';
    $('set-price-lamination-a4').value = p.pricing?.lamination?.a4 ?? '';
    $('set-price-lamination-a3').value = p.pricing?.lamination?.a3 ?? '';
    
    $('set-scanning-enabled').checked = p.servicesOffered?.scanning?.enabled ?? false;
    $('set-price-scanning').value = p.pricing?.scanning ?? '';
    
    $('set-photocopying-enabled').checked = p.servicesOffered?.photocopying?.enabled ?? false;
    $('set-photocopying-color').checked = p.servicesOffered?.photocopying?.supportsColor ?? false;
    $('set-price-photocopying-bw').value = p.pricing?.photocopying?.blackAndWhite ?? '';
    $('set-price-photocopying-color').value = p.pricing?.photocopying?.color ?? '';
    
    $('set-plastic-files-enabled').checked = p.servicesOffered?.plasticFiles?.enabled ?? false;
    $('set-price-plastic-files').value = p.pricing?.plasticFiles ?? '';
    
    $('set-delivery-enabled').checked = p.servicesOffered?.delivery?.enabled ?? false;
    
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
    subtitle.textContent = p.businessName ? `${p.businessName} · what customers see` : 'Profile, prices and location customers see.';
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
          enabled: $('set-delivery-enabled').checked,
        },
        customServices: [],
      },
      pricing: {
        printing: {
          a4: {
            blackAndWhite: { singleSided: num('set-price-a4-bw-single', 2), doubleSided: num('set-price-a4-bw-double', 3) },
            color: { singleSided: num('set-price-a4-color-single', 10), doubleSided: num('set-price-a4-color-double', 15) },
          },
          a3: {
            blackAndWhite: { singleSided: num('set-price-a3-bw-single', 4), doubleSided: num('set-price-a3-bw-double', 6) },
            color: { singleSided: num('set-price-a3-color-single', 20), doubleSided: num('set-price-a3-color-double', 30) },
          },
          letter: {
            blackAndWhite: { singleSided: num('set-price-a4-bw-single', 2), doubleSided: num('set-price-a4-bw-double', 3) },
            color: { singleSided: num('set-price-a4-color-single', 10), doubleSided: num('set-price-a4-color-double', 15) },
          },
          legal: {
            blackAndWhite: { singleSided: num('set-price-a4-bw-single', 2), doubleSided: num('set-price-a4-bw-double', 3) },
            color: { singleSided: num('set-price-a4-color-single', 10), doubleSided: num('set-price-a4-color-double', 15) },
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
