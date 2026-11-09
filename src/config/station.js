const toFiniteNumber = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Satu sumber konfigurasi pangkalan untuk engine geofence dan dashboard.
 * Frontend menerima nilai yang sama lewat GET /api/admin/bikes.
 */
const station = Object.freeze({
  lat: toFiniteNumber(process.env.STATION_LAT, -7.773512),
  lng: toFiniteNumber(process.env.STATION_LNG, 110.385411),
  radiusMeter: toFiniteNumber(process.env.GEOFENCE_RADIUS_M, 500),
  tamperCooldownSeconds: toFiniteNumber(
    process.env.TAMPER_ALERT_COOLDOWN_SECONDS,
    300,
  ),
  tamperResetSeconds: toFiniteNumber(
    process.env.TAMPER_ALERT_RESET_SECONDS,
    120,
  ),
});

module.exports = station;
