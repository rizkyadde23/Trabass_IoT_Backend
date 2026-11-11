const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
require("dotenv").config();

const BCRYPT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^08\d{8,13}$/;
const USERNAME_REGEX = /^[a-z0-9._-]{3,50}$/;

/**
 * jsonwebtoken hanya menerima angka (detik) atau timespan seperti "7d".
 * Nilai .env yang tidak valid/tergabung dengan baris lain tidak boleh
 * membuat login gagal total, jadi fallback ke default.
 */
const DEFAULT_JWT_EXPIRES_IN = "7d";
const JWT_TIMESPAN_REGEX = /^\d+(ms|s|m|h|d|w|y)$/i;

const resolveJwtExpiresIn = (value) => {
  const raw = String(value ?? "").trim();

  if (!raw) return DEFAULT_JWT_EXPIRES_IN;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (JWT_TIMESPAN_REGEX.test(raw)) return raw;

  console.warn(
    `[AUTH CONFIG] JWT_EXPIRES_IN tidak valid ("${raw}"). ` +
      `Memakai default ${DEFAULT_JWT_EXPIRES_IN}.`,
  );

  return DEFAULT_JWT_EXPIRES_IN;
};

const JWT_EXPIRES_IN = resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN);

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const normalizeIdentifier = (value) =>
  String(value || "").trim().toLowerCase();

/**
 * Menyeragamkan nomor WA ke format lokal 08xxxxxxxxxx agar unique index
 * tidak bisa dilewati lewat variasi +62 / 62 / spasi / tanda hubung.
 */
const normalizePhoneNumber = (value) => {
  let phone = String(value || "").replace(/[\s\-().]/g, "");

  if (phone.startsWith("+62")) {
    phone = `0${phone.slice(3)}`;
  } else if (phone.startsWith("62")) {
    phone = `0${phone.slice(2)}`;
  } else if (phone.startsWith("8")) {
    phone = `0${phone}`;
  }

  return phone;
};

/**
 * Penyewa hasil alur scan QR tidak memiliki email/username/password,
 * sehingga kolom tersebut boleh NULL pada data user.
 */
const sanitizeUser = (user) => ({
  user_id: user.user_id,
  name: user.name,
  username: user.username || null,
  email: user.email || null,
  role: user.role || "user",
  phone_number: user.phone_number,
  created_at: user.created_at,
});

const createToken = (user) =>
  jwt.sign(
    {
      user_id: user.user_id,
      email: user.email || undefined,
      username: user.username || undefined,
      role: user.role || "user",
    },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );

