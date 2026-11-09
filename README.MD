# TRABASS IoT - Smart Bicycle Security System

## Setup Database

- Instalasi baru: jalankan `schema.sql`.
- Database yang sudah ada: jalankan `migration_payment_refactor.sql`.

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
- Perintah MQTT yang digunakan: `UNLOCK`, `EXTEND_TIME`, `LOCK`, `LOCK_AND_ALARM`, `WARNING_BEEP`, dan `SEND_SMS`.
