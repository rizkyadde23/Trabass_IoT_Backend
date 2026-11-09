-- Migration: tabel pengaturan aplikasi (pangkalan, geofence, pricing)
-- Jalankan: mysql -u <user> -p bicycle_security_db < migration_app_settings.sql

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(64) PRIMARY KEY,
    setting_value VARCHAR(255) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Nilai default mengikuti .env / config. Baris ini hanya dipakai bila
-- belum ada, sehingga pengaturan yang sudah diubah admin tidak tertimpa.
INSERT INTO app_settings (setting_key, setting_value)
VALUES
    ('station_lat', '-7.773512'),
    ('station_lng', '110.385411'),
    ('geofence_radius_m', '500'),
    ('rental_price_per_minute', '1000'),
    ('extension_price_per_minute', '1000'),
    ('min_rental_minutes', '15'),
    ('max_rental_minutes', '1440')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
