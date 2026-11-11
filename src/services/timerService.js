const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
const incidentService = require("./incidentService");
const {
  sendTimeWarning,
  sendRentalExpired,
  sendIncidentNotification,
} = require("./notificationService");

// Ambang batas waktu peringatan (misal: 5 menit sebelum sewa habis)
const WARNING_THRESHOLD_SECONDS = 300;
const PAYMENT_EXPIRY_MINUTES = Number(
  process.env.PAYMENT_EXPIRY_MINUTES || 15,
);

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

/**
 * Memproses satu rental dengan row lock agar tidak bentrok dengan
 * webhook pembayaran atau proses extend.
 */
const processRentalTimer = async (rentalId) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const [rentals] = await connection.query(
      `SELECT
         r.rental_id,
         r.bike_id,
         r.user_id,
         r.end_time,
         r.rental_status,
         r.payment_status,
         r.duration_minutes,
         u.phone_number,
         u.name AS user_name
       FROM rentals r
       JOIN users u ON u.user_id = r.user_id
       WHERE r.rental_id = ?
       FOR UPDATE`,
      [rentalId],
    );

    if (rentals.length === 0) {
      await connection.commit();
      return;
    }

    const rental = rentals[0];

    if (
      rental.payment_status !== "SETTLED" ||
      !["ACTIVE", "WARNING_SENT"].includes(rental.rental_status)
    ) {
      await connection.commit();
      return;
    }

    const [timeRows] = await connection.query(
      `SELECT TIMESTAMPDIFF(SECOND, NOW(), end_time) AS remaining_seconds
       FROM rentals
       WHERE rental_id = ?`,
      [rentalId],
    );

    const remainingSeconds = Number(timeRows[0].remaining_seconds);

    // -----------------------------------------------------------------
    // SKENARIO A: WAKTU HABIS
    // -----------------------------------------------------------------
    if (remainingSeconds <= 0) {
      await connection.query(
        `UPDATE rentals SET rental_status = 'OVERDUE' WHERE rental_id = ?`,
        [rentalId],
      );

      await connection.query(
        `UPDATE bikes
         SET status = 'OVERDUE', lock_state = TRUE
         WHERE bike_id = ?`,
        [rental.bike_id],
      );

      await connection.commit();

      // Catat insiden pelanggaran: waktu sewa habis.
      // Best-effort: kegagalan pencatatan tidak boleh menghentikan
      // penguncian sepeda dan notifikasi.
      try {
        await incidentService.openIncident({
          bikeId: rental.bike_id,
          type: "OVERDUE",
          severity: "HIGH",
          message: `Waktu sewa habis (durasi ${rental.duration_minutes} menit). Sepeda dikunci otomatis.`,
          lockState: true,
          userId: rental.user_id,
          rentalId: rental.rental_id,
        });
      } catch (incidentError) {
        console.warn(
          `[INCIDENT] Gagal mencatat insiden OVERDUE ${rental.bike_id}:`,
          incidentError.message,
        );
      }

      void updateBikeCache(rental.bike_id, true);
      void publishBikeCommandSafely(rental.bike_id, {
        action: "LOCK_AND_ALARM",
        reason: "RENTAL_TIME_EXPIRED",
        message: "Waktu sewa habis. Sepeda dikunci otomatis.",
        timestamp: new Date().toISOString(),
      });

      if (rental.phone_number) {
        void sendRentalExpired(rental.phone_number, rental.bike_id);
      }

      const adminPhone = process.env.ADMIN_PHONE_NUMBER;
      if (adminPhone) {
        void sendIncidentNotification(adminPhone, {
          bikeId: rental.bike_id,
          userName: rental.user_name,
          userPhone: rental.phone_number,
          typeLabel: "WAKTU SEWA HABIS (OVERDUE)",
          message: `Durasi sewa ${rental.duration_minutes} menit telah berakhir dan sepeda dikunci otomatis.`,
          detectedAt: new Date(),
        });
      }

      console.warn(
        `[! TIMER EXPIRED !] Sewa sepeda ${rental.bike_id} telah habis. Status: OVERDUE.`,
      );
      return;
    }

    // -----------------------------------------------------------------
    // SKENARIO B: WARNING HAMPIR HABIS
    // -----------------------------------------------------------------
    if (
      remainingSeconds <= WARNING_THRESHOLD_SECONDS &&
      rental.rental_status === "ACTIVE"
    ) {
      const remainingMinutes = Math.ceil(remainingSeconds / 60);

      await connection.query(
        `UPDATE rentals SET rental_status = 'WARNING_SENT' WHERE rental_id = ?`,
        [rentalId],
      );

      await connection.commit();

      if (rental.phone_number) {
        void sendTimeWarning(
          rental.phone_number,
          rental.bike_id,
          remainingMinutes,
        );
      }

      void publishBikeCommandSafely(rental.bike_id, {
        action: "WARNING_BEEP",
        reason: "TIME_RUNNING_OUT",
        remaining_minutes: remainingMinutes,
        message: `Sisa waktu sewa ${remainingMinutes} menit. Segera perpanjang atau kembalikan sepeda.`,
        timestamp: new Date().toISOString(),
      });

      console.log(
        `[TIMER WARNING] Sepeda ${rental.bike_id} tersisa ${remainingMinutes} menit.`,
      );
      return;
    }

    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      // Abaikan error rollback.
    }
    console.error(
      `[TIMER SERVICE ERROR] Gagal memproses rental ${rentalId}:`,
      error.message,
    );
  } finally {
    connection.release();
  }
};

