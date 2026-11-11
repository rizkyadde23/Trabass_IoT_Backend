const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
const station = require("../config/station");
const { isOutsideGeofence } = require("../services/geofenceService");
const { sendIncidentNotification } = require("../services/notificationService");
const incidentService = require("../services/incidentService");

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
 * Ambang kecepatan (km/jam) untuk menyimpulkan sepeda "masih berjalan"
 * saat waktu sewa sudah habis. Nilai kecil di bawah ambang dianggap
 * noise GPS NEO-6M saat diam.
 */
const OVERDUE_MOVEMENT_SPEED_KMH = 3;

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
 * Kegagalan pencatatan insiden tidak boleh menghentikan engine alert:
 * alarm MQTT dan notifikasi WA tetap harus berjalan.
 */
const safeOpenIncident = async (payload) => {
  try {
    return await incidentService.openIncident(payload);
  } catch (error) {
    console.warn(
      `[INCIDENT] Gagal mencatat insiden ${payload?.bikeId}:`,
      error.message,
    );
    return { created: false, incidentId: null };
  }
};

const safeResolveIncidents = async (bikeId, types) => {
  try {
    return await incidentService.resolveIncidents(bikeId, types);
  } catch (error) {
    console.warn(
      `[INCIDENT] Gagal menutup insiden ${bikeId}:`,
      error.message,
    );
    return 0;
  }
};

/**
 * Konteks sewa aktif (penyewa) untuk atribusi insiden & notifikasi.
 * Kegagalan query tidak boleh menghentikan engine keamanan.
 */
