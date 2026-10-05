/**
 * Settings modal — shop profile, pricing, delivery points, map, save
 */

function initSettings() {
  const settingsModal = document.getElementById('settings-modal');

  // ── Dynamic UI Builders ────────────────────────────────────────────

  function addDeliveryPointUI(name = '', lat = '', lng = '', contactNumber = '') {
    const dpContainer = document.getElementById('dp-container');
    const div = document.createElement('div');
    div.className = "flex gap-2 items-start bg-gray-50/50 p-2 rounded border border-gray-200 flex-col sm:flex-row";
    div.innerHTML = `
      <div class="flex-1 w-full space-y-2">
        <input type="text" placeholder="Name (e.g. Campus Gate)" class="dp-name w-full bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs text-gray-900" value="${name}">
        <input type="text" placeholder="Contact Number (Optional)" class="dp-contact w-full bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs text-gray-900" value="${contactNumber}">
        <div class="flex gap-2">
          <input type="number" step="any" placeholder="Lat" class="dp-lat w-full bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs text-gray-900" value="${lat}">
          <input type="number" step="any" placeholder="Lng" class="dp-lng w-full bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs text-gray-900" value="${lng}">
        </div>
      </div>
      <button type="button" onclick="this.parentElement.remove()" class="text-red-600 hover:text-red-700 p-2 shrink-0">✕</button>
    `;
    dpContainer.appendChild(div);
  }

  function addPhoneUI(phone = '') {
    const container = document.getElementById('phones-container');
    const div = document.createElement('div');
    div.className = "flex gap-2 items-center";
    div.innerHTML = `
      <input type="text" placeholder="e.g. +919876543210" class="shop-phone w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 text-gray-900" value="${phone}">
      <button type="button" onclick="this.parentElement.remove()" class="text-red-600 hover:text-red-700 p-2 shrink-0">✕</button>
    `;
    container.appendChild(div);
  }

  document.getElementById('add-phone-btn')?.addEventListener('click', () => addPhoneUI());
  document.getElementById('add-dp-btn')?.addEventListener('click', () => addDeliveryPointUI());

  // ── Open Settings ──────────────────────────────────────────────────

  document.getElementById('open-settings-btn').addEventListener('click', async () => {
    const token = document.getElementById('access-token').value;
    if (!token) {
      alert("Please sign in first.");
      return;
    }

    document.getElementById('open-settings-btn').innerHTML = 'Loading...';
    try {
      const res = await fetch('https://www.funprinting.store/api/partner/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success && data.partner) {
        _populateForm(data.partner, addPhoneUI, addDeliveryPointUI);
      }

      settingsModal.classList.remove('hidden');
      _initMap();

    } catch (err) {
      console.error(err);
      alert("Failed to load profile data");
    }
    document.getElementById('open-settings-btn').innerHTML = 'Manage Shop Profile';
  });

  // ── Close Settings ─────────────────────────────────────────────────

  const closeSettings = () => settingsModal.classList.add('hidden');
  document.getElementById('close-settings-btn').addEventListener('click', closeSettings);
  document.getElementById('cancel-settings-btn').addEventListener('click', closeSettings);

  // ── Save Settings ──────────────────────────────────────────────────

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const token = document.getElementById('access-token').value;
    const saveBtn = document.getElementById('save-settings-btn');

    const dps = Array.from(document.getElementById('dp-container').children).map(div => ({
      name: div.querySelector('.dp-name').value,
      contactNumber: div.querySelector('.dp-contact')?.value || '',
      location: {
        type: 'Point',
        coordinates: [
          parseFloat(div.querySelector('.dp-lng').value) || 0,
          parseFloat(div.querySelector('.dp-lat').value) || 0
        ]
      }
    })).filter(dp => dp.name);

    const phoneNumbers = Array.from(document.getElementById('phones-container').children)
      .map(div => div.querySelector('.shop-phone')?.value.trim())
      .filter(Boolean);

    const payload = {
      businessName: document.getElementById('set-business-name').value,
      location: {
        type: 'Point',
        coordinates: [
          parseFloat(document.getElementById('set-lng').value) || 0,
          parseFloat(document.getElementById('set-lat').value) || 0
        ]
      },
      address: {
        street: document.getElementById('set-street').value,
        city: document.getElementById('set-city').value,
        state: document.getElementById('set-state').value,
        zipCode: document.getElementById('set-zip').value
      },
      pricing: {
        perPageBW: parseFloat(document.getElementById('set-price-bw').value) || 2,
        perPageColor: parseFloat(document.getElementById('set-price-color').value) || 10,
        binding: parseFloat(document.getElementById('set-price-binding').value) || 40
      },
      isOnline: document.getElementById('set-is-online').checked,
      deliveryPoints: dps,
      phoneNumbers: phoneNumbers
    };

    saveBtn.innerText = 'Saving...';
    saveBtn.disabled = true;

    try {
      const res = await fetch('https://www.funprinting.store/api/partner/profile', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        closeSettings();
      } else {
        alert('Failed to save profile: ' + data.error);
      }
    } catch (err) {
      alert('Failed to connect to server.');
    }
    saveBtn.innerText = 'Save Profile';
    saveBtn.disabled = false;
  });

  // ── Private Helpers ────────────────────────────────────────────────

  function _populateForm(partner, addPhoneFn, addDPFn) {
    document.getElementById('set-business-name').value = partner.businessName || '';
    if (partner.address) {
      document.getElementById('set-street').value = partner.address.street || '';
      document.getElementById('set-city').value = partner.address.city || '';
      document.getElementById('set-state').value = partner.address.state || '';
      document.getElementById('set-zip').value = partner.address.zipCode || '';
    }
    if (partner.location && partner.location.coordinates) {
      document.getElementById('set-lng').value = partner.location.coordinates[0];
      document.getElementById('set-lat').value = partner.location.coordinates[1];
    }
    if (partner.pricing) {
      document.getElementById('set-price-bw').value = partner.pricing.perPageBW || 2;
      document.getElementById('set-price-color').value = partner.pricing.perPageColor || 10;
      document.getElementById('set-price-binding').value = partner.pricing.binding || 40;
    }
    if (partner.isOnline !== undefined) {
      document.getElementById('set-is-online').checked = partner.isOnline;
    }

    const phoneContainer = document.getElementById('phones-container');
    phoneContainer.innerHTML = '';
    if (partner.phoneNumbers && partner.phoneNumbers.length > 0) {
      partner.phoneNumbers.forEach(phone => addPhoneFn(phone));
    }

    const dpContainer = document.getElementById('dp-container');
    dpContainer.innerHTML = '';
    if (partner.deliveryPoints) {
      partner.deliveryPoints.forEach(dp => {
        addDPFn(dp.name, dp.location.coordinates[1], dp.location.coordinates[0], dp.contactNumber || '');
      });
    }
  }

  function _initMap() {
    if (!window.shopMap) {
      window.shopMap = L.map('shop-map').setView([28.6139, 77.2090], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19
      }).addTo(window.shopMap);

      window.shopMarker = L.marker([28.6139, 77.2090], { draggable: true }).addTo(window.shopMap);

      window.shopMap.on('click', (e) => {
        const { lat, lng } = e.latlng;
        window.shopMarker.setLatLng([lat, lng]);
        document.getElementById('set-lat').value = lat.toFixed(6);
        document.getElementById('set-lng').value = lng.toFixed(6);
      });

      window.shopMarker.on('dragend', () => {
        const pos = window.shopMarker.getLatLng();
        document.getElementById('set-lat').value = pos.lat.toFixed(6);
        document.getElementById('set-lng').value = pos.lng.toFixed(6);
      });

      const updateMarker = () => {
        const lat = parseFloat(document.getElementById('set-lat').value);
        const lng = parseFloat(document.getElementById('set-lng').value);
        if (!isNaN(lat) && !isNaN(lng)) {
          window.shopMarker.setLatLng([lat, lng]);
          window.shopMap.setView([lat, lng]);
        }
      };
      document.getElementById('set-lat').addEventListener('input', updateMarker);
      document.getElementById('set-lng').addEventListener('input', updateMarker);

      // Map search
      document.getElementById('map-search-btn').addEventListener('click', async () => {
        const query = document.getElementById('map-search').value;
        if (!query) return;
        const btn = document.getElementById('map-search-btn');
        btn.innerText = '...';
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
          const data = await res.json();
          if (data && data.length > 0) {
            const lat = parseFloat(data[0].lat);
            const lng = parseFloat(data[0].lon);
            document.getElementById('set-lat').value = lat.toFixed(6);
            document.getElementById('set-lng').value = lng.toFixed(6);
            window.shopMarker.setLatLng([lat, lng]);
            window.shopMap.setView([lat, lng], 15);
          } else {
            alert('Location not found.');
          }
        } catch (err) {
          alert('Search failed.');
        } finally {
          btn.innerText = 'Search';
        }
      });

      document.getElementById('map-search').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('map-search-btn').click();
        }
      });

      // Locate me
      document.getElementById('locate-me-btn').addEventListener('click', async () => {
        const btn = document.getElementById('locate-me-btn');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = 'Locating...';

        const useIPFallback = async () => {
          try {
            const response = await fetch('https://ipwho.is/');
            const data = await response.json();
            if (data && data.success && data.latitude && data.longitude) {
              document.getElementById('set-lat').value = data.latitude.toFixed(6);
              document.getElementById('set-lng').value = data.longitude.toFixed(6);
              window.shopMarker.setLatLng([data.latitude, data.longitude]);
              window.shopMap.setView([data.latitude, data.longitude], 15);
            } else {
              alert('Could not determine location automatically.');
            }
          } catch (err) {
            alert('Network error while retrieving location.');
          } finally {
            btn.innerHTML = originalHTML;
          }
        };

        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const lat = pos.coords.latitude;
              const lng = pos.coords.longitude;
              document.getElementById('set-lat').value = lat.toFixed(6);
              document.getElementById('set-lng').value = lng.toFixed(6);
              window.shopMarker.setLatLng([lat, lng]);
              window.shopMap.setView([lat, lng], 16);
              btn.innerHTML = originalHTML;
            },
            (err) => {
              console.warn("GPS failed, falling back to IP location", err);
              useIPFallback();
            },
            { enableHighAccuracy: true, timeout: 5000 }
          );
        } else {
          useIPFallback();
        }
      });
    }

    // Position map to current saved coordinates
    const currentLat = parseFloat(document.getElementById('set-lat').value);
    const currentLng = parseFloat(document.getElementById('set-lng').value);

    setTimeout(() => {
      window.shopMap.invalidateSize();
      if (!isNaN(currentLat) && !isNaN(currentLng)) {
        window.shopMap.setView([currentLat, currentLng], 15);
        window.shopMarker.setLatLng([currentLat, currentLng]);
      } else {
        document.getElementById('locate-me-btn').click();
      }
    }, 100);
  }
}
