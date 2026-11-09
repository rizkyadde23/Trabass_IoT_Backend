const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
require("dotenv").config();

const BCRYPT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^08\d{8,13}$/;

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

const sanitizeUser = (user) => ({
  user_id: user.user_id,
  name: user.name,
  email: user.email,
  role: user.role || "user",
  phone_number: user.phone_number,
  created_at: user.created_at,
});

const createToken = (user) =>
  jwt.sign(
    {
      user_id: user.user_id,
      email: user.email,
      role: user.role || "user",
    },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );

const validateRegistration = ({ name, email, phoneNumber, password }) => {
  if (!name || name.length < 2 || name.length > 100) {
    return "Nama wajib diisi (2-100 karakter).";
  }

  if (!email || email.length > 150 || !EMAIL_REGEX.test(email)) {
    return "Format email tidak valid.";
  }

  if (!PHONE_REGEX.test(phoneNumber)) {
    return "Nomor WA tidak valid. Gunakan format 08xxxxxxxxxx.";
  }

  if (!password || password.length < 8) {
    return "Password minimal 8 karakter.";
  }

  if (password.length > 72) {
    return "Password maksimal 72 karakter.";
  }

  return null;
};

// ---------------------------------------------------------------------------
// Endpoint: Registrasi user baru
// POST /api/auth/register
// ---------------------------------------------------------------------------
const register = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const phoneNumber = normalizePhoneNumber(req.body?.phone_number);
    const password = String(req.body?.password || "");

    const validationError = validateRegistration({
      name,
      email,
      phoneNumber,
      password,
    });

    if (validationError) {
      return res.status(400).json({
        status: "error",
        message: validationError,
      });
    }

    const [emailRows] = await db.query(
      "SELECT user_id FROM users WHERE email = ? LIMIT 1",
      [email],
    );

    if (emailRows.length > 0) {
      return res.status(409).json({
        status: "error",
        message: "Email sudah terdaftar. Silakan login.",
      });
    }

    const [phoneRows] = await db.query(
      `SELECT user_id, email, password_hash
       FROM users
       WHERE phone_number = ?
       LIMIT 1`,
      [phoneNumber],
    );

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    let userId;

    if (phoneRows.length > 0) {
      const existingUser = phoneRows[0];

      // Nomor sudah terdaftar penuh (punya email/password) -> tolak.
      if (existingUser.email || existingUser.password_hash) {
        return res.status(409).json({
          status: "error",
          message: "Nomor WA sudah terdaftar. Silakan login.",
        });
      }

      // User lama tanpa kredensial: klaim baris agar user_id & riwayat
      // rentals tetap terjaga.
      await db.query(
        `UPDATE users
         SET name = ?, email = ?, password_hash = ?
         WHERE user_id = ?`,
        [name, email, passwordHash, existingUser.user_id],
      );
      userId = existingUser.user_id;
    } else {
      const [insertResult] = await db.query(
        `INSERT INTO users (name, email, password_hash, phone_number)
         VALUES (?, ?, ?, ?)`,
        [name, email, passwordHash, phoneNumber],
      );
      userId = insertResult.insertId;
    }

    const [rows] = await db.query(
      `SELECT user_id, name, email, phone_number, role, created_at
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
      },
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        status: "error",
        message: "Email atau nomor WA sudah terdaftar. Silakan login.",
      });
    }

    console.error("[AUTH REGISTER ERROR]", error.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal memproses registrasi. Silakan coba lagi.",
    });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Login dengan email & password
// POST /api/auth/login
// ---------------------------------------------------------------------------
const login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({
        status: "error",
        message: "Email dan password wajib diisi.",
      });
    }

    const [rows] = await db.query(
      `SELECT user_id, name, email, password_hash, phone_number, role, created_at
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email],
    );

    if (rows.length === 0 || !rows[0].password_hash) {
      return res.status(401).json({
        status: "error",
        message: "Email atau password salah.",
      });
    }

    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        status: "error",
        message: "Email atau password salah.",
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
      `SELECT user_id, name, email, phone_number, role, created_at
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
  register,
  login,
  getMe,
  normalizePhoneNumber,
};
