/**
 * Menghitung jarak antara dua koordinat GPS dalam satuan Meter (Haversine Formula)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Radius bumi (meter)
  const rad = Math.PI / 180;

  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Hasil dalam Meter
}

/**
 * Memeriksa apakah posisi sepeda melebihi radius aman pangkalan
 */
function isOutsideGeofence(bikeLat, bikeLng, stationLat, stationLng, maxRadiusMeter = 500) {
  const distance = calculateDistance(bikeLat, bikeLng, stationLat, stationLng);
  return {
    isViolated: distance > maxRadiusMeter,
    distanceMeter: Math.round(distance)
  };
}

module.exports = {
  calculateDistance,
  isOutsideGeofence
};