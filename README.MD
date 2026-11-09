# TRABASS IoT - Smart Bicycle Security System

## Setup Database

- Instalasi baru: jalankan `schema.sql`.
- Database yang sudah ada: jalankan `migration_payment_refactor.sql`.
- Untuk fitur dashboard admin, jalankan juga `migration_admin_role.sql`.

## Setup Role Admin & Dashboard

1. Pastikan migrasi role sudah dijalankan.
2. Tambahkan konfigurasi akun admin ke `.env`:
   ```env
   ADMIN_NAME=Admin Trabass
   ADMIN_EMAIL=admin@trabass.local
   ADMIN_PASSWORD=ubah-password-ini
   ADMIN_PHONE_NUMBER=08xxxxxxxxxx
   ```
3. Jalankan `npm run seed:admin`. Script ini membuat akun admin baru atau
   mempromosikan akun dengan email yang sama menjadi `role = 'admin'`.
4. Login ulang di frontend. Token JWT lama belum memiliki klaim `role`.

### `GET /api/admin/bikes`

Endpoint daftar armada untuk dashboard admin. Wajib memakai token JWT dengan
`role = 'admin'`. Data lokasi terbaru digabung dari Redis jika tersedia, dan
fallback ke koordinat terakhir di MySQL jika Redis belum siap.

### `POST /api/admin/bike-command`

Mengirim perintah remote ke sepeda melalui MQTT topik `bike/command/<bike_id>`.

```json
{
  "bike_id": "BK-001",
  "action": "FORCE_LOCK",
  "reason": "Opsional, maksimal 255 karakter"
}
```

Nilai `action`: `FORCE_LOCK` (MQTT `LOCK`), `FORCE_UNLOCK` (MQTT `UNLOCK`), dan
`ALARM_OFF` (MQTT `ALARM_OFF`). Response `SENT` berarti perintah sudah diterima
broker, bukan bukti eksekusi firmware. Setiap pengiriman dicatat di
`admin_command_logs` dengan status `SENT` atau `FAILED`. `ALARM_OFF` juga
mengeset `alarm_muted=true` di Redis selama alert masih aktif; mute dibersihkan
saat insiden selesai atau insiden baru muncul.

### `GET /api/admin/incidents`

Feed insiden keamanan dengan filter `status` (`ACTIVE`/`RESOLVED`), `type`
(`TAMPER`/`GEOFENCE`), `bike_id`, cursor `after_id`/`before_id`, dan `limit`
(maksimal 100). Insiden `ACTIVE` yang sama tidak diduplikasi: paket telemetri
berikutnya hanya memperbarui `last_seen_at`.

### `GET /api/admin/command-logs`

Riwayat audit perintah admin dengan filter `bike_id`, `action`, `status`
(`SENT`/`FAILED`), cursor, dan `limit`. Tabel `security_incidents` dan
`admin_command_logs` dibuat otomatis saat backend mulai.

## Konfigurasi Pembayaran

Tambahkan variabel berikut ke `.env` (lihat `.env.example`):

```env
RENTAL_PRICE_PER_MINUTE=1000
EXTENSION_PRICE_PER_MINUTE=1000
MIN_RENTAL_MINUTES=15
MAX_RENTAL_MINUTES=1440
PAYMENT_EXPIRY_MINUTES=15
```

Harga sewa dihitung oleh backend. Nilai `amount` dari frontend tidak digunakan.

## API Pembayaran

### `POST /api/rent/create-transaction`

```json
{
  "bike_id": "BK-001",
  "user_id": 1,
  "duration_minutes": 60
}
```

Response berisi `order_id`, `snap_token`, `redirect_url`, `amount`, dan status rental.
Sepeda akan berstatus `RESERVED` sampai pembayaran selesai atau kedaluwarsa.

### `POST /api/payment/notification`

Endpoint webhook Midtrans. Verifikasi signature dilakukan otomatis.
Webhook bersifat idempoten: notifikasi ganda tidak akan menambah durasi dua kali.

### `POST /api/rent/extend-transaction`

```json
{
  "bike_id": "BK-001",
  "user_id": 1,
  "duration_minutes": 30
}
```

Hanya dapat dilakukan saat rental berstatus `ACTIVE` atau `WARNING_SENT`.

### `POST /api/rent/confirm-payment`

```json
{ "order_id": "RENT-BK-001-..." }
```

Backend memverifikasi status pembayaran langsung ke Midtrans sebelum mengaktifkan sesi.
Gunakan endpoint ini setelah pop-up Snap berhasil, lalu polling sampai status `SETTLED`.

### `GET /api/rent/status/:order_id`

Endpoint read-only untuk polling status pembayaran dan sesi sewa.

### `POST /api/rent/finish`

```json
{
  "bike_id": "BK-001",
  "user_id": 1
}
```

Mengakhiri sesi, mengunci sepeda, dan mengirim notifikasi WhatsApp konfirmasi pengembalian.

## Notifikasi

- WhatsApp dikirim melalui Fonnte.
- Jika WhatsApp gagal, backend mengirim perintah `SEND_SMS` via MQTT ke ESP32.
- Perintah MQTT yang digunakan: `UNLOCK`, `EXTEND_TIME`, `LOCK`, `LOCK_AND_ALARM`, `WARNING_BEEP`, `SEND_SMS`, dan `ALARM_OFF`.
- `ALARM_OFF` memerlukan handler di firmware. Sampai handler tersedia, perintah
  tetap dikirim dan dicatat, tetapi buzzer belum berhenti.
