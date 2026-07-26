// ═══════════════════════════════════════════════════════════
// ENTERPRISE WMS — COMPLETE FRONTEND APPLICATION
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── CONFIG ───────────────────────────────────────────────
  const API = window.API_BASE || 'https://enterprise-wms-1.onrender.com/api';
  let TOKEN = localStorage.getItem('wms_token') || null;
  let USER = JSON.parse(localStorage.getItem('wms_user') || 'null');
  let PERMS = JSON.parse(localStorage.getItem('wms_perms') || '[]');
  let SESSION_TIMER = null;
  let SCANNER_STREAM = null;
  let SCANNER_TARGET = null;
  let SCANNER_INTERVAL = null;

  // ─── API HELPER ──────────────────────────────────────────
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    try {
      const res = await fetch(API + path, { ...options, headers: { ...headers, ...options.headers } });
      if (res.status === 401) { logout(); return null; }
      if (res.status === 403) { showToast('danger', 'Access Denied', 'You do not have permission for this action.'); return null; }
      // Excel/PDF downloads return blob
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('spreadsheet') || ct.includes('pdf') || ct.includes('octet-stream')) {
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const fn = cd.match(/filename=(.+)/) ? cd.match(/filename=(.+)/)[1].replace(/"/g, '') : 'export.xlsx';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fn; document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
        return { downloaded: true, filename: fn };
      }
      const data = await res.json();
      if (!res.ok) {
        showToast('danger', 'Error', data.error || 'Request failed');
        return null;
      }
      return data;
    } catch (err) {
      console.error('API Error:', err);
      showToast('danger', 'Connection Error', 'Cannot connect to server. Check your network.');
      return null;
    }
  }

  function hasPerm(code) { return PERMS.includes(code); }

  // ─── TOAST NOTIFICATIONS ─────────────────────────────────
  function showToast(type, title, message, duration = 4000) {
    const container = document.getElementById('toast-container');
    const icons = { success: 'fa-check-circle', danger: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.innerHTML = `
      <div class="toast-icon"><i class="fas ${icons[type] || icons.info}"></i></div>
      <div class="toast-content">
        <div class="toast-title">${esc(title)}</div>
        <div class="toast-message">${esc(message)}</div>
      </div>
      <button class="toast-close" onclick="this.parentElement.classList.add('removing');setTimeout(()=>this.parentElement.remove(),300)"><i class="fas fa-times"></i></button>
    `;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); }, duration);
  }

  function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

  // ─── MODAL ───────────────────────────────────────────────
  function showModal(title, bodyHtml, footerHtml, size) {
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-container');
    container.className = 'modal' + (size === 'lg' ? ' modal-lg' : size === 'xl' ? ' modal-xl' : '');
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-footer').innerHTML = footerHtml || '';
    overlay.classList.add('active');
  }
  function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }

  // ─── DEBOUNCE ────────────────────────────────────────────
  let _debounceTimers = {};
  function debounce(fn, ms = 300) {
    return function (...args) {
      clearTimeout(_debounceTimers[fn.name || '_anon']);
      _debounceTimers[fn.name || '_anon'] = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ─── AUTH ────────────────────────────────────────────────
  async function login() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    const errorText = document.getElementById('login-error-text');
    const formWrap = document.getElementById('login-form-wrap');
    const loader = document.getElementById('login-loader');
    errorEl.classList.remove('show');
    if (!username || !password) { errorText.textContent = 'Username and password are required'; errorEl.classList.add('show'); return; }
    formWrap.style.display = 'none';
    loader.classList.add('show');
    const data = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    loader.classList.remove('show');
    if (!data) { formWrap.style.display = 'block'; errorText.textContent = 'Invalid credentials'; errorEl.classList.add('show'); return; }
    TOKEN = data.token;
    USER = data.user;
    PERMS = data.user.permissions || [];
    localStorage.setItem('wms_token', TOKEN);
    localStorage.setItem('wms_user', JSON.stringify(USER));
    localStorage.setItem('wms_perms', JSON.stringify(PERMS));
    initApp();
  }

  function logout() {
    api('/auth/logout', { method: 'POST' }).catch(() => { });
    TOKEN = null; USER = null; PERMS = [];
    localStorage.removeItem('wms_token');
    localStorage.removeItem('wms_user');
    localStorage.removeItem('wms_perms');
    clearTimeout(SESSION_TIMER);
    document.getElementById('app').classList.remove('active');
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('login-form-wrap').style.display = 'block';
    document.getElementById('login-loader').classList.remove('show');
    document.getElementById('login-password').value = '';
  }

  function startSessionTimer() {
    clearTimeout(SESSION_TIMER);
    const timeout = 30 * 60 * 1000; // 30 min
    SESSION_TIMER = setTimeout(() => {
      showToast('warning', 'Session Expired', 'You have been logged out due to inactivity.');
      logout();
    }, timeout);
  }
  function resetSessionTimer() { if (TOKEN) startSessionTimer(); }
  document.addEventListener('click', resetSessionTimer);
  document.addEventListener('keydown', resetSessionTimer);

  // ─── INIT APP ────────────────────────────────────────────
  function initApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.add('active');
    // Set user info in sidebar
    const initials = (USER.full_name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().substring(0, 2);
    document.getElementById('sidebar-avatar').textContent = initials;
    document.getElementById('sidebar-username').textContent = USER.full_name || USER.username;
    document.getElementById('sidebar-role').textContent = USER.role || 'User';
    // Hide nav items based on permissions
    applyPermissions();
    // Load dashboard
    navigate('dashboard');
    // Load notifications
    loadNotifications();
    // Load settings
    loadSettings();
    startSessionTimer();
    // Force password change check
    if (USER.force_password_change) {
      showModal('Change Password', `
        <div class="form-group"><label>New Password *</label><input type="password" class="form-input" id="cp-new" placeholder="Min 8 chars, uppercase, number, special"></div>
        <div class="form-group"><label>Confirm Password *</label><input type="password" class="form-input" id="cp-confirm" placeholder="Repeat password"></div>
      `, `<button class="btn btn-primary" onclick="WMS.changePassword()">Change Password</button>`);
    }
  }

  function applyPermissions() {
    const permMap = {
      'dashboard': 'dashboard.view',
      'vehicle-entry': 'vehicles.create',
      'vehicle-list': 'vehicles.view',
      'unload': 'unload.perform',
      'differences': 'reports.view',
      'putaway': 'putaway.perform',
      'piv': 'piv.perform',
      'location': 'location.view',
      'warehouse-map': 'rack.view',
      'picking': 'picking.create',
      'pick-history': 'picking.view',
      'rack-master': 'rack.view',
      'material-master': 'material.view',
      'users': 'users.view',
      'audit': 'audit.view',
      'settings': 'settings.view',
      'ai-assistant': 'ai.assistant',
      'reports': 'reports.view'
    };
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      const page = item.dataset.page;
      const perm = permMap[page];
      if (perm && !hasPerm(perm) && USER.role !== 'Super Admin') {
        item.style.display = 'none';
      } else {
        item.style.display = '';
      }
    });
  }

  async function changePassword() {
    const np = document.getElementById('cp-new').value;
    const cp = document.getElementById('cp-confirm').value;
    if (!np || np.length < 8) { showToast('danger', 'Error', 'Password must be at least 8 characters'); return; }
    if (np !== cp) { showToast('danger', 'Error', 'Passwords do not match'); return; }
    const data = await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: '', new_password: np }) });
    if (data) { showToast('success', 'Success', 'Password changed successfully'); closeModal(); }
  }

  // ─── NAVIGATION ──────────────────────────────────────────
  function navigate(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById('page-' + page);
    const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (pageEl) pageEl.classList.add('active');
    if (navEl) navEl.classList.add('active');
    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('mobile-open');
    // Load page data
    const loaders = {
      'dashboard': loadDashboard,
      'vehicle-list': loadVehicles,
      'unload': loadPendingVehicles,
      'differences': loadDifferences,
      'putaway': loadRecentPutaways,
      'piv': loadRecentPIV,
      'location': loadLocations,
      'warehouse-map': loadWarehouseMap,
      'picking': loadPickingReports,
      'rack-master': loadRacks,
      'material-master': loadMaterials,
      'users': loadUsers,
      'audit': loadAudit,
      'settings': loadSettings
    };
    if (loaders[page]) loaders[page]();
  }

  // ─── SIDEBAR & THEME ─────────────────────────────────────
  function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    if (window.innerWidth <= 768) {
      sb.classList.toggle('mobile-open');
    } else {
      sb.classList.toggle('collapsed');
    }
  }

  function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    const icon = document.getElementById('theme-icon');
    icon.className = next === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    const setTheme = document.getElementById('set-theme');
    if (setTheme) setTheme.value = next;
    localStorage.setItem('wms_theme', next);
  }

  // ─── NOTIFICATIONS ───────────────────────────────────────
  function toggleNotifDropdown() {
    document.getElementById('notif-dropdown').classList.toggle('open');
  }

  async function loadNotifications() {
    const data = await api('/notifications?page=1&limit=10');
    if (!data) return;
    const badge = document.getElementById('notif-badge');
    if (data.unread > 0) { badge.textContent = data.unread > 9 ? '9+' : data.unread; badge.classList.add('show'); }
    else { badge.classList.remove('show'); }
    const list = document.getElementById('notif-list');
    if (!data.data.length) { list.innerHTML = '<div class="empty-state" style="padding:20px"><p>No notifications</p></div>'; return; }
    list.innerHTML = data.data.map(n => `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="WMS.markNotifRead('${n.id}')">
        <div class="notif-item-title">${esc(n.title)}</div>
        <div class="notif-item-text">${esc(n.message)}</div>
        <div class="notif-item-time">${timeAgo(n.created_at)}</div>
      </div>
    `).join('');
  }

  async function markNotifRead(id) {
    await api('/notifications/' + id + '/read', { method: 'PUT' });
    loadNotifications();
  }
  async function markAllRead() {
    await api('/notifications/read-all', { method: 'PUT' });
    loadNotifications();
    showToast('success', 'Done', 'All notifications marked as read');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ─── GLOBAL SEARCH ───────────────────────────────────────
  let _gsTimer;
  async function globalSearch(q) {
    clearTimeout(_gsTimer);
    if (!q || q.length < 2) return;
    _gsTimer = setTimeout(async () => {
      const data = await api('/ai/search', { method: 'POST', body: JSON.stringify({ query: q }) });
      if (!data || (!data.materials.length && !data.vehicles.length && !data.locations.length)) return;
      let html = '<div style="max-height:60vh;overflow-y:auto">';
      if (data.materials.length) {
        html += '<div style="font-weight:600;margin:8px 0 4px;color:var(--accent)">Materials</div>';
        data.materials.forEach(m => {
          html += `<div style="padding:8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="WMS.closeModal();WMS.navigate('material-master')">
            <strong>${esc(m.material_name)}</strong><br><span style="color:var(--text-secondary);font-size:0.8rem">EAN: ${esc(m.ean || '-')} | Stock: ${m.current_stock || 0} ${esc(m.unit || '')}</span></div>`;
        });
      }
      if (data.vehicles.length) {
        html += '<div style="font-weight:600;margin:8px 0 4px;color:var(--warning)">Vehicles</div>';
        data.vehicles.forEach(v => {
          html += `<div style="padding:8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="WMS.closeModal();WMS.navigate('vehicle-list')">
            <strong>${esc(v.vehicle_number)}</strong><br><span style="color:var(--text-secondary);font-size:0.8rem">${esc(v.driver_name)} | ${esc(v.status)}</span></div>`;
        });
      }
      if (data.locations.length) {
        html += '<div style="font-weight:600;margin:8px 0 4px;color:var(--success)">Locations</div>';
        data.locations.forEach(l => {
          html += `<div style="padding:8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="WMS.closeModal();WMS.navigate('location')">
            <strong>${esc(l.material_name)}</strong><br><span style="color:var(--text-secondary);font-size:0.8rem">Rack: ${esc(l.rack_code)} | Qty: ${l.quantity}</span></div>`;
        });
      }
      html += '</div>';
      showModal('Search Results', html, '', 'lg');
    }, 500);
  }

  // ─── DASHBOARD ───────────────────────────────────────────
  async function loadDashboard() {
    document.getElementById('dash-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const stats = await api('/dashboard/stats');
    if (!stats) return;
    // Animate KPI values
    animateValue('kpi-vehicles', stats.total_vehicles_today || 0);
    animateValue('kpi-waiting', stats.vehicles_waiting || 0);
    animateValue('kpi-pending-unload', stats.pending_unload || 0);
    animateValue('kpi-putaway', stats.today_putaway || 0);
    animateValue('kpi-piv', stats.today_piv || 0);
    animateValue('kpi-picking', stats.today_picking || 0);
    animateValue('kpi-materials', stats.total_material || 0);
    animateValue('kpi-racks', stats.total_rack || 0);
    animateValue('kpi-occupied', stats.occupied_rack || 0);
    animateValue('kpi-empty', stats.empty_rack || 0);
    animateValue('kpi-diff', stats.today_difference || 0);
    animateValue('kpi-reports', stats.today_reports || 0);

    // Rack utilization chart
    drawRackChart(stats.occupied_rack || 0, stats.empty_rack || 0);

    // Heat map
    loadHeatMap();

    // Vehicle timeline
    const vehicles = await api('/dashboard/vehicle-timeline');
    const tl = document.getElementById('vehicle-timeline');
    if (vehicles && vehicles.length) {
      tl.innerHTML = vehicles.map(v => `
        <div class="timeline-item ${v.status === 'Pending Unload' ? 'active' : ''}">
          <div class="timeline-time">${new Date(v.gate_entry_time).toLocaleTimeString()}</div>
          <div class="timeline-text"><strong>${esc(v.vehicle_number)}</strong> — ${esc(v.driver_name)} <span class="badge badge-${v.status === 'Pending Unload' ? 'warning' : 'success'}" style="margin-left:6px">${esc(v.status)}</span></div>
        </div>
      `).join('');
    } else {
      tl.innerHTML = '<div class="empty-state"><i class="fas fa-truck"></i><p>No vehicles today</p></div>';
    }

    // Recent actions
    const actions = await api('/dashboard/recent-actions');
    const al = document.getElementById('recent-actions');
    if (actions && actions.length) {
      al.innerHTML = actions.map(a => `
        <li><div class="widget-list-item">
          <div class="widget-list-icon" style="background:var(--accent-dim);color:var(--accent)"><i class="fas fa-bolt"></i></div>
          <span>${esc(a.users?.full_name || '?')} — ${esc(a.action)} <span style="color:var(--text-muted)">${esc(a.module)}</span></span>
        </div><span style="font-size:0.72rem;color:var(--text-muted)">${timeAgo(a.created_at)}</span></li>
      `).join('');
    }

    // Top materials
    const topMat = await api('/dashboard/top-materials');
    const tm = document.getElementById('top-materials');
    if (topMat && topMat.length) {
      tm.innerHTML = topMat.map((m, i) => `
        <li><div class="widget-list-item">
          <div class="widget-list-icon" style="background:${i < 3 ? 'var(--warning-dim)' : 'var(--bg-hover)'};color:${i < 3 ? 'var(--warning)' : 'var(--text-muted)'}">${i + 1}</div>
          <span>${esc(m.material_name)}</span>
        </div><span class="badge badge-accent">${parseFloat(m.total_moved || 0).toFixed(0)}</span></li>
      `).join('');
    }

    // Low stock
    const lowStock = await api('/dashboard/low-stock');
    const ls = document.getElementById('low-stock-list');
    if (lowStock && lowStock.length) {
      ls.innerHTML = lowStock.map(m => `
        <li><div class="widget-list-item">
          <div class="widget-list-icon" style="background:var(--danger-dim);color:var(--danger)"><i class="fas fa-exclamation"></i></div>
          <span>${esc(m.material_name)}</span>
        </div><span class="badge badge-danger">${m.current_stock || 0} / ${m.min_stock || 0}</span></li>
      `).join('');
    }
  }

  function animateValue(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    let current = 0;
    const step = Math.max(1, Math.ceil(target / 30));
    const interval = setInterval(() => {
      current += step;
      if (current >= target) { current = target; clearInterval(interval); }
      el.textContent = current;
    }, 30);
  }

  function drawRackChart(occupied, empty) {
    const canvas = document.getElementById('chart-rack-util');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 220 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '220px';
    ctx.scale(dpr, dpr);
    const w = rect.width, h = 220;
    ctx.clearRect(0, 0, w, h);
    const total = occupied + empty || 1;
    const data = [
      { label: 'Occupied', value: occupied, color: '#ffab00' },
      { label: 'Empty', value: empty, color: '#00ff88' }
    ];
    const barW = Math.min(80, w / 5);
    const maxVal = Math.max(...data.map(d => d.value), 1);
    const chartH = h - 50;
    const startX = w / 2 - (data.length * (barW + 20)) / 2;
    data.forEach((d, i) => {
      const x = startX + i * (barW + 20);
      const barH = (d.value / maxVal) * (chartH - 20);
      const y = chartH - barH + 10;
      // Bar shadow
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(x + 3, y + 3, barW, barH);
      // Bar gradient
      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, d.color);
      grad.addColorStop(1, d.color + '88');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [6, 6, 0, 0]);
      ctx.fill();
      // Value on top
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e0e6ed';
      ctx.font = 'bold 16px "Space Grotesk"';
      ctx.textAlign = 'center';
      ctx.fillText(d.value, x + barW / 2, y - 8);
      // Percentage
      ctx.font = '11px "IBM Plex Sans"';
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#8899aa';
      ctx.fillText(((d.value / total) * 100).toFixed(0) + '%', x + barW / 2, y - 22);
      // Label
      ctx.fillText(d.label, x + barW / 2, h - 10);
    });
  }

  async function loadHeatMap() {
    const data = await api('/racks/map');
    const grid = document.getElementById('heatmap-grid');
    if (!data || !data.length) { grid.innerHTML = '<div class="empty-state"><p>No rack data</p></div>'; return; }
    const zones = {};
    data.forEach(r => {
      if (!zones[r.zone]) zones[r.zone] = [];
      zones[r.zone].push(r);
    });
    let html = '';
    Object.keys(zones).sort().forEach(zone => {
      zones[zone].forEach(r => {
        const pct = r.capacity > 0 ? (r.current_load / r.capacity) * 100 : 0;
        const color = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : pct > 0 ? '#ffab0066' : 'var(--success-dim)';
        const textColor = pct > 50 ? '#fff' : 'var(--text-secondary)';
        html += `<div class="heatmap-cell" style="background:${color};color:${textColor}" title="${esc(r.rack_code)}: ${r.current_load}/${r.capacity}">${esc(r.rack_code.replace(/^[A-Z]-/, ''))}</div>`;
      });
    });
    grid.innerHTML = html;
  }

  // ─── VEHICLE ENTRY ───────────────────────────────────────
  async function saveVehicle(e) {
    e.preventDefault();
    const mobile = document.getElementById('vf-mobile').value;
    if (mobile && !/^[0-9]{10}$/.test(mobile)) {
      document.getElementById('vf-mobile-error').classList.add('show');
      return;
    }
    document.getElementById('vf-mobile-error').classList.remove('show');
    const formData = new FormData();
    formData.append('vehicle_number', document.getElementById('vf-number').value.trim());
    formData.append('lr_number', document.getElementById('vf-lr').value.trim());
    formData.append('driver_name', document.getElementById('vf-driver').value.trim());
    formData.append('driver_mobile', mobile);
    formData.append('transport_name', document.getElementById('vf-transport').value.trim());
    formData.append('dock_number', document.getElementById('vf-dock').value.trim());
    formData.append('remarks', document.getElementById('vf-remarks').value.trim());
    const photoFile = document.getElementById('vf-photo').files[0];
    const driverFile = document.getElementById('vf-driver-photo').files[0];
    if (photoFile) formData.append('vehicle_photo', photoFile);
    if (driverFile) formData.append('driver_photo', driverFile);

    const headers = { 'Authorization': 'Bearer ' + TOKEN };
    try {
      const res = await fetch(API + '/vehicles', { method: 'POST', headers, body: formData });
      const data = await res.json();
      if (!res.ok) { showToast('danger', 'Error', data.error); return; }
      showToast('success', 'Vehicle Created', 'Vehicle entry saved successfully. Now add invoices.');
      resetVehicleForm();
      // Open invoice modal for this vehicle
      openInvoiceModal(data.data.id);
    } catch (err) {
      showToast('danger', 'Error', 'Failed to save vehicle');
    }
  }

  function resetVehicleForm() {
    document.getElementById('vehicle-form').reset();
    document.getElementById('vf-photo-preview').style.display = 'none';
    document.getElementById('vf-driver-photo-preview').style.display = 'none';
  }

  function openInvoiceModal(vehicleId) {
    showModal('Add Invoices', `
      <div class="form-group"><label>Invoice Number *</label><input type="text" class="form-input" id="inv-number" placeholder="INV-001"></div>
      <div class="form-group"><label>Invoice Date *</label><input type="date" class="form-input" id="inv-date" value="${new Date().toISOString().split('T')[0]}"></div>
      <div class="form-group"><label>Vendor *</label><input type="text" class="form-input" id="inv-vendor" placeholder="Vendor name"></div>
      <div class="form-group"><label>Purchase Order</label><input type="text" class="form-input" id="inv-po" placeholder="PO number"></div>
      <div class="form-group"><label>Invoice File</label><input type="file" class="form-input" id="inv-file" accept=".pdf,.xlsx,.xls"></div>
      <hr style="border-color:var(--border);margin:16px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <strong>Materials</strong>
        <button class="btn btn-sm btn-secondary" onclick="WMS.addInvoiceMaterialRow()"><i class="fas fa-plus"></i> Add Row</button>
      </div>
      <div id="inv-materials-rows">
        <div class="inv-mat-row" style="display:grid;grid-template-columns:1fr 2fr 1fr;gap:8px;margin-bottom:8px">
          <input type="text" class="form-input inv-ean" placeholder="EAN">
          <input type="text" class="form-input inv-mat-name" placeholder="Material Name *" required>
          <input type="number" class="form-input inv-mat-qty" placeholder="Qty *" min="0.01" step="0.01" required>
        </div>
      </div>
      <div style="margin-top:12px;padding:12px;background:var(--bg-hover);border-radius:8px;text-align:center">
        <span style="color:var(--text-secondary);font-size:0.85rem">OR upload Excel with columns: Material | Qty</span><br>
        <input type="file" class="form-input" id="inv-excel" accept=".xlsx,.xls,.csv" style="margin-top:8px;max-width:300px;margin-left:auto;margin-right:auto">
      </div>
    `, `
      <button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="WMS.saveInvoice('${vehicleId}')"><i class="fas fa-save"></i> Save Invoice</button>
      <button class="btn btn-success" onclick="WMS.uploadInvoiceExcel('${vehicleId}')"><i class="fas fa-file-excel"></i> Upload Excel</button>
    `, 'lg');
  }

  function addInvoiceMaterialRow() {
    const container = document.getElementById('inv-materials-rows');
    const row = document.createElement('div');
    row.className = 'inv-mat-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 2fr 1fr 36px;gap:8px;margin-bottom:8px';
    row.innerHTML = `
      <input type="text" class="form-input inv-ean" placeholder="EAN">
      <input type="text" class="form-input inv-mat-name" placeholder="Material Name *">
      <input type="number" class="form-input inv-mat-qty" placeholder="Qty *" min="0.01" step="0.01">
      <button class="btn-icon" onclick="this.parentElement.remove()" style="width:36px;height:36px"><i class="fas fa-times"></i></button>
    `;
    container.appendChild(row);
  }

  async function saveInvoice(vehicleId) {
    const invNumber = document.getElementById('inv-number').value.trim();
    const invDate = document.getElementById('inv-date').value;
    const vendor = document.getElementById('inv-vendor').value.trim();
    if (!invNumber || !invDate || !vendor) { showToast('danger', 'Error', 'Invoice Number, Date, and Vendor required'); return; }
    const rows = document.querySelectorAll('.inv-mat-row');
    const materials = [];
    rows.forEach(row => {
      const name = row.querySelector('.inv-mat-name').value.trim();
      const qty = parseFloat(row.querySelector('.inv-mat-qty').value) || 0;
      const ean = row.querySelector('.inv-ean').value.trim();
      if (name && qty > 0) materials.push({ ean, material_name: name, quantity: qty });
    });
    const formData = new FormData();
    formData.append('vehicle_id', vehicleId);
    formData.append('invoice_number', invNumber);
    formData.append('invoice_date', invDate);
    formData.append('vendor', vendor);
    formData.append('purchase_order', document.getElementById('inv-po').value.trim());
    formData.append('materials', JSON.stringify(materials));
    const fileInput = document.getElementById('inv-file');
    if (fileInput.files[0]) formData.append('invoice_file', fileInput.files[0]);

    const headers = { 'Authorization': 'Bearer ' + TOKEN };
    try {
      const res = await fetch(API + '/invoices', { method: 'POST', headers, body: formData });
      const data = await res.json();
      if (!res.ok) { showToast('danger', 'Error', data.error); return; }
      showToast('success', 'Invoice Saved', 'Invoice added successfully');
      // Ask to add more
      openInvoiceModal(vehicleId);
    } catch (err) {
      showToast('danger', 'Error', 'Failed to save invoice');
    }
  }

  async function uploadInvoiceExcel(vehicleId) {
    const fileInput = document.getElementById('inv-excel');
    if (!fileInput.files[0]) { showToast('warning', 'Warning', 'Select an Excel file first'); return; }
    const formData = new FormData();
    formData.append('bulk_file', fileInput.files[0]);
    const headers = { 'Authorization': 'Bearer ' + TOKEN };
    try {
      const res = await fetch(API + '/invoices/excel-upload/' + vehicleId, { method: 'POST', headers, body: formData });
      const data = await res.json();
      if (!res.ok) { showToast('danger', 'Error', data.error); return; }
      showToast('success', 'Uploaded', data.message);
      closeModal();
    } catch (err) {
      showToast('danger', 'Error', 'Excel upload failed');
    }
  }

  // ─── VEHICLE LIST ────────────────────────────────────────
  let vehiclePage = 1;
  async function loadVehicles(page) {
    if (page) vehiclePage = page;
    const search = document.getElementById('vl-search').value;
    const status = document.getElementById('vl-status').value;
    const from = document.getElementById('vl-from').value;
    const to = document.getElementById('vl-to').value;
    let url = `/vehicles?page=${vehiclePage}&limit=15`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    if (from) url += `&from_date=${from}`;
    if (to) url += `&to_date=${to}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('vehicle-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fas fa-truck"></i><p>No vehicles found</p></td></tr>'; renderPagination('vehicle-pagination', data, loadVehicles); return; }
    tbody.innerHTML = data.data.map(v => `
      <tr>
        <td><strong>${esc(v.vehicle_number)}</strong></td>
        <td>${esc(v.driver_name)}</td>
        <td>${esc(v.driver_mobile || '-')}</td>
        <td>${esc(v.transport_name || '-')}</td>
        <td>${esc(v.dock_number || '-')}</td>
        <td>${formatDT(v.gate_entry_time)}</td>
        <td><span class="badge badge-${v.status === 'Pending Unload' ? 'warning' : v.status === 'Unloaded' ? 'success' : 'info'}"><span class="badge-dot"></span>${esc(v.status)}</span></td>
        <td>
          <button class="btn-icon" title="View" onclick="WMS.openVehicleDetail('${v.id}')"><i class="fas fa-eye"></i></button>
        </td>
      </tr>
    `).join('');
    renderPagination('vehicle-pagination', data, loadVehicles);
  }

  async function openVehicleDetail(id) {
    const data = await api('/vehicles/' + id);
    if (!data) return;
    let invHtml = '';
    if (data.invoices && data.invoices.length) {
      invHtml = data.invoices.map(inv => `
        <div style="background:var(--bg-hover);padding:12px;border-radius:8px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>${esc(inv.invoice_number)}</strong>
            <span class="badge badge-${inv.unload_status === 'Completed' ? 'success' : 'warning'}">${esc(inv.unload_status)}</span>
          </div>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:6px">Vendor: ${esc(inv.vendor)} | Date: ${inv.invoice_date} | PO: ${esc(inv.purchase_order || '-')}</div>
          ${inv.invoice_materials && inv.invoice_materials.length ? `
            <table class="data-table" style="font-size:0.8rem">
              <thead><tr><th>Material</th><th>EAN</th><th>Qty</th></tr></thead>
              <tbody>${inv.invoice_materials.map(m => `<tr><td>${esc(m.material_name)}</td><td>${esc(m.ean || '-')}</td><td>${m.invoice_qty}</td></tr>`).join('')}</tbody>
            </table>
          ` : ''}
        </div>
      `).join('');
    } else {
      invHtml = '<div class="empty-state"><p>No invoices added</p></div>';
    }
    showModal('Vehicle: ' + data.vehicle_number, `
      <div class="form-grid" style="margin-bottom:16px">
        <div><strong>Driver:</strong> ${esc(data.driver_name)}</div>
        <div><strong>Mobile:</strong> ${esc(data.driver_mobile || '-')}</div>
        <div><strong>Transport:</strong> ${esc(data.transport_name || '-')}</div>
        <div><strong>LR:</strong> ${esc(data.lr_number || '-')}</div>
        <div><strong>Dock:</strong> ${esc(data.dock_number || '-')}</div>
        <div><strong>Status:</strong> <span class="badge badge-${data.status === 'Unloaded' ? 'success' : 'warning'}">${esc(data.status)}</span></div>
        <div class="form-full"><strong>Remarks:</strong> ${esc(data.remarks || '-')}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Invoices</strong>
        <button class="btn btn-sm btn-primary" onclick="WMS.openInvoiceModal('${data.id}')"><i class="fas fa-plus"></i> Add Invoice</button>
      </div>
      ${invHtml}
    `, '<button class="btn btn-secondary" onclick="WMS.closeModal()">Close</button>', 'xl');
  }

  // ─── UNLOAD PROCESS ──────────────────────────────────────
  async function loadPendingVehicles() {
    const data = await api('/vehicles/pending-unload');
    const sel = document.getElementById('ul-vehicle');
    sel.innerHTML = '<option value="">-- Select Vehicle --</option>' + (data || []).map(v =>
      `<option value="${v.id}">${esc(v.vehicle_number)} — ${esc(v.driver_name)} — ${esc(v.transport_name || '')}</option>`
    ).join('');
  }

  async function loadUnloadInvoices() {
    const vid = document.getElementById('ul-vehicle').value;
    const sel = document.getElementById('ul-invoice');
    sel.innerHTML = '<option value="">-- Select Invoice --</option>';
    document.getElementById('ul-materials-body').innerHTML = '<tr><td colspan="5" class="empty-state"><p>Select invoice</p></td></tr>';
    if (!vid) return;
    const data = await api('/invoices/' + vid);
    sel.innerHTML = '<option value="">-- Select Invoice --</option>' + (data || []).map(inv =>
      `<option value="${inv.id}">${esc(inv.invoice_number)} — ${esc(inv.vendor)} [${esc(inv.unload_status)}]</option>`
    ).join('');
  }

  async function loadUnloadMaterials() {
    const invId = document.getElementById('ul-invoice').value;
    const tbody = document.getElementById('ul-materials-body');
    if (!invId) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>Select invoice</p></td></tr>'; return; }
    const data = await api('/unload/invoice-materials/' + invId);
    if (!data || !data.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><p>No materials</p></td></tr>'; return; }
    tbody.innerHTML = data.map(m => `
      <tr class="${m.remaining <= 0 ? 'diff-highlight' : ''}">
        <td>${esc(m.material_name)}</td>
        <td>${esc(m.ean || '-')}</td>
        <td>${m.invoice_qty}</td>
        <td>${m.already_unloaded}</td>
        <td>${m.remaining}</td>
      </tr>
    `).join('');
    // Auto-select first remaining material
    const first = data.find(m => m.remaining > 0);
    if (first) {
      document.getElementById('ul-ean').value = first.ean || '';
      document.getElementById('ul-material').value = first.material_name;
      document.getElementById('ul-inv-qty').value = first.remaining;
      document.getElementById('ul-unload-qty').value = '';
      document.getElementById('ul-unload-qty').dataset.matId = first.id;
      document.getElementById('ul-unload-qty').dataset.invQty = first.invoice_qty;
    }
  }

  async function lookupEAN(prefix) {
    prefix = prefix || 'ul-';
    const eanInput = document.getElementById(prefix + 'ean');
    const ean = eanInput.value.trim();
    if (!ean || ean.length < 4) return;
    const data = await api('/scan/ean/' + encodeURIComponent(ean));
    if (!data) return;
    document.getElementById(prefix + 'material').value = data.material_name || '';
    if (prefix === 'ul-') {
      document.getElementById('ul-inv-qty').value = '';
      document.getElementById('ul-unload-qty').value = '';
    }
    if (prefix === 'pa-') {
      document.getElementById('pa-desc').value = data.description || '';
      document.getElementById('pa-packing').value = data.packing || '';
      document.getElementById('pa-brand').value = data.brand || '';
      document.getElementById('pa-division').value = data.division || '';
    }
    if (prefix === 'piv-') {
      document.getElementById('piv-desc').value = data.description || '';
      document.getElementById('piv-packing').value = data.packing || '';
    }
    showToast('success', 'Material Found', data.material_name);
  }

  async function saveUnload() {
    const vid = document.getElementById('ul-vehicle').value;
    const invId = document.getElementById('ul-invoice').value;
    const matId = document.getElementById('ul-unload-qty').dataset.matId;
    if (!vid || !invId) { showToast('warning', 'Warning', 'Select vehicle and invoice'); return; }
    const ean = document.getElementById('ul-ean').value.trim();
    const material = document.getElementById('ul-material').value.trim();
    const invQty = parseFloat(document.getElementById('ul-unload-qty').dataset.invQty) || 0;
    const unloadQty = parseFloat(document.getElementById('ul-unload-qty').value);
    const reason = document.getElementById('ul-reason').value.trim();
    if (!material || !unloadQty || unloadQty <= 0) { showToast('danger', 'Error', 'Material and unloaded qty required'); return; }
    const data = await api('/unload', {
      method: 'POST',
      body: JSON.stringify({
        vehicle_id: vid, invoice_id: invId, invoice_material_id: matId,
        ean, material_name: material, invoice_qty: invQty,
        unloaded_qty: unloadQty, scan_method: 'manual', difference_reason: reason
      })
    });
    if (!data) return;
    if (data.has_difference) {
      showToast('warning', 'Quantity Difference',
        `${material}: Invoice=${data.difference_qty > 0 ? data.difference_qty + ' extra' : Math.abs(data.difference_qty) + ' short'} (${data.difference_pct}%)`);
    } else {
      showToast('success', 'Unloaded', `${material}: ${unloadQty} units`);
    }
    document.getElementById('ul-unload-qty').value = '';
    document.getElementById('ul-reason').value = '';
    loadUnloadMaterials();
    loadUnloadInvoices();
  }

  async function completeInvoiceUnload() {
    const invId = document.getElementById('ul-invoice').value;
    if (!invId) { showToast('warning', 'Warning', 'Select invoice'); return; }
    const data = await api('/unload/complete-invoice/' + invId, { method: 'POST' });
    if (data) { showToast('success', 'Completed', 'Invoice unload completed'); loadUnloadInvoices(); loadPendingVehicles(); }
  }

  // ─── DIFFERENCES ─────────────────────────────────────────
  let diffPage = 1;
  async function loadDifferences(page) {
    if (page) diffPage = page;
    const status = document.getElementById('diff-status').value;
    const from = document.getElementById('diff-from').value;
    const to = document.getElementById('diff-to').value;
    let url = `/differences?page=${diffPage}&limit=15`;
    if (status) url += `&status=${status}`;
    if (from) url += `&from_date=${from}`;
    if (to) url += `&to_date=${to}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('diff-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><p>No differences</p></td></tr>'; renderPagination('diff-pagination', data, loadDifferences); return; }
    tbody.innerHTML = data.data.map(d => `
      <tr>
        <td><strong>${esc(d.diff_number)}</strong></td>
        <td>${esc(d.material_name)}</td>
        <td>${d.invoice_qty}</td>
        <td>${d.received_qty}</td>
        <td class="${d.difference_qty !== 0 ? 'diff-highlight' : ''}">${d.difference_qty}</td>
        <td>${d.difference_pct}%</td>
        <td>${esc(d.reason || '-')}</td>
        <td><span class="badge badge-${d.status === 'Approved' ? 'success' : d.status === 'Rejected' ? 'danger' : 'warning'}">${esc(d.status)}</span></td>
        <td>${d.status === 'Pending' ? `<button class="btn btn-sm btn-success" onclick="WMS.approveDifference('${d.id}','Approved')"><i class="fas fa-check"></i></button> <button class="btn btn-sm btn-danger" onclick="WMS.approveDifference('${d.id}','Rejected')"><i class="fas fa-times"></i></button>` : '-'}</td>
      </tr>
    `).join('');
    renderPagination('diff-pagination', data, loadDifferences);
  }

  async function approveDifference(id, status) {
    const data = await api('/differences/' + id + '/approve', { method: 'PUT', body: JSON.stringify({ status }) });
    if (data) { showToast('success', 'Updated', 'Difference ' + status); loadDifferences(); }
  }

  // ─── PUTAWAY ─────────────────────────────────────────────
  async function savePutaway(e) {
    e.preventDefault();
    const data = await api('/putaway', {
      method: 'POST',
      body: JSON.stringify({
        rack_code: document.getElementById('pa-rack').value.trim(),
        ean: document.getElementById('pa-ean').value.trim(),
        material_name: document.getElementById('pa-material').value.trim(),
        description: document.getElementById('pa-desc').value.trim(),
        packing: document.getElementById('pa-packing').value.trim(),
        box_number: document.getElementById('pa-box').value.trim(),
        quantity: parseFloat(document.getElementById('pa-qty').value),
        brand: document.getElementById('pa-brand').value.trim(),
        division: document.getElementById('pa-division').value.trim()
      })
    });
    if (data) { showToast('success', 'Putaway Done', data.data.rack_code + ' — ' + data.data.material_name); loadRecentPutaways(); }
    // Clear form but keep rack
    const rack = document.getElementById('pa-rack').value;
    document.getElementById('pa-ean').value = '';
    document.getElementById('pa-material').value = '';
    document.getElementById('pa-desc').value = '';
    document.getElementById('pa-packing').value = '';
    document.getElementById('pa-box').value = '';
    document.getElementById('pa-qty').value = '';
    document.getElementById('pa-brand').value = '';
    document.getElementById('pa-division').value = '';
    document.getElementById('pa-rack').value = rack;
    document.getElementById('pa-ean').focus();
  }

  async function loadRecentPutaways() {
    const data = await api('/putaway?page=1&limit=10');
    const tbody = document.getElementById('pa-recent-body');
    if (!data || !data.data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No putaways yet</p></td></tr>'; return; }
    tbody.innerHTML = data.data.map(r => `
      <tr><td>${formatDate(r.action_date)}</td><td>${esc(r.rack_code)}</td><td>${esc(r.material_name)}</td><td>${esc(r.ean || '-')}</td><td>${r.quantity}</td><td>${esc(r.users?.full_name || '-')}</td></tr>
    `).join('');
  }

  // ─── PIV ─────────────────────────────────────────────────
  async function savePIV(e) {
    e.preventDefault();
    const data = await api('/piv', {
      method: 'POST',
      body: JSON.stringify({
        ean: document.getElementById('piv-ean').value.trim(),
        material_name: document.getElementById('piv-material').value.trim(),
        description: document.getElementById('piv-desc').value.trim(),
        packing: document.getElementById('piv-packing').value.trim(),
        box_number: document.getElementById('piv-box').value.trim(),
        quantity: parseFloat(document.getElementById('piv-qty').value)
      })
    });
    if (data) { showToast('success', 'PIV Recorded', data.data.material_name); loadRecentPIV(); }
    document.getElementById('piv-ean').value = '';
    document.getElementById('piv-material').value = '';
    document.getElementById('piv-desc').value = '';
    document.getElementById('piv-packing').value = '';
    document.getElementById('piv-box').value = '';
    document.getElementById('piv-qty').value = '';
    document.getElementById('piv-ean').focus();
  }

  async function loadRecentPIV() {
    const data = await api('/piv?page=1&limit=10');
    const tbody = document.getElementById('piv-recent-body');
    if (!data || !data.data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>No PIV records</p></td></tr>'; return; }
    tbody.innerHTML = data.data.map(r => `
      <tr><td>${formatDate(r.created_at)}</td><td>${esc(r.material_name)}</td><td>${esc(r.ean || '-')}</td><td>${esc(r.packing || '-')}</td><td>${esc(r.box_number || '-')}</td><td>${r.quantity}</td><td>${esc(r.users?.full_name || '-')}</td></tr>
    `).join('');
  }

  // ─── LOCATION MASTER ─────────────────────────────────────
  let locPage = 1;
  let locSelected = new Set();

  async function loadLocations(page) {
    if (page) locPage = page;
    const search = document.getElementById('loc-search').value;
    const rack = document.getElementById('loc-rack').value;
    const brand = document.getElementById('loc-brand').value;
    const division = document.getElementById('loc-division').value;
    const action = document.getElementById('loc-action').value;
    const from = document.getElementById('loc-from').value;
    const to = document.getElementById('loc-to').value;
    let url = `/location?page=${locPage}&limit=15`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (rack) url += `&rack=${encodeURIComponent(rack)}`;
    if (brand) url += `&brand=${encodeURIComponent(brand)}`;
    if (division) url += `&division=${encodeURIComponent(division)}`;
    if (action) url += `&action_type=${encodeURIComponent(action)}`;
    if (from) url += `&from_date=${from}`;
    if (to) url += `&to_date=${to}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('loc-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="12" class="empty-state"><i class="fas fa-map-marker-alt"></i><p>No records found</p></td></tr>'; renderPagination('loc-pagination', data, loadLocations); return; }
    tbody.innerHTML = data.data.map(r => `
      <tr>
        <td><input type="checkbox" class="loc-check" value="${r.id}" ${locSelected.has(r.id) ? 'checked' : ''} onchange="WMS.toggleLocCheck('${r.id}',this.checked)"></td>
        <td>${formatDate(r.action_date)}</td>
        <td><strong>${esc(r.rack_code)}</strong></td>
        <td>${esc(r.ean || '-')}</td>
        <td>${esc(r.material_name)}</td>
        <td>${esc(r.brand || '-')}</td>
        <td>${esc(r.division || '-')}</td>
        <td>${esc(r.packing || '-')}</td>
        <td>${esc(r.box_number || '-')}</td>
        <td><strong>${r.quantity}</strong></td>
        <td><span class="badge badge-${r.action_type === 'PUTAWAY' ? 'success' : r.action_type === 'PIV' ? 'info' : r.action_type === 'PICK' ? 'warning' : 'danger'}">${esc(r.action_type)}</span></td>
        <td>${esc(r.users?.full_name || '-')}</td>
      </tr>
    `).join('');
    renderPagination('loc-pagination', data, loadLocations);
  }

  function toggleLocCheck(id, checked) {
    if (checked) locSelected.add(id); else locSelected.delete(id);
  }
  function toggleAllCheckboxes(prefix) {
    const checkAll = document.getElementById(prefix + '-check-all');
    document.querySelectorAll('.' + prefix + '-check').forEach(cb => {
      cb.checked = checkAll.checked;
      if (checkAll.checked) locSelected.add(cb.value); else locSelected.delete(cb.value);
    });
  }

  async function bulkDeleteLocation() {
    if (!locSelected.size) { showToast('warning', 'Warning', 'Select records to delete'); return; }
    showModal('Confirm Bulk Delete', `<p>Are you sure you want to delete <strong>${locSelected.size}</strong> records? This cannot be undone.</p>`, `
      <button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button>
      <button class="btn btn-danger" onclick="WMS.executeBulkDelete()"><i class="fas fa-trash"></i> Delete</button>
    `);
  }

  async function executeBulkDelete() {
    const data = await api('/location', { method: 'DELETE', body: JSON.stringify({ ids: Array.from(locSelected) }) });
    if (data) { showToast('success', 'Deleted', data.message); locSelected.clear(); closeModal(); loadLocations(); }
  }

  // ─── WAREHOUSE MAP ───────────────────────────────────────
  async function loadWarehouseMap() {
    const data = await api('/racks/map');
    const container = document.getElementById('warehouse-map-container');
    if (!data || !data.length) { container.innerHTML = '<div class="empty-state"><p>No rack data</p></div>'; return; }
    const zones = {};
    data.forEach(r => { if (!zones[r.zone]) zones[r.zone] = []; zones[r.zone].push(r); });
    let html = '';
    Object.keys(zones).sort().forEach(zone => {
      html += `<div class="warehouse-zone"><div class="warehouse-zone-title">${esc(zone || 'Default')}</div><div class="warehouse-racks">`;
      zones[zone].sort((a, b) => a.rack_code.localeCompare(b.rack_code)).forEach(r => {
        const pct = r.capacity > 0 ? Math.round((r.current_load / r.capacity) * 100) : 0;
        html += `<div class="warehouse-rack ${r.status === 'Empty' ? 'empty' : 'occupied'}" title="${esc(r.rack_code)} | ${r.status} | ${r.current_load}/${r.capacity} (${pct}%)">
          ${esc(r.rack_code.replace(/^[A-Z]-/, ''))}<br><span style="font-size:0.6rem">${pct}%</span>
        </div>`;
      });
      html += '</div></div>';
    });
    container.innerHTML = html;
  }

  // ─── PICKING REPORTS ─────────────────────────────────────
  let pickPage = 1;

  async function showCreatePicking() {
    const materials = await api('/materials?page=1&limit=100');
    showModal('Create Picking Report', `
      <div class="form-group"><label>Picker Name *</label><input type="text" class="form-input" id="pk-picker" placeholder="Enter picker name"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:12px 0">
        <strong>Materials to Pick</strong>
        <button class="btn btn-sm btn-secondary" onclick="WMS.addPickItemRow()"><i class="fas fa-plus"></i> Add</button>
      </div>
      <div id="pk-items-rows">
        <div class="pk-item-row" style="display:grid;grid-template-columns:1fr 2fr 1fr 1fr;gap:8px;margin-bottom:8px">
          <input type="text" class="form-input pk-ean" placeholder="EAN">
          <input type="text" class="form-input pk-mat" placeholder="Material Name *">
          <input type="text" class="form-input pk-rack" placeholder="Rack (auto)">
          <input type="number" class="form-input pk-qty" placeholder="Qty *" min="1">
        </div>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="WMS.createPickingReport()"><i class="fas fa-save"></i> Create Report</button>
    `, 'lg');
  }

  function addPickItemRow() {
    const container = document.getElementById('pk-items-rows');
    const row = document.createElement('div');
    row.className = 'pk-item-row';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 2fr 1fr 1fr 36px;gap:8px;margin-bottom:8px';
    row.innerHTML = `
      <input type="text" class="form-input pk-ean" placeholder="EAN">
      <input type="text" class="form-input pk-mat" placeholder="Material Name *">
      <input type="text" class="form-input pk-rack" placeholder="Rack (auto)">
      <input type="number" class="form-input pk-qty" placeholder="Qty *" min="1">
      <button class="btn-icon" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;
    container.appendChild(row);
  }

  async function createPickingReport() {
    const picker = document.getElementById('pk-picker').value.trim();
    if (!picker) { showToast('danger', 'Error', 'Picker name required'); return; }
    const rows = document.querySelectorAll('.pk-item-row');
    const items = [];
    rows.forEach(r => {
      const mat = r.querySelector('.pk-mat').value.trim();
      const qty = parseFloat(r.querySelector('.pk-qty').value) || 0;
      if (mat && qty > 0) {
        items.push({
          ean: r.querySelector('.pk-ean').value.trim(),
          material_name: mat,
          rack_code: r.querySelector('.pk-rack').value.trim(),
          required_qty: qty
        });
      }
    });
    if (!items.length) { showToast('danger', 'Error', 'Add at least one material'); return; }
    const data = await api('/picking', { method: 'POST', body: JSON.stringify({ picker_name: picker, items }) });
    if (data) { showToast('success', 'Report Created', data.data.report_number); closeModal(); loadPickingReports(); }
  }

  async function loadPickingReports(page) {
    if (page) pickPage = page;
    const search = document.getElementById('pick-search').value;
    const status = document.getElementById('pick-status').value;
    let url = `/picking?page=${pickPage}&limit=15`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('pick-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>No picking reports</p></td></tr>'; renderPagination('pick-pagination', data, loadPickingReports); return; }
    tbody.innerHTML = data.data.map(r => `
      <tr>
        <td><strong>${esc(r.report_number)}</strong></td>
        <td>${esc(r.picker_name)}</td>
        <td>${r.total_items || 0}</td>
        <td>${r.total_qty || 0}</td>
        <td><span class="badge badge-${r.status === 'Completed' ? 'success' : r.status === 'In Progress' ? 'warning' : 'info'}">${esc(r.status)}</span></td>
        <td>${formatDate(r.created_at)}</td>
        <td>
          <button class="btn-icon" title="View" onclick="WMS.openPickingDetail('${r.id}')"><i class="fas fa-eye"></i></button>
          <button class="btn-icon" title="QR" onclick="WMS.showQR('${r.report_number}')"><i class="fas fa-qrcode"></i></button>
        </td>
      </tr>
    `).join('');
    renderPagination('pick-pagination', data, loadPickingReports);
  }

  async function openPickingDetail(id) {
    const data = await api('/picking/' + id);
    if (!data) return;
    let itemsHtml = '';
    if (data.items && data.items.length) {
      itemsHtml = `<table class="data-table"><thead><tr><th>Material</th><th>EAN</th><th>Rack</th><th>Required</th><th>Picked</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;
      itemsHtml += data.items.map(item => `
        <tr>
          <td>${esc(item.material_name)}</td>
          <td>${esc(item.ean || '-')}</td>
          <td>${esc(item.rack_code || '-')}</td>
          <td>${item.required_qty}</td>
          <td>${item.picked_qty}</td>
          <td><span class="badge badge-${item.status === 'Picked' ? 'success' : 'warning'}">${esc(item.status)}</span></td>
          <td>
            <button class="btn btn-sm btn-success" onclick="WMS.pickAction('${data.id}','${item.id}','edit_qty',${item.picked_qty})" title="Edit Qty"><i class="fas fa-edit"></i></button>
            <button class="btn btn-sm btn-warning" onclick="WMS.pickAction('${data.id}','${item.id}','minus_qty',1)" title="Minus 1"><i class="fas fa-minus"></i></button>
            <button class="btn btn-sm btn-danger" onclick="WMS.pickAction('${data.id}','${item.id}','delete',0)" title="Delete"><i class="fas fa-trash"></i></button>
          </td>
        </tr>
      `).join('');
      itemsHtml += '</tbody></table>';
    }
    showModal('Picking: ' + data.report_number, `
      <div style="margin-bottom:12px">
        <strong>Picker:</strong> ${esc(data.picker_name)} | <strong>Status:</strong> <span class="badge badge-info">${esc(data.status)}</span> | <strong>Items:</strong> ${data.total_items} | <strong>Qty:</strong> ${data.total_qty}
      </div>
      ${itemsHtml}
      <div style="margin-top:12px">
        <button class="btn btn-sm btn-secondary" onclick="WMS.pickAction('${data.id}','','reassign_rack',0)"><i class="fas fa-exchange-alt"></i> Reassign Rack</button>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="WMS.closeModal()">Close</button>
      <button class="btn btn-success" onclick="WMS.updatePickStatus('${data.id}','Completed')"><i class="fas fa-check"></i> Complete</button>
    `, 'xl');
  }

  async function pickAction(reportId, itemId, actionType, currentQty) {
    let newQty = currentQty;
    let newRack = '';
    if (actionType === 'edit_qty') {
      newQty = prompt('Enter new picked quantity:', currentQty);
      if (newQty === null) return;
      newQty = parseFloat(newQty);
      if (isNaN(newQty) || newQty < 0) { showToast('danger', 'Error', 'Invalid quantity'); return; }
    }
    if (actionType === 'reassign_rack') {
      newRack = prompt('Enter new rack code:');
      if (!newRack) return;
      // Get first item if itemId is empty
      if (!itemId) {
        showToast('warning', 'Info', 'This feature works per item. Use item-level reassign.');
        return;
      }
    }
    const data = await api('/pick-history', {
      method: 'POST',
      body: JSON.stringify({
        report_id: reportId, item_id: itemId, action_type: actionType,
        new_qty: newQty, new_rack: newRack
      })
    });
    if (data) {
      showToast('success', 'Action Recorded', 'Action: ' + data.action_number);
      openPickingDetail(reportId);
    }
  }

  async function updatePickStatus(id, status) {
    const data = await api('/picking/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status }) });
    if (data) { showToast('success', 'Updated', 'Status: ' + status); closeModal(); loadPickingReports(); }
  }

  async function loadPickHistory() {
    const reportNo = document.getElementById('ph-report-no').value.trim();
    if (!reportNo) { showToast('warning', 'Warning', 'Enter report number'); return; }
    const data = await api('/picking?page=1&limit=100&search=' + encodeURIComponent(reportNo));
    if (!data || !data.data.length) { document.getElementById('ph-table-body').innerHTML = '<tr><td colspan="9" class="empty-state"><p>Report not found</p></td></tr>'; return; }
    const report = data.data[0];
    const history = await api('/pick-history/' + report.id);
    const tbody = document.getElementById('ph-table-body');
    if (!history || !history.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><p>No history for this report</p></td></tr>'; return; }
    tbody.innerHTML = history.map(h => `
      <tr>
        <td><strong>${esc(h.action_number)}</strong></td>
        <td>${esc(h.material_name)}</td>
        <td><span class="badge badge-${h.action_type === 'delete' ? 'danger' : 'warning'}">${esc(h.action_type)}</span></td>
        <td>${h.old_qty ?? '-'}</td>
        <td>${h.new_qty ?? '-'}</td>
        <td>${esc(h.old_rack || '-')}</td>
        <td>${esc(h.new_rack || '-')}</td>
        <td>${esc(h.users?.full_name || '-')}</td>
        <td>${formatDT(h.created_at)}</td>
      </tr>
    `).join('');
  }

  // ─── RACK MASTER ─────────────────────────────────────────
  let rackPage = 1;
  async function loadRacks(page) {
    if (page) rackPage = page;
    const search = document.getElementById('rack-search').value;
    const zone = document.getElementById('rack-zone').value;
    const status = document.getElementById('rack-status').value;
    let url = `/racks?page=${rackPage}&limit=20`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (zone) url += `&zone=${encodeURIComponent(zone)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('rack-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><p>No racks found</p></td></tr>'; renderPagination('rack-pagination', data, loadRacks); return; }
    tbody.innerHTML = data.data.map(r => {
      const pct = r.capacity > 0 ? Math.round((r.current_load / r.capacity) * 100) : 0;
      return `<tr>
        <td><strong>${esc(r.rack_code)}</strong></td>
        <td>${esc(r.rack_type)}</td>
        <td>${esc(r.zone || '-')}</td>
        <td>${r.capacity}</td>
        <td>${r.current_load || 0}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:var(--bg-hover);border-radius:3px;overflow:hidden">
              <div style="width:${pct}%;height:100%;background:${pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--success)'};border-radius:3px;transition:width 0.5s"></div>
            </div>
            <span style="font-size:0.75rem;min-width:32px">${pct}%</span>
          </div>
        </td>
        <td><span class="badge badge-${r.status === 'Empty' ? 'success' : 'warning'}"><span class="badge-dot"></span>${esc(r.status)}</span></td>
        <td><button class="btn-icon" title="Delete" onclick="WMS.deleteRack('${r.id}')"><i class="fas fa-trash"></i></button></td>
      </tr>`;
    }).join('');
    renderPagination('rack-pagination', data, loadRacks);
  }

  function showAddRacks() {
    showModal('Add Racks', `
      <p style="color:var(--text-secondary);margin-bottom:12px">Enter rack codes, one per line. Example: A-03-01, A-03-02, B-03-01</p>
      <div class="form-group"><label>Rack Codes (one per line) *</label><textarea class="form-input" id="add-rack-codes" rows="6" placeholder="A-03-01\nA-03-02\nA-03-03"></textarea></div>
      <div class="form-grid">
        <div class="form-group"><label>Type</label><select class="form-input" id="add-rack-type"><option>Standard</option><option>Heavy Duty</option><option>Cold Storage</option><option>High Rise</option><option>Bulk</option></select></div>
        <div class="form-group"><label>Zone</label><select class="form-input" id="add-rack-zone"><option>Zone A</option><option>Zone B</option><option>Zone C</option><option>Zone D</option><option>Zone E</option></select></div>
        <div class="form-group"><label>Capacity</label><input type="number" class="form-input" id="add-rack-cap" value="500"></div>
      </div>
    `, `<button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button><button class="btn btn-primary" onclick="WMS.saveRacks()"><i class="fas fa-save"></i> Save</button>`);
  }

  async function saveRacks() {
    const codes = document.getElementById('add-rack-codes').value.trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (!codes.length) { showToast('danger', 'Error', 'Enter at least one rack code'); return; }
    const type = document.getElementById('add-rack-type').value;
    const zone = document.getElementById('add-rack-zone').value;
    const cap = parseFloat(document.getElementById('add-rack-cap').value) || 500;
    const racks = codes.map(code => ({ rack_code: code, rack_type: type, zone, capacity: cap }));
    const data = await api('/racks', { method: 'POST', body: JSON.stringify({ racks }) });
    if (data) { showToast('success', 'Created', data.message); closeModal(); loadRacks(); }
  }

  async function deleteRack(id) {
    const data = await api('/racks/' + id, { method: 'DELETE' });
    if (data) { showToast('success', 'Deleted', data.message); loadRacks(); }
  }

  // ─── MATERIAL MASTER ─────────────────────────────────────
  let matPage = 1;
  async function loadMaterials(page) {
    if (page) matPage = page;
    const search = document.getElementById('mat-search').value;
    const ean = document.getElementById('mat-ean').value;
    const brand = document.getElementById('mat-brand').value;
    const division = document.getElementById('mat-division').value;
    let url = `/materials?page=${matPage}&limit=15`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (ean) url += `&ean=${encodeURIComponent(ean)}`;
    if (brand) url += `&brand=${encodeURIComponent(brand)}`;
    if (division) url += `&division=${encodeURIComponent(division)}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('mat-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><p>No materials found</p></td></tr>'; renderPagination('mat-pagination', data, loadMaterials); return; }
    tbody.innerHTML = data.data.map(m => `
      <tr>
        <td>${esc(m.material_code)}</td>
        <td><strong>${esc(m.material_name)}</strong></td>
        <td>${esc(m.ean || '-')}</td>
        <td>${esc(m.brand || '-')}</td>
        <td>${esc(m.division || '-')}</td>
        <td>${esc(m.packing || '-')}</td>
        <td>${esc(m.unit || 'PCS')}</td>
        <td class="${(m.current_stock || 0) < (m.min_stock || 0) ? 'diff-highlight' : ''}"><strong>${m.current_stock || 0}</strong></td>
        <td>${m.min_stock || 0}</td>
        <td><button class="btn-icon" title="Delete" onclick="WMS.deleteMaterial('${m.id}')"><i class="fas fa-trash"></i></button></td>
      </tr>
    `).join('');
    renderPagination('mat-pagination', data, loadMaterials);
  }

  function showAddMaterial() {
    showModal('Add Material', `
      <div class="form-grid">
        <div class="form-group"><label>Material Code *</label><input type="text" class="form-input" id="am-code" placeholder="MAT-011"></div>
        <div class="form-group"><label>Material Name *</label><input type="text" class="form-input" id="am-name" placeholder="Product name"></div>
        <div class="form-group"><label>EAN</label><input type="text" class="form-input" id="am-ean" placeholder="EAN barcode"></div>
        <div class="form-group"><label>Brand</label><input type="text" class="form-input" id="am-brand" placeholder="Brand name"></div>
        <div class="form-group"><label>Division</label><select class="form-input" id="am-division"><option value="">Select</option><option>FMCG</option><option>Personal Care</option><option>Home Care</option></select></div>
        <div class="form-group"><label>Packing</label><input type="text" class="form-input" id="am-packing" placeholder="e.g. 5 KG Bag"></div>
        <div class="form-group"><label>Unit</label><select class="form-input" id="am-unit"><option>PCS</option><option>KG</option><option>LTR</option><option>BOX</option><option>BAG</option></select></div>
        <div class="form-group"><label>Weight</label><input type="number" class="form-input" id="am-weight" placeholder="0.0" step="0.001"></div>
        <div class="form-group"><label>Min Stock</label><input type="number" class="form-input" id="am-minstock" value="10"></div>
        <div class="form-group form-full"><label>Description</label><textarea class="form-input" id="am-desc" placeholder="Description"></textarea></div>
      </div>
    `, `<button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button><button class="btn btn-primary" onclick="WMS.saveMaterial()"><i class="fas fa-save"></i> Save</button>`, 'lg');
  }

  async function saveMaterial() {
    const formData = new FormData();
    formData.append('material_code', document.getElementById('am-code').value.trim());
    formData.append('material_name', document.getElementById('am-name').value.trim());
    formData.append('ean', document.getElementById('am-ean').value.trim());
    formData.append('brand', document.getElementById('am-brand').value.trim());
    formData.append('division', document.getElementById('am-division').value);
    formData.append('packing', document.getElementById('am-packing').value.trim());
    formData.append('unit', document.getElementById('am-unit').value);
    formData.append('weight', document.getElementById('am-weight').value);
    formData.append('min_stock', document.getElementById('am-minstock').value);
    formData.append('description', document.getElementById('am-desc').value.trim());
    const headers = { 'Authorization': 'Bearer ' + TOKEN };
    try {
      const res = await fetch(API + '/materials', { method: 'POST', headers, body: formData });
      const data = await res.json();
      if (!res.ok) { showToast('danger', 'Error', data.error); return; }
      showToast('success', 'Material Created', data.data.material_name);
      closeModal(); loadMaterials();
    } catch (err) { showToast('danger', 'Error', 'Failed'); }
  }

  async function deleteMaterial(id) {
    const data = await api('/materials/' + id, { method: 'DELETE' });
    if (data) { showToast('success', 'Deleted', data.message); loadMaterials(); }
  }

  // ─── USER MANAGEMENT ─────────────────────────────────────
  let userPage = 1;
  async function loadUsers(page) {
    if (page) userPage = page;
    const search = document.getElementById('user-search').value;
    const role = document.getElementById('user-role').value;
    const status = document.getElementById('user-status').value;
    let url = `/users?page=${userPage}&limit=15`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (role) url += `&role=${encodeURIComponent(role)}`;
    if (status) url += `&status=${encodeURIComponent(status)}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('user-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><p>No users found</p></td></tr>'; renderPagination('user-pagination', data, loadUsers); return; }
    tbody.innerHTML = data.data.map(u => {
      const roleName = u.roles ? u.roles.name : '-';
      const statusBadge = u.is_locked ? 'danger' : !u.is_active ? 'warning' : 'success';
      const statusText = u.is_locked ? 'Locked' : !u.is_active ? 'Inactive' : 'Active';
      return `<tr>
        <td><strong>${esc(u.username)}</strong></td>
        <td>${esc(u.full_name)}</td>
        <td>${esc(u.email)}</td>
        <td><span class="badge badge-accent">${esc(roleName)}</span></td>
        <td><span class="badge badge-${statusBadge}"><span class="badge-dot"></span>${statusText}</span></td>
        <td>${u.last_login ? timeAgo(u.last_login) : 'Never'}</td>
        <td>
          <button class="btn-icon" title="Edit" onclick="WMS.editUser('${u.id}','${esc(u.full_name)}','${esc(u.email)}','${u.role_id}','${u.is_active}')"><i class="fas fa-edit"></i></button>
          <button class="btn-icon" title="Reset Password" onclick="WMS.resetUserPassword('${u.id}','${esc(u.full_name)}')"><i class="fas fa-key"></i></button>
          <button class="btn-icon" title="${u.is_active ? 'Deactivate' : 'Activate'}" onclick="WMS.deactivateUser('${u.id}','${!u.is_active}')"><i class="fas fa-${u.is_active ? 'ban' : 'check'}"></i></button>
        </td>
      </tr>`;
    }).join('');
    renderPagination('user-pagination', data, loadUsers);
  }

  async function showCreateUser() {
    const roles = await api('/roles');
    const roleOpts = (roles || []).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    showModal('Create User', `
      <div class="form-grid">
        <div class="form-group"><label>Username *</label><input type="text" class="form-input" id="cu-username"></div>
        <div class="form-group"><label>Full Name *</label><input type="text" class="form-input" id="cu-name"></div>
        <div class="form-group"><label>Email *</label><input type="email" class="form-input" id="cu-email"></div>
        <div class="form-group"><label>Phone</label><input type="tel" class="form-input" id="cu-phone"></div>
        <div class="form-group"><label>Role *</label><select class="form-input" id="cu-role">${roleOpts}</select></div>
        <div class="form-group"><label>Password *</label><input type="password" class="form-input" id="cu-password" placeholder="Min 8 chars"></div>
      </div>
    `, `<button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button><button class="btn btn-primary" onclick="WMS.createUser()"><i class="fas fa-save"></i> Create</button>`);
  }

  async function createUser() {
    const data = await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('cu-username').value.trim(),
        full_name: document.getElementById('cu-name').value.trim(),
        email: document.getElementById('cu-email').value.trim(),
        phone: document.getElementById('cu-phone').value.trim(),
        role_id: document.getElementById('cu-role').value,
        password: document.getElementById('cu-password').value
      })
    });
    if (data) { showToast('success', 'User Created', data.data.full_name); closeModal(); loadUsers(); }
  }

  async function editUser(id, name, email, roleId, isActive) {
    const roles = await api('/roles');
    const roleOpts = (roles || []).map(r => `<option value="${r.id}" ${r.id === roleId ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    showModal('Edit User', `
      <div class="form-grid">
        <div class="form-group"><label>Full Name</label><input type="text" class="form-input" id="eu-name" value="${esc(name)}"></div>
        <div class="form-group"><label>Email</label><input type="email" class="form-input" id="eu-email" value="${esc(email)}"></div>
        <div class="form-group"><label>Role</label><select class="form-input" id="eu-role">${roleOpts}</select></div>
        <div class="form-group"><label>Active</label><select class="form-input" id="eu-active"><option value="true" ${isActive === 'true' ? 'selected' : ''}>Yes</option><option value="false" ${isActive === 'false' ? 'selected' : ''}>No</option></select></div>
      </div>
    `, `<button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button><button class="btn btn-primary" onclick="WMS.saveUserEdit('${id}')"><i class="fas fa-save"></i> Save</button>`);
  }

  async function saveUserEdit(id) {
    const data = await api('/users/' + id, {
      method: 'PUT',
      body: JSON.stringify({
        full_name: document.getElementById('eu-name').value.trim(),
        email: document.getElementById('eu-email').value.trim(),
        role_id: document.getElementById('eu-role').value,
        is_active: document.getElementById('eu-active').value === 'true'
      })
    });
    if (data) { showToast('success', 'Updated', data.data.full_name); closeModal(); loadUsers(); }
  }

  async function resetUserPassword(id, name) {
    showModal('Reset Password', `
      <p>Reset password for <strong>${esc(name)}</strong></p>
      <div class="form-group" style="margin-top:12px"><label>New Password *</label><input type="password" class="form-input" id="rp-password" placeholder="Min 8 chars"></div>
    `, `<button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button><button class="btn btn-primary" onclick="WMS.executeResetPwd('${id}')"><i class="fas fa-key"></i> Reset</button>`);
  }

  async function executeResetPwd(id) {
    const pwd = document.getElementById('rp-password').value;
    if (!pwd || pwd.length < 8) { showToast('danger', 'Error', 'Password must be at least 8 characters'); return; }
    const data = await api('/users/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({ new_password: pwd }) });
    if (data) { showToast('success', 'Done', data.message); closeModal(); }
  }

  async function deactivateUser(id, active) {
    const data = await api('/users/' + id, { method: 'PUT', body: JSON.stringify({ is_active: active }) });
    if (data) { showToast('success', 'Updated', active ? 'User activated' : 'User deactivated'); loadUsers(); }
  }

  // ─── AUDIT LOG ───────────────────────────────────────────
  let auditPage = 1;
  async function loadAudit(page) {
    if (page) auditPage = page;
    const search = document.getElementById('audit-search').value;
    const module = document.getElementById('audit-module').value;
    const from = document.getElementById('audit-from').value;
    const to = document.getElementById('audit-to').value;
    let url = `/audit?page=${auditPage}&limit=20`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (module) url += `&module=${encodeURIComponent(module)}`;
    if (from) url += `&from_date=${from}`;
    if (to) url += `&to_date=${to}`;
    const data = await api(url);
    if (!data) return;
    const tbody = document.getElementById('audit-table-body');
    if (!data.data.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><p>No audit records</p></td></tr>'; renderPagination('audit-pagination', data, loadAudit); return; }
    tbody.innerHTML = data.data.map(a => `
      <tr>
        <td><strong style="cursor:pointer;color:var(--accent)" onclick="WMS.viewAuditDetail('${esc(a.action_number)}')">${esc(a.action_number)}</strong></td>
        <td><span class="badge badge-info">${esc(a.module)}</span></td>
        <td>${esc(a.action)}</td>
        <td>${esc(a.users?.full_name || '-')}</td>
        <td style="font-family:monospace;font-size:0.8rem">${esc(a.ip_address || '-')}</td>
        <td>${formatDT(a.created_at)}</td>
      </tr>
    `).join('');
    renderPagination('audit-pagination', data, loadAudit);
  }

  async function viewAuditDetail(actionNumber) {
    const data = await api('/audit/' + actionNumber);
    if (!data || !data.length) { showToast('info', 'Info', 'No detail found'); return; }
    const a = data[0];
    let html = `<div class="form-grid">
      <div><strong>Action Number:</strong> ${esc(a.action_number)}</div>
      <div><strong>Module:</strong> ${esc(a.module)}</div>
      <div><strong>Action:</strong> ${esc(a.action)}</div>
      <div><strong>Table:</strong> ${esc(a.table_name || '-')}</div>
      <div><strong>User:</strong> ${esc(a.users?.full_name || '-')}</div>
      <div><strong>IP:</strong> ${esc(a.ip_address || '-')}</div>
      <div><strong>User Agent:</strong> ${esc(a.user_agent || '-')}</div>
      <div><strong>Date:</strong> ${formatDT(a.created_at)}</div>
    </div>`;
    if (a.old_value) html += `<div style="margin-top:12px"><strong>Old Value:</strong><pre style="background:var(--bg-hover);padding:10px;border-radius:8px;margin-top:4px;overflow-x:auto;font-size:0.8rem;max-height:200px">${esc(JSON.stringify(a.old_value, null, 2))}</pre></div>`;
    if (a.new_value) html += `<div style="margin-top:12px"><strong>New Value:</strong><pre style="background:var(--bg-hover);padding:10px;border-radius:8px;margin-top:4px;overflow-x:auto;font-size:0.8rem;max-height:200px">${esc(JSON.stringify(a.new_value, null, 2))}</pre></div>`;
    showModal('Audit Detail', html, '<button class="btn btn-secondary" onclick="WMS.closeModal()">Close</button>', 'lg');
  }

  // ─── SETTINGS ────────────────────────────────────────────
  async function loadSettings() {
    const data = await api('/settings');
    if (!data) return;
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.value = data[key] || ''; };
    set('set-company', 'company_name');
    set('set-theme', 'theme');
    set('set-session-timeout', 'session_timeout');
    set('set-max-fails', 'max_failed_logins');
    set('set-pwd-min', 'password_min_length');
    set('set-pwd-upper', 'password_require_uppercase');
    set('set-pwd-num', 'password_require_number');
    set('set-pwd-special', 'password_require_special');
    set('set-smtp-host', 'smtp_host');
    set('set-smtp-port', 'smtp_port');
    set('set-smtp-user', 'smtp_user');
    set('set-smtp-pass', 'smtp_pass');
    set('set-smtp-from', 'smtp_from');
    set('set-scanner-type', 'scanner_type');
    set('set-camera-facing', 'camera_facing');
    set('set-wh-name', 'warehouse_name');
    set('set-low-stock', 'low_stock_threshold');
    set('set-ai-rack', 'auto_suggest_rack');
    set('set-ai-assistant', 'ai_assistant');
    // Apply saved theme
    if (data.theme) {
      document.documentElement.setAttribute('data-theme', data.theme);
      const icon = document.getElementById('theme-icon');
      if (icon) icon.className = data.theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    }
  }

  async function saveSettings() {
    const get = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const updates = {
      company_name: get('set-company'),
      theme: get('set-theme'),
      session_timeout: get('set-session-timeout'),
      max_failed_logins: get('set-max-fails'),
      password_min_length: get('set-pwd-min'),
      password_require_uppercase: get('set-pwd-upper'),
      password_require_number: get('set-pwd-num'),
      password_require_special: get('set-pwd-special'),
      smtp_host: get('set-smtp-host'),
      smtp_port: get('set-smtp-port'),
      smtp_user: get('set-smtp-user'),
      smtp_pass: get('set-smtp-pass'),
      smtp_from: get('set-smtp-from'),
      scanner_type: get('set-scanner-type'),
      camera_facing: get('set-camera-facing'),
      warehouse_name: get('set-wh-name'),
      low_stock_threshold: get('set-low-stock'),
      auto_suggest_rack: get('set-ai-rack'),
      ai_assistant: get('set-ai-assistant')
    };
    const data = await api('/settings', { method: 'PUT', body: JSON.stringify(updates) });
    if (data) showToast('success', 'Saved', 'Settings updated successfully');
  }

  function switchTab(btn, tabId) {
    btn.closest('.tabs').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    btn.closest('.page').querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
  }

  // ─── SCANNER ─────────────────────────────────────────────
  async function openScanner(targetId) {
    SCANNER_TARGET = targetId;
    const overlay = document.getElementById('scanner-overlay');
    overlay.classList.add('active');
    const video = document.getElementById('scanner-video');
    try {
      const facing = (document.getElementById('set-camera-facing') || {}).value || 'environment';
      SCANNER_STREAM = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      video.srcObject = SCANNER_STREAM;
      // Start scanning with simple barcode detection
      startBarcodeDetection(video);
    } catch (err) {
      showToast('danger', 'Camera Error', 'Cannot access camera. Check permissions.');
      closeScanner();
    }
  }

  function startBarcodeDetection(video) {
    // Simple interval-based scan using canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let scanning = true;

    SCANNER_INTERVAL = setInterval(async () => {
      if (!scanning || video.readyState < 2) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Simple barcode line detection (center row)
      const centerY = Math.floor(canvas.height / 2);
      const row = imageData.data.slice(centerY * canvas.width * 4, (centerY + 1) * canvas.width * 4);
      // Detect dark/light transitions (basic barcode pattern)
      let bars = [];
      let current = row[0] < 128 ? 'dark' : 'light';
      let count = 1;
      for (let i = 1; i < row.length; i += 2) { // Skip every other pixel for speed
        const isDark = row[i * 4] < 128;
        if (isDark !== (current === 'dark')) {
          bars.push({ type: current, width: count });
          current = isDark ? 'dark' : 'light';
          count = 1;
        } else {
          count++;
        }
      }
      bars.push({ type: current, width: count });

      // If we detect a reasonable barcode pattern (alternating bars)
      const darkBars = bars.filter(b => b.type === 'dark');
      if (darkBars.length >= 8 && darkBars.length <= 60) {
        // Try to decode as EAN-13 pattern (simplified)
        // Since full barcode decoding is complex, we'll simulate detection after pattern match
        // In production, use QuaggaJS or ZXing library
        const eanPattern = darkBars.map(b => b.width);
        const totalWidth = eanPattern.reduce((s, w) => s + w, 0);
        if (totalWidth > 50) { // Minimum barcode width
          // Simulate successful scan with a random EAN from material master
          scanning = false;
          clearInterval(SCANNER_INTERVAL);
          closeScanner();
          showToast('info', 'Scan Detected', 'Barcode pattern detected. Use USB/Bluetooth scanner for reliable reading.');
          // Focus the target input
          const target = document.getElementById(SCANNER_TARGET);
          if (target) { target.focus(); target.select(); }
        }
      }
    }, 500);
  }

  function closeScanner() {
    clearInterval(SCANNER_INTERVAL);
    if (SCANNER_STREAM) {
      SCANNER_STREAM.getTracks().forEach(t => t.stop());
      SCANNER_STREAM = null;
    }
    document.getElementById('scanner-overlay').classList.remove('active');
  }

  // ─── BULK UPLOAD ─────────────────────────────────────────
  function showBulkUpload(module) {
    const templates = {
      location: 'Rack, EAN, Material, Description, Brand, Division, Packing, Box Number, Quantity, Action',
      rack: 'Rack, Type, Zone, Warehouse, Capacity',
      material: 'Material Code, Material Name, Description, EAN, Brand, Division, Packing, Unit, Weight, Min Stock'
    };
    const endpoints = { location: 'location/bulk-upload', rack: 'racks/bulk-upload', material: 'materials/bulk-upload' };
    showModal('Bulk Upload — ' + module.charAt(0).toUpperCase() + module.slice(1), `
      <div class="file-upload-area" id="bulk-drop-area" onclick="document.getElementById('bulk-file-input').click()">
        <i class="fas fa-cloud-upload-alt"></i>
        <p>Click to select Excel/CSV file or drag and drop</p>
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Accepted: .xlsx, .xls, .csv</p>
      </div>
      <input type="file" id="bulk-file-input" accept=".xlsx,.xls,.csv" style="display:none" onchange="document.getElementById('bulk-file-name').textContent=this.files[0]?.name||''">
      <div id="bulk-file-name" style="margin-top:8px;font-size:0.85rem;color:var(--text-secondary)"></div>
      <div style="margin-top:16px;padding:12px;background:var(--bg-hover);border-radius:8px">
        <strong style="font-size:0.82rem">Excel Format Required:</strong>
        <code style="display:block;margin-top:4px;font-size:0.78rem;color:var(--accent)">${templates[module] || ''}</code>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="WMS.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="WMS.executeBulkUpload('${endpoints[module]}')"><i class="fas fa-upload"></i> Upload</button>
    `, 'lg');

    // Drag and drop
    const dropArea = document.getElementById('bulk-drop-area');
    if (dropArea) {
      dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.style.borderColor = 'var(--accent)'; dropArea.style.background = 'var(--accent-dim)'; });
      dropArea.addEventListener('dragleave', () => { dropArea.style.borderColor = ''; dropArea.style.background = ''; });
      dropArea.addEventListener('drop', e => {
        e.preventDefault(); dropArea.style.borderColor = ''; dropArea.style.background = '';
        const fileInput = document.getElementById('bulk-file-input');
        fileInput.files = e.dataTransfer.files;
        document.getElementById('bulk-file-name').textContent = e.dataTransfer.files[0]?.name || '';
      });
    }
  }

  async function executeBulkUpload(endpoint) {
    const fileInput = document.getElementById('bulk-file-input');
    if (!fileInput.files[0]) { showToast('warning', 'Warning', 'Select a file first'); return; }
    const formData = new FormData();
    formData.append('bulk_file', fileInput.files[0]);
    const headers = { 'Authorization': 'Bearer ' + TOKEN };
    try {
      const res = await fetch(API + '/' + endpoint, { method: 'POST', headers, body: formData });
      const data = await res.json();
      if (!res.ok) { showToast('danger', 'Error', data.error); return; }
      showToast('success', 'Uploaded', data.message);
      closeModal();
      // Refresh relevant page
      if (endpoint.includes('location')) loadLocations();
      if (endpoint.includes('rack')) loadRacks();
      if (endpoint.includes('material')) loadMaterials();
    } catch (err) {
      showToast('danger', 'Error', 'Upload failed');
    }
  }

  // ─── EXPORTS ─────────────────────────────────────────────
  function exportExcel(module) {
    const from = getFilterDate(module, 'from');
    const to = getFilterDate(module, 'to');
    const search = getFilterSearch(module);
    let url = `/export/excel/${module}?`;
    if (from) url += `from_date=${from}&`;
    if (to) url += `to_date=${to}&`;
    if (search) url += `search=${encodeURIComponent(search)}&`;
    showToast('info', 'Downloading', 'Generating Excel file...');
    api(url);
  }

  function exportPDF(module) {
    const from = getFilterDate(module, 'from');
    const to = getFilterDate(module, 'to');
    const search = getFilterSearch(module);
    let url = `/export/pdf/${module}?`;
    if (from) url += `from_date=${from}&`;
    if (to) url += `to_date=${to}&`;
    if (search) url += `search=${encodeURIComponent(search)}&`;
    showToast('info', 'Downloading', 'Generating PDF...');
    api(url);
  }

  function getFilterDate(module, type) {
    const map = {
      'vehicles': { from: 'vl-from', to: 'vl-to' },
      'location': { from: 'loc-from', to: 'loc-to' },
      'differences': { from: 'diff-from', to: 'diff-to' },
      'picking': { from: 'pick-from', to: 'pick-to' },
      'audit': { from: 'audit-from', to: 'audit-to' }
    };
    const ids = map[module];
    if (!ids) return '';
    const el = document.getElementById(ids[type]);
    return el ? el.value : '';
  }

  function getFilterSearch(module) {
    const map = { 'vehicles': 'vl-search', 'location': 'loc-search', 'picking': 'pick-search', 'audit': 'audit-search' };
    const el = document.getElementById(map[module]);
    return el ? el.value : '';
  }

  // ─── QR CODE ─────────────────────────────────────────────
  function showQR(text) {
    const qrUrl = API + '/qrcode/' + encodeURIComponent(text);
    showModal('QR Code', `<div style="text-align:center"><img src="${qrUrl}" style="max-width:200px;border-radius:8px" alt="QR Code"><p style="margin-top:12px;font-weight:600">${esc(text)}</p></div>`, '<button class="btn btn-secondary" onclick="WMS.closeModal()">Close</button>');
  }

  // ─── AI CHAT ─────────────────────────────────────────────
  async function sendAIChat() {
    const input = document.getElementById('ai-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    const container = document.getElementById('ai-messages');
    // Add user message
    container.innerHTML += `<div class="ai-msg user"><div class="ai-msg-avatar"><i class="fas fa-user"></i></div><div class="ai-msg-bubble">${esc(msg)}</div></div>`;
    container.scrollTop = container.scrollHeight;
    // Add typing indicator
    const typingId = 'typing-' + Date.now();
    container.innerHTML += `<div class="ai-msg bot" id="${typingId}"><div class="ai-msg-avatar"><i class="fas fa-robot"></i></div><div class="ai-msg-bubble"><div class="spinner" style="margin:0 auto"></div></div></div>`;
    container.scrollTop = container.scrollHeight;
    const data = await api('/ai/chat', { method: 'POST', body: JSON.stringify({ message: msg }) });
    // Remove typing indicator
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    // Add bot response
    const reply = data ? data.reply : 'Sorry, I could not process that request.';
    container.innerHTML += `<div class="ai-msg bot"><div class="ai-msg-avatar"><i class="fas fa-robot"></i></div><div class="ai-msg-bubble">${esc(reply)}</div></div>`;
    container.scrollTop = container.scrollHeight;
  }

  // ─── PAGINATION HELPER ───────────────────────────────────
  function renderPagination(containerId, data, loader) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const total = data.total || 0;
    const page = data.page || 1;
    const limit = data.limit || 15;
    const totalPages = Math.ceil(total / limit) || 1;
    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);
    let html = `<div class="pagination-info">Showing ${total > 0 ? start : 0}-${end} of ${total}</div><div class="pagination-btns">`;
    html += `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} onclick="WMS._pg('${containerId}',${page - 1})"><i class="fas fa-chevron-left"></i></button>`;
    let startPage = Math.max(1, page - 2);
    let endPage = Math.min(totalPages, page + 2);
    if (startPage > 1) { html += `<button class="page-btn" onclick="WMS._pg('${containerId}',1)">1</button>`; if (startPage > 2) html += '<span style="padding:0 4px">...</span>'; }
    for (let i = startPage; i <= endPage; i++) {
      html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="WMS._pg('${containerId}',${i})">${i}</button>`;
    }
    if (endPage < totalPages) { if (endPage < totalPages - 1) html += '<span style="padding:0 4px">...</span>'; html += `<button class="page-btn" onclick="WMS._pg('${containerId}',${totalPages})">${totalPages}</button>`; }
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="WMS._pg('${containerId}',${page + 1})"><i class="fas fa-chevron-right"></i></button>`;
    html += '</div>';
    container.innerHTML = html;
  }

  // Store loader references for pagination
  const _pgLoaders = {
    'vehicle-pagination': loadVehicles,
    'diff-pagination': loadDifferences,
    'loc-pagination': loadLocations,
    'pick-pagination': loadPickingReports,
    'rack-pagination': loadRacks,
    'mat-pagination': loadMaterials,
    'user-pagination': loadUsers,
    'audit-pagination': loadAudit
  };

  window.WMS._pg = function (containerId, page) {
    const loader = _pgLoaders[containerId];
    if (loader) loader(page);
  };

  // ─── DATE FORMATTERS ─────────────────────────────────────
  function formatDate(d) { if (!d) return '-'; return d.split('T')[0]; }
  function formatDT(d) {
    if (!d) return '-';
    const dt = new Date(d);
    return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─── AUTO-INIT ───────────────────────────────────────────
  function init() {
    // Apply saved theme
    const savedTheme = localStorage.getItem('wms_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.className = savedTheme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    // Check if already logged in
    if (TOKEN && USER) {
      // Verify token
      api('/auth/me').then(data => {
        if (data) { initApp(); }
        else { logout(); }
      });
    }
  }

  // ─── EXPOSE TO GLOBAL ────────────────────────────────────
  window.WMS = {
    login, logout, navigate, toggleSidebar, toggleTheme,
    toggleNotifDropdown, markAllRead, markNotifRead,
    loadDashboard, saveVehicle, resetVehicleForm,
    openInvoiceModal, addInvoiceMaterialRow, saveInvoice, uploadInvoiceExcel,
    loadVehicles, openVehicleDetail,
    loadPendingVehicles, loadUnloadInvoices, loadUnloadMaterials,
    lookupEAN, saveUnload, completeInvoiceUnload,
    loadDifferences, approveDifference,
    savePutaway, loadRecentPutaways,
    savePIV, loadRecentPIV,
    loadLocations, bulkDeleteLocation, toggleAllCheckboxes,
    loadWarehouseMap,
    showCreatePicking, addPickItemRow, createPickingReport,
    loadPickingReports, openPickingDetail, pickAction, updatePickStatus,
    loadPickHistory,
    loadRacks, showAddRacks, saveRacks, deleteRack,
    loadMaterials, showAddMaterial, saveMaterial, deleteMaterial,
    loadUsers, showCreateUser, createUser, editUser, saveUserEdit,
    resetUserPassword, executeResetPwd, deactivateUser,
    loadAudit, viewAuditDetail,
    loadSettings, saveSettings, switchTab,
    sendAIChat,
    openScanner, closeScanner,
    showBulkUpload, executeBulkUpload,
    exportExcel, exportPDF,
    globalSearch, debounce,
    loadNotifications, changePassword,
    showModal, closeModal, showToast,
    showQR, _pg: window.WMS._pg
  };

  // Start
  init();

})();