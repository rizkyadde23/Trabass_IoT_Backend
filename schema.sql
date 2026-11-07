CREATE DATABASE IF NOT EXISTS bicycle_security_db;
USE bicycle_security_db;

-- 1. Tabel Data Sepeda
CREATE TABLE IF NOT EXISTS bikes (
    bike_id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'AVAILABLE', -- AVAILABLE, RENTED, MAINTENANCE, GEOFENCE_VIOLATION, TAMPER_ALERT
    lock_state BOOLEAN DEFAULT TRUE,
    last_latitude DECIMAL(10, 8),
    last_longitude DECIMAL(11, 8),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Tabel User / Penyewa
CREATE TABLE IF NOT EXISTS users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    payment_status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, SETTLED, EXPIRED, CANCELLED
    rental_status VARCHAR(20) DEFAULT 'WAITING_PAYMENT', -- WAITING_PAYMENT, ACTIVE, COMPLETED, OVERDUE
    midtrans_order_id VARCHAR(100) UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bike_id) REFERENCES bikes(bike_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
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