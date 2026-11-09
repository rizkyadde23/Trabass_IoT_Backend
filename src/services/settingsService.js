const db = require("../config/db");
const station = require("../config/station");
const pricing = require("../config/pricing");

/**
 * Pengaturan aplikasi disimpan sebagai key-value di tabel app_settings.
 * Nilai di tabel ini menjadi sumber kebenaran saat runtime sehingga
 * perubahan dari halaman Pengaturan admin langsung berlaku tanpa restart.
 */
const SETTING_KEYS = {
  stationLat: "station_lat",
  stationLng: "station_lng",
  geofenceRadius: "geofence_radius_m",
  rentalPrice: "rental_price_per_minute",
  extensionPrice: "extension_price_per_minute",
  minRentalMinutes: "min_rental_minutes",
  maxRentalMinutes: "max_rental_minutes",
};

const toFiniteNumber = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ensureTable = async () => {
  await db.query(
    `CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
  );
};

const readStoredSettings = async () => {
  const [rows] = await db.query(
    "SELECT setting_key, setting_value, updated_at FROM app_settings",
  );

  return rows.reduce((result, row) => {
    result[row.setting_key] = {
      value: row.setting_value,
      updatedAt: row.updated_at,
    };
    return result;
  }, {});
};

/**
 * Menyalin nilai dari tabel ke objek konfigurasi yang dipakai engine
 * geofence (station) dan mesin pembayaran (pricing).
 */
const applySettings = (stored) => {
  const pick = (key) => stored[key]?.value;

  station.lat = toFiniteNumber(pick(SETTING_KEYS.stationLat), station.lat);
  station.lng = toFiniteNumber(pick(SETTING_KEYS.stationLng), station.lng);
  station.radiusMeter = toFiniteNumber(
    pick(SETTING_KEYS.geofenceRadius),
    station.radiusMeter,
  );

  pricing.initialPricePerMinute = toFiniteNumber(
    pick(SETTING_KEYS.rentalPrice),
    pricing.initialPricePerMinute,
  );
  pricing.extensionPricePerMinute = toFiniteNumber(
    pick(SETTING_KEYS.extensionPrice),
    pricing.extensionPricePerMinute,
  );
  pricing.minRentalMinutes = toFiniteNumber(
    pick(SETTING_KEYS.minRentalMinutes),
    pricing.minRentalMinutes,
  );
  pricing.maxRentalMinutes = toFiniteNumber(
    pick(SETTING_KEYS.maxRentalMinutes),
    pricing.maxRentalMinutes,
  );
};

const getSettings = () => ({
  station: {
    lat: station.lat,
    lng: station.lng,
    radius_m: station.radiusMeter,
  },
  pricing: {
    initial_price_per_minute: pricing.initialPricePerMinute,
    extension_price_per_minute: pricing.extensionPricePerMinute,
    min_rental_minutes: pricing.minRentalMinutes,
    max_rental_minutes: pricing.maxRentalMinutes,
    payment_expiry_minutes: pricing.paymentExpiryMinutes,
  },
});

const validateSettings = (payload = {}) => {
  const stationInput = payload.station || {};
  const pricingInput = payload.pricing || {};

  const lat = toFiniteNumber(stationInput.lat, station.lat);
  const lng = toFiniteNumber(stationInput.lng, station.lng);
  const radius = toFiniteNumber(stationInput.radius_m, station.radiusMeter);
  const initialPrice = toFiniteNumber(
    pricingInput.initial_price_per_minute,
    pricing.initialPricePerMinute,
  );
  const extensionPrice = toFiniteNumber(
    pricingInput.extension_price_per_minute,
    pricing.extensionPricePerMinute,
  );
  const minMinutes = toFiniteNumber(
    pricingInput.min_rental_minutes,
    pricing.minRentalMinutes,
  );
  const maxMinutes = toFiniteNumber(
    pricingInput.max_rental_minutes,
    pricing.maxRentalMinutes,
  );

  const errors = [];

  if (lat < -90 || lat > 90) {
    errors.push("Latitude pangkalan harus berada di antara -90 dan 90.");
  }
  if (lng < -180 || lng > 180) {
    errors.push("Longitude pangkalan harus berada di antara -180 dan 180.");
  }
  if (radius < 50 || radius > 100000) {
    errors.push("Radius geofence harus berada di antara 50 dan 100000 meter.");
  }
  if (initialPrice < 0) {
    errors.push("Harga awal per menit tidak boleh negatif.");
  }
  if (extensionPrice < 0) {
    errors.push("Harga perpanjangan per menit tidak boleh negatif.");
  }
  if (minMinutes < 1 || !Number.isInteger(minMinutes)) {
    errors.push("Durasi minimum sewa minimal 1 menit dan berupa bilangan bulat.");
  }
  if (maxMinutes < minMinutes || !Number.isInteger(maxMinutes)) {
    errors.push(
      "Durasi maksimum sewa harus bilangan bulat dan tidak kurang dari durasi minimum.",
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    values: {
      [SETTING_KEYS.stationLat]: lat,
      [SETTING_KEYS.stationLng]: lng,
      [SETTING_KEYS.geofenceRadius]: radius,
      [SETTING_KEYS.rentalPrice]: initialPrice,
      [SETTING_KEYS.extensionPrice]: extensionPrice,
      [SETTING_KEYS.minRentalMinutes]: minMinutes,
      [SETTING_KEYS.maxRentalMinutes]: maxMinutes,
    },
  };
};

const saveSettings = async (values) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    for (const [key, value] of Object.entries(values)) {
      await connection.query(
        `INSERT INTO app_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, String(value)],
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const updateSettings = async (payload) => {
  const validation = validateSettings(payload);

  if (!validation.valid) {
    return { status: "invalid", errors: validation.errors };
  }

  await saveSettings(validation.values);

  const stored = await readStoredSettings();
  applySettings(stored);

  return { status: "success", settings: getSettings() };
};

/**
 * Dipanggil sekali saat startup. Tabel dibuat otomatis agar instalasi
 * baru tidak perlu menjalankan migration secara manual.
 */
const init = async () => {
  try {
    await ensureTable();
    const stored = await readStoredSettings();
    applySettings(stored);
    console.log("[SETTINGS] Konfigurasi pangkalan dan pricing berhasil dimuat.");
  } catch (error) {
    // Backend tetap boleh jalan memakai default dari .env, tetapi
    // perubahan settings tidak akan tersimpan sampai DB tersedia.
    console.warn(
      "[SETTINGS] Gagal memuat pengaturan dari database:",
      error.message,
    );
  }
};

module.exports = {
  SETTING_KEYS,
  init,
  ensureTable,
  getSettings,
  updateSettings,
  validateSettings,
};
