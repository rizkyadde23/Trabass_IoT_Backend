const midtransClient = require("midtrans-client");
const crypto = require("crypto");
const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
require("dotenv").config();

const {
  sendPaymentReceipt,
  sendExtensionReceipt,
  sendReturnReceipt,
  sendPaymentConflictAlert,
} = require("../services/notificationService");

// Inisialisasi Midtrans Snap Instance
const snap = new midtransClient.Snap({
  isProduction: false, // Sandbox Mode
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// ---------------------------------------------------------------------------
// Konfigurasi pembayaran
// ---------------------------------------------------------------------------
const INITIAL_PRICE_PER_MINUTE = Number(
  process.env.RENTAL_PRICE_PER_MINUTE || 1000,
);
const EXTENSION_PRICE_PER_MINUTE = Number(
  process.env.EXTENSION_PRICE_PER_MINUTE || INITIAL_PRICE_PER_MINUTE,
);
const MIN_RENTAL_MINUTES = Number(process.env.MIN_RENTAL_MINUTES || 15);
const MAX_RENTAL_MINUTES = Number(process.env.MAX_RENTAL_MINUTES || 1440);
const PAYMENT_EXPIRY_MINUTES = Number(
  process.env.PAYMENT_EXPIRY_MINUTES || 15,
);

// ---------------------------------------------------------------------------
// Helper umum
// ---------------------------------------------------------------------------
const parseDurationMinutes = (value) => {
  const duration = Number(value);
  if (
    !Number.isInteger(duration) ||
    duration < MIN_RENTAL_MINUTES ||
    duration > MAX_RENTAL_MINUTES
  ) {
    return null;
  }
  return duration;
};

const calculateAmount = (durationMinutes, type = "INITIAL") => {
  const rate =
    type === "EXTENSION"
      ? EXTENSION_PRICE_PER_MINUTE
      : INITIAL_PRICE_PER_MINUTE;
  return Math.round(durationMinutes * rate);
};

const toIsoString = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const amountsMatch = (expected, actual) => {
  const expectedAmount = Number(expected);
  const actualAmount = Number(actual);
  return (
    Number.isFinite(expectedAmount) &&
    Number.isFinite(actualAmount) &&
    Math.abs(expectedAmount - actualAmount) < 0.01
  );
};

const verifyMidtransSignature = ({
  orderId,
  statusCode,
  grossAmount,
  signatureKey,
}) => {
  const serverKey = process.env.MIDTRANS_SERVER_KEY;
  if (!serverKey || !signatureKey) return false;

  const expectedSignature = crypto
    .createHash("sha512")
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(String(signatureKey), "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
};

const mapMidtransEvent = (transactionStatus, fraudStatus) => {
  if (transactionStatus === "settlement") return "SUCCESS";
  if (transactionStatus === "capture") {
    return fraudStatus === "accept" ? "SUCCESS" : "PENDING";
  }
  if (["pending", "authorize"].includes(transactionStatus)) return "PENDING";
  if (["deny", "cancel", "expire", "failure"].includes(transactionStatus)) {
    return "FAILED";
  }
  return "IGNORED";
};

const publishBikeCommand = (bikeId, payload) => {
  const topic = `bike/command/${bikeId}`;
  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

const publishBikeCommandSafely = async (bikeId, payload) => {
  try {
    await publishBikeCommand(bikeId, payload);
    console.log(`[MQTT PUB] ${bikeId} -> ${payload.action}`);
  } catch (error) {
    console.error(
      `[MQTT ERROR] Gagal publish ${payload.action} ke ${bikeId}:`,
      error.message,
    );
  }
};

const updateBikeCache = async (bikeId, lockState) => {
  try {
    await redisClient.hSet(`bike:${bikeId}:location`, {
      lock_state: lockState ? "true" : "false",
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `[REDIS ERROR] Gagal update cache bike ${bikeId}:`,
      error.message,
    );
  }
};

const getRentalPaymentState = async (rentalId) => {
  const [rows] = await db.query(
    `SELECT
       r.rental_id,
       r.bike_id,
       r.user_id,
       r.rental_type,
       r.parent_rental_id,
       r.duration_minutes,
       r.amount,
       r.payment_status,
       r.rental_status,
       r.midtrans_order_id,
       r.start_time,
       r.end_time,
       r.payment_processed_at,
       p.end_time AS parent_end_time,
       p.rental_status AS parent_rental_status
     FROM rentals r
     LEFT JOIN rentals p ON p.rental_id = r.parent_rental_id
     WHERE r.rental_id = ?`,
    [rentalId],
  );

  if (rows.length === 0) return null;

  const rental = rows[0];
  return {
    ...rental,
    active_end_time: rental.parent_rental_id
      ? rental.parent_end_time
      : rental.end_time,
  };
};

const releaseBikeReservation = async (connection, bikeId) => {
  const [bikes] = await connection.query(
    "SELECT status FROM bikes WHERE bike_id = ? FOR UPDATE",
    [bikeId],
  );

  if (bikes.length === 0 || bikes[0].status !== "RESERVED") return false;

  const [otherPending] = await connection.query(
    `SELECT rental_id
     FROM rentals
     WHERE bike_id = ?
       AND payment_status = 'PENDING'
       AND rental_status IN ('WAITING_PAYMENT', 'WAITING_EXTEND')
     LIMIT 1`,
    [bikeId],
  );

  if (otherPending.length > 0) return false;

  const [otherActive] = await connection.query(
    `SELECT rental_id
     FROM rentals
     WHERE bike_id = ?
       AND rental_status IN ('ACTIVE', 'WARNING_SENT', 'OVERDUE')
     LIMIT 1`,
    [bikeId],
  );

  if (otherActive.length > 0) return false;

  await connection.query(
    "UPDATE bikes SET status = 'AVAILABLE', lock_state = TRUE WHERE bike_id = ?",
    [bikeId],
  );

  return true;
};

const markExtensionRejected = async (connection, rentalId, reason) => {
  await connection.query(
    `UPDATE rentals
     SET payment_status = 'SETTLED',
         rental_status = 'EXTENSION_REJECTED',
         payment_processed_at = NOW()
     WHERE rental_id = ?`,
    [rentalId],
  );

  console.warn(`[EXTENSION REJECTED] Rental ${rentalId}: ${reason}`);
};

const markPaymentConflict = async (connection, rentalId, reason) => {
  await connection.query(
    `UPDATE rentals
     SET payment_status = 'SETTLED',
         rental_status = 'PAID_CONFLICT',
         payment_processed_at = NOW()
     WHERE rental_id = ?`,
    [rentalId],
  );

  console.warn(`[PAYMENT CONFLICT] Rental ${rentalId}: ${reason}`);
};

/**
 * Menandai rental sebagai konflik pembayaran (mis. nominal tidak cocok).
 * Hanya mengubah data jika pembayaran masih PENDING agar tidak menimpa
 * status yang sudah final.
 */
const flagPaymentConflict = async (rentalId, reason) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rentals] = await connection.query(
      `SELECT payment_status, bike_id, rental_type
       FROM rentals
       WHERE rental_id = ?
       FOR UPDATE`,
      [rentalId],
    );

    if (rentals.length > 0 && rentals[0].payment_status === "PENDING") {
      const rental = rentals[0];

      await markPaymentConflict(connection, rentalId, reason);

      // Pembayaran konflik tidak mengaktifkan sesi, jadi sepeda yang tadinya
      // RESERVED untuk sewa awal dilepas agar tidak tertahan.
      if (rental.rental_type !== "EXTENSION") {
        await releaseBikeReservation(connection, rental.bike_id);
      }
    }

    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Abaikan error rollback.
    }

    console.error(
      `[PAYMENT CONFLICT ERROR] Gagal menandai rental ${rentalId}:`,
      error.message,
    );
  } finally {
    connection.release();
  }
};

const notifyPaymentConflict = (result, orderId) => {
  const rental = result.rental || {};
  const bikeId = result.bikeId || rental.bike_id;
  const reason = result.reason || "PAYMENT_CONFLICT";
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;

  if (adminPhone) {
    void sendPaymentConflictAlert(adminPhone, bikeId, reason, orderId, true);
  }

  if (rental.phone_number) {
    void sendPaymentConflictAlert(
      rental.phone_number,
      bikeId,
      reason,
      orderId,
      false,
    );
  }
};

const cancelRentalAndRelease = async (rentalId, bikeId) => {
  try {
    await db.query(
      `UPDATE rentals
       SET payment_status = 'CANCELLED',
           rental_status = 'CANCELLED',
           payment_processed_at = NOW()
       WHERE rental_id = ? AND payment_status = 'PENDING'`,
      [rentalId],
    );

    if (!bikeId) return;

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await releaseBikeReservation(connection, bikeId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(
      `[CANCEL RENTAL ERROR] Gagal membatalkan rental ${rentalId}:`,
      error.message,
    );
  }
};

const cancelOldMidtransOrders = async (pendingRentals) => {
  for (const oldRental of pendingRentals) {
    if (!oldRental.midtrans_order_id) continue;

    try {
      await snap.transaction.cancel(oldRental.midtrans_order_id);
      console.log(
        `[AUTO-CLEANUP] Order pending lama dibatalkan: ${oldRental.midtrans_order_id}`,
      );
    } catch (error) {
      console.warn(
        `[MIDTRANS CANCEL NOTICE] ${oldRental.midtrans_order_id}: ${error.message}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Proses aktivasi pembayaran sukses
// ---------------------------------------------------------------------------
const activateInitialRental = async (connection, rental) => {
  const [bikes] = await connection.query(
    "SELECT bike_id, status FROM bikes WHERE bike_id = ? FOR UPDATE",
    [rental.bike_id],
  );

  if (bikes.length === 0) {
    throw new Error(`Data sepeda ${rental.bike_id} tidak ditemukan`);
  }

  const bike = bikes[0];

  const [otherActive] = await connection.query(
    `SELECT rental_id
     FROM rentals
     WHERE bike_id = ?
       AND rental_id <> ?
       AND rental_status IN ('ACTIVE', 'WARNING_SENT', 'OVERDUE')
     LIMIT 1`,
    [rental.bike_id, rental.rental_id],
  );

  if (otherActive.length > 0 || !["AVAILABLE", "RESERVED"].includes(bike.status)) {
    const reason =
      otherActive.length > 0
        ? "BIKE_ALREADY_IN_USE"
        : `BIKE_STATUS_${bike.status}`;

    await markPaymentConflict(connection, rental.rental_id, reason);

    return {
      alreadyProcessed: false,
      conflict: true,
      rental,
      bikeId: rental.bike_id,
      reason,
    };
  }

  const [timeRows] = await connection.query(
    `SELECT
       NOW() AS start_time,
       DATE_ADD(NOW(), INTERVAL ? MINUTE) AS end_time`,
    [rental.duration_minutes],
  );

  const startTime = timeRows[0].start_time;
  const endTime = timeRows[0].end_time;

  await connection.query(
    `UPDATE rentals
     SET payment_status = 'SETTLED',
         rental_status = 'ACTIVE',
         start_time = ?,
         end_time = ?,
         payment_processed_at = NOW()
     WHERE rental_id = ?`,
    [startTime, endTime, rental.rental_id],
  );

  await connection.query(
    `UPDATE bikes
     SET status = 'RENTED', lock_state = FALSE
     WHERE bike_id = ?`,
    [rental.bike_id],
  );

  return {
    alreadyProcessed: false,
    conflict: false,
    rental,
    rentalType: "INITIAL",
    bikeId: rental.bike_id,
    startTime,
    endTime,
    durationMinutes: rental.duration_minutes,
  };
};

const applyExtension = async (connection, extensionRental) => {
  let parentRentalId = extensionRental.parent_rental_id;

  // Fallback untuk data lama yang belum memiliki parent_rental_id.
  if (!parentRentalId) {
    const [legacyParents] = await connection.query(
      `SELECT rental_id
       FROM rentals
       WHERE bike_id = ?
         AND rental_type = 'INITIAL'
         AND rental_status IN ('ACTIVE', 'WARNING_SENT')
       ORDER BY rental_id DESC
       LIMIT 1
       FOR UPDATE`,
      [extensionRental.bike_id],
    );

    parentRentalId = legacyParents[0] ? legacyParents[0].rental_id : null;
  }

  if (!parentRentalId) {
    await markExtensionRejected(
      connection,
      extensionRental.rental_id,
      "PARENT_RENTAL_NOT_FOUND",
    );

    return {
      alreadyProcessed: false,
      conflict: true,
      rental: extensionRental,
      bikeId: extensionRental.bike_id,
      reason: "PARENT_RENTAL_NOT_FOUND",
    };
  }

  const [parents] = await connection.query(
    "SELECT * FROM rentals WHERE rental_id = ? FOR UPDATE",
    [parentRentalId],
  );

  if (parents.length === 0) {
    await markExtensionRejected(
      connection,
      extensionRental.rental_id,
      "PARENT_RENTAL_NOT_FOUND",
    );

    return {
      alreadyProcessed: false,
      conflict: true,
      rental: extensionRental,
      bikeId: extensionRental.bike_id,
      reason: "PARENT_RENTAL_NOT_FOUND",
    };
  }

  const parent = parents[0];

  if (
    String(parent.bike_id) !== String(extensionRental.bike_id) ||
    String(parent.user_id) !== String(extensionRental.user_id)
  ) {
    await markExtensionRejected(
      connection,
      extensionRental.rental_id,
      "PARENT_RENTAL_MISMATCH",
    );

    return {
      alreadyProcessed: false,
      conflict: true,
      rental: extensionRental,
      bikeId: extensionRental.bike_id,
      reason: "PARENT_RENTAL_MISMATCH",
    };
  }

  if (!["ACTIVE", "WARNING_SENT"].includes(parent.rental_status)) {
    await markExtensionRejected(
      connection,
      extensionRental.rental_id,
      `PARENT_STATUS_${parent.rental_status}`,
    );

    return {
      alreadyProcessed: false,
      conflict: true,
      rental: extensionRental,
      bikeId: extensionRental.bike_id,
      reason: `PARENT_STATUS_${parent.rental_status}`,
    };
  }

  const [timeRows] = await connection.query(
    `SELECT
       DATE_ADD(
         GREATEST(COALESCE(end_time, NOW()), NOW()),
         INTERVAL ? MINUTE
       ) AS new_end_time
     FROM rentals
     WHERE rental_id = ?`,
    [extensionRental.duration_minutes, parent.rental_id],
  );

  const newEndTime = timeRows[0].new_end_time;

  await connection.query(
    `UPDATE rentals
     SET end_time = ?,
         rental_status = 'ACTIVE',
         duration_minutes = duration_minutes + ?
     WHERE rental_id = ?`,
    [newEndTime, extensionRental.duration_minutes, parent.rental_id],
  );

  await connection.query(
    `UPDATE rentals
     SET payment_status = 'SETTLED',
         rental_status = 'EXTENDED',
         payment_processed_at = NOW()
     WHERE rental_id = ?`,
    [extensionRental.rental_id],
  );

  await connection.query(
    `UPDATE bikes
     SET status = 'RENTED', lock_state = FALSE
     WHERE bike_id = ?`,
    [extensionRental.bike_id],
  );

  return {
    alreadyProcessed: false,
    conflict: false,
    rental: extensionRental,
    rentalType: "EXTENSION",
    bikeId: extensionRental.bike_id,
    parentRentalId: parent.rental_id,
    addedMinutes: extensionRental.duration_minutes,
    endTime: newEndTime,
  };
};

const processSuccessfulPayment = async (rentalId) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rentals] = await connection.query(
      `SELECT
         r.*,
         u.name AS user_name,
         u.phone_number
       FROM rentals r
       JOIN users u ON u.user_id = r.user_id
       WHERE r.rental_id = ?
       FOR UPDATE`,
      [rentalId],
    );

    if (rentals.length === 0) {
      throw new Error(`Data rental ${rentalId} tidak ditemukan`);
    }

    const rental = rentals[0];

    // Idempotensi: webhook Midtrans bisa dikirim lebih dari sekali.
    if (rental.payment_status === "SETTLED") {
      let republish = false;

      if (rental.rental_type === "EXTENSION") {
        if (
          rental.rental_status === "EXTENDED" &&
          rental.parent_rental_id
        ) {
          const [parents] = await connection.query(
            "SELECT rental_status FROM rentals WHERE rental_id = ?",
            [rental.parent_rental_id],
          );

          republish =
            parents.length > 0 &&
            ["ACTIVE", "WARNING_SENT"].includes(parents[0].rental_status);
        }
      } else {
        // Jangan kirim ulang UNLOCK jika sesi sudah selesai/overdue/conflict.
        republish = ["ACTIVE", "WARNING_SENT"].includes(rental.rental_status);
      }

      await connection.commit();
      return {
        alreadyProcessed: true,
        conflict: false,
        republish,
        rental,
      };
    }

    if (rental.payment_status !== "PENDING") {
      await markPaymentConflict(
        connection,
        rental.rental_id,
        `PAYMENT_ARRIVED_AFTER_${rental.payment_status}`,
      );

      await connection.commit();

      return {
        alreadyProcessed: false,
        conflict: true,
        rental,
        bikeId: rental.bike_id,
        reason: `PAYMENT_ARRIVED_AFTER_${rental.payment_status}`,
      };
    }

    const result =
      rental.rental_type === "EXTENSION"
        ? await applyExtension(connection, rental)
        : await activateInitialRental(connection, rental);

    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Abaikan error rollback.
    }
    throw error;
  } finally {
    connection.release();
  }
};

const processFailedPayment = async (rentalId, transactionStatus) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rentals] = await connection.query(
      "SELECT * FROM rentals WHERE rental_id = ? FOR UPDATE",
      [rentalId],
    );

    if (rentals.length === 0) {
      await connection.commit();
      return { ignored: true, reason: "RENTAL_NOT_FOUND" };
    }

    const rental = rentals[0];

    if (rental.payment_status !== "PENDING") {
      await connection.commit();
      return { ignored: true, reason: "PAYMENT_ALREADY_PROCESSED" };
    }

    const paymentStatus =
      transactionStatus === "expire" ? "EXPIRED" : "CANCELLED";

    await connection.query(
      `UPDATE rentals
       SET payment_status = ?,
           rental_status = 'CANCELLED',
           payment_processed_at = NOW()
       WHERE rental_id = ?`,
      [paymentStatus, rental.rental_id],
    );

    // Hanya sewa awal yang melepas reservasi sepeda.
    // Perpanjangan yang gagal tidak boleh mengubah parent atau status sepeda.
    if (rental.rental_type !== "EXTENSION") {
      await releaseBikeReservation(connection, rental.bike_id);
    }

    await connection.commit();

    return {
      ignored: false,
      rental,
      bikeId: rental.bike_id,
      paymentStatus,
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Abaikan error rollback.
    }
    throw error;
  } finally {
    connection.release();
  }
};

const republishIdempotentCommand = async (rental) => {
  if (rental.rental_type === "EXTENSION") {
    let endTime = null;

    if (rental.parent_rental_id) {
      const [parents] = await db.query(
        "SELECT end_time FROM rentals WHERE rental_id = ?",
        [rental.parent_rental_id],
      );
      endTime = parents.length > 0 ? parents[0].end_time : null;
    }

    void publishBikeCommandSafely(rental.bike_id, {
      action: "EXTEND_TIME",
      message: "Perpanjangan sewa sudah aktif.",
      added_minutes: rental.duration_minutes,
      end_time: toIsoString(endTime),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  void publishBikeCommandSafely(rental.bike_id, {
    action: "UNLOCK",
    message: "Sesi sewa sudah aktif.",
    duration_minutes: rental.duration_minutes,
    end_time: toIsoString(rental.end_time),
    timestamp: new Date().toISOString(),
  });
};

const sendSuccessNotifications = (result) => {
  const rental = result.rental;
  const bikeId = result.bikeId || rental.bike_id;

  void updateBikeCache(bikeId, false);

  if (result.rentalType === "EXTENSION") {
    void publishBikeCommandSafely(bikeId, {
      action: "EXTEND_TIME",
      message: "Perpanjangan sewa berhasil!",
      added_minutes: result.addedMinutes,
      end_time: toIsoString(result.endTime),
      timestamp: new Date().toISOString(),
    });

    if (rental.phone_number) {
      void sendExtensionReceipt(
        rental.phone_number,
        rental.user_name,
        bikeId,
        result.addedMinutes,
        result.endTime,
      );
    }
    return;
  }

  void publishBikeCommandSafely(bikeId, {
    action: "UNLOCK",
    message: "Pembayaran sukses, selamat berkendara!",
    duration_minutes: result.durationMinutes,
    end_time: toIsoString(result.endTime),
    timestamp: new Date().toISOString(),
  });

  if (rental.phone_number) {
    void sendPaymentReceipt(
      rental.phone_number,
      rental.user_name,
      bikeId,
      result.durationMinutes,
      result.endTime,
    );
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Membuat transaksi sewa baru
// POST /api/rent/create-transaction
// ---------------------------------------------------------------------------
const createRentTransaction = async (req, res) => {
  let connection;
  let newRentalId = null;
  let reservedBikeId = null;

  try {
    const { bike_id } = req.body;
    const userId = req.user.user_id;
    const durationMinutes = parseDurationMinutes(req.body.duration_minutes);

    if (!bike_id || !durationMinutes) {
      return res.status(400).json({
        status: "error",
        message: `Parameter bike_id dan duration_minutes (${MIN_RENTAL_MINUTES}-${MAX_RENTAL_MINUTES} menit) wajib diisi.`,
      });
    }

    const amount = calculateAmount(durationMinutes, "INITIAL");

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(500).json({
        status: "error",
        message: "Konfigurasi tarif sewa tidak valid.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [users] = await connection.query(
      "SELECT name, phone_number FROM users WHERE user_id = ?",
      [userId],
    );

    if (users.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        status: "error",
        message: "User tidak ditemukan.",
      });
    }

    const user = users[0];

    // Lock semua pending rental untuk sepeda ini terlebih dahulu.
    // Urutan lock dibuat konsisten dengan webhook: rental -> bike.
    const [pendingRentals] = await connection.query(
      `SELECT rental_id, user_id, midtrans_order_id
       FROM rentals
       WHERE bike_id = ?
         AND payment_status = 'PENDING'
         AND rental_status IN ('WAITING_PAYMENT', 'WAITING_EXTEND')
       FOR UPDATE`,
      [bike_id],
    );

    const otherUserPending = pendingRentals.find(
      (rental) => Number(rental.user_id) !== Number(userId),
    );

    if (otherUserPending) {
      await connection.rollback();
      return res.status(409).json({
        status: "error",
        message:
          "Sepeda sedang menunggu pembayaran dari pengguna lain. Silakan pilih sepeda lain.",
      });
    }

    const [bikes] = await connection.query(
      "SELECT status FROM bikes WHERE bike_id = ? FOR UPDATE",
      [bike_id],
    );

    if (bikes.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        status: "error",
        message: "Sepeda tidak ditemukan.",
      });
    }

    if (!["AVAILABLE", "RESERVED"].includes(bikes[0].status)) {
      await connection.rollback();
      return res.status(409).json({
        status: "error",
        message: `Sepeda tidak tersedia (status: ${bikes[0].status}).`,
      });
    }

    // Batalkan pending lama milik user yang sama agar tidak menumpuk.
    if (pendingRentals.length > 0) {
      const placeholders = pendingRentals.map(() => "?").join(",");
      const rentalIds = pendingRentals.map((rental) => rental.rental_id);

      await connection.query(
        `UPDATE rentals
         SET payment_status = 'CANCELLED',
             rental_status = 'CANCELLED',
             payment_processed_at = NOW()
         WHERE rental_id IN (${placeholders})`,
        rentalIds,
      );
    }

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const orderId = `RENT-${bike_id}-${Date.now()}-${randomSuffix}`;

    const [insertResult] = await connection.query(
      `INSERT INTO rentals
         (bike_id, user_id, duration_minutes, amount, payment_status,
          rental_status, midtrans_order_id, rental_type)
       VALUES (?, ?, ?, ?, 'PENDING', 'WAITING_PAYMENT', ?, 'INITIAL')`,
      [bike_id, userId, durationMinutes, amount, orderId],
    );

    newRentalId = insertResult.insertId;

    await connection.query(
      `UPDATE bikes
       SET status = 'RESERVED', lock_state = TRUE
       WHERE bike_id = ?`,
      [bike_id],
    );

    reservedBikeId = bike_id;
    await connection.commit();

    // Best-effort: batalkan order lama di Midtrans tanpa menahan transaksi DB.
    if (pendingRentals.length > 0) {
      void cancelOldMidtransOrders(pendingRentals);
    }

    let transaction;

    try {
      transaction = await snap.createTransaction({
        transaction_details: {
          order_id: orderId,
          gross_amount: amount,
        },
        customer_details: {
          first_name: user.name,
          phone: user.phone_number,
        },
        item_details: [
          {
            id: bike_id,
            price: amount,
            quantity: 1,
            name: `Sewa Sepeda ${bike_id} (${durationMinutes} Menit)`,
          },
        ],
        expiry: {
          unit: "minutes",
          duration: PAYMENT_EXPIRY_MINUTES,
        },
      });
    } catch (midtransError) {
      await cancelRentalAndRelease(newRentalId, reservedBikeId);
      console.error("[MIDTRANS ERROR]", midtransError.message);

      return res.status(502).json({
        status: "error",
        message: "Gagal membuat transaksi pembayaran ke Midtrans.",
      });
    }

    return res.status(201).json({
      status: "success",
      message: "Token pembayaran berhasil dibuat",
      data: {
        order_id: orderId,
        snap_token: transaction.token,
        redirect_url: transaction.redirect_url,
        amount,
        payment_status: "PENDING",
        rental_status: "WAITING_PAYMENT",
        expires_in_minutes: PAYMENT_EXPIRY_MINUTES,
      },
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {
        // Abaikan error rollback.
      }
    }

    if (newRentalId) {
      await cancelRentalAndRelease(newRentalId, reservedBikeId);
    }

    console.error("[TRANSACTION ERROR]", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Webhook callback Midtrans
// POST /api/payment/notification
// ---------------------------------------------------------------------------
const handlePaymentNotification = async (req, res) => {
  try {
    const notificationJson = req.body || {};
    const {
      order_id: orderId,
      transaction_status: transactionStatus,
      fraud_status: fraudStatus,
      status_code: statusCode,
      gross_amount: grossAmount,
      signature_key: signatureKey,
    } = notificationJson;

    if (
      !orderId ||
      !transactionStatus ||
      !statusCode ||
      grossAmount === undefined ||
      !signatureKey
    ) {
      return res.status(400).json({
        status: "error",
        message: "Payload notifikasi Midtrans tidak lengkap.",
      });
    }

    if (
      !verifyMidtransSignature({
        orderId,
        statusCode,
        grossAmount,
        signatureKey,
      })
    ) {
      console.warn(
        `[MIDTRANS WARN] Invalid Signature Key untuk order: ${orderId}`,
      );
      return res.status(403).json({
        status: "error",
        message: "Signature Key tidak valid",
      });
    }

    const event = mapMidtransEvent(transactionStatus, fraudStatus);
    console.log(
      `[MIDTRANS NOTIF] Order: ${orderId} | Status: ${transactionStatus} | Event: ${event}`,
    );

    if (event === "IGNORED") {
      return res.status(200).json({
        status: "success",
        message: `Status ${transactionStatus} diabaikan.`,
      });
    }

    const [rentals] = await db.query(
      `SELECT r.*, u.name AS user_name, u.phone_number
       FROM rentals r
       JOIN users u ON u.user_id = r.user_id
       WHERE r.midtrans_order_id = ?`,
      [orderId],
    );

    // Order yang tidak dikenal tidak perlu membuat Midtrans retry terus-menerus.
    if (rentals.length === 0) {
      console.warn(`[MIDTRANS WARN] Order tidak ditemukan: ${orderId}`);
      return res.status(200).json({
        status: "ignored",
        message: "Order tidak ditemukan di database.",
      });
    }

    const rental = rentals[0];

    if (!amountsMatch(rental.amount, grossAmount)) {
      console.error(
        `[MIDTRANS WARN] Amount mismatch untuk ${orderId}: DB=${rental.amount}, Midtrans=${grossAmount}`,
      );

      await flagPaymentConflict(rental.rental_id, "AMOUNT_MISMATCH");

      notifyPaymentConflict(
        {
          rental,
          bikeId: rental.bike_id,
          reason: "AMOUNT_MISMATCH",
        },
        orderId,
      );

      return res.status(200).json({
        status: "ignored",
        message: "Nominal pembayaran tidak sesuai. Hubungi admin.",
      });
    }

    if (event === "PENDING") {
      return res.status(200).json({
        status: "pending",
        message: "Pembayaran masih menunggu penyelesaian.",
      });
    }

    if (event === "FAILED") {
      const result = await processFailedPayment(
        rental.rental_id,
        transactionStatus,
      );

      return res.status(200).json({
        status: "success",
        message: result.ignored
          ? "Pembayaran sudah diproses sebelumnya."
          : `Pembayaran ditandai ${result.paymentStatus}.`,
      });
    }

    const result = await processSuccessfulPayment(rental.rental_id);

    if (result.alreadyProcessed) {
      if (result.republish) {
        void republishIdempotentCommand(result.rental).catch((error) => {
          console.error(
            "[MQTT IDEMPOTENT ERROR] Gagal mengirim ulang command:",
            error.message,
          );
        });
      }

      return res.status(200).json({
        status: "success",
        message: "Pembayaran sudah pernah diproses (idempoten).",
      });
    }

    if (result.conflict) {
      notifyPaymentConflict(result, orderId);

      return res.status(200).json({
        status: "conflict",
        message:
          "Pembayaran diterima, tetapi sesi tidak dapat diaktifkan. Admin akan menindaklanjuti.",
        data: { reason: result.reason },
      });
    }

    void sendSuccessNotifications(result);

    return res.status(200).json({
      status: "success",
      message: "Webhook berhasil diproses.",
      data: {
        rental_type: result.rentalType,
        bike_id: result.bikeId,
        end_time: toIsoString(result.endTime),
      },
    });
  } catch (error) {
    console.error(
      "[WEBHOOK ERROR] Gagal memproses callback Midtrans:",
      error.message,
    );
    return res.status(500).json({ status: "error", message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Meminta token pembayaran perpanjangan sewa
// POST /api/rent/extend-transaction
// ---------------------------------------------------------------------------
const extendRentTransaction = async (req, res) => {
  let connection;
  let createdExtensionId = null;

  try {
    const { bike_id } = req.body;
    const userId = req.user.user_id;
    const durationMinutes = parseDurationMinutes(req.body.duration_minutes);

    if (!bike_id || !durationMinutes) {
      return res.status(400).json({
        status: "error",
        message: `Parameter bike_id dan duration_minutes (${MIN_RENTAL_MINUTES}-${MAX_RENTAL_MINUTES} menit) wajib diisi.`,
      });
    }

    const amount = calculateAmount(durationMinutes, "EXTENSION");

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(500).json({
        status: "error",
        message: "Konfigurasi tarif perpanjangan tidak valid.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Cari parent tanpa lock terlebih dahulu. Lock diambil dengan urutan
    // pending extension -> parent agar konsisten dengan webhook.
    const [rentalCandidates] = await connection.query(
      `SELECT rental_id
       FROM rentals
       WHERE bike_id = ?
         AND user_id = ?
         AND rental_type = 'INITIAL'
         AND payment_status = 'SETTLED'
         AND rental_status IN ('ACTIVE', 'WARNING_SENT')
       ORDER BY rental_id DESC
       LIMIT 1`,
      [bike_id, userId],
    );

    if (rentalCandidates.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        status: "error",
        message:
          "Sesi sewa aktif tidak ditemukan atau sudah berakhir. Perpanjangan hanya dapat dilakukan sebelum waktu sewa habis.",
      });
    }

    const parentRentalId = rentalCandidates[0].rental_id;

    const [pendingExtensions] = await connection.query(
      `SELECT rental_id, midtrans_order_id
       FROM rentals
       WHERE parent_rental_id = ?
         AND payment_status = 'PENDING'
         AND rental_status = 'WAITING_EXTEND'
       FOR UPDATE`,
      [parentRentalId],
    );

    if (pendingExtensions.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        status: "error",
        message:
          "Masih ada pembayaran perpanjangan yang menunggu. Selesaikan atau tunggu hingga kedaluwarsa.",
      });
    }

    const [rentals] = await connection.query(
      `SELECT r.*, u.name AS user_name, u.phone_number
       FROM rentals r
       JOIN users u ON u.user_id = r.user_id
       WHERE r.rental_id = ?
       FOR UPDATE`,
      [parentRentalId],
    );

    if (
      rentals.length === 0 ||
      !["ACTIVE", "WARNING_SENT"].includes(rentals[0].rental_status)
    ) {
      await connection.rollback();
      return res.status(409).json({
        status: "error",
        message:
          "Sesi sewa sudah berakhir saat transaksi perpanjangan dibuat. Silakan mulai sesi baru.",
      });
    }

    const parentRental = rentals[0];

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const orderId = `EXTEND-${bike_id}-${Date.now()}-${randomSuffix}`;

    const [insertResult] = await connection.query(
      `INSERT INTO rentals
         (bike_id, user_id, duration_minutes, amount, payment_status,
          rental_status, midtrans_order_id, rental_type, parent_rental_id)
       VALUES (?, ?, ?, ?, 'PENDING', 'WAITING_EXTEND', ?, 'EXTENSION', ?)`,
      [
        parentRental.bike_id,
        parentRental.user_id,
        durationMinutes,
        amount,
        orderId,
        parentRental.rental_id,
      ],
    );

    createdExtensionId = insertResult.insertId;
    await connection.commit();

    let transaction;

    try {
      transaction = await snap.createTransaction({
        transaction_details: {
          order_id: orderId,
          gross_amount: amount,
        },
        customer_details: {
          first_name: parentRental.user_name,
          phone: parentRental.phone_number,
        },
        item_details: [
          {
            id: `EXT-${parentRental.bike_id}`,
            price: amount,
            quantity: 1,
            name: `Perpanjangan Sewa ${parentRental.bike_id} (+${durationMinutes} Menit)`,
          },
        ],
        expiry: {
          unit: "minutes",
          duration: PAYMENT_EXPIRY_MINUTES,
        },
      });
    } catch (midtransError) {
      await cancelRentalAndRelease(createdExtensionId, null);
      console.error("[EXTEND MIDTRANS ERROR]", midtransError.message);

      return res.status(502).json({
        status: "error",
        message: "Gagal membuat transaksi perpanjangan ke Midtrans.",
      });
    }

    return res.status(201).json({
      status: "success",
      message: "Token perpanjangan berhasil dibuat",
      data: {
        order_id: orderId,
        snap_token: transaction.token,
        redirect_url: transaction.redirect_url,
        amount,
        parent_rental_id: parentRental.rental_id,
        payment_status: "PENDING",
        rental_status: "WAITING_EXTEND",
        expires_in_minutes: PAYMENT_EXPIRY_MINUTES,
      },
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {
        // Abaikan error rollback.
      }
    }

    if (createdExtensionId) {
      await cancelRentalAndRelease(createdExtensionId, null);
    }

    console.error("[EXTEND ERROR]", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Mengakhiri sesi sewa / pengembalian sepeda
// POST /api/rent/finish
// ---------------------------------------------------------------------------
const finishRentSession = async (req, res) => {
  let connection;
  let pendingExtensionOrders = [];

  try {
    const { bike_id } = req.body;
    const userId = req.user.user_id;

    if (!bike_id) {
      return res.status(400).json({
        status: "error",
        message: "Parameter bike_id wajib diisi.",
      });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    // Lock dengan urutan: pending extension -> parent rental -> bike.
    // Urutan ini sama dengan webhook (extension -> parent) agar tidak deadlock.
    const [rentalCandidates] = await connection.query(
      `SELECT rental_id
       FROM rentals
       WHERE bike_id = ?
         AND user_id = ?
         AND rental_type = 'INITIAL'
         AND rental_status IN ('ACTIVE', 'WARNING_SENT', 'OVERDUE')
       ORDER BY rental_id DESC
       LIMIT 1`,
      [bike_id, userId],
    );

    if (rentalCandidates.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        status: "error",
        message: "Sesi sewa aktif tidak ditemukan untuk user dan sepeda ini.",
      });
    }

    const parentRentalId = rentalCandidates[0].rental_id;

    const [pendingExtensions] = await connection.query(
      `SELECT rental_id, midtrans_order_id
       FROM rentals
       WHERE parent_rental_id = ?
         AND payment_status = 'PENDING'
       FOR UPDATE`,
      [parentRentalId],
    );

    pendingExtensionOrders = pendingExtensions;

    const [rentals] = await connection.query(
      `SELECT r.*, u.name AS user_name, u.phone_number
       FROM rentals r
       JOIN users u ON u.user_id = r.user_id
       WHERE r.rental_id = ?
       FOR UPDATE`,
      [parentRentalId],
    );

    if (
      rentals.length === 0 ||
      !["ACTIVE", "WARNING_SENT", "OVERDUE"].includes(
        rentals[0].rental_status,
      )
    ) {
      await connection.rollback();
      return res.status(404).json({
        status: "error",
        message: "Sesi sewa aktif tidak ditemukan untuk user dan sepeda ini.",
      });
    }

    const rental = rentals[0];

    const [bikes] = await connection.query(
      "SELECT status FROM bikes WHERE bike_id = ? FOR UPDATE",
      [bike_id],
    );

    if (bikes.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        status: "error",
        message: "Sepeda tidak ditemukan.",
      });
    }

    if (pendingExtensions.length > 0) {
      await connection.query(
        `UPDATE rentals
         SET payment_status = 'CANCELLED',
             rental_status = 'CANCELLED',
             payment_processed_at = NOW()
         WHERE parent_rental_id = ?
           AND payment_status = 'PENDING'`,
        [parentRentalId],
      );
    }

    await connection.query(
      `UPDATE rentals
       SET rental_status = 'COMPLETED',
           end_time = NOW()
       WHERE rental_id = ?`,
      [rental.rental_id],
    );

    await connection.query(
      `UPDATE bikes
       SET status = 'AVAILABLE', lock_state = TRUE
       WHERE bike_id = ?`,
      [bike_id],
    );

    await connection.commit();

    // Best-effort: batalkan order perpanjangan yang masih pending.
    for (const extension of pendingExtensionOrders) {
      if (!extension.midtrans_order_id) continue;
      try {
        await snap.transaction.cancel(extension.midtrans_order_id);
      } catch (error) {
        console.warn(
          `[EXTEND CANCEL NOTICE] ${extension.midtrans_order_id}: ${error.message}`,
        );
      }
    }

    void updateBikeCache(bike_id, true);
    void publishBikeCommandSafely(bike_id, {
      action: "LOCK",
      message: "Pengguna telah mengakhiri sesi sewa.",
      timestamp: new Date().toISOString(),
    });

    if (rental.phone_number) {
      void sendReturnReceipt(rental.phone_number, rental.user_name, bike_id);
    }

    const state = await getRentalPaymentState(rental.rental_id);

    console.log(
      `[SESSION FINISHED] Sepeda ${bike_id} dikembalikan oleh User ${userId} & DILOCK.`,
    );

    return res.status(200).json({
      status: "success",
      message:
        "Sesi sewa berhasil diakhiri dan kunci sepeda telah terkunci kembali.",
      data: state,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (_) {
        // Abaikan error rollback.
      }
    }

    console.error("[FINISH RENTAL ERROR]", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Konfirmasi pembayaran dari client dengan verifikasi Midtrans
// POST /api/rent/confirm-payment
// ---------------------------------------------------------------------------
const confirmRentPayment = async (req, res) => {
  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({
        status: "error",
        message: "order_id wajib diisi.",
      });
    }

    const [rentals] = await db.query(
      "SELECT rental_id, user_id FROM rentals WHERE midtrans_order_id = ?",
      [order_id],
    );

    if (
      rentals.length === 0 ||
      Number(rentals[0].user_id) !== Number(req.user.user_id)
    ) {
      return res.status(404).json({
        status: "error",
        message: "Data rental tidak ditemukan.",
      });
    }

    const rentalId = rentals[0].rental_id;
    const stateBefore = await getRentalPaymentState(rentalId);

    if (stateBefore.payment_status === "SETTLED") {
      return res.status(200).json({
        status: "success",
        message: "Pembayaran sudah diproses.",
        data: stateBefore,
      });
    }

    if (stateBefore.payment_status !== "PENDING") {
      return res.status(409).json({
        status: "error",
        message: `Transaksi sudah berstatus ${stateBefore.payment_status}.`,
        data: stateBefore,
      });
    }

    let midtransStatus;

    try {
      midtransStatus = await snap.transaction.status(order_id);
    } catch (error) {
      console.error(
        `[CONFIRM PAYMENT] Gagal cek status Midtrans ${order_id}:`,
        error.message,
      );

      return res.status(502).json({
        status: "error",
        message: "Gagal memverifikasi status pembayaran ke Midtrans.",
      });
    }

    if (
      midtransStatus.order_id &&
      String(midtransStatus.order_id) !== String(order_id)
    ) {
      console.error(
        `[CONFIRM PAYMENT] Order ID tidak cocok: request=${order_id}, midtrans=${midtransStatus.order_id}`,
      );

      return res.status(409).json({
        status: "error",
        message: "Data pembayaran tidak cocok dengan order yang diminta.",
      });
    }

    if (!amountsMatch(stateBefore.amount, midtransStatus.gross_amount)) {
      console.error(
        `[CONFIRM PAYMENT] Amount mismatch untuk ${order_id}: DB=${stateBefore.amount}, Midtrans=${midtransStatus.gross_amount}`,
      );

      await flagPaymentConflict(rentalId, "AMOUNT_MISMATCH");

      notifyPaymentConflict(
        {
          rental: stateBefore,
          bikeId: stateBefore.bike_id,
          reason: "AMOUNT_MISMATCH",
        },
        order_id,
      );

      return res.status(409).json({
        status: "error",
        message: "Nominal pembayaran tidak sesuai. Silakan hubungi admin.",
      });
    }

    const event = mapMidtransEvent(
      midtransStatus.transaction_status,
      midtransStatus.fraud_status,
    );

    if (event === "PENDING") {
      return res.status(202).json({
        status: "pending",
        message: "Pembayaran masih diproses.",
        data: {
          ...stateBefore,
          midtrans_status: midtransStatus.transaction_status,
        },
      });
    }

    if (event !== "SUCCESS") {
      return res.status(409).json({
        status: "error",
        message: "Pembayaran tidak berhasil.",
        data: {
          ...stateBefore,
          midtrans_status: midtransStatus.transaction_status,
        },
      });
    }

    const result = await processSuccessfulPayment(rentalId);

    if (result.conflict) {
      notifyPaymentConflict(result, order_id);
      const state = await getRentalPaymentState(rentalId);

      return res.status(409).json({
        status: "error",
        message:
          "Pembayaran diterima, tetapi sesi tidak dapat diaktifkan. Silakan hubungi admin.",
        data: state,
      });
    }

    if (!result.alreadyProcessed) {
      void sendSuccessNotifications(result);
    }

    const state = await getRentalPaymentState(rentalId);

    return res.status(200).json({
      status: "success",
      message: result.alreadyProcessed
        ? "Pembayaran sudah pernah diproses."
        : "Sesi sewa berhasil diaktifkan.",
      data: state,
    });
  } catch (error) {
    console.error("[CONFIRM PAYMENT ERROR]", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Cek status pembayaran (read-only, untuk polling frontend)
// GET /api/rent/status/:order_id
// ---------------------------------------------------------------------------
const getRentStatus = async (req, res) => {
  try {
    const { order_id } = req.params;

    const [rentals] = await db.query(
      "SELECT rental_id, user_id FROM rentals WHERE midtrans_order_id = ?",
      [order_id],
    );

    if (
      rentals.length === 0 ||
      Number(rentals[0].user_id) !== Number(req.user.user_id)
    ) {
      return res.status(404).json({
        status: "error",
        message: "Data rental tidak ditemukan.",
      });
    }

    const state = await getRentalPaymentState(rentals[0].rental_id);

    return res.status(200).json({
      status: "success",
      data: state,
    });
  } catch (error) {
    console.error("[RENT STATUS ERROR]", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Endpoint: Konfigurasi tarif & batas sewa (dipakai frontend)
// GET /api/config/pricing
// ---------------------------------------------------------------------------
const getPaymentConfig = async (req, res) => {
  return res.status(200).json({
    status: "success",
    data: {
      initial_price_per_minute: INITIAL_PRICE_PER_MINUTE,
      extension_price_per_minute: EXTENSION_PRICE_PER_MINUTE,
      min_rental_minutes: MIN_RENTAL_MINUTES,
      max_rental_minutes: MAX_RENTAL_MINUTES,
      payment_expiry_minutes: PAYMENT_EXPIRY_MINUTES,
    },
  });
};

module.exports = {
  createRentTransaction,
  handlePaymentNotification,
  extendRentTransaction,
  finishRentSession,
  confirmRentPayment,
  getRentStatus,
  getPaymentConfig,
};
