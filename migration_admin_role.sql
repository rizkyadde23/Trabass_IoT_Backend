-- Migration: Tambah role admin/user pada tabel users
-- Jalankan sekali pada database bicycle_security_db yang sudah ada.
-- Untuk instalasi baru, gunakan schema.sql.

USE bicycle_security_db;

ALTER TABLE users
  ADD COLUMN role ENUM('user', 'admin') NOT NULL DEFAULT 'user' AFTER password_hash;

-- Setelah migrasi, buat akun admin dengan:
--   npm run seed:admin
-- Pastikan ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, dan ADMIN_PHONE_NUMBER
-- sudah diisi di file .env.

-- Catatan:
-- Token JWT yang dibuat sebelum migrasi tidak memiliki klaim role.
-- Semua pengguna (termasuk admin) perlu login ulang setelah backend diperbarui.
