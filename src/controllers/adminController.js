const db = require("../config/db");
const redisClient = require("../config/redis");
const station = require("../config/station");
const { isOutsideGeofence } = require("../services/geofenceService");

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

  // Baterai dari perception layer: nilai live Redis diprioritaskan,
  // fallback ke kolom terakhir di MySQL.
  const batteryPercent =
    (hasLiveLocation
      ? toNumberOrNull(liveLocation.battery)
      : null) ?? toNumberOrNull(row.battery_percent);

  // Deteksi geofence dihitung ulang saat data dibaca agar dashboard tetap
  // benar walau status di MySQL belum sempat diperbarui oleh telemetri
  // (misalnya paket terakhir diproses sebelum engine geofence aktif).
  const hasCoordinates = latitude !== null && longitude !== null;
  const geofenceCheck = hasCoordinates
    ? isOutsideGeofence(
        latitude,
        longitude,
        station.lat,
        station.lng,
        station.radiusMeter,
      )
    : { isViolated: false, distanceMeter: null };

  const storedStatus = row.status;
  const geofenceViolated = Boolean(hasCoordinates && geofenceCheck.isViolated);
  const effectiveStatus =
    geofenceViolated && storedStatus !== "TAMPER_ALERT"
      ? "GEOFENCE_VIOLATION"
      : storedStatus;

  return {
    bike_id: row.bike_id,
    name: row.name,
    status: effectiveStatus,
    stored_status: storedStatus,
    geofence_violated: geofenceViolated,
    geofence_distance_m: geofenceCheck.distanceMeter,
    geofence_radius_m: station.radiusMeter,
    lock_state: lockState,
    last_latitude: latitude,
    last_longitude: longitude,
    speed: hasLiveLocation ? toNumberOrNull(liveLocation.speed) : null,
    mpu_motion: mpuMotion,
    battery_percent: batteryPercent,
    battery_low:
      batteryPercent !== null &&
      batteryPercent <= station.lowBatteryThresholdPercent,
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
      `SELECT bike_id, name, status, lock_state, battery_percent,
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

// ---------------------------------------------------------------------------
// Endpoint: Detail satu sepeda untuk halaman monitoring tingkat lanjut
// GET /api/admin/bikes/:bike_id
// ---------------------------------------------------------------------------
const getBikeDetail = async (req, res) => {
  try {
    const bikeId = String(req.params.bike_id || "")
      .trim()
      .toUpperCase();

    const [rows] = await db.query(
      `SELECT bike_id, name, status, lock_state, battery_percent,
              last_latitude, last_longitude, created_at
       FROM bikes
       WHERE bike_id = ?
       LIMIT 1`,
      [bikeId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Sepeda ${bikeId} tidak ditemukan.`,
      });
    }

    const [liveLocation, alertState] = await Promise.all([
      readLiveLocation(bikeId),
      readAlertState(bikeId),
    ]);

    // Sesi sewa yang sedang berjalan (dipakai tombol "Akhiri Sesi" di
    // dashboard admin). Sesi aktif selalu berupa rental INITIAL; bila belum
    // ada, tampilkan pembayaran awal yang masih menunggu.
    const [activeRentalRows] = await db.query(
      `SELECT r.rental_id, r.user_id, r.rental_type, r.rental_status,
              r.payment_status, r.duration_minutes, r.amount,
              r.start_time, r.end_time,
              u.name AS user_name, u.phone_number
       FROM rentals r
       JOIN users u ON u.user_id = r.user_id
       WHERE r.bike_id = ?
         AND r.rental_type = 'INITIAL'
         AND r.rental_status IN ('ACTIVE', 'WARNING_SENT', 'OVERDUE')
       ORDER BY r.rental_id DESC
       LIMIT 1`,
      [bikeId],
    );

    const activeRental = activeRentalRows[0] || null;
    let pendingPayment = null;

    if (!activeRental) {
      const [pendingPaymentRows] = await db.query(
        `SELECT r.rental_id, r.user_id, r.rental_status, r.payment_status,
                r.duration_minutes, r.amount, r.start_time, r.end_time,
                u.name AS user_name, u.phone_number
         FROM rentals r
         JOIN users u ON u.user_id = r.user_id
         WHERE r.bike_id = ?
           AND r.rental_type = 'INITIAL'
           AND r.payment_status = 'PENDING'
           AND r.rental_status = 'WAITING_PAYMENT'
         ORDER BY r.rental_id DESC
         LIMIT 1`,
        [bikeId],
      );

      pendingPayment = pendingPaymentRows[0] || null;
    }

    return res.status(200).json({
      status: "success",
      data: {
        bike: mapBike(rows[0], liveLocation, alertState),
        active_rental: activeRental,
        pending_payment: pendingPayment,
        geofence: {
          lat: station.lat,
          lng: station.lng,
          radius_m: station.radiusMeter,
        },
      },
    });
  } catch (error) {
    console.error("[ADMIN BIKE DETAIL ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengambil detail sepeda.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Riwayat telemetri terbaru satu sepeda
// GET /api/admin/bikes/:bike_id/telemetry?limit=50
// Sumber: tabel telemetry_logs hasil paket MQTT dari perception layer ESP32.
// ---------------------------------------------------------------------------
const getBikeTelemetry = async (req, res) => {
  try {
    const bikeId = String(req.params.bike_id || "")
      .trim()
      .toUpperCase();

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;

    const [bikeRows] = await db.query(
      "SELECT bike_id FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    if (bikeRows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Sepeda ${bikeId} tidak ditemukan.`,
      });
    }

    const [logs] = await db.query(
      `SELECT log_id, latitude, longitude, speed, mpu_motion, lock_state, recorded_at
       FROM telemetry_logs
       WHERE bike_id = ?
       ORDER BY recorded_at DESC, log_id DESC
       LIMIT ?`,
      [bikeId, limit],
    );

    return res.status(200).json({
      status: "success",
      data: {
        bike_id: bikeId,
        total: logs.length,
        logs: logs.map((log) => ({
          log_id: log.log_id,
          latitude: toNumberOrNull(log.latitude),
          longitude: toNumberOrNull(log.longitude),
          speed: toNumberOrNull(log.speed),
          mpu_motion: toBoolean(log.mpu_motion, false),
          lock_state: toBoolean(log.lock_state, true),
          recorded_at: log.recorded_at,
        })),
      },
    });
  } catch (error) {
    console.error("[ADMIN BIKE TELEMETRY ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengambil riwayat telemetri sepeda.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Tambah sepeda baru ke armada
// POST /api/admin/bikes
// ---------------------------------------------------------------------------
const BIKE_ID_REGEX = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const BIKE_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "RENTED",
  "OVERDUE",
  "MAINTENANCE",
  "GEOFENCE_VIOLATION",
  "TAMPER_ALERT",
];

const createBike = async (req, res) => {
  try {
    const bikeId = String(req.body?.bike_id || "")
      .trim()
      .toUpperCase();
    const name = String(req.body?.name || "").trim();
    const status = String(req.body?.status || "AVAILABLE")
      .trim()
      .toUpperCase();
    const lockState = toBoolean(req.body?.lock_state, true);
    const latitude = toNumberOrNull(req.body?.last_latitude);
    const longitude = toNumberOrNull(req.body?.last_longitude);

    if (!BIKE_ID_REGEX.test(bikeId)) {
      return res.status(400).json({
        status: "error",
        message:
          "ID sepeda tidak valid. Gunakan 2-20 karakter huruf besar, angka, " +
          "atau tanda hubung dan diawali huruf/angka (contoh: BK-002).",
      });
    }

    if (!name || name.length > 50) {
      return res.status(400).json({
        status: "error",
        message: "Nama sepeda wajib diisi (maksimal 50 karakter).",
      });
    }

    if (!BIKE_STATUSES.includes(status)) {
      return res.status(400).json({
        status: "error",
        message: `Status tidak valid. Pilihan: ${BIKE_STATUSES.join(", ")}.`,
      });
    }

    if ((latitude === null) !== (longitude === null)) {
      return res.status(400).json({
        status: "error",
        message: "Latitude dan longitude harus diisi bersamaan.",
      });
    }

    if (latitude !== null && (latitude < -90 || latitude > 90)) {
      return res.status(400).json({
        status: "error",
        message: "Latitude harus berada di rentang -90 sampai 90.",
      });
    }

    if (longitude !== null && (longitude < -180 || longitude > 180)) {
      return res.status(400).json({
        status: "error",
        message: "Longitude harus berada di rentang -180 sampai 180.",
      });
    }

    const [existing] = await db.query(
      "SELECT bike_id FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    if (existing.length > 0) {
      return res.status(409).json({
        status: "error",
        message: `Sepeda ${bikeId} sudah terdaftar. Gunakan ID lain.`,
      });
    }

    await db.query(
      `INSERT INTO bikes (bike_id, name, status, lock_state, last_latitude, last_longitude)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bikeId, name, status, lockState, latitude, longitude],
    );

    return res.status(201).json({
      status: "success",
      message: `Sepeda ${bikeId} berhasil ditambahkan ke armada.`,
      data: {
        bike_id: bikeId,
        name,
        status,
        lock_state: lockState,
        last_latitude: latitude,
        last_longitude: longitude,
      },
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        status: "error",
        message: `Sepeda sudah terdaftar. Gunakan ID lain.`,
      });
    }

    console.error("[ADMIN CREATE BIKE ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal menambahkan sepeda.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Ubah data sepeda (nama, status, status kunci)
// PUT /api/admin/bikes/:bike_id
// ---------------------------------------------------------------------------
const updateBike = async (req, res) => {
  try {
    const bikeId = String(req.params.bike_id || "")
      .trim()
      .toUpperCase();

    const [rows] = await db.query(
      "SELECT bike_id, name, status, lock_state FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Sepeda ${bikeId} tidak ditemukan.`,
      });
    }

    const updates = {};
    const values = [];

    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim();

      if (!name || name.length > 50) {
        return res.status(400).json({
          status: "error",
          message: "Nama sepeda wajib diisi (maksimal 50 karakter).",
        });
      }

      updates.name = name;
      values.push(name);
    }

    if (req.body?.status !== undefined) {
      const status = String(req.body.status || "")
        .trim()
        .toUpperCase();

      if (!BIKE_STATUSES.includes(status)) {
        return res.status(400).json({
          status: "error",
          message: `Status tidak valid. Pilihan: ${BIKE_STATUSES.join(", ")}.`,
        });
      }

      updates.status = status;
      values.push(status);
    }

    if (req.body?.lock_state !== undefined) {
      updates.lock_state = toBoolean(req.body.lock_state, true);
      values.push(updates.lock_state);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        status: "error",
        message: "Tidak ada perubahan. Kirim name, status, atau lock_state.",
      });
    }

    const setClause = Object.keys(updates)
      .map((column) => `${column} = ?`)
      .join(", ");

    await db.query(
      `UPDATE bikes SET ${setClause} WHERE bike_id = ?`,
      [...values, bikeId],
    );

    const [freshRows] = await db.query(
      "SELECT bike_id, name, status, lock_state FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    return res.status(200).json({
      status: "success",
      message: `Sepeda ${bikeId} berhasil diperbarui.`,
      data: freshRows[0],
    });
  } catch (error) {
    console.error("[ADMIN UPDATE BIKE ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal memperbarui sepeda.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Hapus sepeda dari armada
// DELETE /api/admin/bikes/:bike_id
// Riwayat sewa, telemetri, insiden, dan log perintah ikut terhapus
// (FK ON DELETE CASCADE). Sepeda dengan sesi sewa aktif ditolak.
// ---------------------------------------------------------------------------
const deleteBike = async (req, res) => {
  try {
    const bikeId = String(req.params.bike_id || "")
      .trim()
      .toUpperCase();

    const [rows] = await db.query(
      "SELECT bike_id, name FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Sepeda ${bikeId} tidak ditemukan.`,
      });
    }

    const [activeRentals] = await db.query(
      `SELECT rental_id, rental_status
       FROM rentals
       WHERE bike_id = ?
         AND rental_status IN
             ('WAITING_PAYMENT', 'WAITING_EXTEND', 'ACTIVE', 'WARNING_SENT', 'OVERDUE')
       LIMIT 1`,
      [bikeId],
    );

    if (activeRentals.length > 0) {
      return res.status(409).json({
        status: "error",
        message:
          `Sepeda ${bikeId} masih memiliki sesi sewa aktif ` +
          `(${activeRentals[0].rental_status}). Akhiri sesi terlebih dahulu ` +
          `sebelum menghapus sepeda.`,
      });
    }

    await db.query("DELETE FROM bikes WHERE bike_id = ?", [bikeId]);

    return res.status(200).json({
      status: "success",
      message: `Sepeda ${bikeId} (${rows[0].name || "tanpa nama"}) berhasil dihapus beserta riwayatnya.`,
      data: { bike_id: bikeId },
    });
  } catch (error) {
    console.error("[ADMIN DELETE BIKE ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal menghapus sepeda.",
    });
  }
};

module.exports = {
  getBikes,
  getBikeDetail,
  getBikeTelemetry,
  createBike,
  updateBike,
  deleteBike,
};
