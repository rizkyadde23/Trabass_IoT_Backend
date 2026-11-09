const db = require("../config/db");
const redisClient = require("../config/redis");

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBoolean = (value, fallback = true) => {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "boolean") return value;

  return value === 1 || value === "1" || value === "true";
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

const mapBike = (row, liveLocation) => {
  const hasLiveLocation = Boolean(liveLocation);
  const latitude = hasLiveLocation
    ? toNumberOrNull(liveLocation.lat)
    : toNumberOrNull(row.last_latitude);
  const longitude = hasLiveLocation
    ? toNumberOrNull(liveLocation.lng)
    : toNumberOrNull(row.last_longitude);

  return {
    bike_id: row.bike_id,
    name: row.name,
    status: row.status,
    lock_state: hasLiveLocation
      ? toBoolean(liveLocation.lock_state, toBoolean(row.lock_state))
      : toBoolean(row.lock_state),
    last_latitude: latitude,
    last_longitude: longitude,
    speed: hasLiveLocation ? toNumberOrNull(liveLocation.speed) : null,
    mpu_motion: hasLiveLocation
      ? toBoolean(liveLocation.mpu_motion, false)
      : false,
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
        const liveLocation = await readLiveLocation(row.bike_id);
        return mapBike(row, liveLocation);
      }),
    );

    return res.status(200).json({
      status: "success",
      data: {
        bikes,
        total: bikes.length,
        generated_at: new Date().toISOString(),
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
