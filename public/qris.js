// QRIS payment page: polls /api/v1/qris/:id/status and updates UI.
const id = location.pathname.split('/').pop();
const amt = new URLSearchParams(location.search).get('amt');
const el = {
  status: document.getElementById('status'),
  countdown: document.getElementById('countdown'),
  amt: document.getElementById('amt'),
  ref: document.getElementById('ref'),
  img: document.getElementById('qrimg'),
  dl: document.getElementById('dl'),
  meta: document.getElementById('meta')
};

async function poll() {
  try {
    const r = await fetch(`/api/v1/qris/${id}/status`).then(r => r.json());
    if (r.status === 'PAID') {
      el.status.textContent = '✅ Pembayaran Diterima';
      el.status.className = 'status paid';
      if (r.transaction) {
        el.meta.textContent = `TxID: ${r.transaction.transaction_id} · ${r.transaction.provider}`;
      }
      return true;
    }
    if (r.status === 'EXPIRED') {
      el.status.textContent = '⏰ QRIS Kadaluarsa';
      el.status.className = 'status expired';
      el.img.style.opacity = '0.3';
      return true;
    }
    el.status.textContent = '⏳ Menunggu Pembayaran';
    el.status.className = 'status';
    return false;
  } catch {
    return false;
  }
}

if (amt) el.amt.textContent = 'Rp ' + Number(amt).toLocaleString('id-ID');
el.ref.textContent = id;

(async () => {
  if (await poll()) return; // already settled/expired
  let deadline = Date.now() + 5 * 60 * 1000;
  // Try to read expiry from detail endpoint
  try {
    const d = await fetch(`/api/v1/qris/${id}`).then(r => r.json());
    if (d.data?.expires_at) deadline = new Date(d.data.expires_at).getTime();
    if (d.data?.amount && !amt) el.amt.textContent = 'Rp ' + Number(d.data.amount).toLocaleString('id-ID');
    el.img.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(d.data?.qris_code || '')}`;
  } catch {}
  const tick = setInterval(async () => {
    const left = Math.max(0, deadline - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.countdown.textContent = `Berlaku ${m}m ${s}j`;
    if (left <= 0) { clearInterval(tick); el.status.textContent = '⏰ QRIS Kadaluarsa'; el.status.className = 'status expired'; el.img.style.opacity = '0.3'; return; }
    if (await poll()) { clearInterval(tick); }
  }, 5000);
})();
