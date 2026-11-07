const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Verifikasi koneksi saat awal server berjalan
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log('[DB] Berhasil terhubung ke MySQL XAMPP');
    connection.release();
  } catch (error) {
    console.error('[DB ERROR] Gagal terhubung ke MySQL:', error.message);
  }
})();

module.exports = pool;