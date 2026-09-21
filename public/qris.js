// QRIS checkout page v14 — polls /api/v1/qris/:id/status and updates UI.
const id = location.pathname.split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '');
const $ = (s) => document.querySelector(s);
const el = {
  status: $('#status'), statusText: $('#statusText'),
  countdown: $('#countdown'), countbar: $('#countbar'), counttext: $('#counttext'),
  amt: $('#amt'), merchant: $('#merchant'),
  img: $('#qrimg'), skel: $('#qrskel'), scan: $('#qrscan'),
  done: $('#qrdone'), dead: $('#qrdead'), qrbox: $('#qrbox'),
  dl: $('#dl'), copy: $('#copy'),
  dRef: $('#d-ref'), dTx: $('#d-tx'), rowTx: $('#row-tx'),
  checkout: $('#checkout')
};

const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
let deadline = Date.now() + 5 * 60 * 1000;
let total = 5 * 60 * 1000;

el.dRef.textContent = id;
el.statusText.textContent = 'Memuat QR…';

function showState(state, text) {
  el.status.className = 'status status--' + state;
  el.statusText.textContent = text;
  if (state === 'paid') {
    el.checkout.classList.add('paid');
    el.skel.hidden = true; el.scan.hidden = true; el.img.hidden = true;
    el.done.hidden = false; el.dead.hidden = true;
    el.qrbox.classList.remove('dim');
  } else if (state === 'expired') {
    el.checkout.classList.remove('paid');
    el.skel.hidden = true; el.scan.hidden = true; el.img.hidden = false;
    el.done.hidden = true; el.dead.hidden = false;
    el.qrbox.classList.add('dim');
    el.countdown.hidden = true;
  } else {
    el.skel.hidden = true; el.img.hidden = false; el.scan.hidden = false;
    el.done.hidden = true; el.dead.hidden = true; el.qrbox.classList.remove('dim');
  }
}

async function poll() {
  try {
    const r = await fetch('/api/v1/qris/' + id + '/status').then((r) => r.json());
    if (r.status === 'PAID' || r.paid === true) {
      showState('paid', 'Pembayaran Diterima');
      el.countdown.hidden = true;
      if (r.transaction) {
        const tx = r.transaction.transaction_id || r.transaction.tx_id || r.transaction.reference;
        if (tx) { el.dTx.textContent = tx; el.rowTx.hidden = false; }
      }
      return true;
    }
    if (r.status === 'EXPIRED' || r.status === 410) { showState('expired', 'QRIS Kadaluarsa'); return true; }
    showState('wait', 'Menunggu Pembayaran');
    return false;
  } catch (e) {
    el.status.className = 'status status--wait';
    el.statusText.textContent = 'Memeriksa status…';
    return false;
  }
}

(async () => {
  // Load QR image + expiry from detail endpoint.
  let qrisCode = null;
  try {
    const d = await fetch('/api/v1/qris/' + id).then((r) => r.json());
    const data = d.data || {};
    qrisCode = data.qris_code || null;
    if (data.expires_at) { deadline = data.expires_at; total = data.duration_ms || 5 * 60 * 1000; }
    if (data.amount) el.amt.textContent = fmt(data.amount);
    el.copy.hidden = false;
    if (qrisCode || data.qr_image_url) {
      const src = data.qr_image_url || ('https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(qrisCode));
      el.img.alt = 'QRIS ' + id;
      el.dl.hidden = false;
      el.dl.href = location.pathname + '?download=1';
      // Retry image loading: network can be flaky on mobile.
      let tries = 0;
      const loadImg = (url) => new Promise((resolve) => {
        el.img.onload = () => resolve(true);
        el.img.onerror = () => resolve(false);
        el.img.src = url;
      });
      const urls = [src, 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' + encodeURIComponent(qrisCode || id)];
      for (const u of urls) {
        if (await loadImg(u)) { el.img.hidden = false; el.skel.hidden = true; el.scan.hidden = false; break; }
        tries++;
      }
      if (tries >= urls.length && !el.img.complete) {
        // gambar gagal total — bukan berarti expired; tampilkan state menunggu
        el.skel.hidden = true; el.scan.hidden = true;
        el.status.className = 'status status--wait';
        el.statusText.textContent = 'QR sedang dimuat…';
      }
    } else {
      el.skel.hidden = true; el.scan.hidden = true;
      el.status.className = 'status status--wait';
      el.statusText.textContent = 'Menunggu QR dibuat…';
      return;
    }
  } catch (e) {
    el.status.className = 'status status--wait';
    el.statusText.textContent = 'Gagal memuat detail QR';
  }

  if (await poll()) return; // already settled/expired

  el.countdown.hidden = false;
  const tick = setInterval(async () => {
    const left = Math.max(0, deadline - Date.now());
    if (left <= 0) {
      clearInterval(tick);
      showState('expired', 'QRIS Kadaluarsa');
      return;
    }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.counttext.textContent = 'Bayar dalam ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    const pct = Math.min(100, Math.max(2, (left / total) * 100));
    el.countbar.style.width = pct.toFixed(1) + '%';
    el.countbar.className = pct < 20 ? 'crit' : pct < 45 ? 'low' : '';
    if (await poll()) clearInterval(tick);
  }, 1000);

  el.copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.amt.textContent.replace(/[^\d]/g, ''));
      el.copy.classList.add('ok');
      setTimeout(() => el.copy.classList.remove('ok'), 1300);
    } catch (e) {}
  };
})();
