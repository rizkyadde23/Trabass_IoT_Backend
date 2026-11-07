const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
const { isOutsideGeofence } = require("../services/geofenceService");

// Koordinat Pusat Pangkalan Utama (Contoh: Area Kampus UPN "Veteran" Yogyakarta)
const STATION_COORDS = {
  lat: -7.773512,
  lng: 110.385411,
  maxRadiusMeter: 500, // Batas aman 500 meter
};

const handleTelemetry = async (topic, message) => {
  try {
    const topicParts = topic.split("/");
    const bikeId = topicParts[2];
    if (!bikeId) return;

    const payload = JSON.parse(message.toString());
    const {
      lat,
      lng,
      speed = 0.0,
      mpu_motion = false,
      lock_state = true,
    } = payload;

    if (lat === undefined || lng === undefined) return;

    // 1. Simpan/Update Cache Real-time di Redis Hash
    const redisKey = `bike:${bikeId}:location`;
    await redisClient.hSet(redisKey, {
      lat: String(lat),
      lng: String(lng),
      speed: String(speed),
      lock_state: String(lock_state),
      mpu_motion: String(mpu_motion),
      updated_at: new Date().toISOString(),
    });

    // 2. Catat Log ke Database MySQL
    await db.query(
      `INSERT INTO telemetry_logs (bike_id, latitude, longitude, speed, mpu_motion, lock_state)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bikeId, lat, lng, speed, mpu_motion, lock_state],
    );

    // 3. LOGIKA SECURITY ENGINE
    let systemAlertTriggered = false;
    let alertReason = "";

    // A. Deteksi Tamper MPU6050 (Guncangan saat kondisi sepeda TERKUNCI)
    if (lock_state === true && mpu_motion === true) {
      systemAlertTriggered = true;
      alertReason = "TAMPER_DETECTED_MPU6050";
      console.warn(
        `[! SECURITY ALERT !] Guncangan terdeteksi pada sepeda ${bikeId} saat terkunci!`,
      );
    }

    // B. Deteksi Pelanggaran Batas Geofencing
    const geofenceCheck = isOutsideGeofence(
      lat,
      lng,
      STATION_COORDS.lat,
      STATION_COORDS.lng,
      STATION_COORDS.maxRadiusMeter,
    );

    if (geofenceCheck.isViolated) {
      systemAlertTriggered = true;
      alertReason = `GEOFENCE_VIOLATION (${geofenceCheck.distanceMeter}m dari pangkalan)`;
      console.warn(
        `[! SECURITY ALERT !] Sepeda ${bikeId} keluar batas aman! Jarak: ${geofenceCheck.distanceMeter}m`,
      );
    }

    // 4. EKSEKUSI ACTION JIKA TERJADI INDIKASI ANOMALI / BAHAYA
    if (systemAlertTriggered) {
      // Publish perintah ALARM_ON langsung ke topik MQTT sepeda
      const commandTopic = `bike/command/${bikeId}`;
      const commandPayload = JSON.stringify({
        action: "ALARM_ON",
        reason: alertReason,
        timestamp: new Date().toISOString(),
      });

      mqttClient.publish(commandTopic, commandPayload, { qos: 1 });
      console.log(`[MQTT PUB] Command Sent to ${commandTopic} -> ALARM_ON`);

      // Update status sepeda di MySQL menjadi TAMPER_ALERT atau GEOFENCE_VIOLATION
      const newBikeStatus = alertReason.includes("GEOFENCE")
        ? "GEOFENCE_VIOLATION"
        : "TAMPER_ALERT";
      await db.query(
        `UPDATE bikes SET status = ?, last_latitude = ?, last_longitude = ? WHERE bike_id = ?`,
        [newBikeStatus, lat, lng, bikeId],
      );
    } else {
      // Jika kondisi normal, update koordinat terakhir sepeda
      await db.query(
        `UPDATE bikes SET last_latitude = ?, last_longitude = ?, lock_state = ? WHERE bike_id = ?`,
        [lat, lng, lock_state, bikeId],
      );
    }
  } catch (error) {
    console.error("[TELEMETRY ERROR] Gagal memproses data:", error.message);
  }
};

module.exports = {
  handleTelemetry,
};