const safeGetRentalContext = async (bikeId) => {
  try {
    return await incidentService.getActiveRentalContext(bikeId);
  } catch (error) {
    console.warn(
      `[INCIDENT] Gagal membaca konteks sewa ${bikeId}:`,
      error.message,
    );
    return null;
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

/**
 * Menerjemahkan reason mentah engine keamanan menjadi label pelanggaran
 * yang mudah dibaca admin di WhatsApp.
 */
const buildViolationLabel = (reason) => {
  const parts = String(reason || "")
    .split(" + ")
    .map((part) => part.trim())
    .filter(Boolean);

  const labels = parts.map((part) => {
    if (part.startsWith("TAMPER_DETECTED_MPU6050")) {
      return "MANIPULASI PAKSA (TAMPER)";
    }
    if (part.startsWith("GEOFENCE_VIOLATION")) {
      return "KELUAR BATAS AREA (GEOFENCE)";
    }
    return part;
  });

  return labels.length > 0 ? labels.join(" + ") : "TIDAK DIKETAHUI";
};

/**
 * Notifikasi WA pelanggaran ke admin dengan format lengkap:
 * ID Sepeda, Nama Penyewa, Jenis Pelanggaran, Waktu, dan Link Insiden.
 */
const sendAlertAndTrack = (
  bikeId,
  reason,
  rentalContext = null,
  location = null,
) => {
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

  void sendIncidentNotification(adminPhone, {
    bikeId,
    userName: rentalContext?.user_name || null,
    userPhone: rentalContext?.user_phone || null,
    typeLabel: buildViolationLabel(reason),
    message: "Sistem telah membunyikan alarm sirene pada sepeda.",
    detectedAt: new Date(),
    latitude: location?.lat ?? null,
    longitude: location?.lng ?? null,
  })
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

    // Baterai dari perception layer (persen 0-100, opsional).
    const rawBattery = toNumberOrNull(payload.battery);
    const batteryPercent =
      rawBattery === null ? null : Math.min(100, Math.max(0, rawBattery));

    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Simpan/update cache real-time di Redis.
    //    Kegagalan Redis tidak boleh menghentikan engine keamanan & update MySQL.
    try {
      if (redisClient.isReady) {
        const cacheValues = {
          lat: String(lat),
          lng: String(lng),
          speed: String(speed),
          lock_state: String(lockState),
          mpu_motion: String(mpuMotion),
          updated_at: nowIso,
        };

        if (batteryPercent !== null) {
          cacheValues.battery = String(batteryPercent);
        }

        await redisClient.hSet(buildLocationKey(bikeId), cacheValues);
      }
    } catch (cacheError) {
      console.warn(
        `[TELEMETRY CACHE] Gagal menyimpan lokasi ${bikeId}:`,
        cacheError.message,
      );
    }

    // 2. Catat log ke database MySQL.
    try {
      await db.query(
        `INSERT INTO telemetry_logs (bike_id, latitude, longitude, speed, mpu_motion, lock_state)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [bikeId, lat, lng, speed, mpuMotion, lockState],
      );
    } catch (logError) {
      console.warn(
        `[TELEMETRY LOG] Gagal mencatat log ${bikeId}:`,
        logError.message,
      );
    }

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

    // Konteks sewa aktif untuk atribusi penyewa pada insiden & notifikasi.
    const rentalContext = await safeGetRentalContext(bikeId);

    // Update koordinat, status kunci, dan baterai setiap paket.
    await db.query(
      batteryPercent !== null
        ? `UPDATE bikes
           SET last_latitude = ?, last_longitude = ?, lock_state = ?, battery_percent = ?
           WHERE bike_id = ?`
        : `UPDATE bikes
           SET last_latitude = ?, last_longitude = ?, lock_state = ?
           WHERE bike_id = ?`,
      batteryPercent !== null
        ? [lat, lng, lockState, batteryPercent, bikeId]
        : [lat, lng, lockState, bikeId],
    );

    // 3.5 Pelanggaran sewa: waktu sewa habis tetapi sepeda masih berjalan.
    if (rentalContext?.rental_status === "OVERDUE") {
      const bikeMoving =
        speed >= OVERDUE_MOVEMENT_SPEED_KMH || mpuMotion === true;

      if (bikeMoving) {
        const overdueResult = await safeOpenIncident({
          bikeId,
          type: "OVERDUE_MOVEMENT",
          severity: "HIGH",
          message:
            "Waktu sewa telah habis tetapi sepeda masih terdeteksi bergerak.",
          latitude: lat,
          longitude: lng,
          speed,
          lockState,
          mpuMotion,
          userId: rentalContext.user_id,
          rentalId: rentalContext.rental_id,
        });

        const shouldNotifyOverdue =
          overdueResult.created &&
          (await claimAlertCooldown(bikeId, "overdue_movement"));

        if (shouldNotifyOverdue) {
          const adminPhone = process.env.ADMIN_PHONE_NUMBER;

          if (adminPhone) {
            void sendIncidentNotification(adminPhone, {
              bikeId,
              userName: rentalContext.user_name,
              userPhone: rentalContext.user_phone,
              typeLabel: "SEWA HABIS — SEPEDA MASIH DIGUNAKAN",
              message: `Durasi sewa ${rentalContext.duration_minutes} menit telah berakhir (sejak ${rentalContext.end_time}), namun sepeda masih bergerak (kecepatan ${speed} km/jam).`,
              detectedAt: new Date(),
              latitude: lat,
              longitude: lng,
            });
          }
        }

        console.warn(
          `[! OVERDUE MOVEMENT !] Sepeda ${bikeId} melewati batas waktu sewa tetapi masih bergerak.`,
        );
      }
    }

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

      const incidentResults = [];

      if (tamperDetected) {
        incidentResults.push(
          await safeOpenIncident({
            bikeId,
            type: "TAMPER",
            severity: "CRITICAL",
            message: "Gerakan terdeteksi saat sepeda terkunci.",
            latitude: lat,
            longitude: lng,
            speed,
            lockState,
            mpuMotion,
            userId: rentalContext?.user_id ?? null,
            rentalId: rentalContext?.rental_id ?? null,
          }),
        );
      }

      if (geofenceViolated) {
        incidentResults.push(
          await safeOpenIncident({
            bikeId,
            type: "GEOFENCE",
            severity: "HIGH",
            message: `Sepeda keluar radius aman (${geofenceCheck.distanceMeter}m dari pangkalan).`,
            latitude: lat,
            longitude: lng,
            distanceM: geofenceCheck.distanceMeter,
            speed,
            lockState,
            mpuMotion,
            userId: rentalContext?.user_id ?? null,
            rentalId: rentalContext?.rental_id ?? null,
          }),
        );
      }

      const hasNewIncident = incidentResults.some((item) => item.created);

      // Insiden baru tidak boleh tetap dibisukan oleh ALARM_OFF sebelumnya.
      if (hasNewIncident && alertState.alarm_muted === "true") {
        await updateAlertCache(bikeId, {
          alarm_muted: "false",
          alarm_muted_at: "",
        });
      }

      const alarmMuted =
        alertState.alarm_muted === "true" && !hasNewIncident;

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

        // Buzzer yang sudah dimatikan admin tidak boleh langsung menyala
        // lagi sebelum ada insiden baru.
        if (!alarmMuted) publishAlarm(bikeId, alertReason);
        sendAlertAndTrack(bikeId, alertReason, rentalContext, {
          lat,
          lng,
        });
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

    // Tutup insiden di database berdasarkan kondisi telemetri saat ini.
    // Ini juga bekerja setelah backend restart walaupun cache Redis kosong.
    const incidentTypesToResolve = [];

    if (!lockState || quietElapsed) {
      incidentTypesToResolve.push("TAMPER");
    }

    if (!geofenceViolated) {
      incidentTypesToResolve.push("GEOFENCE");
    }

    const resolvedIncidentCount =
      incidentTypesToResolve.length > 0
        ? await safeResolveIncidents(bikeId, incidentTypesToResolve)
        : 0;

    if (resolvedIncidentCount > 0) {
      await updateAlertCache(bikeId, {
        alarm_muted: "false",
        alarm_muted_at: "",
      });
    }

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
          alarm_muted: "false",
          alarm_muted_at: "",
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
