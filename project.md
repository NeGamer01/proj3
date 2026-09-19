# QRISPay — Operator-Pooled Multi-Provider QRIS Payment Gateway

> **Dokumentasi lengkap & cadangan.** File ini merangkum seluruh arsitektur, keputusan desain,
> struktur file, skema database, kontrak API, invariants keamanan, bug yang ditemukan, langkah
> setup, dan roadmap. Jika ada script yang rusak/hilang, dokumen ini cukup untuk merekonstruksi
> proyek atau men-debug masalahnya.

---

## 1. Ringkasan

**QRISPay** adalah payment gateway QRIS yang **operator-pooled**: operator (pemilik gateway)
memiliki **SATU akun GoBiz (GoPay) + SATU akun ShopeePay**, dan **semua pembayaran buyer
mendarat di akun operator tersebut**. Setiap client-user (pemilik bot/web) mendapat **saldo
ledger internal** yang ditarik (withdraw) secara manual — meniru model Digiflazz/Tripay.

Dua provider di-gate berdasarkan tier langganan:
- **ShopeePay (H+1 settlement) = tier gratis** — untuk semua user.
- **GoPay/GoBiz (H+0 settlement) = langganan berbayar** — khusus subscriber.

Paket langganan diatur admin. Urutan build: **GoPay dulu ke produksi (Fase 1, selesai)**,
**ShopeePay nyusul (Fase 2)**.

### Stack & konvensi
- **Node.js** (Express + mysql2 + axios), **tanpa build step**, cPanel-ready.
- Brand: **QRISPay** (netral, mudah rebrand via `config.appName`).
- Lokasi: `/root/gateway`.
- Endpoint meniru `nikipayv2` supaya client (mis. NIKISTORE Bot) mudah adopt.
- Rentang kode unik: **21–200** (180 slot).
- Provider dibatasi: **GoPay + ShopeePay** saja.

### Proyek referensi (di `/root`)
| Referensi | Peran |
|---|---|
| `/root/nikipayv2` | Kode acuan utama untuk REUSE/adapt (multi-tenant QRIS gateway). |
| `/root/BOT2` | NIKISTORE Bot — client pertama. |
| `/root/QrisMerchantID` | Python SDK wrapping GoPay+ShopeePay — acuan port ShopeePay (Fase 2). |

---

## 2. Arsitektur inti

### 2.1 Provider abstraction (satu kontrak bersama)

Kedua provider implement satu interface sehingga `matching`/`payments`/`routes` **tidak pernah
branch pada provider**:

```js
// providers/base.js (kontrak terdokumentasi)
interface Provider {
  name: 'gopay' | 'shopeepay'
  getActiveSession(): Promise<Session | null>   // auto-refresh dekat expiry; null jika mati
  fetchRecentMutasi({ startTimeMs }): Promise<NormalizedTx[]>
  staticQris(): string | null                    // QR statis operator untuk provider ini
  requestOtp(phone?): Promise<{otpToken, deviceId}>
  verifyOtp(challenge): Promise<Session>
  refresh(session?): Promise<Session | null>
  summary(): Promise<{status, merchant_id, ...}>
}

NormalizedTx = {
  txId: string,
  amount_idr: number,       // INT rupiah penuh (dinormalisasi per provider)
  create_time_ms: number,
  completed: boolean,
  raw: object
}
```

**Normalisasi uang = permukaan bug #1.** GoPay mutasi = **minor unit (sen)**:
`gross_amount: 10600000` = Rp 106.000 (÷100). ShopeePay = **string rupiah dikelompokkan**:
`"409.662"` = Rp 409.662. Tiap provider punya `normalize.js` sendiri yang output `amount_idr`
(int rupiah); matcher lalu lakukan **`amount_idr === invoice.total_amount` eksak**. Ini lebih
bersih daripada logika fuzzy `*100 / /100` nikipayv2 (yang ada justru karena normalisasi tidak
diisolasi) — kita isolasi per provider.

### 2.2 Pooled amount-only matching + kode unik global (21–200)

Karena semua buyer membayar QR operator yang sama, satu-satunya cara mengatribusi pembayaran
ke invoice adalah **amount**. Maka **tidak boleh ada dua invoice PENDING dengan `total_amount`
sama**. Strategi alokasi (`invoices.allocateUniqueCode`):

- Saat buat invoice: ambil set `total_amount` PENDING untuk base amount itu, + invoice
  EXPIRED dalam grace window (anti orphan-collision), lalu pilih kode unik acak di 21–200 di
  mana `base + code` belum dipakai. Retry acak ±180×, lalu fallback linear scan.
- **Acak** (bukan sekuensial) menghindari pola prediktif yang bisa disalahgunakan.
- 180 slot cukup untuk skala kecil-menengah; slot bebas saat invoice expire (5 menit) atau settle.
- Jika habis → `503 UNIQUE_CODE_EXHAUSTED` (jarang; hanya saat >~150 invoice konkuren share
  base amount sama).

**Orphan payment** (buyer bayar setelah invoice expire): **grace window** (default 10 menit
post-expiry) — matcher masih scan invoice yang baru expire untuk provider itu dan, kalau cocok,
kredit ledger user + log `INFO` "late settle". Setelah grace window tanpa match, baris mutasi
dimasukkan ke `unmatched_payments` untuk **rekonsiliasi manual admin** (TIDAK auto-kredit uang
tak dikenal). Ini default pooled-model paling aman.

### 2.3 Session provider & dead-account handling

- **GoPay**: `refresh_token` bekerja (diselesaikan di `nikipayv2/gobiz.refreshToken`, reuse).
  Saat HTTP 401 saat fetch → refresh → retry sekali (port cabang 401 `payments.verifyPayment`
  ke `fetchRecentMutasi` provider).
- **ShopeePay (Fase 2, B1 dulu)**: token manual `B:` TIDAK punya auto-refresh. Rotasi =
  re-paste. Envelope code token-mati `200020`/`2010000` → `provider_accounts.status='expired'`.
- **Policy degrade**: jika provider yang diminta mati → **`503 PROVIDER_UNAVAILABLE`**
  (TIDAK auto-fallback ke provider lain — itu diam-diam mengubah semantik settlement H+0↔H+1).
  Dashboard admin menampilkan health provider; admin re-auth.

### 2.4 Ledger — running balance + row lock (race-safe)