const checkRentalTimers = async () => {
  try {
    const [activeRentals] = await db.query(`
      SELECT rental_id
      FROM rentals
      WHERE rental_status IN ('ACTIVE', 'WARNING_SENT')
        AND payment_status = 'SETTLED'
    `);

    for (const rental of activeRentals) {
      await processRentalTimer(rental.rental_id);
    }
  } catch (error) {
    console.error(
      "[TIMER SERVICE ERROR] Gagal memeriksa status waktu sewa:",
      error.message,
    );
  }
};

/**
 * Membersihkan rental PENDING yang melewati batas waktu pembayaran.
 * Mencegah sepeda tertahan di status RESERVED jika webhook expire tidak datang.
 */
const cleanupStalePendingPayments = async () => {
  try {
    const [pendingRentals] = await db.query(
      `SELECT rental_id
       FROM rentals
       WHERE payment_status = 'PENDING'
         AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [PAYMENT_EXPIRY_MINUTES],
    );

    for (const pending of pendingRentals) {
      const connection = await db.getConnection();

      try {
        await connection.beginTransaction();

        const [rentals] = await connection.query(
          `SELECT rental_id, bike_id, rental_type, payment_status
           FROM rentals
           WHERE rental_id = ?
           FOR UPDATE`,
          [pending.rental_id],
        );

        if (
          rentals.length === 0 ||
          rentals[0].payment_status !== "PENDING"
        ) {
          await connection.commit();
          continue;
        }

        const rental = rentals[0];

        await connection.query(
          `UPDATE rentals
           SET payment_status = 'EXPIRED',
               rental_status = 'CANCELLED',
               payment_processed_at = NOW()
           WHERE rental_id = ?`,
          [rental.rental_id],
        );

        let released = false;

        if (rental.rental_type !== "EXTENSION") {
          released = await releaseBikeReservation(
            connection,
            rental.bike_id,
          );
        }

        await connection.commit();

        if (released) {
          void updateBikeCache(rental.bike_id, true);
        }

        console.log(
          `[PAYMENT CLEANUP] Rental ${rental.rental_id} (${rental.rental_type}) kedaluwarsa.`,
        );
      } catch (error) {
        try {
          await connection.rollback();
        } catch (_) {
          // Abaikan error rollback.
        }
        console.error(
          `[PAYMENT CLEANUP ERROR] Rental ${pending.rental_id}:`,
          error.message,
        );
      } finally {
        connection.release();
      }
    }
  } catch (error) {
    console.error(
      "[PAYMENT CLEANUP ERROR] Gagal membersihkan pending payment:",
      error.message,
    );
  }
};

/**
 * Inisialisasi background job timer.
 */
const initTimerService = () => {
  console.log(
    "[TIMER SERVICE] Engine Pengecekan Durasi Sewa Aktif (Interval: 10s)",
  );
  setInterval(checkRentalTimers, 10000); // 10000 ms = 10 detik
  setInterval(cleanupStalePendingPayments, 60000); // 60 detik
};

module.exports = {
  initTimerService,
  checkRentalTimers,
  cleanupStalePendingPayments,
};
