// Shared dashboard helper.
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({ success: false, message: 'Invalid JSON' }));
  if (!r.ok && !j.code) j.code = 'HTTP_' + r.status;
  return j;
}
function money(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function tag(status) {
  const map = { PAID: 'ok', active: 'ok', processed: 'ok', PENDING: 'warn', requested: 'warn', EXPIRED: 'err', rejected: 'err', blocked: 'err', cancelled: 'mut' };
  const cls = map[status] || 'mut';
  return `<span class="tag ${cls}">${esc(status)}</span>`;
}
async function loadOverview() {
  const r = await api('/app/api/overview');
  if (!r.success) { location.href = '/login'; return; }
  return r.data;
}