`SUM(ledger_entries)` derivatif benar tapi race under settle+withdraw konkuren. Pakai
**kolom running `user_balances` + `SELECT … FOR UPDATE`** dalam `db.tx` (primitif tx existing
memberi koneksi + begin/commit/rollback):

- `user_balances(user_id PK, balance INT, held INT, updated_at)` — `available = balance - held`.
- **Settle** (credit): `tx → FOR UPDATE balance → balance += amount → insert ledger_entries(type='credit', balance_after)`.
- **Withdraw request** (hold): `tx → FOR UPDATE → assert available >= amount → held += amount → insert ledger_entries(type='debit_hold') + withdrawals(status='requested')`.
- **Withdraw processed** admin: tak ubah balance (sudah held) → `withdrawals.status='processed'`.
- **Withdraw rejected**: `tx → held -= amount → insert credit_back → withdrawals.status='rejected'`.
- **Idempotent** by `ref_type`+`ref_id` (credit skip kalau sudah ada entry dengan ref sama).

Race-safe dan O(1) untuk baca balance.

### 2.5 Matching trigger — hybrid (lazy + background poller)

- **Lazy**: `GET /qris/:id/status` trigger fetch+match langsung untuk provider invoice itu
  (instan untuk client polling) — persis pola `checkStatus` nikipayv2.
- **Background poller** (baru, esensial untuk pooled gateway nyata): per provider, tiap ~10 d,
  **hanya saat ≥1 pending invoice untuk provider itu**, fetch SATU window mutasi (lookback 15
  menit) dan match terhadap **semua** pending invoice provider itu dalam satu pass. Saat 0
  pending → poller idle (zero traffic). Ini (a) settle pembayaran walau client berhenti polling,
  webhook reliably tembak, dan (b) jauh lebih efisien daripada fetch per-invoice nikipayv2 (satu
  fetch layani semua pending — win besar pooled-model).

### 2.6 Idempotency — claim table PK `(provider, tx_id)`

nikipayv2 PK claim = `(user_id, tx_id)`. Di pooled model, satu provider account layani semua
user, maka PK claim HARUS **`(provider, tx_id)`** supaya mutasi yang sama tidak settle dua
invoice. Match insert/update claim atomik dalam tx settle. **Ini perubahan correctness pooled
paling penting vs referensi.**

### 2.7 markPaid diskriminator by kind

`kind='subscription'` → `subscriptions.settleOrder` (reuse); `kind='api'|'test'` →
`ledger.credit` (base_amount; kode unik tetap sebagai fee margin operator).

---

## 3. Struktur folder (Fase 1: GoPay; seam ShopeePay bersih)

```
gateway/
├── app.js                      # Passenger entry: require('./src/server.js').main()
├── package.json                # express, mysql2, axios, cookie-parser, dotenv; node>=20
├── .env.example                # semua env var (lihat §7)
├── project.md                  # DOKUMEN INI
├── src/
│   ├── server.js               # main(): validate + db.ping + migrate + ensureAdmin + bg jobs + poller.start
│   ├── app.js                  # express setup, pages, mount routes
│   ├── config.js               # config object + validate() (SESSION_SECRET>=32, PROVIDER_MASTER_KEY==64 hex)
│   ├── db.js                   # pool + query/one/tx + SCHEMA[] + migrate() + seed plans + seed provider_accounts
│   ├── providers/
│   │   ├── index.js            # registry: getProvider(name)→singleton, listProviders(), isImplemented(name)
│   │   ├── base.js             # Provider interface doc + BaseProvider
│   │   ├── gopay/
│   │   │   ├── client.js       # ported gobiz.js verbatim (requestOtp, verifyOtp, refreshToken, fetchTransactions, parsePhone, GoBizError, URLS, UA)
│   │   │   ├── normalize.js     # txAmountMinor, minorToRupiah (÷100), normalizeTx→NormalizedTx, normalizeBatch
│   │   │   └── index.js        # GoPayProvider implements Provider (401-refresh-retry)
│   │   └── shopeepay/
│   │       └── index.js        # STUB, notImplemented=true, throws NOT_IMPLEMENTED (Fase 2)
│   ├── services/
│   │   ├── users.js            # register/login/hashPassword(scrypt)/signToken(HS256)/verifyToken/ensureAdminFromEnv/findById/changePassword
│   │   ├── apikeys.js          # prefix qp_, sha256 hash, resolve→{subscription_active,...}
│   │   ├── subscriptions.js    # plans CRUD (+providers/tier), allowedProviders, grant, createOrder, settleOrder, listOrders, getBillingAdmin
│   │   ├── invoices.js         # createInvoice (+allocateUniqueCode global), getRecord, setStatus, publicView, listForUser, listPendingForProvider, countPendingForProvider, stats, expireStale, isValidStaticQris
│   │   ├── matching.js         # tryClaim (provider,tx_id idempotent), matchMutations (exact amount_idr===total_amount, time gate, grace), recordUnmatched, cleanOldClaims
│   │   ├── payments.js         # settle (markPaid + kind-discriminated side effects + webhook/callback), manualMarkPaid, verifyInvoicePayment (lazy), toTransaction
│   │   ├── qris.js             # checkStatus (PAID→return, EXPIRED→return+grace, else verifyInvoicePayment)
│   │   ├── ledger.js           # getBalance, credit, hold, releaseHold, settleDebit, listEntries (semua FOR UPDATE)
│   │   ├── withdrawals.js      # request (hold), listForUser/listAll, process (settleDebit), reject (releaseHold), cancel
│   │   ├── providerAccounts.js # operator-level session store: loadSession/saveSession/markExpired/deleteSession/getActiveSession/sessionSummary/setStaticQris/getStaticQris/refreshAllExpiring + cache Map
│   │   ├── webhooks.js         # HMAC-SHA256, User-Agent QRISPay-Webhook/1.0, dispatchWebhookEvent
│   │   └── logs.js             # logActivity, listLogs, pruneLogs
│   ├── poller/
│   │   └── index.js            # per-provider tick (idle-when-empty, one fetch→match all pending→record unmatched), start/stop/startProvider
│   ├── routes/
│   │   ├── api.js              # POST /api/v1/qris (+provider+tier gating), /me, /balance, /withdraw, /withdrawals, /transactions, /ledger, /webhooks, /qris/:id/status (public), /qris/:id (public), /qr/:id, /healthz
│   │   ├── user.js             # /app/api: auth register/login/logout, /overview, /balance, /ledger, /withdraw, /withdrawals, /keys, /plans, /subscription, /qris (test), /webhooks, /logs
│   │   └── admin.js            # /admin/api: /overview, /users, /users/:id, /plans, /providers, /providers/:name/static-qris, /providers/:name/otp, /providers/:name/verify, /orders, /qris, /withdrawals (process/reject), /unmatched (resolve), /logs
│   ├── middlewares/auth.js     # cookie qrispay_session (HS256), attachUser/requireUser/requireAdmin/requireApiKey (+allowed_providers) + rate limit
│   └── utils/
│       ├── crypto.js           # AES-256-GCM encryptPayload/decryptPayload (env PROVIDER_MASTER_KEY 64-hex, key file qrispay.key, format iv:authTag:ciphertext)
│       ├── qris.js             # parseEMVCoTags, generateDynamicQRIS (tag 01→12, inject tag 54, append CRC)
│       ├── crc16.js            # calculateCRC16 (EMVCo CRC16-CCITT)
│       ├── logger.js          # logger (file + stdout/stderr)
│       └── retry.js           # withRetry (transport/5xx only)
├── public/                     # index.html (login/register), app.html (dashboard user), admin.html (dashboard admin), docs.html (API docs), qris.html + qris.js + qris.css (payment page), assets/app.css + assets/common.js
├── scripts/                    # gen-secrets.js, migrate.js, create-admin.js
└── tests/                      # gopay/normalize.test.js (sen→rupiah), matching.test.js (QRIS injection)
```

