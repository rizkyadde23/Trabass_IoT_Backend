-- Migration: Tambah kredensial login (email + password) pada tabel users
-- Jalankan sekali pada database bicycle_security_db yang sudah ada.
-- Untuk instalasi baru, gunakan schema.sql.

USE bicycle_security_db;

-- Pastikan tidak ada nomor WA duplikat sebelum unique index dibuat.
-- Jika query di bawah mengembalikan baris, rapikan datanya terlebih dahulu.
-- SELECT phone_number, COUNT(*) AS total
-- FROM users
-- GROUP BY phone_number
-- HAVING COUNT(*) > 1;

ALTER TABLE users
  ADD COLUMN email VARCHAR(150) NULL AFTER name,
  ADD COLUMN password_hash VARCHAR(255) NULL AFTER email,
  ADD UNIQUE KEY uq_users_email (email),
  ADD UNIQUE KEY uq_users_phone_number (phone_number);

-- Catatan:
-- User lama memiliki email & password_hash NULL sehingga tidak dapat login.
-- Saat registrasi, backend akan meng-claim baris lama jika nomor WA cocok dan
-- email masih NULL, sehingga user_id dan riwayat rentals tetap terjaga.
