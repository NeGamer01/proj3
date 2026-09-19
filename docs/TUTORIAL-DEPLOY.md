# Tutorial Deploy QRISPay ke cPanel (CloudLinux + Passenger)

Ditulis berdasarkan verifikasi kode nyata (semua path dan perintah di bawah sudah dicek
terhadap repo ini). Berlaku untuk shared hosting cPanel dengan **Setup Node.js App**.

Persyaratan hosting: Node.js 20 atau 22 (cek selector), MySQL/MariaDB, Terminal access
(cPanel > Terminal), dan PHP tidak digunakan sama sekali.

---

## 0. Sebelum mulai

Siapkan:

- File project (folder `PayGateway`) dalam bentuk zip di komputer Anda.
- Akses cPanel (alamat, user, password).
- Nama domain/subdomain yang akan dipakai, contoh `pay.halogamingzone.com`.

Pastikan isi zip hanya folder ini, tanpa `node_modules` dan tanpa `.env`:

```
app.js
package.json
.env.example
src/
public/
scripts/
tests/
```

`node_modules` akan dibuat ulang di server (lihat langkah 6), jadi tidak perlu diupload.

---

## 1. Upload file project

1. Buka **cPanel > File Manager**.
2. Masuk ke folder `/home/USER` (USER = username cPanel Anda), di luar `public_html`.
3. Klik **Upload** dan pilih file zip Anda.
4. Klik kanan file zip > **Extract**. Nama folder hasil extract jadikan `qrispay`.
5. Hapus file zip-nya.

Struktur yang benar setelah langkah ini:

```
/home/USER/qrispay/          <- aplikasi
/home/USER/public_html/      <- tetap kosong
```

Kenapa di luar `public_html`? Karena seluruh project Anda (termasuk `.env` yang berisi
secret, dan halaman admin) tidak boleh diakses langsung dari web. Nanti Passenger yang
menyajikan halaman publiknya melalui domain Anda.

**Catatan:** apabila extract Anda menghasilkan `qrispay/PayGateway/...` (folder ganda),
pindahkan isinya satu level ke atas supaya `/home/USER/qrispay/app.js` benar-benar ada.

---

## 2. Buat database MySQL

1. Buka **cPanel > MySQL Databases**.
2. **Create New Database**: nama `qrispay` → klik **Create Database**.
   Nama lengkapnya menjadi `USER_qrispay` (cPanel selalu menambah prefix username).
3. **Add New User**: nama `qrispay`, password kuat (catat!) → **Create User**.
4. **Add User To Database**: pilih `USER_qrispay` dan `USER_qrispay` → **Add**.
5. Pada halaman privileges, centang **ALL PRIVILEGES** → **Make Changes**.

Catat: nama database, username, password. Ini untuk `.env`.

Jika hosting Anda menyediakan database MySQL **remote** (bukan localhost), catat juga
hostname-nya.

---

## 3. Buka Terminal cPanel

**cPanel > Terminal**. Semua perintah di bawah dijalankan di sini.

Pasang default Node ke versi yang benar dulu (supaya perintah `node` konsisten):

```bash
node -v
```

Kalau `node` belum dikenali atau versinya di bawah 20, keluar Terminal dulu, buka
**cPanel > Setup Node.js App**, buat app baru apa adanya (lihat langkah 5), lalu buka
kembali Terminal — setiap Node app punya environment Node sendiri yang aktif.

---

## 4. Isi file .env

```bash
cd ~/qrispay
cp .env.example .env
node scripts/gen-secrets.js
```

Perintah terakhir mencetak tiga baris. Salin dan simpan dulu:

```
SESSION_SECRET=...
PROVIDER_MASTER_KEY=...
ADMIN_PASSWORD=...
```

Buka editor (kalau `nano` tersedia: `nano .env`, atau lewat **File Manager > Edit**),
lalu isi bagian-bagian berikut:

```
NODE_ENV=production
PUBLIC_GATEWAY_URL=https://pay.halogamingzone.com
APP_NAME=QRISPay

DB_HOST=localhost
DB_PORT=3306
DB_NAME=USER_qrispay
DB_USER=USER_qrispay
DB_PASS=password-user-mysql-anda

SESSION_SECRET=<hasil gen-secrets>
PROVIDER_MASTER_KEY=<hasil gen-secrets>

ADMIN_EMAIL=admin@halogamingzone.com
ADMIN_PASSWORD=<hasil gen-secrets, atau password Anda sendiri>
```

Penting:

- `DB_NAME` dan `DB_USER` **harus** pakai prefix cPanel (`USER_qrispay`), bukan cuma `qrispay`.
- `PROVIDER_MASTER_KEY` dipakai mengenkripsi token operator GoPay Anda. **Jangan sampai
  hilang** — tanpa key ini, token yang tersimpan tidak bisa dibaca lagi.
- `PUBLIC_GATEWAY_URL` dipakai untuk URL QRIS dan callback. Domain harus sudah aktif.

Simpan file.

---

## 5. Migrasi database

Masih di Terminal, di folder `~/qrispay`:

```bash
node scripts/migrate.js
```

Output yang diharapkan:

```
migrated
```

Kalau muncul error akses database, periksa kembali langkah 2 (prefix nama, privileges,
password). Kalau muncul `ER_BAD_DB_ERROR` berarti `DB_NAME` salah.

Setelah ini, database sudah punya 15 tabel + data default (paket free dan H0 bulanan,
dua baris provider_account berstatus `unconfigured`).

---

## 6. Buat Node.js App

**cPanel > Setup Node.js App > Create Application**:

| Field | Isi |
|---|---|
| Node.js version | 20 atau 22 |
| Application mode | **Production** |
| Application root | `qrispay` |
| Application URL | domain/subdomain Anda |
| Application startup file | `app.js` |
| Passenger log file | biarkan default |
| Environment variables | (biarkan kosong, semua sudah di `.env`) |

Klik **Create**.

Halaman aplikasi menampilkan tombol **Run NPM Install**. Klik tombol itu dan tunggu
sampai selesai. Ini memasang dependensi (`express`, `mysql2`, `dotenv`, `axios`,
`cookie-parser`) di server.

Kalau tombolnya tidak ada atau gagal, jalankan manual lewat Terminal:

```bash
cd ~/qrispay && npm install --omit=dev
```

Lalu kembali ke halaman app dan klik **Restart** (ikon ⟳).

---

## 7. Tes aplikasi

Buka domain Anda di browser:

```
https://pay.halogamingzone.com/api/v1/healthz
```

Output yang diharapkan:

```json
{"status":"healthy", ...}
```

Kalau yang muncul **502 Bad Gateway** atau **Passenger error**, cek log Passenger
(lihat langkah 9). Sebab paling umum: `.env` belum diisi, `DB_NAME` tanpa prefix,
atau `node_modules` belum terpasang.

Setelah healthz sehat, buka:

```
https://pay.halogamingzone.com/admin
```

Login pakai `ADMIN_EMAIL` / `ADMIN_PASSWORD` yang Anda isi di `.env`.

Kalau lupa password admin, buat ulang dari Terminal:

```bash
node scripts/create-admin.js admin@domain.com passwordBaru123
```

---

## 8. Konfigurasi provider pertama

Aplikasi sudah jalan, tapi QRIS belum bisa dipakai karena akun provider masih kosong.
Di menu admin:

1. Buka tab **Provider** > pilih **GoPay**.
2. Masukkan **QRIS statis** Anda (string QR yang biasanya didapat dari aplikasi
   merchant GoBiz / GoPay Anda). Format harus valid: dimulai `000201010212`, panjang
   minimal 40 karakter, CRC16 di bagian akhir benar, dan tag 58 = `ID`.
3. Klik **Simpan**.

Setelah ini QRIS dinamis baru bisa dibuat. Untuk langganan langkah tambahan ini
diperlukan, karena QRIS statis adalah sumber payload untuk invoice dinamis.

