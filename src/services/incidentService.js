const db = require("../config/db");

/**
 * Insiden keamanan disimpan di MySQL agar riwayat tetap ada walaupun
 * cache Redis dibersihkan atau backend di-restart.
 */
const VALID_TYPES = new Set(["TAMPER", "GEOFENCE"]);
const VALID_STATUSES = new Set(["ACTIVE", "RESOLVED"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const normalizeType = (value) =>
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

const ensureTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS security_incidents (
      incident_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      bike_id VARCHAR(20) NOT NULL,
      incident_type VARCHAR(32) NOT NULL,
      severity VARCHAR(16) NOT NULL DEFAULT 'HIGH',
      status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      message VARCHAR(255) NOT NULL,
      latitude DECIMAL(10, 8) NULL,
      longitude DECIMAL(11, 8) NULL,
      distance_m DECIMAL(10, 2) NULL,
      speed DECIMAL(5, 2) NULL,
      lock_state BOOLEAN NULL,
      mpu_motion BOOLEAN NULL,
      detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME NULL,
      resolved_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bike_id) REFERENCES bikes(bike_id) ON DELETE CASCADE,
      FOREIGN KEY (resolved_by) REFERENCES users(user_id) ON DELETE SET NULL,
      INDEX idx_incidents_detected (detected_at),
      INDEX idx_incidents_status (status, detected_at),
      INDEX idx_incidents_bike (bike_id, detected_at),
      INDEX idx_incidents_type (incident_type, detected_at)
    ) ENGINE=InnoDB`,
  );
};

const toBooleanOrNull = (value) => {
  if (value === null || value === undefined) return null;
  return Boolean(value);
};

/**
 * Membuka insiden baru atau memperbarui insiden aktif dengan tipe yang
 * sama. Dengan cara ini satu kejadian tamper/geofence tidak dicatat
 * berulang kali untuk setiap paket telemetri.
 */
const openIncident = async ({
  bikeId,
  type,
  severity = "HIGH",
  message,
  latitude = null,
  longitude = null,
  distanceM = null,
  speed = null,
  lockState = null,
  mpuMotion = null,
}) => {
  const incidentType = normalizeType(type);

  if (!bikeId || !VALID_TYPES.has(incidentType)) {
    return { created: false, incidentId: null };
  }

  const [activeRows] = await db.query(
    `SELECT incident_id
     FROM security_incidents
     WHERE bike_id = ?
       AND incident_type = ?
       AND status = 'ACTIVE'
     ORDER BY incident_id DESC
     LIMIT 1`,
    [bikeId, incidentType],
  );

  if (activeRows.length > 0) {
    const incidentId = activeRows[0].incident_id;

    await db.query(
      `UPDATE security_incidents
       SET last_seen_at = CURRENT_TIMESTAMP,
           latitude = COALESCE(?, latitude),
           longitude = COALESCE(?, longitude),
           distance_m = COALESCE(?, distance_m),
           speed = COALESCE(?, speed),
           lock_state = COALESCE(?, lock_state),
           mpu_motion = COALESCE(?, mpu_motion)
       WHERE incident_id = ?`,
      [
        latitude,
        longitude,
        distanceM,
        speed,
        toBooleanOrNull(lockState),
        toBooleanOrNull(mpuMotion),
        incidentId,
      ],
    );

    return { created: false, incidentId };
  }

  const [result] = await db.query(
    `INSERT INTO security_incidents
      (bike_id, incident_type, severity, status, message,
       latitude, longitude, distance_m, speed, lock_state, mpu_motion,
       detected_at, last_seen_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      bikeId,
      incidentType,
      severity,
      message || "Insiden keamanan terdeteksi.",
      latitude,
      longitude,
      distanceM,
      speed,
      toBooleanOrNull(lockState),
      toBooleanOrNull(mpuMotion),
    ],
  );

  return { created: true, incidentId: result.insertId };
};

