const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
const station = require("../config/station");
const { isOutsideGeofence } = require("../services/geofenceService");
const { sendSecurityAlert } = require("../services/notificationService");

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

const buildLocationKey = (bikeId) => `bike:${bikeId}:location`;
const buildAlertKey = (bikeId) => `bike:${bikeId}:alert`;
const buildCooldownKey = (bikeId, type) =>
  `bike:${bikeId}:alert:cooldown:${type}`;

const readAlertCache = async (bikeId) => {
  try {
    if (!redisClient.isReady) return {};

    const alertState = await redisClient.hGetAll(buildAlertKey(bikeId));
    return alertState || {};
  } catch (error) {
    console.warn(
      `[ALERT CACHE] Gagal membaca alert ${bikeId}:`,
      error.message,
    );
    return {};
  }
};

const updateAlertCache = async (bikeId, values) => {
  try {
    if (!redisClient.isReady) return;

    await redisClient.hSet(buildAlertKey(bikeId), values);
  } catch (error) {
    console.warn(
      `[ALERT CACHE] Gagal menyimpan alert ${bikeId}:`,
      error.message,
    );
  }
};

/**
 * Cooldown mencegah WA dan alarm MQTT dikirim berulang untuk getaran yang
 * sama. Data telemetri dan status dashboard tetap diperbarui setiap paket.
 */
const claimAlertCooldown = async (bikeId, type) => {
  try {
    if (!redisClient.isReady) return true;

    const result = await redisClient.set(
      buildCooldownKey(bikeId, type),
      "1",
      {
        NX: true,
        EX: Math.max(1, station.tamperCooldownSeconds),
      },
    );

    return result === "OK";
  } catch (error) {
    console.warn(
      `[ALERT COOLDOWN] Gagal mengunci cooldown ${bikeId}:`,
      error.message,
    );
    return true;
  }
};

const publishAlarm = (bikeId, reason) => {
  const commandTopic = `bike/command/${bikeId}`;
  const commandPayload = JSON.stringify({
    action: "ALARM_ON",
    reason,
    timestamp: new Date().toISOString(),
  });

  mqttClient.publish(commandTopic, commandPayload, { qos: 1 }, (error) => {
    if (error) {
      console.error(
        `[MQTT ERROR] Gagal mengirim ALARM_ON ke ${bikeId}:`,
        error.message,
      );
      return;
    }

    console.log(`[MQTT PUB] Command sent to ${commandTopic} -> ALARM_ON`);
  });
};

const sendAlertAndTrack = (bikeId, reason) => {
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;
  const notifiedAt = new Date().toISOString();

  if (!adminPhone) {
    void updateAlertCache(bikeId, {
      notified: "false",
      notified_at: notifiedAt,
      notify_error: "ADMIN_PHONE_NUMBER tidak tersedia",
    });
    return;
  }

  void sendSecurityAlert(adminPhone, bikeId, reason)
    .then((sent) => {
      void updateAlertCache(bikeId, {
        notified: String(sent),
        notified_at: new Date().toISOString(),
        notify_error: sent ? "" : "WA gagal, fallback SMS diproses",
      });
    })
    .catch((error) => {
      void updateAlertCache(bikeId, {
        notified: "false",
        notified_at: new Date().toISOString(),
        notify_error: error.message,
      });
    });
};

/**
 * Mengembalikan status sepeda ke kondisi yang sesuai setelah alert selesai.
 * Status diambil dari rental aktif agar sepeda yang masih disewa tidak
 * berubah menjadi AVAILABLE.
 */
const resolveBikeStatusAfterAlert = async (bikeId, targetStatuses) => {
  const [bikes] = await db.query(
    "SELECT status FROM bikes WHERE bike_id = ?",
    [bikeId],
  );

  if (
    bikes.length === 0 ||
    !targetStatuses.includes(bikes[0].status)
  ) {
    return null;
  }

  const [rentals] = await db.query(
    `SELECT rental_status
     FROM rentals
     WHERE bike_id = ?
       AND rental_status IN ('ACTIVE', 'WARNING_SENT', 'OVERDUE')
     ORDER BY rental_id DESC
     LIMIT 1`,
    [bikeId],
  );

  let nextStatus = "AVAILABLE";

  if (rentals.length > 0) {
    nextStatus =
      rentals[0].rental_status === "OVERDUE" ? "OVERDUE" : "RENTED";
  }

  await db.query("UPDATE bikes SET status = ? WHERE bike_id = ?", [
    nextStatus,
    bikeId,
  ]);

  return nextStatus;
};

