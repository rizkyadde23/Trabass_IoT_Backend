const incidentService = require("../services/incidentService");

// ---------------------------------------------------------------------------
// GET /api/admin/incidents
// ---------------------------------------------------------------------------
const getIncidents = async (req, res) => {
  try {
    const result = await incidentService.listIncidents({
      status: req.query.status,
      type: req.query.type,
      bikeId: req.query.bike_id,
      afterId: req.query.after_id,
      beforeId: req.query.before_id,
      limit: req.query.limit,
    });

    return res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (error) {
    console.error("[INCIDENT LIST ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengambil daftar insiden keamanan.",
    });
  }
};

module.exports = {
  getIncidents,
};
