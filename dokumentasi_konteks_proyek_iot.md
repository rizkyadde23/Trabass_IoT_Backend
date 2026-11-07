# Dokumentasi Konteks Proyek: Tracking Bicycle Alert & Security System

## 1. Gambaran Umum Proyek

**Tracking Bicycle Alert & Security System** adalah sistem keamanan berbasis *Internet of Things* (IoT) dan platform web yang dirancang khusus untuk pengelolaan sepeda rental di area terbatas seperti kawasan kampus dan destinasi wisata. Sistem ini mengintegrasikan pelacakan lokasi real-time via GPS, batas wilayah operasional (*geofencing*), deteksi gerakan/pencurian saat terkunci via IMU MPU6050, sistem penguncian elektronik mandiri, integrasi simulasi pembayaran sewa via **Midtrans Payment Gateway**, serta otomatisasi notifikasi ganda via **SMS (Modul GSM)** dan WhatsApp/Telegram untuk mencegah pencurian dan keterlambatan pengembalian armada.

## 2. Arsitektur Sistem 4-Layer

```
+-----------------------------------------------------------------------+
| 4. APPLICATION LAYER (PWA User, Midtrans Snap, Web Dashboard Admin)  |
+-----------------------------------------------------------------------+
                                   ▲ WebSocket / REST API / Webhooks
                                   ▼
+-----------------------------------------------------------------------+
| 3. MIDDLEWARE LAYER (Node.js/FastAPI, PostgreSQL, Redis, Midtrans API)|
+-----------------------------------------------------------------------+
                                   ▲ MQTT / TCP-IP / AT+CMGS (SMS)
                                   ▼
+-----------------------------------------------------------------------+
| 2. NETWORK LAYER (A7670C LTE / SIM800L GSM Module - Data & SMS)       |
+-----------------------------------------------------------------------+
                                   ▲ UART Serial / I2C
                                   ▼
+-----------------------------------------------------------------------+
| 1. PERCEPTION LAYER (ESP32, NEO-6M, MPU6050, Solenoid/Servo, Buzzer)  |
+-----------------------------------------------------------------------+
```

### Layer 1: Perception / Sensing Layer (Hardware Sepeda)

* **Mikrokontroler Utama:** ESP32 DevKit v1 (mengolah input sensor, logika actuating, dan serial komunikasi).
* **Sensor Lokasi:** Modul GPS NEO-6M (membaca data koordinat *Latitude* dan *Longitude* via UART2).
* **Sensor Deteksi Gerakan/Anti-Theft:** Sensor IMU MPU6050 (Akselerometer & Giroskop via I2C) untuk mendeteksi guncangan, pergerakan, atau pemindahan paksa saat sepeda dalam status terkunci (*locked*).
* **Aktuator Pengunci:** Solenoid Door Lock 12V melalui Modul Relay 5V (disimulasikan dengan Servo Motor PWM di simulator Wokwi).
* **Indikator & Alarm Lokal:** Piezo Buzzer 12V (sirine peringatan) & LCD I2C 16x2 (layar status pengguna).
* **Sumber Daya:** Baterai Lithium-Ion 18650 + Modul Step-Down / Charger TP4056.

### Layer 2: Network Layer (Konektivitas & SMS Gateway)

* **Modul Seluler:** A7670C LTE / SIM800L GSM/GPRS (koneksi data internet seluler & layanan SMS seluler).
* **Fitur SMS Service:** Eksekusi AT Command (`AT+CMGS`) dari modul GSM untuk pengiriman pesan singkat (SMS) notifikasi transaksi dan alert darurat langsung ke nomor HP pengguna.
* **Protokol Komunikasi Data:** MQTT (protokol *publish/subscribe* hemat kuota & daya) atau HTTP POST fallback.
* **Jaringan Transmisi:** TCP/IP & Cellular SMS Network (GSM/LTE).

### Layer 3: Middleware / Processing Layer (Server Backend & Logic)

* **Server/Backend Engine:** Node.js (Express) atau Python (FastAPI).
* **Payment Processing:** Integrasi **Midtrans Payment Gateway** (Core API / Snap API) untuk penanganan simulasi transaksi sewa (QRIS, E-Wallet, Virtual Account) dan verifikasi otomatis via *Payment Notification Webhook*.
* **Database & Caching:** PostgreSQL + PostGIS (penyimpanan transaksi, data pengguna, log sewa, data spasial) & Redis (caching posisi real-time cepat & status sesi sewa).
* **Engine Utama:**
  * **Geofencing Engine:** Menghitung jarak sepeda ke titik pangkalan/batas aman menggunakan **Rumus Haversine**.
  * **Tamper & Theft Engine:** Mengolah alert pergerakan abnormal dari MPU6050 saat sepeda tidak dalam masa sewa aktif.
  * **Timer Engine:** Menghitung waktu sewa aktif dan pemicu batas waktu pengembalian.
  * **Multi-Channel Notification Gateway:** Integrasi layanan SMS via GSM Modul AT Command, WhatsApp API (Fonnte / `wwebjs`), serta Telegram Bot API.

### Layer 4: Application Layer (Antarmuka Pengguna & Pembayaran)

* **User App (PWA):** Scan QR Code sepeda (`Bike_ID`), formulir durasi sewa, checkout pembayaran terintegrasi Midtrans Snap Pop-up, dan countdown timer sewa.
* **Manager Dashboard (Web Admin):** Peta interaktif (Leaflet.js/Mapbox), indikator status armada real-time, log transaksi pembayaran Midtrans, remote *force unlock/lock*, serta notifikasi insiden pencurian/pelanggaran.

