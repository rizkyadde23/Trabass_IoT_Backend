-- Migration: Refactor alur pembayaran, extend, dan reservasi sepeda
-- Jalankan sekali pada database bicycle_security_db yang sudah ada.
-- Untuk instalasi baru, gunakan schema.sql.

USE bicycle_security_db;

ALTER TABLE rentals
  ADD COLUMN rental_type VARCHAR(20) NOT NULL DEFAULT 'INITIAL' AFTER midtrans_order_id,
  ADD COLUMN parent_rental_id INT NULL AFTER rental_type,
  ADD COLUMN payment_processed_at DATETIME NULL AFTER parent_rental_id,
  ADD INDEX idx_rentals_bike_status (bike_id, rental_status),
  ADD INDEX idx_rentals_parent (parent_rental_id),
  ADD CONSTRAINT fk_rentals_parent
    FOREIGN KEY (parent_rental_id) REFERENCES rentals(rental_id) ON DELETE SET NULL;

-- Backfill dasar untuk transaksi perpanjangan lama yang memakai prefix EXTEND-.
-- parent_rental_id tidak dapat ditentukan otomatis dari data lama.
UPDATE rentals
SET rental_type = 'EXTENSION'
WHERE midtrans_order_id LIKE 'EXTEND-%'
  AND rental_type = 'INITIAL';