**Seam**: `services/matching.js`, `payments.js`, `routes/api.js` hanya konsumsi
`NormalizedTx[]` + `getProvider(name)`. Fase 2 tambah `providers/shopeepay/*` (port dari
`QrisMerchantID`) dan register — **tidak ada yang lain berubah**.

---

## 4. Skema database (`src/db.js` SCHEMA[])

Semua tabel InnoDB, utf8mb4. Migrate idempoten (`CREATE TABLE IF NOT EXISTS`).

| Tabel | Tujuan | Catatan pooled |
|---|---|---|
| `users` | Akun user/admin | id INT AI, email UNIQUE, role ENUM('user','admin'), status ENUM('active','blocked') |
| `provider_accounts` | **Operator-level** (1 baris per provider) | name VARCHAR(24) PK, token_encrypted TEXT, cookies_json MEDIUMTEXT, merchant_id, store_id, qris_static TEXT, phone, outlet_name, expires_at, status ENUM('active','expired','unconfigured'). **Menggantikan gobiz_sessions + merchant_settings nikipayv2.** |
| `plans` | Paket langganan | +providers JSON, +tier ENUM('H0','H1'), +sort_order, code UNIQUE, duration_days, price |
| `subscriptions` | Grant langganan | user_id FK, plan_id, starts_at, ends_at, source ENUM('payment','manual'), note. INDEX(user_id, ends_at) |
| `subscription_orders` | Order langganan (dibayar via QRIS operator) | id VARCHAR(24) PK, user_id, plan_id, amount, qris_id, status ENUM('PENDING','PAID','EXPIRED','CANCELLED'), paid_at |
| `api_keys` | API key client | key_hash CHAR(64) UNIQUE, key_prefix, label, active, last_used_at |
| `invoices` | Invoice QRIS | id VARCHAR(16) PK, user_id, provider, trx_id, **base_amount, unique_code, total_amount** (=base+code), data (QRIS string), reference, attributes, callback_url, kind ENUM('api','subscription','test'), status ENUM('PENDING','PAID','EXPIRED'), transaction_json, created_at DATETIME(3), expires_at DATETIME(3), paid_at. INDEX(provider,status,expires_at), INDEX(status,total_amount), INDEX(reference) |
| `claimed_transactions` | **Idempotensi PK (provider, tx_id)** | provider, tx_id, qris_id, claimed_at BIGINT. **PK pooled correctness.** |
| `user_balances` | Running balance | user_id PK FK, balance INT, held INT, updated_at. **Race-safe via FOR UPDATE.** |
| `ledger_entries` | Audit trail | user_id, type ENUM('credit','debit_hold','debit_settled','credit_back'), amount, ref_type, ref_id, balance_after, created_at DATETIME(3) |
| `withdrawals` | Request withdraw | id VARCHAR(20) PK, user_id, amount, bank_detail JSON, status ENUM('requested','processed','rejected','cancelled'), note, processed_at |
| `unmatched_payments` | Mutasi tanpa match → admin reconcile | id AI, provider, tx_id, amount_idr, create_time, raw_json, status ENUM('pending','resolved'), resolved_to_qris_id. UNIQUE(provider, tx_id) |
| `webhooks` | Webhook per tenant | id VARCHAR(20) PK, user_id, url, secret, events |
| `activity_logs` | Log aktivitas | user_id NULL, timestamp DATETIME(3), type, message |
| `app_settings` | KV settings | `key` PK, value. (menyimpan `billing_admin_user_id`) |

**Default plans** (di-seed kalau kosong):
- `free` — Gratis (H+1), 0 hari, Rp 0, tier H1, providers `["shopeepay"]`.
- `h0-monthly` — Bulanan H+0, 30 hari, Rp 30.000, tier H0, providers `["gopay","shopeepay"]`.

**Provider accounts** di-seed: baris `gopay` (display "GoPay / GoBiz") dan `shopeepay`
("ShopeePay") dengan status `unconfigured` — admin tinggal configure via dashboard.

---

## 5. Invariants keamanan (yang HARUS tetap benar)

Ini properti yang tidak boleh dilanggar oleh perubahan kode apa pun. Saat debug/edit,
verifikasi ini tetap dipenuhi:

1. **Idempotensi claim**: satu mutasi provider tidak boleh settle lebih dari satu invoice.
   Enforced by `claimed_transactions` PK `(provider, tx_id)`. **Jangan pernah kembalikan ke
   `(user_id, tx_id)`** — itu benar untuk multi-tenant tapi SALAH untuk pooled.
2. **Kekhasan total_amount PENDING**: tidak ada dua invoice PENDING dengan `total_amount`
   sama. `allocateUniqueCode` cek PENDING + grace-expired. Jika diganti alokasi, pertahankan
   invariant ini.
