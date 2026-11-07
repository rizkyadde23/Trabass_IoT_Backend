const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
const { sendTimeWarning } = require("./notificationService");

// Ambang batas waktu peringatan (misal: 5 menit sebelum sewa habis)
const WARNING_THRESHOLD_SECONDS = 300;

const checkRentalTimers = async () => {
  try {
    // 1. Ambil semua rental yang sedang berjalan (status ACTIVE atau WARNING_SENT)
    const [activeRentals] = await db.query(`
      SELECT r.rental_id, r.bike_id, r.user_id, r.end_time, r.rental_status, u.phone_number, u.name AS user_name
      FROM rentals r
      JOIN users u ON r.user_id = u.user_id
      WHERE r.rental_status IN ('ACTIVE', 'WARNING_SENT') 
        AND r.payment_status = 'SETTLED'
    `);

    const now = new Date();

    for (const rental of activeRentals) {
      const endTime = new Date(rental.end_time);
      const remainingSeconds = Math.floor((endTime - now) / 1000);

      const bikeId = rental.bike_id;
      const commandTopic = `bike/command/${bikeId}`;

      // -------------------------------------------------------------
      // SKENARIO A: WAKTU HABIS (Sisa Waktu <= 0 Detik)
      // -------------------------------------------------------------
      if (remainingSeconds <= 0) {
        console.warn(
          `[! TIMER EXPIRED !] Sewa sepeda ${bikeId} telah habis! Mengunci sepeda...`,
        );

        // 1. Publish Perintah LOCK & ALARM ke Sepeda via MQTT
        mqttClient.publish(
          commandTopic,
          JSON.stringify({
            action: "LOCK_AND_ALARM",
            reason: "RENTAL_TIME_EXPIRED",
            message: "Waktu sewa habis. Sepeda dikunci otomatis.",
            timestamp: new Date().toISOString(),
          }),
          { qos: 1 },
        );

        // 2. Update Status Rental di MySQL menjadi COMPLETED / EXPIRED
        await db.query(
          `UPDATE rentals SET rental_status = 'EXPIRED' WHERE rental_id = ?`,
          [rental.rental_id],
        );

        // 3. Update Status Sepeda di MySQL & Redis
        await db.query(
          `UPDATE bikes SET lock_state = TRUE, status = 'AVAILABLE' WHERE bike_id = ?`,
          [bikeId],
        );

        await redisClient.hSet(`bike:${bikeId}:location`, {
          lock_state: "true",
          updated_at: new Date().toISOString(),
        });

        // -------------------------------------------------------------
        // SKENARIO B: WARNING HAMPIR HABIS (<= 5 Menit)
        // -------------------------------------------------------------
      } else if (
        remainingSeconds <= WARNING_THRESHOLD_SECONDS &&
        rental.rental_status === "ACTIVE"
      ) {
        const remainingMinutes = Math.ceil(remainingSeconds / 60);
        // Kirim WA Warning ke User
        if (rental.phone_number) {
          sendTimeWarning(rental.phone_number, bikeId, remainingMinutes);
        }
        console.log(
          `[TIMER WARNING] Sepeda ${bikeId} tersisa ${remainingMinutes} menit.`,
        );

        // 1. Publish Perintah BEEP Peringatan ke Sepeda
        mqttClient.publish(
          commandTopic,
          JSON.stringify({
            action: "WARNING_BEEP",
            reason: "TIME_RUNNING_OUT",
            remaining_minutes: remainingMinutes,
            message: `Sisa waktu sewa ${remainingMinutes} menit. Segera perpanjang atau kembalikan sepeda.`,
            timestamp: new Date().toISOString(),
          }),
          { qos: 1 },
        );

        // 2. Update Status Rental menjadi 'WARNING_SENT' agar tidak membunyikan warning berulang kali
        await db.query(
          `UPDATE rentals SET rental_status = 'WARNING_SENT' WHERE rental_id = ?`,
          [rental.rental_id],
        );
      }
    }
  } catch (error) {
    console.error(
      "[TIMER SERVICE ERROR] Gagal memeriksa status waktu sewa:",
      error.message,
    );
  }
};

/**
 * Inisialisasi background job timer (Menjalankan pengecekan setiap 10 detik)
 */
const initTimerService = () => {
  console.log(
    "[TIMER SERVICE] Engine Pengecekan Durasi Sewa Aktif (Interval: 10s)",
  );
  setInterval(checkRentalTimers, 10000); // 10000 ms = 10 detik
};

module.exports = {
  initTimerService,
  checkRentalTimers,
};