const resolveIncidents = async (bikeId, types) => {
  if (!bikeId) return 0;

  const normalizedTypes = (Array.isArray(types) ? types : [types])
    .map(normalizeType)
    .filter((type) => VALID_TYPES.has(type));

  if (normalizedTypes.length === 0) return 0;

  const placeholders = normalizedTypes.map(() => "?").join(", ");

  const [result] = await db.query(
    `UPDATE security_incidents
     SET status = 'RESOLVED',
         resolved_at = CURRENT_TIMESTAMP
     WHERE bike_id = ?
       AND status = 'ACTIVE'
       AND incident_type IN (${placeholders})`,
    [bikeId, ...normalizedTypes],
  );

  return result.affectedRows;
};

const mapIncident = (row) => ({
  incident_id: row.incident_id,
  bike_id: row.bike_id,
  bike_name: row.bike_name || null,
  incident_type: row.incident_type,
  severity: row.severity,
  status: row.status,
  message: row.message,
  latitude:
    row.latitude === null || row.latitude === undefined
      ? null
      : Number(row.latitude),
  longitude:
    row.longitude === null || row.longitude === undefined
      ? null
      : Number(row.longitude),
  distance_m:
    row.distance_m === null || row.distance_m === undefined
      ? null
      : Number(row.distance_m),
  speed:
    row.speed === null || row.speed === undefined ? null : Number(row.speed),
  lock_state:
    row.lock_state === null || row.lock_state === undefined
      ? null
      : Boolean(row.lock_state),
  mpu_motion:
    row.mpu_motion === null || row.mpu_motion === undefined
      ? null
      : Boolean(row.mpu_motion),
  detected_at: row.detected_at,
  last_seen_at: row.last_seen_at,
  resolved_at: row.resolved_at,
});

const listIncidents = async ({
  status = "ALL",
  type = "ALL",
  bikeId = "",
  afterId = null,
  beforeId = null,
  limit = DEFAULT_LIMIT,
} = {}) => {
  const normalizedStatus = normalizeStatus(status);
  const normalizedType = normalizeType(type);
  const safeLimit = normalizeLimit(limit);
  const safeAfterId = normalizeId(afterId);
  const safeBeforeId = normalizeId(beforeId);

  const conditions = [];
  const params = [];

  if (VALID_STATUSES.has(normalizedStatus)) {
    conditions.push("i.status = ?");
    params.push(normalizedStatus);
  }

  if (VALID_TYPES.has(normalizedType)) {
    conditions.push("i.incident_type = ?");
    params.push(normalizedType);
  }

  if (bikeId) {
    conditions.push("i.bike_id = ?");
    params.push(String(bikeId).trim());
  }

  if (safeAfterId) {
    conditions.push("i.incident_id > ?");
    params.push(safeAfterId);
  }

  if (safeBeforeId) {
    conditions.push("i.incident_id < ?");
    params.push(safeBeforeId);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows] = await db.query(
    `SELECT i.*, b.name AS bike_name
     FROM security_incidents i
     LEFT JOIN bikes b ON b.bike_id = i.bike_id
     ${whereClause}
     ORDER BY i.incident_id DESC
     LIMIT ${safeLimit}`,
    params,
  );

  const [[activeRow]] = await db.query(
    "SELECT COUNT(*) AS total FROM security_incidents WHERE status = 'ACTIVE'",
  );

  return {
    incidents: rows.map(mapIncident),
    total_active: Number(activeRow?.total || 0),
    generated_at: new Date().toISOString(),
  };
};

/**
 * Dipanggil sekali saat startup. Tabel dibuat otomatis agar instalasi
 * baru tidak perlu menjalankan migration manual.
 */
const init = async () => {
  try {
    await ensureTable();
    console.log("[INCIDENT] Tabel security_incidents siap digunakan.");
  } catch (error) {
    console.warn(
      "[INCIDENT] Gagal menyiapkan tabel insiden:",
      error.message,
    );
  }
};

module.exports = {
  init,
  ensureTable,
  openIncident,
  resolveIncidents,
  listIncidents,
};
