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

el.ref.textContent = id;
el.status.textContent = '⏳ Memuat QR…';
if (amt) el.amt.textContent = 'Rp ' + Number(amt).toLocaleString('id-ID');

let deadline = Date.now() + 5 * 60 * 1000;

async function poll() {
  try {
    const r = await fetch(`/api/v1/qris/${id}/status`).then(r => r.json());
    if (r.status === 'PAID' || r.paid === true) {
      el.status.textContent = '✅ Pembayaran Diterima';
      el.status.className = 'status paid';
      el.countdown.textContent = '';
      if (r.transaction) {
        el.meta.textContent = `TxID: ${r.transaction.transaction_id || r.transaction.tx_id || '-'} · ${r.transaction.provider || ''}`;
      }
      return true;
    }
    if (r.status === 'EXPIRED') {
      el.status.textContent = '⏰ QRIS Kadaluarsa';
      el.status.className = 'status expired';
      el.img.style.opacity = '0.3';
      el.countdown.textContent = '';
      return true;
    }
    el.status.textContent = '⏳ Menunggu Pembayaran';
    el.status.className = 'status';
    return false;
  } catch (e) {
    el.status.textContent = '⚠️ Gagal mengecek status — mencoba lagi…';
    el.status.className = 'status';
    return false;
  }
}

(async () => {
  // Load QR image + expiry from detail endpoint.
  try {
    const d = await fetch(`/api/v1/qris/${id}`).then(r => r.json());
    if (d.data?.expires_at) deadline = new Date(d.data.expires_at).getTime();
    if (d.data?.amount && !amt) el.amt.textContent = 'Rp ' + Number(d.data.amount).toLocaleString('id-ID');
    if (d.data?.qris_code) {
      el.img.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(d.data.qris_code)}`;
      el.img.alt = 'QRIS ' + id;
    } else {
      el.status.textContent = '⚠️ QR tidak tersedia';
      el.status.className = 'status expired';
      return;
    }
  } catch (e) {
    el.status.textContent = '⚠️ Gagal memuat detail QR';
    el.status.className = 'status';
  }

  if (await poll()) return; // already settled/expired

  const tick = setInterval(async () => {
    const left = Math.max(0, deadline - Date.now());
    if (left > 0) {
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      el.countdown.textContent = `Berlaku ${m} menit ${s} detik`;
    } else {
      clearInterval(tick);
      el.countdown.textContent = '';
      el.status.textContent = '⏰ QRIS Kadaluarsa';
      el.status.className = 'status expired';
      el.img.style.opacity = '0.3';
      return;
    }
    if (await poll()) clearInterval(tick);
  }, 5000);

  // Also tick countdown immediately once.
  const m = Math.floor(Math.max(0, deadline - Date.now()) / 60000);
  const s = Math.floor((Math.max(0, deadline - Date.now()) % 60000) / 1000);
  el.countdown.textContent = `Berlaku ${m} menit ${s} detik`;
})();