3. **Normalisasi terisolasi**: matcher ONLY bandingkan `amount_idr` (int rupiah) ===
   `total_amount`. GoPay ÷100 di `normalize.js`; ShopeePay whole-rupiah. Jangan pernah
   introduce fuzzy `*100//100` di matcher.
4. **No auto-fallback provider**: provider mati → 503, BUKAN switch ke provider lain.
   Memelihara semantik H+0/H+1.
5. **No auto-credit uang tak dikenal**: mutasi tanpa match → `unmatched_payments`, admin
   resolve manual. Jangan auto-kredit.
6. **Ledger race-safe**: semua mutasi balance via `db.tx` + `FOR UPDATE`. Jangan baca-tulis
   balance di luar tx.
7. **Diskriminator kind**: `subscription` → settleOrder; `api`/`test` → ledger.credit(base_amount).
   Kode unik = fee margin operator (tidak dikredit ke user).
8. **Tier gating**: free user `provider=gopay` → 403 PROVIDER_NOT_PERMITTED. `allowedProviders`
   free = `['shopeepay']`, admin = both, subscriber = plan.providers.
9. **Secrets**: PROVIDER_MASTER_KEY 64-hex (AES-256-GCM); SESSION_SECRET ≥32 char.
   `validate()` lempar kalau tidak.
10. **Grace window orphan**: invoice EXPIRED masih dicocok dalam grace (default 10 menit)
    untuk late payment; setelah itu → unmatched.

---

## 6. Kontrak API (Fase 1)

Envelope mana-mana: `{success, code, message}` atau `{success, data}`.

### Public API (header `x-api-key`)
```
POST   /api/v1/qris                 x-api-key  {amount, provider?, reference?, attributes?, callback_url?}
                                               → 201 {qris_id, qris_code, qr_url, amount, expires_at}
                                               → 403 PROVIDER_NOT_PERMITTED (tier)
                                               → 503 PROVIDER_UNAVAILABLE (mati/tidak terhubung)
                                               → 503 UNIQUE_CODE_EXHAUSTED
GET    /api/v1/qris/:id/status      public     → {paid, status: PENDING|PAID|EXPIRED, transaction?}
                                               → 410 jika EXPIRED
GET    /api/v1/qris/:id             public     detail + QR image
GET    /qr/:id                      public     halaman bayar (qris.html); ?format=raw, ?download=1
GET    /api/v1/me                   x-api-key  subscription + allowed_providers + balance
GET    /api/v1/balance              x-api-key  {balance, held, available}
POST   /api/v1/withdraw             x-api-key  {amount, bank_detail:{bank_name,account_number,account_name}}
GET    /api/v1/withdrawals          x-api-key
POST   /api/v1/withdrawals/:id/cancel  x-api-key
GET    /api/v1/transactions         x-api-key
GET    /api/v1/ledger               x-api-key  audit trail
GET|POST|DELETE /api/v1/webhooks    x-api-key  HMAC-SHA256 (X-Webhook-Signature: sha256=...)
GET    /api/v1/healthz              public     {status:"healthy", service:"qrispay", time}
```

**`provider` omitted** → auto-pick by tier (implemented pertama). Forced provider on
disallowed tier → `403 PROVIDER_NOT_PERMITTED`. Dead/unconfigured → `503 PROVIDER_UNAVAILABLE`.

### Dashboard user (`/app/api`, cookie session)
```
POST   /app/api/auth/register       {email,password,name}   (REGISTRATION_OPEN)
POST   /app/api/auth/login
POST   /app/api/auth/logout
GET    /app/api/me
GET    /app/api/overview            user, subscription, allowed_providers, stats, api_keys, balance, providers
GET    /app/api/balance
GET    /app/api/ledger
POST   /app/api/withdraw
GET    /app/api/withdrawals
POST   /app/api/withdrawals/:id/cancel
GET|POST|DELETE /app/api/keys
GET    /app/api/plans
GET    /app/api/subscription
POST   /app/api/subscription/orders  {plan_id}
GET    /app/api/subscription/orders/:id
POST   /app/api/qris                 {amount, provider, reference} (kind='test')
GET    /app/api/qris
GET    /app/api/qris/:id/status
POST   /app/api/qris/:id/mark-paid
GET|POST|DELETE /app/api/webhooks
GET    /app/api/logs
```

### Dashboard admin (`/admin/api`, cookie admin)
```
GET    /admin/api/overview           counts, stats, revenue_30d, recent_orders, providers, pending_withdrawals
GET    /admin/api/users             ?q=search
GET    /admin/api/users/:id         user, subscription, history, orders, api_keys, recent_invoices, balance, ledger, logs
POST   /admin/api/users/:id/status   {status:'blocked'|'active'}
POST   /admin/api/users/:id/subscription  {days, note}
POST   /admin/api/users/:id/password {password}
DELETE /admin/api/users/:id
GET    /admin/api/plans
POST   /admin/api/plans             upsertPlan
PUT    /admin/api/plans/:id
GET    /admin/api/providers
PUT    /admin/api/providers/:name/static-qris  {qris_static}
POST   /admin/api/providers/:name/otp          {phone}
POST   /admin/api/providers/:name/verify       {phone, otp_token, otp, device_id}
DELETE /admin/api/providers/:name               cabut session
GET    /admin/api/orders
POST   /admin/api/orders/:id/settle
GET    /admin/api/qris
POST   /admin/api/qris/:id/mark-paid
GET    /admin/api/withdrawals       ?status=
POST   /admin/api/withdrawals/:id/process
POST   /admin/api/withdrawals/:id/reject  {reason}
GET    /admin/api/unmatched
POST   /admin/api/unmatched/:id/resolve   {qris_id|null}
GET    /admin/api/logs
```

### Webhook
Event `payment.success` dikirim ke URL dengan signature
`X-Webhook-Signature: sha256=...` (HMAC-SHA256 dari body). User-Agent `QRISPay-Webhook/1.0`.
Verifikasi sisi client:
```js
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-webhook-signature']));
```

---

## 7. Environment variables (`.env.example`)

