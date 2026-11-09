const jwt = require("jsonwebtoken");
require("dotenv").config();

/**
 * Middleware validasi JWT dari header Authorization: Bearer <token>.
 * Menyimpan payload ke req.user agar controller dapat memakai user_id
 * yang sudah terverifikasi.
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      status: "error",
      message: "Token autentikasi tidak ditemukan. Silakan login.",
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    req.user = {
      user_id: payload.user_id,
      email: payload.email,
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      status: "error",
      message: "Sesi login tidak valid atau sudah kedaluwarsa. Silakan login kembali.",
    });
  }
};

module.exports = authMiddleware;
