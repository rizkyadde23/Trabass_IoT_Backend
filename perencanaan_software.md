# Perencanaan Implementasi Software: Tracking Bicycle Alert & Security System

Dokumen ini berisi panduan alur pengerjaan software *Tracking Bicycle Alert & Security System* secara bertahap, mencakup fokus pekerjaan, langkah teknis detail, serta luaran (*output*) dari setiap tahap.

---

## 📋 Ringkasan Arsitektur & Perangkat Software

* **Backend Engine:** Node.js (Express.js)
* **Protokol IoT:** MQTT (Mosquitto Broker)
* **Database Utama:** MySQL (XAMPP Native)
* **Caching & Real-time State:** Redis Server (Windows Native)
* **Payment Gateway:** Midtrans Snap (Sandbox API)
* **Notification Gateway:** WhatsApp (Fonnte API) & SMS (GSM AT Command Fallback)
* **Frontend:** PWA Penyewa (Scan QR Code & Payment) + Web Dashboard Admin (Leaflet.js Real-time Monitoring)

---

## 🗺️ Roadmap & Alur Implementasi Berkelanjutan

```
+-----------------------------------------------------------------------------------+
| FASE 1: Infrastruktur Backend & Pendukung (SELESAI)                               |
| Setup Environment, Server Node.js, MySQL (XAMPP), Redis, MQTT (Mosquitto)          |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| FASE 2: Backend Core Services & Logic Engine                                      |
| Telemetry Ingestion, Geofencing, Tamper Alarm, Payment & Notification Gateway     |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| FASE 3: Frontend Applications                                                     |
| Progressive Web App (User) & Dashboard Interactive Map (Admin Manager)            |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| FASE 4: Firmware ESP32 & System Integration                                       |
| Communication Engine, Hardware Controllers, Non-blocking Parsing, E2E Testing     |
+-----------------------------------------------------------------------------------+
```

---

## 🛠️ Detail Langkah Demi Langkah & Output Implementasi

### **FASE 1: Infrastruktur Backend & Pendukung (Status: Selesai)**

* **Fokus Utama:** Menyiapkan fondasi dasar koneksi data, tabel database, broker pesan, serta entri aplikasi server.
* **Langkah-langkah:**
  1. Inisialisasi projek Node.js dan install dependensi (`express`, `mysql2`, `redis`, `mqtt`, `dotenv`, `cors`).
  2. Setup file `.env`, `mosquitto.conf`, serta koneksi database MySQL (`src/config/db.js`), Redis (`src/config/redis.js`), dan MQTT (`src/config/mqtt.js`).
  3. Pembuatan skema database `bicycle_security_db` di MySQL XAMPP (Tabel `bikes`, `users`, `rentals`, `telemetry_logs`).
  4. Pengujian endpoint `/health` pada Express App.
* **Output yang Dihasilkan:**
  * File struktur backend Node.js (`src/app.js`, `src/config/*`).
  * Database `bicycle_security_db` aktif di phpMyAdmin dengan data *seed* awal `BK-001`.
  * Service Redis (`localhost:6379`) dan Mosquitto MQTT (`localhost:1883`) terhubung normal ke Node.js.

---

### **FASE 2: Backend Core Services & Logic Engine (Langkah Berikutnya)**

* **Fokus Utama:** Mengolah pesan telemetri dari sepeda, membuat *engine* keputusan keamanan otomatis (Geofencing & Tamper Detection), serta memproses transaksi dan notifikasi.

#### **Langkah 2.1: Telemetry Ingestion & Real-time Caching Service**
* **Kegiatan:**
  1. Membuat `src/controllers/telemetryController.js` untuk memproses data dari topik MQTT `bike/telemetry/{bike_id}`.
  2. Menyimpan status koordinat dan *lock state* terbaru sepeda ke Redis Hash (`bike:BK-001:location`).
  3. Memasukkan *history log* ke tabel MySQL `telemetry_logs`.
* **Output:** Data koordinat dari sepeda tersimpan di Redis dalam hitungan milidetik dan tercatat di riwayat MySQL.

#### **Langkah 2.2: Geofencing & Tamper Detection Logic Engine**
* **Kegiatan:**
  1. Membuat `src/services/geofenceService.js` menggunakan algoritma Rumus Haversine untuk menghitung jarak sepeda ke titik pangkalan.
  2. Menentukan *threshold* alarm: Jika jarak > `R_MAX` (misal 500 meter) ATAU status sepeda `LOCKED` tetapi `mpu_motion = true`.
  3. Mengirim perintah otomatis via MQTT `bike/command/{bike_id}` dengan *payload* `{"action": "ALARM_ON"}`.
* **Output:** Backend secara otomatis mendeteksi pencurian/pelanggaran batas dan langsung menyalakan buzzer di hardware sepeda.

#### **Langkah 2.3: Payment Gateway (Midtrans Snap) & Webhook Handler**
* **Kegiatan:**
  1. Membuat `src/controllers/paymentController.js` untuk generate `snap_token` saat user memilih durasi sewa.
  2. Membuat route webhook `POST /api/payment/notification` untuk menerima HTTP Callback dari Midtrans.
  3. Ketika status transaksi `settlement` (sukses):
     * Update tabel `rentals` (`payment_status = 'SETTLED'`, `rental_status = 'ACTIVE'`).
     * Update status sepeda `bikes` (`status = 'RENTED'`, `lock_state = false`).
     * Kirim perintah MQTT `{"action": "UNLOCK"}` ke sepeda.