| Var | Default | Wajib | Keterangan |
|---|---|---|---|
| `NODE_ENV` | development | – | production → cookie secure |
| `PORT` | 3000 | – | |
| `PUBLIC_GATEWAY_URL` | (kosong) | ya | base URL untuk QR/webhook |
| `APP_NAME` | QRISPay | – | |
| `DB_HOST` | 127.0.0.1 | ya | |
| `DB_PORT` | 3306 | – | |
| `DB_USER` | root | ya | |
| `DB_PASS` | (kosong) | ya | |
| `DB_NAME` | qrispay | ya | |
| `DB_SOCKET` | (kosong) | – | untuk cPanel cloudmysql socket |
| `SESSION_SECRET` | – | ya (≥32) | HS256 cookie. `gen-secrets.js` |
| `PROVIDER_MASTER_KEY` | – | ya (64 hex) | AES-256-GCM provider tokens. `gen-secrets.js` |
| `ADMIN_EMAIL` | – | ya | boot: buat admin pertama |
| `ADMIN_PASSWORD` | – | ya | (≥8 char) |
| `UNIQUE_CODE_MIN` | 21 | – | |
| `UNIQUE_CODE_MAX` | 200 | – | 180 slot |
| `QRIS_EXPIRY_MS` | 300000 (5m) | – | invoice API expiry |
| `SUBSCRIPTION_QRIS_EXPIRY_MS` | 900000 (15m) | – | invoice langganan expiry |
| `REGISTRATION_OPEN` | true | – | false = tutup register |
| `RATE_LIMIT_PER_MINUTE` | 60 | – | per API key |
| `POLLER_INTERVAL_MS` | 10000 | – | background poller |
| `MUTASI_LOOKBACK_MINUTES` | 15 | – | window fetch mutasi |
| `UNMATCHED_GRACE_MINUTES` | 10 | – | grace orphan |

### Keamanan (konvensi referensi QrisMerchantID)
- Jangan commit `.env`, `*.har`, atau file cache token/OTP.
- Capture device-risk blob dari browser operator sendiri (Fase 2 ShopeePay) — tidak pakai
  shared blob.
- `qrispay.key` (file key AES) jangan commit.

---

## 8. Setup & verifikasi end-to-end

```bash
cd /root/gateway
cp .env.example .env
node scripts/gen-secrets.js          # isi SESSION_SECRET + PROVIDER_MASTER_KEY; isi DB_*, ADMIN_*
npm install
npm test                             # gopay/normalize + matching (pure, offline)
npm start                            # expect "[Startup] DB ready" + admin created + poller idle
# atau: npm run migrate && npm run create-admin
```

### Verifikasi fungsional
1. **Admin flow**: login `/admin` → paste operator GoBiz static QR ke `provider_accounts`
   → OTP-login GoBiz (`/providers/gopay/otp` + `/verify`) → provider health `active`.
2. **Client flow**: register user → admin grant plan (atau user beli via QRIS,
   `kind=subscription` → `settleOrder`) → buat API key → `POST /api/v1/qris {amount:10000,
   provider:gopay}` → dapat `qris_code`; **scan & bayar** QR dengan GoPay asli → poll
   `GET /qris/:id/status` → `PAID`; konfirmasi `GET /api/v1/balance` tercredit sebesar
   `base_amount` (kode unik tetap = fee operator) + webhook terkirim (HMAC valid).
3. **Tier gating**: free user `POST /qris {provider:gopay}` → `403 PROVIDER_NOT_PERMITTED`;
   `provider:shopeepay` (Fase 2) atau omitted → bekerja.
4. **Withdraw**: `POST /api/v1/withdraw {amount}` → balance `held`; admin
   `/admin/api/withdrawals/:id/process` → `balance` turun, `held` bersih.
5. **Idempotensi/collision**: `npm test` — normalize, matching-claim, ledger suites hijau.
6. **Poller etiquette**: tanpa pending invoice, konfirmasi zero GoBiz fetch traffic (log);
   buat invoice → konfirmasi ~10s fetch cadence; settle → cadence idle lagi.

---

## 9. Bug ditemukan & diperbaiki selama audit (catatan penting)

> Audit read-only seluruh codebase dilakukan sebelum verifikasi runtime. Dua bug ditemukan
> dan **sudah diperbaiki**. Catat di sini agar tidak kambuh / untuk referensi debugging.
> **Verifikasi runtime (§9.1) lalu menemukan 3 bug tambahan, juga sudah diperbaiki.**

### Bug 1 — `src/services/invoices.js` INSERT placeholder mismatch (FIXED)
- **Gejala**: setiap pembuatan invoice (API, test, langganan) akan throw — MySQL reject.
- **Sebab**: `INSERT INTO invoices (...15 kolom...) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  punya **14 placeholder** untuk **15 kolom & 15 nilai**.
- **Fix**: tambah satu placeholder → 15: `VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`.
- **Status**: ✅ fixed (line ~118).

### Bug 2 — `src/services/subscriptions.js` `createOrder` kolom amount salah nilai (FIXED)
- **Gejala**: saat user beli langganan berbayar, `INSERT INTO subscription_orders` throw
  (kolom `amount` INT diisi string) atau data rusak.
- **Sebab**: `INSERT INTO subscription_orders (id, user_id, plan_id, amount, qris_id) VALUES
  (?,?,?,?,?)` diisi `[orderId, userId, plan.id, invoice.qris_id, invoice.qris_id]` —
  kolom ke-4 `amount` (INT) keisi `invoice.qris_id` (string ID seperti "abc123"), bukan
  `invoice.total_amount`.
- **Fix**: nilai ke-4 → `invoice.total_amount` (int rupiah): `[orderId, userId, plan.id,
  invoice.total_amount, invoice.qris_id]`.
- **Status**: ✅ fixed (line ~116).

### Catatan audit lainnya (bersih, tidak perlu fix)
- `withdrawals.js` INSERT (6/6/6), `ledger.js` (credit/hold/releaseHold/settleDebit 6/6/6),
  `matching.js` (claimed 4/4, unmatched 5/5), `providerAccounts.saveSession` (8/8),
  `apikeys.js`, `users.js`, `db.js` migrate seed — semua placeholder benar.
- Kontrak frontend↔backend selaras: `checkStatus` return `paid`+`status`; `getBalance` return
  `balance/held/available`; `allowedProviders` free=shopeepay/admin=both; `resolve` return
  `subscription_active`.
- `app.js` routing cocok dengan `app.html`/`admin.html`/`qris.html`/`docs.html`.

### 9.1 Bug ditemukan saat verifikasi runtime (FIXED)

Verifikasi runtime penuh dijalankan (install → unit test → migrate → boot → integration test
end-to-end dengan mock GoBiz server). **3 bug baru ditemukan & diperbaiki:**

#### Bug 3 — `src/db.js` seed plans placeholder mismatch (FIXED, menggagalkan migrate)
- **Gejala**: `npm run migrate` (atau boot pertama kali) **selalu gagal** dengan
  `Column count doesn't match value count at row 1`. **Setiap fresh install gagal** — bug paling
  kritis dari semua: aplikasi tidak bisa dipasang baru sama sekali.
