const db = require("../config/db");

// ---------------------------------------------------------------------------
// Endpoint: Ketersediaan sepeda untuk halaman registrasi (publik)
// GET /api/bikes/:bike_id/availability
// Dipakai halaman /register?bike_id=... untuk validasi dini: sepeda RENTED,
// RESERVED, OVERDUE, atau MAINTENANCE ditolak sebelum user mengisi form.
// ---------------------------------------------------------------------------
const getBikeAvailability = async (req, res) => {
  try {
    const bikeId = String(req.params.bike_id || "")
      .trim()
      .toUpperCase();

    if (!bikeId) {
      return res.status(400).json({
        status: "error",
        message: "ID sepeda wajib diisi.",
      });
    }

    const [rows] = await db.query(
      "SELECT bike_id, name, status FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Sepeda ${bikeId} tidak terdaftar. Silakan scan ulang QR code.`,
      });
    }

    const bike = rows[0];
    const available = bike.status === "AVAILABLE";

    const statusLabels = {
      AVAILABLE: "Tersedia",
      RESERVED: "Sedang dipesan orang lain",
      RENTED: "Sedang disewa",
      OVERDUE: "Melewati batas waktu sewa",
      MAINTENANCE: "Sedang perawatan",
      GEOFENCE_VIOLATION: "Pelanggaran area sewa",
      TAMPER_ALERT: "Peringatan keamanan",
    };

    return res.status(200).json({
      status: "success",
      data: {
        bike_id: bike.bike_id,
        name: bike.name,
        bike_status: bike.status,
        bike_status_label: statusLabels[bike.status] || bike.status,
        available,
      },
    });
  } catch (error) {
    console.error("[BIKE AVAILABILITY ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal memeriksa ketersediaan sepeda.",
    });
  }
};

module.exports = {
  getBikeAvailability,
};
