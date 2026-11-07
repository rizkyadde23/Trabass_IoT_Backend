const db = require('../config/db');
const redisClient = require('../config/redis');

/**
 * Memproses pesan telemetri masuk dari topik MQTT `bike/telemetry/{bike_id}`
 * @param {string} topic Topik MQTT (misal: bike/telemetry/BK-001)
 * @param {Buffer} message Buffer JSON payload dari ESP32
 */
const handleTelemetry = async (topic, message) => {
  try {
    // 1. Ekstrak bike_id dari topik MQTT
    const topicParts = topic.split('/');
    const bikeId = topicParts[2];

    if (!bikeId) {
      console.warn('[TELEMETRY] Topik tidak valid:', topic);
      return;
    }

    // 2. Parse Payload JSON
    const payload = JSON.parse(message.toString());
    const {
      lat,
      lng,
      speed = 0.0,
      mpu_motion = false,
      lock_state = true
    } = payload;

    // Validasi dasar koordinat
    if (lat === undefined || lng === undefined) {
      console.warn(`[TELEMETRY] Payload ${bikeId} tidak memiliki koordinat lat/lng`);
      return;
    }

    // 3. Simpan / Update Caching Real-time di Redis Hash
    const redisKey = `bike:${bikeId}:location`;
    await redisClient.hSet(redisKey, {
      lat: String(lat),
      lng: String(lng),
      speed: String(speed),
      lock_state: String(lock_state),
      mpu_motion: String(mpu_motion),
      updated_at: new Date().toISOString()
    });

    // 4. Catat Riwayat Perjalanan ke Tabel `telemetry_logs` MySQL
    const insertLogSql = `
      INSERT INTO telemetry_logs (bike_id, latitude, longitude, speed, mpu_motion, lock_state)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    await db.query(insertLogSql, [bikeId, lat, lng, speed, mpu_motion, lock_state]);

    // 5. Update Koordinat Terakhir di Tabel `bikes` MySQL
    const updateBikeSql = `
      UPDATE bikes 
      SET last_latitude = ?, last_longitude = ?, lock_state = ?
      WHERE bike_id = ?
    `;
    await db.query(updateBikeSql, [lat, lng, lock_state, bikeId]);

    console.log(`[TELEMETRY RECV] ${bikeId} -> Lat: ${lat}, Lng: ${lng}, Lock: ${lock_state}`);

  } catch (error) {
    console.error('[TELEMETRY ERROR] Gagal memproses pesan MQTT:', error.message);
  }
};

module.exports = {
  handleTelemetry
};