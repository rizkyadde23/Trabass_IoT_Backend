const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");

/**
 * Perintah admin dipetakan ke action MQTT yang dipahami firmware.
 * FORCE_LOCK/FORCE_UNLOCK memakai action lama LOCK/UNLOCK, sedangkan
 * ALARM_OFF adalah action baru yang harus didukung firmware.
 */
const ADMIN_ACTIONS = {
  FORCE_LOCK: {
    mqttAction: "LOCK",
    label: "Force Lock",
    lockState: true,
  },
  FORCE_UNLOCK: {
    mqttAction: "UNLOCK",
    label: "Force Unlock",
    lockState: false,
  },
  ALARM_OFF: {
    mqttAction: "ALARM_OFF",
    label: "Turn Off Alarm",
    lockState: null,
  },
};

const VALID_ACTION_KEYS = new Set(Object.keys(ADMIN_ACTIONS));
const VALID_LOG_STATUSES = new Set(["SENT", "FAILED"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const normalizeAction = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeStatus = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeLimit = (value) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const buildError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const ensureTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS admin_command_logs (
      command_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      admin_user_id INT NULL,
      bike_id VARCHAR(20) NOT NULL,
      action VARCHAR(32) NOT NULL,
      mqtt_action VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL,
      reason VARCHAR(255) NULL,
      error_message VARCHAR(255) NULL,
      ip_address VARCHAR(45) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
      FOREIGN KEY (bike_id) REFERENCES bikes(bike_id) ON DELETE CASCADE,
      INDEX idx_command_created (created_at),
      INDEX idx_command_bike (bike_id, created_at),
      INDEX idx_command_status (status, created_at)
    ) ENGINE=InnoDB`,
  );
};

const writeLog = async ({
  adminUserId = null,
  bikeId,
  action,
  mqttAction,
  status,
  reason = null,
  errorMessage = null,
  ipAddress = null,
}) => {
  try {
    await db.query(
      `INSERT INTO admin_command_logs
        (admin_user_id, bike_id, action, mqtt_action, status,
         reason, error_message, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminUserId,
        bikeId,
        action,
        mqttAction,
        status,
        reason ? String(reason).slice(0, 255) : null,
        errorMessage ? String(errorMessage).slice(0, 255) : null,
        ipAddress ? String(ipAddress).slice(0, 45) : null,
      ],
    );
  } catch (error) {
    console.warn(
      `[COMMAND LOG] Gagal menyimpan audit ${action} untuk ${bikeId}:`,
      error.message,
    );
  }
};

const publishCommand = (bikeId, payload) => {
  if (!mqttClient.connected) {
    throw buildError(
      "Broker MQTT belum terhubung. Perintah tidak dapat dikirim.",
      503,
    );
  }

  const topic = `bike/command/${bikeId}`;

  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      JSON.stringify(payload),
      { qos: 1 },
      (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ topic });
      },
    );
  });
};

