const bcrypt = require("bcryptjs");
const db = require("../config/db");
require("dotenv").config();

const BCRYPT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^08\d{8,13}$/;

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
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

const fail = (message) => {
  throw new Error(message);
};

const main = async () => {
  const name = String(process.env.ADMIN_NAME || "").trim();
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || "");
  const phoneNumber = normalizePhoneNumber(process.env.ADMIN_PHONE_NUMBER);

  if (name.length < 2) {
    fail("ADMIN_NAME wajib diisi minimal 2 karakter.");
  }

  if (!EMAIL_REGEX.test(email)) {
    fail("ADMIN_EMAIL tidak valid.");
  }

  if (password.length < 8) {
    fail("ADMIN_PASSWORD wajib diisi minimal 8 karakter.");
  }

  if (phoneNumber && !PHONE_REGEX.test(phoneNumber)) {
    fail("ADMIN_PHONE_NUMBER tidak valid. Gunakan format 08xxxxxxxxxx.");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const [existingRows] = await db.query(
    "SELECT user_id FROM users WHERE email = ? LIMIT 1",
    [email],
  );

  if (existingRows.length > 0) {
    const userId = existingRows[0].user_id;

    await db.query(
      `UPDATE users
       SET name = ?, password_hash = ?, role = 'admin'
       WHERE user_id = ?`,
      [name, passwordHash, userId],
    );

    console.log(
      `[ADMIN] Akun ${email} (user_id: ${userId}) berhasil dipromosikan menjadi admin.`,
    );
    console.log(
      "[ADMIN] Password direset sesuai ADMIN_PASSWORD. Login ulang di frontend.",
    );
    return;
  }

  if (!phoneNumber) {
    fail(
      "ADMIN_PHONE_NUMBER wajib diisi untuk membuat akun admin baru.",
    );
  }

  // Nomor WA bersifat unik. Jika nomor sudah dipakai user lama tanpa email,
  // klaim baris tersebut agar riwayat tetap terjaga (sama seperti registrasi).
  const [phoneRows] = await db.query(
    "SELECT user_id, email FROM users WHERE phone_number = ? LIMIT 1",
    [phoneNumber],
  );

  if (phoneRows.length > 0) {
    const existingUser = phoneRows[0];

    if (existingUser.email) {
      fail(
        `ADMIN_PHONE_NUMBER sudah dipakai akun lain (${existingUser.email}). Gunakan nomor lain.`,
      );
    }

    await db.query(
      `UPDATE users
       SET name = ?, email = ?, password_hash = ?, role = 'admin'
       WHERE user_id = ?`,
      [name, email, passwordHash, existingUser.user_id],
    );

    console.log(
      `[ADMIN] Akun lama dengan nomor ${phoneNumber} (user_id: ${existingUser.user_id}) diklaim dan dipromosikan menjadi admin.`,
    );
    console.log(
      "[ADMIN] Password direset sesuai ADMIN_PASSWORD. Login ulang di frontend.",
    );
    return;
  }

  const [insertResult] = await db.query(
    `INSERT INTO users (name, email, password_hash, phone_number, role)
     VALUES (?, ?, ?, ?, 'admin')`,
    [name, email, passwordHash, phoneNumber],
  );

  console.log(
    `[ADMIN] Akun admin baru ${email} berhasil dibuat (user_id: ${insertResult.insertId}).`,
  );
};

main()
  .then(async () => {
    await db.end();
  })
  .catch(async (error) => {
    console.error("[ADMIN SEED ERROR]", error.message);
    process.exitCode = 1;
    await db.end().catch(() => {});
  });
