CREATE DATABASE IF NOT EXISTS bicycle_security_db;
USE bicycle_security_db;

-- 1. Tabel Data Sepeda
CREATE TABLE IF NOT EXISTS bikes (
    bike_id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    -- AVAILABLE, RESERVED, RENTED, OVERDUE, MAINTENANCE, GEOFENCE_VIOLATION, TAMPER_ALERT
    status VARCHAR(20) DEFAULT 'AVAILABLE',
    lock_state BOOLEAN DEFAULT TRUE,
    last_latitude DECIMAL(10, 8),
    last_longitude DECIMAL(11, 8),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Tabel User / Penyewa
CREATE TABLE IF NOT EXISTS users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    -- user: penyewa PWA, admin: pengelola dashboard monitoring
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    phone_number VARCHAR(20) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_email (email),
    UNIQUE KEY uq_users_phone_number (phone_number)
) ENGINE=InnoDB;

-- 3. Tabel Transaksi Sewa (Rentals)
CREATE TABLE IF NOT EXISTS rentals (
    rental_id INT AUTO_INCREMENT PRIMARY KEY,
    bike_id VARCHAR(20),
    user_id INT,
    start_time DATETIME NULL,
    end_time DATETIME NULL,
    duration_minutes INT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    -- PENDING, SETTLED, EXPIRED, CANCELLED, REFUNDED
    payment_status VARCHAR(20) DEFAULT 'PENDING',
    -- WAITING_PAYMENT, WAITING_EXTEND, ACTIVE, WARNING_SENT, OVERDUE,
    -- COMPLETED, EXPIRED, CANCELLED, EXTENDED, PAID_CONFLICT, EXTENSION_REJECTED
    rental_status VARCHAR(20) DEFAULT 'WAITING_PAYMENT',
    midtrans_order_id VARCHAR(100) UNIQUE,
    -- INITIAL untuk sewa baru, EXTENSION untuk perpanjangan
    rental_type VARCHAR(20) NOT NULL DEFAULT 'INITIAL',
    -- Menunjuk ke rental utama jika rental_type = EXTENSION
    parent_rental_id INT NULL,
    payment_processed_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bike_id) REFERENCES bikes(bike_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_rentals_bike_status (bike_id, rental_status),
    INDEX idx_rentals_parent (parent_rental_id),
    CONSTRAINT fk_rentals_parent
        FOREIGN KEY (parent_rental_id) REFERENCES rentals(rental_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 4. Tabel Log Telemetri GPS (Riwayat Perjalanan)
CREATE TABLE IF NOT EXISTS telemetry_logs (
    log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    bike_id VARCHAR(20),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    speed DECIMAL(5, 2) DEFAULT 0.0,
    mpu_motion BOOLEAN DEFAULT FALSE,
    lock_state BOOLEAN DEFAULT TRUE,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bike_id) REFERENCES bikes(bike_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Seed Data Sepeda Pertama
INSERT INTO bikes (bike_id, name, status, lock_state, last_latitude, last_longitude)
VALUES ('BK-001', 'Sepeda Rental Kampus 01', 'AVAILABLE', TRUE, -7.77351200, 110.38541100)
ON DUPLICATE KEY UPDATE name=VALUES(name);
