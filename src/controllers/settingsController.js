const settingsService = require("../services/settingsService");

// ---------------------------------------------------------------------------
// GET /api/admin/settings
// ---------------------------------------------------------------------------
const getSettings = async (req, res) => {
  try {
    return res.status(200).json({
      status: "success",
      data: settingsService.getSettings(),
    });
  } catch (error) {
    console.error("[SETTINGS GET ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal mengambil pengaturan aplikasi.",
    });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/admin/settings
// ---------------------------------------------------------------------------
const updateSettings = async (req, res) => {
  try {
    const result = await settingsService.updateSettings(req.body);

    if (result.status === "invalid") {
      return res.status(400).json({
        status: "error",
        message: result.errors[0],
        errors: result.errors,
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Pengaturan berhasil disimpan dan langsung diterapkan.",
      data: result.settings,
    });
  } catch (error) {
    console.error("[SETTINGS UPDATE ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal menyimpan pengaturan aplikasi.",
    });
  }
};

module.exports = {
  getSettings,
  updateSettings,
};
