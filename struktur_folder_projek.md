bicycle-security-backend/
├── src/
│   ├── config/
│   │   ├── db.js                 # Pool koneksi MySQL (mysql2/promise)
│   │   ├── redis.js              # Redis client connection
│   │   └── mqtt.js               # Client MQTT (PubSub & Telemetry subscriber)
│   ├── controllers/
│   │   ├── authController.js      # Registrasi, login, profil & role user
│   │   ├── adminController.js     # Data armada untuk dashboard admin
│   │   ├── telemetryController.js # Pengolahan data telemetry & emergency alert
│   │   ├── paymentController.js   # Integration Midtrans Snap & Webhook Handler
│   │   ├── rentalController.js    # Logika mulai sewa, durasi, & pengembalian
│   │   └── bikeController.js      # CRUD & status realtime armada sepeda
│   ├── scripts/
│   │   └── createAdmin.js         # Seed/promosi akun admin dari .env
│   ├── services/
│   │   ├── geofenceService.js     # Logika kalkulasi jarak (Haversine Formula)
│   │   ├── notificationService.js # WA Gateway (Fonnte) & SMS fallback logic
│   │   └── timerService.js        # Background timer monitoring sisa waktu sewa
│   ├── routes/
│   │   ├── api.js                # Router endpoint REST API (User PWA & Dashboard)
│   │   └── webhook.js            # Route khusus HTTP Callback Midtrans
│   ├── middlewares/
│   │   ├── authMiddleware.js     # Validasi JWT / API Key
│   │   ├── adminMiddleware.js    # Pembatasan endpoint khusus role admin
│   │   └── errorHandler.js       # Centralized error handler
│   └── app.js                    # Entry point Express, MQTT event listener & server start
├── schema.sql                    # Script DDL tabel MySQL (Import ke phpMyAdmin)
├── migration_admin_role.sql      # Migrasi role admin/user pada tabel users
├── mosquitto.conf                # Konfigurasi Mosquitto Broker (Listener 1883 & 9001)
├── .env                          # Variable environment (Port, DB, MQTT, Midtrans, WA)
├── .gitignore                    # File/folder yang diabaikan Git (node_modules, .env)
├── package.json                  # Script npm & daftar dependensi proyek
└── README.md                     # Dokumentasi petunjuk penjalanan proyek