**Jangan lupa cek paket default.** Di tab **Users** atau **Plans**, pastikan paket
`free` (tier H1, provider `shopeepay`) dan `h0-monthly` (tier H0, provider `gopay`
dan `shopeepay`) sudah sesuai dengan kebutuhan Anda. Untuk memberi akses GoPay ke
user saat ini, beri langganan paket `h0-monthly` melalui tab Users > **Beri
Langganan Manual** — pastikan **memilih paket** di dropdown (kalau tidak dipilih,
`allowed_providers` jadi kosong dan user tidak bisa buat QRIS sama sekali).

---

## 9. Lihat log dan troubleshooting

**Log aplikasi** (log Anda sendiri):

```bash
tail -f ~/qrispay/logs/app.log
```

**Log Passenger** (error startup, 502):

```bash
tail -f ~/logs/$(whoami)_app.log
```

Periksa status aplikasi tanpa browser:

```bash
cd ~/qrispay && curl -s http://localhost/api/v1/healthz
```

Daftar error umum dan solusinya:

| Gejala | Penyebab | Solusi |
|---|---|---|
| 502 Bad Gateway saat buka domain | app crash saat start | Cek Passenger log; biasanya `.env` belum diisi atau DB salah |
| `ER_BAD_DB_ERROR` | `DB_NAME` tanpa prefix | Ganti `DB_NAME=USER_qrispay` |
| `EACCES` saat write `logs/` atau `qrispay.key` | folder tidak writable | `chmod -R u+w ~/qrispay` |
| Halaman blank / asset hilang | folder `public` tidak terupload | Upload ulang folder `public` |
| Admin login 401 | `ADMIN_EMAIL`/`ADMIN_PASSWORD` salah di `.env` | `node scripts/create-admin.js ...` |
| `PROVIDER_MASTER_KEY must be 64 hex` | key tidak lengkap | `node scripts/gen-secrets.js` lagi |
| QRIS 400 `invalid static qris` | QR statis tidak valid | Pakai QR dari GoBiz merchant asli |
| User berlangganan tapi tidak bisa buat QRIS | grant tanpa pilih paket | Beri ulang langganan, **pilih paket** |

---

## 10. Selesai, apa berikutnya

Aplikasi QRISPay Anda sekarang online. Alur yang sudah berjalan:

1. User mendaftar di `/` dan membuat API key di `/app`.
2. Admin memberi langganan (pilih paket!) melalui `/admin`.
3. User buat invoice lewat `POST /api/v1/qris` dengan API key.
4. Invoice dipair ke mutasi operator GoPay lewat **kode unik** (total = nominal + kode 21-200).
5. Pembayaran cocok → invoice `PAID` → saldo masuk di ledger → user bisa tarik (withdraw).
6. Pembayaran tidak cocok dalam 10 menit → masuk `unmatched_payments` untuk direconcile admin.

Untuk pengembangan selanjutnya: fase 2 adalah provider ShopeePay. Struktur provider di
`src/providers/` sudah disiapkan untuk ini, tinggal tambahkan `src/providers/shopeepay/`
dan daftarkan ke registry provider — services dan routes tidak perlu diubah.

---

## Catatan teknis (untuk referensi)

- **Tidak ada native module** di dependency tree (0 file `.node`), jadi `mysql2` aman
  di shared hosting yang melarang module native.
- **Tidak ada build step** — Express langsung menyajikan folder `public` tanpa webpack/vite.
- **Semua path memakai `process.cwd()` / `__dirname`** — tidak ada path absolut yang
  di-hardcode, jadi aplikasi boleh ditaruh di folder mana pun.
- **PORT dibaca dari environment** (Passenger set otomatis), `PORT` di `.env` diabaikan.
- **Background poller memakai `setInterval(...).unref()`** — tidak menahan proses
  Passenger tetap hidup, dan idle kalau tidak ada invoice pending.
- **Auto-create database** ada di `db.migrate()` untuk kemudahan lokal, tapi di cPanel
  Anda **wajib** membuat database manual dulu (langkah 2) karena user shared hosting
  biasanya tidak punya hak `CREATE DATABASE`. Kalau auto-create gagal, hanya warning.