- **Sebab**: `INSERT INTO plans (code, name, duration_days, price, tier, providers, active,
  sort_order) VALUES (?,?,?,?,?,?,?,1,?)` — 8 kolom, tapi VALUES punya **9 elemen**
  (8 placeholder + literal `1`), dan params array hanya 7 elemen. Posisi literal `1` juga salah
  (di kolom `providers`, bukan `active`).
- **Fix**: `VALUES (?,?,?,?,?,?,1,?)` — literal `1` di posisi `active` (kolom ke-7), 8 placeholder,
  7 params.
- **Status**: ✅ fixed.

#### Bug 4 — grant langganan admin tidak teruskan `plan_id` → provider list kosong (FIXED)
- **Gejala**: admin beri langganan manual via dashboard → user jadi "aktif" tetapi
  `allowed_providers` **kosong** (`[]`). Akibatnya user langganan **tidak bisa buat QRIS dengan
  provider manapun** — selalu `403 PROVIDER_NOT_PERMITTED`. Bug diam-diam: status langganan
  terlihat aktif, tapi provider gating memblok semua.
- **Sebab**: `routes/admin.js POST /users/:id/subscription` **tidak meneruskan `plan_id`** ke
  `subs.grant()`; UI `admin.html` juga tidak punya field untuk memilih paket. Padahal
  `allowedProviders` membaca `plan.providers` dari join `subscriptions → plans`. Tanpa plan_id,
  `plan_id` NULL → `providers` NULL → `parseProviders(null)` = `[]`.
- **Fix**: route teruskan `plan_id` (optional, default null); `admin.html` form "Beri Langganan
  Manual" sekarang punya **dropdown paket** (diisi dinamis dari `GET /admin/api/plans`) dan
  mengirim `plan_id`.
- **Catatan**: `POST /users/:id/subscription` tanpa `plan_id` masih legal (kompatibel), hanya
  saja providers = free-tier default.
- **Status**: ✅ fixed (backend + UI).

#### Bug 5 — `npm test` glob tidak rekursif (FIXED)
- **Gejala**: `npm test` hanya menjalankan 1 dari 2 file test (`tests/matching.test.js` tidak
  pernah dijalankan). Silent failure — test terlihat hijau tapi cakupannya separuh.
- **Sebab**: `scripts.test` = `node --test tests/**/*.test.js`. Bash dengan `globstar` **off**
  (default) memperluas `**` seperti `*` → hanya `tests/gopay/normalize.test.js` yang cocok;
  `tests/matching.test.js` di root `tests/` tidak terambil.
- **Fix**: quote glob: `node --test "tests/**/*.test.js"` — Node's `--test` melakukan glob-nya
  sendiri secara rekursif saat di-quote.
- **Status**: ✅ fixed; `npm test` sekarang menjalankan **11 test** (normalize 7 + matching 4).

#### Hasil verifikasi runtime (lengkap, §8 + §16)
- `node --version` v24, deps 5/5 terinstall (express, mysql2, axios, cookie-parser, dotenv).
- **Syntax check 40 file JS**: 0 error (parse-only via `new Function`).
- **Config validation**: reject ketika `SESSION_SECRET` <32 / `PROVIDER_MASTER_KEY` bukan 64-hex;
  accept saat valid. `scripts/gen-secrets.js` output benar.
- **MariaDB 10.x** (pengganti MySQL di environment test): `npm run migrate` → **14 tabel** InnoDB
  terbuat + seed plans (`free` H1 shopeepay, `h0-monthly` H0 gopay+shopeepay) + 2 baris
  `provider_accounts` (status `unconfigured`).
- **Boot**: `[Startup] DB ready` + admin dari env dibuat + poller gopay & shopeepay start +
  `QRISPay running on port 3111`. `GET /api/v1/healthz` → `{"status":"healthy"}`.
- **`npm test`**: 11/11 pass (normalize sen→rupiah 7, QRIS injection/CRC 4).
- **`npm run test:integration`** (script baru `scripts/integration-test.js`, §16): **28/28 pass** —
  spawn app instance + mock GoBiz server, lalu lewati seluruh pipeline asli:
  admin login → set static QRIS → provider session aktif → register user (201) → tier gate
  `SUBSCRIPTION_REQUIRED` → grant plan H0 → API key `qp_` → `POST /api/v1/qris` 201 →
  **QRIS dinamis valid** (tag 01→12, tag 54=total, CRC) → **matching amount eksak → PAID** →
  **ledger kredit base_amount** → **idempotensi claim (provider,tx_id)** → alokasi kode unik
  berbeda untuk base sama → **orphan → unmatched_payments** (no auto-credit) → withdraw hold →
  `INSUFFICIENT_BALANCE` → admin process → balance 6000/held 0 → audit trail
  credit+debit_hold+debit_settled.
- **Environment**: Termux/Android (Node 24, MariaDB port 3306, socket `$PREFIX/var/run/mysqld/`).
  Aplikasi sendiri cPanel-ready (tidak ada perubahan untuk environment ini; `.env` test dipakai
  hanya untuk verifikasi).

#### Tambahan setelah fresh-install test (dari database benar-benar kosong)
- **Auto-create database** ditambahkan ke `db.migrate()`: `CREATE DATABASE IF NOT EXISTS` lewat
  koneksi throwaway **tanpa default database** (pool utama tidak bisa connect saat DB default
  belum ada — `ER_BAD_DB_ERROR` di handshake). Gagal (mis. di cPanel user tak punya hak CREATE)
  hanya di-warning, lalu `CREATE TABLE` yang menampilkan error sebenarnya. Sekarang
  `DB_NAME=qrispay_baru npm run migrate` langsung bekerja dari nol.
- **Fresh-install verified**: database baru → 15 tabel + seed plans + 2 provider_accounts →
  `npm run test:integration` **28/28 pass** tanpa data residual.
- `.env.example` disarankan tetap menyebut bahwa di cPanel DB dibuat manual dulu (ALL PRIVILEGES),
  auto-create hanya kenyamanan lokal/dev.
