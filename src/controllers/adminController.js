const db = require("../config/db");
const redisClient = require("../config/redis");
const station = require("../config/station");

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBoolean = (value, fallback = false) => {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "locked"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "unlocked"].includes(normalized)) {
    return false;
  }

  return fallback;
};

/**
 * Redis menyimpan posisi terbaru hasil telemetri MQTT.
 * Jika Redis belum siap atau key belum ada, dashboard tetap memakai
 * koordinat terakhir dari MySQL.
 */
const readLiveLocation = async (bikeId) => {
  try {
    if (!redisClient.isReady) return null;

    const location = await redisClient.hGetAll(`bike:${bikeId}:location`);

    if (!location || Object.keys(location).length === 0) return null;

    return location;
  } catch (error) {
    console.warn(
      `[ADMIN] Gagal membaca lokasi Redis untuk ${bikeId}:`,
      error.message,
    );
    return null;
  }
};

const readAlertState = async (bikeId) => {
  try {
    if (!redisClient.isReady) return null;

    const alert = await redisClient.hGetAll(`bike:${bikeId}:alert`);

    if (!alert || Object.keys(alert).length === 0) return null;

    return alert;
  } catch (error) {
    console.warn(
      `[ADMIN] Gagal membaca alert Redis untuk ${bikeId}:`,
      error.message,
    );
    return null;
  }
};

const mapNotified = (value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};

const mapBike = (row, liveLocation, alertState) => {
  const hasLiveLocation = Boolean(liveLocation);
  const latitude = hasLiveLocation
    ? toNumberOrNull(liveLocation.lat)
    : toNumberOrNull(row.last_latitude);
  const longitude = hasLiveLocation
    ? toNumberOrNull(liveLocation.lng)
    : toNumberOrNull(row.last_longitude);
  const lockState = hasLiveLocation
    ? toBoolean(liveLocation.lock_state, toBoolean(row.lock_state))
    : toBoolean(row.lock_state);
  const mpuMotion = hasLiveLocation
    ? toBoolean(liveLocation.mpu_motion, false)
    : false;

  return {
    bike_id: row.bike_id,
    name: row.name,
    status: row.status,
    lock_state: lockState,
    last_latitude: latitude,
    last_longitude: longitude,
    speed: hasLiveLocation ? toNumberOrNull(liveLocation.speed) : null,
    mpu_motion: mpuMotion,
    imu_alert: lockState === true && mpuMotion === true,
    imu_alert_reason: alertState?.reason || null,
    imu_alert_at: alertState?.at || null,
    imu_alert_notified: mapNotified(alertState?.notified),
    imu_alert_active: alertState?.active === "true",
    last_reported_at:
      (hasLiveLocation && liveLocation.updated_at) ||
      row.created_at ||
      null,
    has_live_location: hasLiveLocation,
  };
};

// ---------------------------------------------------------------------------
// Endpoint: Daftar seluruh armada untuk dashboard admin
// GET /api/admin/bikes
// ---------------------------------------------------------------------------
const getBikes = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT bike_id, name, status, lock_state,
              last_latitude, last_longitude, created_at
       FROM bikes
       ORDER BY bike_id ASC`,
    );

    const bikes = await Promise.all(
      rows.map(async (row) => {
        const [liveLocation, alertState] = await Promise.all([
          readLiveLocation(row.bike_id),
          readAlertState(row.bike_id),
        ]);

        return mapBike(row, liveLocation, alertState);
      }),
    );

    return res.status(200).json({
      status: "success",
      data: {
        bikes,
        total: bikes.length,
        generated_at: new Date().toISOString(),
        geofence: {
          lat: station.lat,
          lng: station.lng,
          radius_m: station.radiusMeter,
        },
      },
    });
  } catch (error) {
    console.error("[ADMIN BIKES ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengambil data armada.",
    });
  }
};

module.exports = {
  getBikes,
};