const updateBikeState = async (bikeId, lockState) => {
  await db.query("UPDATE bikes SET lock_state = ? WHERE bike_id = ?", [
    lockState,
    bikeId,
  ]);

  try {
    if (redisClient.isReady) {
      const locationKey = `bike:${bikeId}:location`;
      const exists = await redisClient.exists(locationKey);

      // Jangan membuat hash baru tanpa koordinat: dashboard akan
      // menganggap sepeda punya lokasi live padahal lat/lng kosong.
      if (exists) {
        await redisClient.hSet(locationKey, {
          lock_state: lockState ? "true" : "false",
          updated_at: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    console.warn(
      `[COMMAND CACHE] Gagal memperbarui cache kunci ${bikeId}:`,
      error.message,
    );
  }
};

const muteActiveAlarm = async (bikeId, adminUserId) => {
  try {
    if (!redisClient.isReady) return false;

    const alertKey = `bike:${bikeId}:alert`;
    const alertState = await redisClient.hGetAll(alertKey);

    if (!alertState || alertState.active !== "true") return false;

    await redisClient.hSet(alertKey, {
      alarm_muted: "true",
      alarm_muted_at: new Date().toISOString(),
      alarm_muted_by: String(adminUserId || ""),
    });

    return true;
  } catch (error) {
    console.warn(
      `[COMMAND CACHE] Gagal mematikan alarm ${bikeId}:`,
      error.message,
    );
    return false;
  }
};

const sendCommand = async ({
  adminUserId = null,
  bikeId,
  action,
  reason = "",
  ipAddress = null,
}) => {
  const normalizedBikeId = String(bikeId || "").trim();
  const normalizedAction = normalizeAction(action);

  if (!normalizedBikeId) {
    throw buildError("bike_id wajib diisi.", 400);
  }

  if (!VALID_ACTION_KEYS.has(normalizedAction)) {
    throw buildError(
      "Action tidak valid. Gunakan FORCE_LOCK, FORCE_UNLOCK, atau ALARM_OFF.",
      400,
    );
  }

  const actionSpec = ADMIN_ACTIONS[normalizedAction];

  const [bikes] = await db.query(
    `SELECT bike_id, name, status, lock_state
     FROM bikes
     WHERE bike_id = ?`,
    [normalizedBikeId],
  );

  if (bikes.length === 0) {
    throw buildError(
      `Sepeda ${normalizedBikeId} tidak ditemukan.`,
      404,
    );
  }

  const bike = bikes[0];
  const sentAt = new Date().toISOString();
  const payload = {
    action: actionSpec.mqttAction,
    reason: reason ? String(reason).slice(0, 255) : "ADMIN_MANUAL",
    source: "ADMIN_DASHBOARD",
    admin_user_id: adminUserId,
    timestamp: sentAt,
  };

  let topic = `bike/command/${normalizedBikeId}`;

  try {
    const publishResult = await publishCommand(normalizedBikeId, payload);
    topic = publishResult.topic;
  } catch (error) {
    await writeLog({
      adminUserId,
      bikeId: normalizedBikeId,
      action: normalizedAction,
      mqttAction: actionSpec.mqttAction,
      status: "FAILED",
      reason,
      errorMessage: error.message,
      ipAddress,
    });

    if (error.statusCode) throw error;
    throw buildError(
      `Gagal mengirim perintah ke ${normalizedBikeId}: ${error.message}`,
      503,
    );
  }

  let stateUpdated = false;

  if (actionSpec.lockState !== null) {
    try {
      await updateBikeState(normalizedBikeId, actionSpec.lockState);
      stateUpdated = true;
    } catch (error) {
      console.warn(
        `[COMMAND DB] Perintah terkirim tetapi gagal update status ${normalizedBikeId}:`,
        error.message,
      );
    }
  }

  let alarmMuted = false;

  if (normalizedAction === "ALARM_OFF") {
    alarmMuted = await muteActiveAlarm(normalizedBikeId, adminUserId);
    stateUpdated = alarmMuted;
  }

  await writeLog({
    adminUserId,
    bikeId: normalizedBikeId,
    action: normalizedAction,
    mqttAction: actionSpec.mqttAction,
    status: "SENT",
    reason,
    ipAddress,
  });

  return {
    bike_id: normalizedBikeId,
    bike_name: bike.name,
    action: normalizedAction,
    action_label: actionSpec.label,
    mqtt_action: actionSpec.mqttAction,
    status: "SENT",
    topic,
    sent_at: sentAt,
    state_updated: stateUpdated,
    alarm_muted: alarmMuted,
  };
};

const mapCommandLog = (row) => ({
  command_id: row.command_id,
  admin_user_id: row.admin_user_id,
  admin_name: row.admin_name || null,
  bike_id: row.bike_id,
  bike_name: row.bike_name || null,
  action: row.action,
  action_label:
    ADMIN_ACTIONS[row.action]?.label || row.action,
  mqtt_action: row.mqtt_action,
  status: row.status,
  reason: row.reason,
  error_message: row.error_message,
  ip_address: row.ip_address,
  created_at: row.created_at,
});

const listCommandLogs = async ({
  bikeId = "",
  action = "ALL",
  status = "ALL",
  afterId = null,
  beforeId = null,
  limit = DEFAULT_LIMIT,
} = {}) => {
  const normalizedAction = normalizeAction(action);
  const normalizedStatus = normalizeStatus(status);
  const safeLimit = normalizeLimit(limit);
  const safeAfterId = normalizeId(afterId);
  const safeBeforeId = normalizeId(beforeId);

  const conditions = [];
  const params = [];

  if (bikeId) {
    conditions.push("c.bike_id = ?");
    params.push(String(bikeId).trim());
  }

  if (VALID_ACTION_KEYS.has(normalizedAction)) {
    conditions.push("c.action = ?");
    params.push(normalizedAction);
  }

  if (VALID_LOG_STATUSES.has(normalizedStatus)) {
    conditions.push("c.status = ?");
    params.push(normalizedStatus);
  }

  if (safeAfterId) {
    conditions.push("c.command_id > ?");
    params.push(safeAfterId);
  }

  if (safeBeforeId) {
    conditions.push("c.command_id < ?");
    params.push(safeBeforeId);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT c.*, u.name AS admin_name, b.name AS bike_name
     FROM admin_command_logs c
     LEFT JOIN users u ON u.user_id = c.admin_user_id
     LEFT JOIN bikes b ON b.bike_id = c.bike_id
     ${whereClause}
     ORDER BY c.command_id DESC
     LIMIT ${safeLimit}`,
    params,
  );

  return {
    commands: rows.map(mapCommandLog),
    generated_at: new Date().toISOString(),
  };
};

/**
 * Dipanggil sekali saat startup agar tabel audit tersedia.
 */
const init = async () => {
  try {
    await ensureTable();
    console.log("[COMMAND] Tabel admin_command_logs siap digunakan.");
  } catch (error) {
    console.warn(
      "[COMMAND] Gagal menyiapkan tabel audit perintah:",
      error.message,
    );
  }
};

module.exports = {
  init,
  ensureTable,
  sendCommand,
  listCommandLogs,
  ADMIN_ACTIONS,
};