- **Tutorial deploy** ditulis di `docs/TUTORIAL-DEPLOY.md` (10 langkah: upload → MySQL →
  `.env` via `gen-secrets.js` → migrate → Setup Node.js App → healthz → admin → provider →
  log/troubleshooting table). Semua path/perintah di tutorial sudah diverifikasi terhadap repo.

#### Production-readiness (verifikasi kode app)
- `app.set('trust proxy', true)` + `disable('x-powered-by')` — benar untuk HTTPS lewat
  proxy cPanel/Cloudflare.
- Graceful shutdown `SIGTERM`/`SIGINT`: poller stop → server close → db close → exit.
  Passenger restart tidak menyebabkan koneksi menggantung.
- Semua background job `setInterval(...).unref()` (expire invoice, clean claims, prune logs,
  refresh token 6 jam, poller) — tidak menahan proses.
- 0 native module di dependency tree → shared-hosting safe; tidak ada build step.

---

## 10. Reused verbatim dari nikipayv2 (tidak ditulis ulang)

| File | Reuse |
|---|---|
| `src/utils/crypto.js` | AES-256-GCM `encryptPayload`/`decryptPayload` (env `PROVIDER_MASTER_KEY`) — encrypt provider token operator. |
| `src/utils/qris.js` | `generateDynamicQRIS(static, amount)`, `parseEMVCoTags` — EMVCo-standard, **provider-agnostic**. |
| `src/utils/crc16.js` | `calculateCRC16`. |
| `src/utils/logger.js` | `logger` + format. |
| `src/utils/retry.js` | `withRetry`. |
| `src/services/webhooks.js` | HMAC-SHA256 sign/verify/dispatch (event `payment.success`). |
| `src/middlewares/auth.js` | cookie `qrispay_session` (HS256), `requireUser`/`requireAdmin`/`requireApiKey` + rate-limit (+allowed_providers). |
| `src/services/apikeys.js` | prefix `qp_`, sha256, `resolve`. |
| `src/services/users.js` | register/login/scrypt/signToken/verifyToken/ensureAdminFromEnv. |
| `src/services/subscriptions.js` | plans CRUD, grant, createOrder/settleOrder (FOR UPDATE). |
| `src/providers/gopay/client.js` | requestOtp/verifyOtp/refreshToken/fetchTransactions/parsePhone/GoBizError (from `gobiz.js`). |

---

## 11. Delta vs nikipayv2 (apa yang berubah)

- `merchant_settings` (static QR per-user) → **dihapus**. Static QR operator-owned di
  `provider_accounts.qris_static`. Admin paste.
- `gobiz_sessions` (per-user) → **`provider_accounts`** (operator-level, 1 baris/provider).
- **Kode unik di SETIAP invoice** (bukan cuma order langganan): `total_amount = base_amount
  + unique_code`. `createInvoice` alokasi global-unique.
- `claimed_transactions` PK → **`(provider, tx_id)`**.
- **Tabel baru**: `user_balances`, `ledger_entries`, `withdrawals`, `unmatched_payments`.
- **Service baru**: `ledger.js`, `withdrawals.js`, `matching.js` (provider-agnostic),
  `providerAccounts.js`, `poller/index.js`.
- `plans` +`providers` JSON +`tier` ENUM('H0','H1'). `requireApiKey` resolve plan aktif →
  allowed providers.
- `markPaid` diskriminator `kind`.
- **Background poller** baru (idle-when-empty, satu fetch layani semua pending).

---

## 12. Fase 2 — Port ShopeePay (setelah Fase 1 ship)

Port dari `/root/QrisMerchantID/src/qrismerchantid/shopee/` (Python → JS):

- `constants.py` → `providers/shopeepay/constants.js` — endpoints, `INVALID_TOKEN_CODES`
  (200020/2010000), `COMPLETED_STATUS=3`, `parse_id_amount`.
- `client.py` (`post_payment`, envelope `{code,msg,data}`) → `providers/shopeepay/client.js`.
- `transactions.py` (`list_recent`, `next_position` cursor, page cap 10) + `stores.py` →
  `transactions.js`/`stores.js`.
- `auth.py` (925 baris: OTP B2 7-call chain + `refresh_session` + `select_merchant`) →
  `providers/shopeepay/auth.js` (bagian terberat). Butuh **device-risk blob** dari browser
  operator sendiri — tanpa itu OTP silently suppressed. **Plan B**: ship **B1 manual token**
  dulu, B2 OTP login kedua setelah stabilitas blob terkarakterisasi.
- `watcher.py` → lipat shape `seed/poll/wait` ke `fetchRecentMutasi` provider + shared
  `matching.js` (ShopeePay whole-rupiah, normalize cuma panggil `parse_id_amount`).
- Register di `providers/index.js`; **tidak ada perubahan** services/routes.

### Catatan ShopeePay (dari referensi)
- Invalid token codes `200020`/`2010000` → session dead, mark `provider_accounts.status='expired'`.
- Akun mati `48500102` → hanya fresh OTP yang recover.
- Device-risk blob WAJIB untuk OTP (tanpa itu OTP silently suppressed).
- Store-scoping: ShopeePay feed store-scoped (`list_recent(store_id)`). Pooled: operator
  pilih SATU store (merchant storefront aktif), simpan `store_id` di `provider_accounts`.
- B1 manual token: no auto-refresh; rotasi = re-paste.

---

## 13. Background jobs (`src/server.js`)

| Job | Interval | Fungsi |
|---|---|---|
| `expireStale` | 60 d | `invoices.expireStale()` — PENDING→EXPIRED; order langganan ikut. |
| `cleanOldClaims` | 1 jam | `matching.cleanOldClaims()` — hapus claim >24 jam. |
| `pruneLogs` | 6 jam | `logs.pruneLogs()`. |
| `refreshAllExpiring` | 6 jam | refresh token GoPay operator dekat expiry. |
| `poller.start` | 10 d/provider | idle-when-empty, satu fetch→match semua pending. |
| rate-limit bucket GC | 120 d | hapus bucket per-key stale. |

Semua `setInterval(...).unref()` — tidak keep process hidup; `app.listen` yang keep alive.
`SIGTERM`/`SIGINT` → `poller.stop()` + `server.close()` + `db.close()`.

---

## 14. Halaman publik (`public/`)