// ---------------------------------------------------------------------------
// Endpoint: Registrasi ringan penyewa (hasil scan QR sepeda)
// POST /api/auth/quick-register
// Identitas penyewa adalah Nomor WA. Tanpa email & password: user scan QR,
// mengisi nama + nomor WA, lalu langsung diarahkan ke halaman pembayaran.
// ---------------------------------------------------------------------------
const quickRegister = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phoneNumber = normalizePhoneNumber(req.body?.phone_number);
    const bikeId = String(req.body?.bike_id || "")
      .trim()
      .toUpperCase();
    const password = String(req.body?.password || "");

    if (!bikeId) {
      return res.status(400).json({
        status: "error",
        message: "ID sepeda wajib diisi. Silakan scan ulang QR code sepeda.",
      });
    }

    if (!name || name.length < 2 || name.length > 100) {
      return res.status(400).json({
        status: "error",
        message: "Nama wajib diisi (2-100 karakter).",
      });
    }

    if (!PHONE_REGEX.test(phoneNumber)) {
      return res.status(400).json({
        status: "error",
        message: "Nomor WA tidak valid. Gunakan format 08xxxxxxxxxx.",
      });
    }

    if (password) {
      return res.status(400).json({
        status: "error",
        message:
          "Registrasi penyewa hanya menggunakan nama dan nomor WA. " +
          "Akun dengan password hanya dibuat lewat admin.",
      });
    }

    const [bikeRows] = await db.query(
      "SELECT bike_id FROM bikes WHERE bike_id = ? LIMIT 1",
      [bikeId],
    );

    if (bikeRows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: `Sepeda ${bikeId} tidak terdaftar. Silakan scan ulang QR code.`,
      });
    }

    const [phoneRows] = await db.query(
      `SELECT user_id, role, email, password_hash
       FROM users
       WHERE phone_number = ?
       LIMIT 1`,
      [phoneNumber],
    );

    let userId;

    if (phoneRows.length > 0) {
      const existingUser = phoneRows[0];

      // Nomor milik admin tidak boleh diklaim sebagai akun penyewa.
      if (existingUser.role === "admin") {
        return res.status(403).json({
          status: "error",
          message:
            "Nomor WA ini terdaftar sebagai admin. Gunakan nomor pribadi untuk menyewa.",
        });
      }

      // Nomor sudah dikenal: lanjutkan sesi dengan memperbarui nama.
      // Nomor WA adalah identitas penyewa pada alur scan QR.
      await db.query("UPDATE users SET name = ? WHERE user_id = ?", [
        name,
        existingUser.user_id,
      ]);
      userId = existingUser.user_id;
    } else {
      const [insertResult] = await db.query(
        `INSERT INTO users (name, email, password_hash, phone_number, role)
         VALUES (?, NULL, NULL, ?, 'user')`,
        [name, phoneNumber],
      );
      userId = insertResult.insertId;
    }

    const [rows] = await db.query(
      `SELECT user_id, name, username, email, phone_number, role, created_at
       FROM users
       WHERE user_id = ?`,
      [userId],
    );

    const user = sanitizeUser(rows[0]);

    return res.status(201).json({
      status: "success",
      message: "Registrasi berhasil.",
      data: {
        token: createToken(user),
        user,
        bike_id: bikeId,
      },
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        status: "error",
        message: "Nomor WA sudah terdaftar. Coba lagi atau gunakan nomor lain.",
      });
    }

    console.error("[AUTH QUICK REGISTER ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal memproses registrasi. Silakan coba lagi.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Login admin dengan username ATAU email + password
// POST /api/auth/login
// ---------------------------------------------------------------------------
const login = async (req, res) => {
  try {
    // Field `identifier` menerima username atau email. Field `email`
    // tetap diterima untuk kompatibilitas klien lama.
    const identifier = normalizeIdentifier(
      req.body?.identifier || req.body?.email,
    );
    const password = String(req.body?.password || "");

    if (!identifier || !password) {
      return res.status(400).json({
        status: "error",
        message: "Username/email dan password wajib diisi.",
      });
    }

    const [rows] = await db.query(
      `SELECT user_id, name, username, email, password_hash, phone_number, role, created_at
       FROM users
       WHERE email = ? OR username = ?
       LIMIT 1`,
      [identifier, identifier],
    );

    if (rows.length === 0 || !rows[0].password_hash) {
      return res.status(401).json({
        status: "error",
        message: "Username/email atau password salah.",
      });
    }

    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        status: "error",
        message: "Username/email atau password salah.",
      });
    }

    const sanitizedUser = sanitizeUser(user);

    return res.status(200).json({
      status: "success",
      message: "Login berhasil.",
      data: {
        token: createToken(sanitizedUser),
        user: sanitizedUser,
      },
    });
  } catch (error) {
    console.error("[AUTH LOGIN ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal memproses login. Silakan coba lagi.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Ambil profil user yang sedang login
// GET /api/auth/me
// ---------------------------------------------------------------------------
const getMe = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT user_id, name, username, email, phone_number, role, created_at
       FROM users
       WHERE user_id = ?`,
      [req.user.user_id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User tidak ditemukan.",
      });
    }

    return res.status(200).json({
      status: "success",
      data: { user: sanitizeUser(rows[0]) },
    });
  } catch (error) {
    console.error("[AUTH ME ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
};

module.exports = {
  quickRegister,
  login,
  getMe,
  normalizePhoneNumber,
  normalizeIdentifier,
  USERNAME_REGEX,
};
