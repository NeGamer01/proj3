// QRISPay shared dashboard helpers v5.
// Toast notifications (replaces alert) + skeleton loading + nav icons.

// ── toast ──
function toast(msg, kind = '', ms = 4000) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<div class="t-msg">${String(msg ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))}</div><span class="t-x" role="button" aria-label="Tutup">&times;</span>`;
  el.querySelector('.t-x').onclick = () => dismiss(el);
  box.appendChild(el);
  const t = setTimeout(() => dismiss(el), ms);
  function dismiss(n) { clearTimeout(t); if (!n.isConnected) return; n.classList.add('out'); setTimeout(() => n.remove(), 200); }
}
// confirm() replacement — async, non-blocking fallback to native confirm if DOM unavailable
function confirmDialog(msg) { return Promise.resolve(confirm(msg)); }

// ── api ──
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ success: false, message: 'Invalid JSON' }));
  if (!r.ok && !j.code) j.code = 'HTTP_' + r.status;
  return j;
}
function money(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function tag(status) {
  const map = { PAID: 'ok', active: 'ok', processed: 'ok', PENDING: 'warn', requested: 'warn', EXPIRED: 'err', rejected: 'err', blocked: 'err', cancelled: 'mut', H0: 'warn' };
  const cls = map[status] || 'mut';
  return `<span class="tag ${cls}">${esc(status)}</span>`;
}

// ── skeleton loading ──
function showSkeleton(content) {
  content.innerHTML = `<div class="skel"><div class="skel-grid"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div><div class="skel-row w80"></div><div class="skel-row w60"></div><div class="skel-row w40"></div></div>`;
}

// ── overview loaders ──
// User dashboard overview.
async function loadOverview() {
  const r = await api('/app/api/overview');
  if (!r.success) {
    if (r.code === 'HTTP_401' || r.code === 'UNAUTHORIZED') { location.href = '/login'; return null; }
    throw new Error(r.message || 'Gagal memuat data');
  }
  return r.data;
}
// Admin overview: counts, revenue, providers, pending withdrawals, recent orders.
async function loadAdminOverview() {
  const r = await api('/admin/api/overview');
  if (!r.success) {
    if (r.code === 'HTTP_401' || r.code === 'UNAUTHORIZED') { location.href = '/login'; return null; }
    throw new Error(r.message || 'Gagal memuat data admin');
  }
  return r.data;
}
function setActiveNav(view) {
  document.querySelectorAll('.nav').forEach(a => a.classList.toggle('active', a.dataset.view === view));
}