const handleTelemetry = async (topic, message) => {
  try {
    const topicParts = topic.split("/");
    const bikeId = topicParts[2];
    if (!bikeId) return;

    const payload = JSON.parse(message.toString());
    const lat = toNumberOrNull(payload.lat);
    const lng = toNumberOrNull(payload.lng);

    if (lat === null || lng === null) return;

    const speed = toNumberOrNull(payload.speed) ?? 0;
    const mpuMotion = toBoolean(payload.mpu_motion, false);
    const lockState = toBoolean(payload.lock_state, true);
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Simpan/update cache real-time di Redis.
    await redisClient.hSet(buildLocationKey(bikeId), {
      lat: String(lat),
      lng: String(lng),
      speed: String(speed),
      lock_state: String(lockState),
      mpu_motion: String(mpuMotion),
      updated_at: nowIso,
    });

    // 2. Catat log ke database MySQL.
    await db.query(
      `INSERT INTO telemetry_logs (bike_id, latitude, longitude, speed, mpu_motion, lock_state)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bikeId, lat, lng, speed, mpuMotion, lockState],
    );

    // 3. Security engine.
    const alertState = await readAlertCache(bikeId);
    const geofenceCheck = isOutsideGeofence(
      lat,
      lng,
      station.lat,
      station.lng,
      station.radiusMeter,
    );

    const tamperDetected = lockState === true && mpuMotion === true;
    const geofenceViolated = geofenceCheck.isViolated;
    const alertReasons = [];

    if (tamperDetected) alertReasons.push("TAMPER_DETECTED_MPU6050");
    if (geofenceViolated) {
      alertReasons.push(
        `GEOFENCE_VIOLATION (${geofenceCheck.distanceMeter}m dari pangkalan)`,
      );
    }

    const alertReason = alertReasons.join(" + ");

    // Update koordinat dan status kunci setiap paket.
    await db.query(
      `UPDATE bikes
       SET last_latitude = ?, last_longitude = ?, lock_state = ?
       WHERE bike_id = ?`,
      [lat, lng, lockState, bikeId],
    );

    if (tamperDetected || geofenceViolated) {
      const newBikeStatus = tamperDetected
        ? "TAMPER_ALERT"
        : "GEOFENCE_VIOLATION";
      const alertType =
        tamperDetected && geofenceViolated
          ? "tamper+geofence"
          : tamperDetected
            ? "tamper"
            : "geofence";

      await db.query(
        "UPDATE bikes SET status = ? WHERE bike_id = ?",
        [newBikeStatus, bikeId],
      );

      await updateAlertCache(bikeId, {
        reason: alertReason,
        at: nowIso,
        active: "true",
        type: alertType,
        ...(tamperDetected ? { last_motion_at: nowIso } : {}),
      });

      const cooldownType = tamperDetected ? "tamper" : "geofence";
      const shouldNotify = await claimAlertCooldown(
        bikeId,
        cooldownType,
      );

      if (shouldNotify) {
        await updateAlertCache(bikeId, {
          notified: "pending",
          notified_at: nowIso,
        });

        publishAlarm(bikeId, alertReason);
        sendAlertAndTrack(bikeId, alertReason);
      }

      if (tamperDetected) {
        console.warn(
          `[! SECURITY ALERT !] Gerakan terdeteksi pada ${bikeId} saat terkunci.`,
        );
      }

      if (geofenceViolated) {
        console.warn(
          `[! SECURITY ALERT !] Sepeda ${bikeId} keluar batas aman. Jarak: ${geofenceCheck.distanceMeter}m`,
        );
      }

      return;
    }

    // 4. Kondisi normal: cek apakah alert lama sudah boleh direset.
    const lastMotionMs = alertState.last_motion_at
      ? new Date(alertState.last_motion_at).getTime()
      : NaN;
    const quietElapsed =
      !Number.isFinite(lastMotionMs) ||
      now.getTime() - lastMotionMs >= station.tamperResetSeconds * 1000;

    const shouldResolveTamper =
      alertState.active === "true" && (!lockState || quietElapsed);
    const shouldResolveGeofence =
      alertState.type === "geofence" ||
      String(alertState.reason || "").includes("GEOFENCE_VIOLATION");

    if (shouldResolveTamper || shouldResolveGeofence) {
      const targetStatuses = [];

      if (shouldResolveTamper) targetStatuses.push("TAMPER_ALERT");
      if (shouldResolveGeofence) targetStatuses.push("GEOFENCE_VIOLATION");

      const resolvedStatus = await resolveBikeStatusAfterAlert(
        bikeId,
        targetStatuses,
      );

      if (resolvedStatus) {
        await updateAlertCache(bikeId, {
          active: "false",
          resolved_at: nowIso,
          resolved_status: resolvedStatus,
        });

        console.log(
          `[SECURITY RESET] ${bikeId} kembali ke status ${resolvedStatus}.`,
        );
      }
    }
  } catch (error) {
    console.error(
      "[TELEMETRY ERROR] Gagal memproses data:",
      error.message,
    );
  }
};

module.exports = {
  handleTelemetry,
};
