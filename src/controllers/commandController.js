const bikeCommandService = require("../services/bikeCommandService");

const getClientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
};

// ---------------------------------------------------------------------------
// POST /api/admin/bike-command
// ---------------------------------------------------------------------------
const sendBikeCommand = async (req, res) => {
  try {
    const { bike_id: bikeId, action, reason } = req.body || {};

    const result = await bikeCommandService.sendCommand({
      adminUserId: req.user?.user_id || null,
      bikeId,
      action,
      reason,
      ipAddress: getClientIp(req),
    });

    return res.status(200).json({
      status: "success",
      message:
        result.action === "ALARM_OFF"
          ? "Perintah mematikan alarm terkirim ke sepeda."
          : "Perintah terkirim ke sepeda. Status akan diperbarui setelah telemetri berikutnya.",
      data: result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      console.error("[ADMIN COMMAND ERROR]", error.message);
    }

    return res.status(statusCode).json({
      status: "error",
      message: error.message || "Gagal mengirim perintah ke sepeda.",
    });
  }
};

// ---------------------------------------------------------------------------
// GET /api/admin/command-logs
// ---------------------------------------------------------------------------
const getCommandLogs = async (req, res) => {
  try {
    const result = await bikeCommandService.listCommandLogs({
      bikeId: req.query.bike_id,
      action: req.query.action,
      status: req.query.status,
      afterId: req.query.after_id,
      beforeId: req.query.before_id,
      limit: req.query.limit,
    });

    return res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (error) {
    console.error("[COMMAND LOGS ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengambil riwayat perintah admin.",
    });
  }
};

module.exports = {
  sendBikeCommand,
  getCommandLogs,
};