| File | Tujuan |
|---|---|
| `index.html` | Login/register SPA. |
| `app.html` | Dashboard user: overview, saldo & withdraw, invoice QRIS, API keys, langganan, webhooks. |
| `admin.html` | Dashboard admin: overview, pengguna, paket, provider & OTP, order, invoice, withdraw, unmatched, logs. |
| `qris.html` + `qris.js` + `qris.css` | Halaman bayar: poll `/api/v1/qris/:id/status` tiap 5 d, countdown, render QR. |
| `docs.html` | Dokumentasi API. |
| `assets/app.css` | Dark theme. |
| `assets/common.js` | Helper: `api()`, `money()`, `esc()`, `tag()`, `loadOverview()`. |

---

## 15. Scripts (`scripts/`)

- `gen-secrets.js` — generate `SESSION_SECRET` (48 hex) + `PROVIDER_MASTER_KEY` (64 hex) +
  `ADMIN_PASSWORD`, print ke .env.
- `migrate.js` — jalankan `db.migrate()` standalone.
- `create-admin.js` — buat admin dari env standalone (butuh argumen email+password).
- `integration-test.js` — integration test runtime penuh (lihat §16), jalankan dengan
  `npm run test:integration`.

---

## 16. Tests (`tests/` + `scripts/integration-test.js`)

### Unit tests (pure, offline) — `npm test`
- `tests/gopay/normalize.test.js` — sen→rupiah: `gross_amount`, `real_gross_amount`,
  `amount.value`, malformed skip, completed status (SETTLEMENT/CAPTURE/empty).
- `tests/matching.test.js` — pure QRIS injection: `calculateCRC16` stable,
  `generateDynamicQRIS` flips tag 01→12 + inject tag 54 + CRC valid, rejects invalid,
  `parseEMVCoTags` strips CRC.

Jalankan: `npm test` (pakai `node --test`, glob di-quote agar rekursif — lihat §9.1 Bug 5).
**11/11 pass.**

### Integration test (butuh MySQL) — `npm run test:integration`
`scripts/integration-test.js` — verifikasi runtime penuh. Men-spawn instance aplikasi
sendiri di port `INTEST_APP_PORT` (default 3222) + mock server GoBiz di
`INTEST_MOCK_PORT` (default 3333). Transaksi URL GoPay di-redirect via env
`GOBIZ_TX_URL` (hook testability di `providers/gopay/client.js`), jadi **tidak ada trafik
GoBiz asli**. Kemudian lewatati seluruh pipeline via HTTP biasa:

auth admin → set QRIS statis → inject session → register → tier gate → grant plan H0 →
API key → buat invoice → **QRIS dinamis tervalidasi (tag 01→12, 54, CRC)** → inject mutasi
mock (minor unit) → **matching amount eksak → PAID** → **ledger kredit base_amount** →
**idempotensi claim** (re-inject tx sama, balance tidak berubah, 1 baris claim) → alokasi
kode unik berbeda untuk base sama → **orphan → unmatched_payments** → withdraw hold →
`INSUFFICIENT_BALANCE` untuk over-withdraw → admin process → balance turun, held 0 →
ledger audit trail.

**28/28 pass.** Lihat §9.1 untuk ringkasan bug yang ditemukan oleh test ini.

---

## 17. Troubleshooting cepat

| Gejala | Cek |
|---|---|
| Boot gagal "SESSION_SECRET must be at least 32" | `node scripts/gen-secrets.js`, isi .env. |
| Boot gagal "PROVIDER_MASTER_KEY must be 64 hex" | idem. |
| `ECONNREFUSED` / DB | cek `DB_*`, `DB_SOCKET` (cPanel). |
| `POST /qris` → 503 STATIC_QRIS_NOT_SET | admin paste QR statis GoBiz di `/admin` → providers. |
| `POST /qris` → 503 PROVIDER_UNAVAILABLE | admin OTP-login GoBiz (`/providers/gopay/otp`+`/verify`). |
| `POST /qris` → 403 PROVIDER_NOT_PERMITTED | user free tier pilih gopay; upgrade langganan. |
| `POST /qris` → 503 UNIQUE_CODE_EXHAUSTED | slot kode unik penuh (banyak invoice konkuren sama base); tunggu expire. |
| Status stuck PENDING padahal sudah bayar | cek provider session aktif; cek `claimed_transactions`; cek `unmatched_payments`; cek log poller. |
| Ledger tidak naik setelah PAID | cek `kind` invoice — `subscription`→settleOrder, `api`/`test`→credit. Cek `ledger_entries`. |
| Withdraw gagal INSUFFICIENT_BALANCE | `available = balance - held` < amount; cek `user_balances.held`. |
| Webhook tidak terkirim | cek `webhooks` tabel; `ping` saat register butuh URL reachable; cek `X-Webhook-Signature`. |
| Bug 1/2 kambuh | lihat §9 — verifikasi placeholder INSERT invoice (15) & nilai amount order (`invoice.total_amount`). |

---

## 18. Status saat dokumen ini dibuat

- ✅ **Fase 1 lengkap secara kode**: semua service, provider GoPay, routes, middleware,
  poller, db, utils, scripts, tests, halaman publik (termasuk `app.html` + `admin.html`).
- ✅ **Audit read-only seluruh codebase** selesai; 2 bug ditemukan & diperbaiki (§9).
- ✅ **Verifikasi runtime SELESAI** (§9.1): install deps → `npm test` 11/11 → migrate 14 tabel →
  boot server (healthz OK, poller start) → `npm run test:integration` **28/28 pass**.
  **3 bug tambahan ditemukan & diperbaiki** selama verifikasi:
  - **Bug 3** (kritis!): seed `plans` placeholder mismatch → **setiap fresh install gagal**.
  - **Bug 4** (silent): grant langganan admin tidak teruskan `plan_id` → `allowed_providers`
    kosong → user langganan tidak bisa QRIS sama sekali.
  - **Bug 5**: `npm test` glob tidak rekursif → `matching.test.js` never ran.
  Tambahan: `.gitignore` dibuat (`.env`, `*.key`, `*.har`, `logs/`, `node_modules/`),
  hook testability `GOBIZ_TX_URL` di `providers/gopay/client.js`, script integration test
  permanen, UI admin dapat dropdown paket saat grant langganan.
- 🔜 **Fase 2** ShopeePay — port dari `QrisMerchantID` (B1 manual token dulu, B2 OTP kedua).

---

*Dokumen ini = source of truth cadangan. Jika script rusak/hilang, rekonstruksi dari sini.*
