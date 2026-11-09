/**
 * Middleware khusus endpoint admin.
 * Wajib dipasang setelah authMiddleware sehingga req.user sudah terisi.
 */
const adminMiddleware = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      status: "error",
      message: "Akses ditolak. Endpoint ini hanya untuk admin.",
    });
  }

  return next();
};

module.exports = adminMiddleware;