* **Output:** Pembayaran yang sukses langsung membuka kunci sepeda secara otomatis tanpa intervensi manual.

#### **Langkah 2.4: Multi-Channel Notification Gateway (WhatsApp & SMS)**
* **Kegiatan:**
  1. Membuat `src/services/notificationService.js` terintegrasi dengan Fonnte API untuk mengirim notifikasi WhatsApp (Struk transaksi sewa & Peringatan darurat ke Admin/User).
  2. Menyiapkan *fallback mechanism*: Jika WhatsApp gagal, sistem menyisipkan instruksi `SEND_SMS` ke payload MQTT sepeda untuk memicu pengiriman SMS langsung via GSM A7670C/SIM800L.
* **Output:** User dan Admin mendapat pesan notifikasi WhatsApp/SMS saat sewa berhasil atau terjadi indikasi pencurian.

---

### **FASE 3: Frontend Applications**

* **Fokus Utama:** Menyediakan antarmuka intuitif untuk pelanggan (sewa & pembayaran) dan pengelola (monitoring armada & insiden).

#### **Langkah 3.1: User Progressive Web App (PWA)**
* **Kegiatan:**
  1. Integrasi library `html5-qrcode` untuk membaca QR Code `bike_id`.
  2. Membuat form pemilihan durasi sewa dan pop-up pembayaran Midtrans Snap SDK.
  3. Menampilkan halaman *Active Session*: *Countdown timer* sisa durasi sewa dan peta sederhana lokasi sepeda terkini.
* **Output:** Aplikasi PWA berbasis browser HP yang siap digunakan penyewa di lokasi pangkalan.

#### **Langkah 3.2: Admin Manager Dashboard**
* **Kegiatan:**
  1. Membuat antarmuka peta interaktif menggunakan **Leaflet.js** yang terhubung ke backend via WebSocket / MQTT over WebSockets (port 9001).
  2. Menampilkan *marker* posisi real-time seluruh sepeda beserta radius lingkaran Geofence.
  3. Menyediakan panel *Force Remote Lock/Unlock* dan *alert pop-up* jika terjadi pelanggaran geofence atau aksi perusakan MPU6050.
* **Output:** Web Dashboard Admin untuk pemantauan posisi armada sepeda secara *live*.

---

### **FASE 4: Firmware ESP32 & System Integration (E2E Testing)**

* **Fokus Utama:** Implementasi kode akhir C++ pada hardware ESP32, sinkronisasi Wokwi simulator, dan pengujian alur sistem penuh.

#### **Langkah 4.1: Final Firmware C++ ESP32**
* **Kegiatan:**
  1. Mengintegrasikan parser NMEA GPS (`TinyGPS++`), sensor MPU6050, Servo (kunci), Relay, Buzzer, dan LCD I2C.
  2. Membangun koneksi seluler GSM A7670C/SIM800L dan PubSubClient MQTT ke broker backend.
  3. Menangani *callback* MQTT `bike/command/{bike_id}` untuk merespon perintah `UNLOCK`, `LOCK`, dan `ALARM_ON`.
* **Output:** Kode `sketch.ino` siap *upload* ke ESP32 fisik maupun simulator Wokwi.

#### **Langkah 4.2: Testing End-to-End (E2E)**
* **Skenario Pengujian:**
  1. **Uji Sewa Normal:** Scan QR $\rightarrow$ Bayar Midtrans Sandbox $\rightarrow$ Webhook Web Server $\rightarrow$ Perintah MQTT `UNLOCK` diterima ESP32 $\rightarrow$ Servo Berputar 90° & LCD terupdate.
  2. **Uji Geofence:** Mengubah koordinat GPS keluar dari pangkalan $\rightarrow$ Backend hitung Haversine $\rightarrow$ MQTT `ALARM_ON` $\rightarrow$ Buzzer berbunyi & Notifikasi WhatsApp terkirim.
  3. **Uji Anti-Theft MPU6050:** Menggerakkan sensor MPU6050 saat posisi terkunci $\rightarrow$ Data `mpu_motion: true` terkirim $\rightarrow$ Sirine alarm aktif.
* **Output:** Laporan pengujian sistem (*test-case log*) yang membuktikan hardware dan software terintegrasi 100%.

---

## 📌 Checklist Status Proyek

* [x] **Fase 1:** Infrastruktur Server Node.js, MySQL (XAMPP), Redis Native, Mosquitto MQTT, File `.env`, & Database Schema.
* [x] **Fase 2.1:** Controller Telemetri & Ingestion Redis/MySQL.
* [x] **Fase 2.2:** Engine Geofencing (Haversine) & Tamper Alarm MPU6050.
* [x] **Fase 2.3:** Payment Gateway Midtrans Snap & Webhook.
* [x] **Fase 2.4:** Notification Gateway (Fonnte WhatsApp).
* [x] **Fase 3.1:** Web App User (PWA Scan QR & Checkout).
* [x] **Fase 3.2:** Web Admin Dashboard (Leaflet.js Realtime Map).
* [ ] **Fase 4.1:** Firmware C++ ESP32 Complete.
* [ ] **Fase 4.2:** Integrasi & Pengujian End-to-End.