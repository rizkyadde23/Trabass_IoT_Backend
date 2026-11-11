-- ============================================================================
-- Migration: Refactoring Alur Autentikasi & Pencatatan Insiden Pelanggaran
-- Proyek   : TRABASS IoT (Tracking Bicycle Alert & Security System)
--
-- Perubahan:
--   1. users              -> kolom username (login admin), email & password
--                            menjadi opsional (penyewa baru identitasnya No. WA)
--   2. bikes              -> kolom battery_percent (data perception layer)
--   3. security_incidents -> atribusi penyewa saat pelanggaran terjadi
--                            (user_id, rental_id) + tipe baru OVERDUE &
--                            OVERDUE_MOVEMENT (disimpan sebagai VARCHAR, tanpa
--                            perubahan tipe kolom)
--
-- Jalankan sekali di MySQL/XAMPP:
--   mysql -u root -p < migration_auth_incident_refactor.sql
-- ============================================================================

USE bicycle_security_db;

-- ---------------------------------------------------------------------------
-- 1. Users: username untuk login admin + kolom kredensial jadi opsional
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN username VARCHAR(50) NULL AFTER name,
  ADD UNIQUE KEY uq_users_username (username),
  MODIFY email VARCHAR(150) NULL,
  MODIFY password_hash VARCHAR(255) NULL;

-- ---------------------------------------------------------------------------
-- 2. Bikes: data baterai dari perception layer (persen 0-100)
-- ---------------------------------------------------------------------------
ALTER TABLE bikes
  ADD COLUMN battery_percent DECIMAL(5, 2) NULL AFTER lock_state;

-- ---------------------------------------------------------------------------
-- 3. Insiden: atribusi penyewa yang sedang menyewa saat pelanggaran terjadi
-- ---------------------------------------------------------------------------
ALTER TABLE security_incidents
  ADD COLUMN user_id INT NULL AFTER bike_id,
  ADD COLUMN rental_id INT NULL AFTER user_id,
  ADD CONSTRAINT fk_incidents_user
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_incidents_rental
    FOREIGN KEY (rental_id) REFERENCES rentals(rental_id) ON DELETE SET NULL,
  ADD INDEX idx_incidents_user (user_id);

-- Selesai. Tabel telemetry_logs dapat ditambah kolom `battery` pada tahap
-- berikutnya jika histori grafik baterai dibutuhkan.