## 3. Alur Kerja Operasional & Logika Keamanan

```
                                  [ USER PWA ]
                                       │
                         1. Scan QR & Checkout Sewa
                                       │
                                       ▼
                       2. Bayar via [ Midtrans Snap ]
                                       │
                                (Webhook Callback)
                                       ▼
 [ ESP32 Sepeda ] ◄── 3. MQTT Command (Unlock) ─── [ Backend Server ]
        │                                                ▲
   4. GPS & MPU6050                                      │
   (Telemetri JSON)                                      │ 5. Hitung Haversine,
        │                                                │    Timer, & Deteksi
        ▼                                                │    Motion MPU6050
 [ MQTT Broker ] ────────── Sub Telemetri ───────────────┘
                                                         │
                                               6. Jika Keluar Batas /
                                                  Waktu Habis /
                                                  Gerak Saat Locked
                                                         │
                                      ┌──────────────────┴──────────────────┐
                                      ▼                                     ▼
                          [ Send MQTT Command (Alarm) ]         [ Multi-Channel Notification ]
                                      │                         (SMS GSM, WA & Telegram Gateway)
                                      ▼                                     │
                          [ Buzzer ON & Lock Servo ]                        ▼
                                                                    [ User & Admin HP ]
```

1. **Simulasi Pembayaran & Pembukaan Kunci (Midtrans Integration):**
   * Pengguna memindai QR Code di sepeda menggunakan PWA dan memilih durasi sewa.
   * PWA memanggil backend untuk membuat transaksi Midtrans Snap token. Pop-up Midtrans muncul di PWA untuk simulasi pembayaran (QRIS / GoPay / Bank Transfer).
   * Setelah pembayaran sukses, Midtrans mengirimkan *HTTP Notification Webhook* ke Backend.
   * Backend mengonfirmasi transaksi valid, lalu mengirimkan perintah `UNLOCK` via MQTT ke topik `bike/command/{bike_id}` serta memicu pengiriman **SMS konfirmasi sewa** via Modul GSM.
   * ESP32 menggerakkan Servo (90°) / Relay HIGH, LCD menampilkan pesan *"STATUS: TERBUKA"*, dan deteksi gerakan MPU6050 dinonaktifkan sementara selama durasi sewa.

2. **Monitoring, Geofencing, & Deteksi Gerakan (MPU6050):**
   * Modul GPS secara periodik membaca koordinat dan MPU6050 membaca akselerasi 3-sumbu ($X, Y, Z$).
   * **Kondisi Terkunci (Locked):** Jika MPU6050 mendeteksi perubahan nilai akselerasi/guncangan melebihi ambang batas (*threshold*) saat sepeda tidak dalam status disewa, ESP32 mendeteksi upaya pencurian/pemindahan paksa dan langsung mengirimkan sinyal *theft alert*.
   * **Kondisi Disewa (Unlocked):** Server memproses koordinat GPS secara berkala menggunakan **Rumus Haversine**:

     $$
     d = 2r \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta \phi}{2}\right) + \cos(\phi_1) \cos(\phi_2) \sin^2\left(\frac{\Delta \lambda}{2}\right)}\right)
     $$

3. **Pemicu Keamanan & Notifikasi Ganda (SMS + WA/Telegram):**
   * Jika $d > R_{max}$ (keluar geofence), *Timer* sewa habis, ATAU MPU6050 mendeteksi gerakan abnormal saat sepeda status *Locked*, Server dan ESP32 secara bersamaan:
     * Membunyikan **Buzzer 12V** (sirine bahaya) di lokasi sepeda.
     * Mengirimkan **SMS Alert** langsung via perintah AT Modul GSM ke HP pengguna (`"PERINGATAN: Sepeda Anda keluar dari area resmi/waktu sewa habis!"`).
     * Mengirimkan peringatan paralel via **WhatsApp/Telegram Gateway** ke Admin Pangkalan.
     * Menampilkan *pop-up alert* merah pada **Dashboard Web Admin** lengkap dengan posisi GPS real-time.

4. **Pengembalian Sepeda:**
   * Pengguna memarkir sepeda di pangkalan resmi.
   * Sistem memverifikasi lokasi akhir sepeda di area pangkalan, penguncian solenoid diaktifkan, status MPU6050 di-set kembali ke mode siaga *anti-tamper*, SMS konfirmasi pengembalian dikirimkan, dan sesi sewa diakhiri di database.

## 4. Software Stack & Dependensi

* **Embedded Firmware (ESP32):** C/C++, Arduino IDE / Wokwi, `TinyGPS++`, `Adafruit_MPU6050` / `MPU6050_light`, `ESP32Servo`, `LiquidCrystal_I2C`, `PubSubClient`, AT Command Parser untuk GSM SMS (`AT+CMGS`).
* **Backend:** Node.js (Express) / Python (FastAPI), `midtrans-client` SDK, `aedes` (MQTT Broker), `ioredis`, `pg` (PostgreSQL Client).
* **Frontend:** React.js / Vue.js, Leaflet.js / Mapbox GL JS, HTML5 QR Code Scanner, Midtrans Snap.js, PWA Service Worker.
* **Infrastructure & Gateway:** Docker Compose, Mosquitto MQTT Broker, Midtrans Sandbox Account, GSM Cellular SMS Gateway, Fonnte / Telegram API.