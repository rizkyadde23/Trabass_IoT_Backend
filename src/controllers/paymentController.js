const midtransClient = require("midtrans-client");
const crypto = require("crypto");
const db = require("../config/db");
const redisClient = require("../config/redis");
const mqttClient = require("../config/mqtt");
require("dotenv").config();
const { sendPaymentReceipt } = require("../services/notificationService");

// Inisialisasi Midtrans Snap Instance
const snap = new midtransClient.Snap({
  isProduction: false, // Sandbox Mode
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

/**
 * 1. Endpoint Meminta Token Pembayaran (Create Transaction)
 * POST /api/rent/create-transaction
 */
const createRentTransaction = async (req, res) => {
  try {
    const { bike_id, user_id, duration_minutes, amount } = req.body;

    if (!bike_id || !user_id || !duration_minutes || !amount) {
      return res.status(400).json({
        status: "error",
        message:
          "Parameter bike_id, user_id, duration_minutes, dan amount wajib diisi.",
      });
    }

    // A. Cek Ketersediaan Sepeda
    const [bikes] = await db.query(
      "SELECT status, lock_state FROM bikes WHERE bike_id = ?",
      [bike_id],
    );
    if (bikes.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Sepeda tidak ditemukan." });
    }
    if (bikes[0].status !== "AVAILABLE") {
      return res.status(400).json({
        status: "error",
        message: "Sepeda sedang digunakan atau tidak tersedia.",
      });
    }

    // B. Cek Data User
    const [users] = await db.query(
      "SELECT name, phone_number FROM users WHERE user_id = ?",
      [user_id],
    );
    if (users.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "User tidak ditemukan." });
    }
    const user = users[0];

    // C. Generate Unique Order ID
    const orderId = `RENT-${bike_id}-${Date.now()}`;

    // D. Parameter Payload ke Midtrans Snap API
    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: Number(amount),
      },
      customer_details: {
        first_name: user.name,
        phone: user.phone_number,
      },
      item_details: [
        {
          id: bike_id,
          price: Number(amount),
          quantity: 1,
          name: `Sewa Sepeda ${bike_id} (${duration_minutes} Menit)`,
        },
      ],
    };

    // E. Dapatkan Snap Token dari Midtrans
    const transaction = await snap.createTransaction(parameter);
    const snapToken = transaction.token;
    const redirectUrl = transaction.redirect_url;

    // F. Simpan Transaksi PENDING ke Database MySQL
    await db.query(
      `INSERT INTO rentals (bike_id, user_id, duration_minutes, amount, payment_status, rental_status, midtrans_order_id)
       VALUES (?, ?, ?, ?, 'PENDING', 'WAITING_PAYMENT', ?)`,
      [bike_id, user_id, duration_minutes, amount, orderId],
    );

    console.log(`[MIDTRANS] Order ID dibuat: ${orderId} | Token: ${snapToken}`);

    return res.status(201).json({
      status: "success",
      message: "Token pembayaran berhasil dibuat",
      data: {
        order_id: orderId,
        snap_token: snapToken,
        redirect_url: redirectUrl,
      },
    });
  } catch (error) {
    console.error("[MIDTRANS ERROR] Gagal membuat transaksi:", error.message);
    return res.status(500).json({ status: "error", message: error.message });
  }
};

/**
 * 2. Webhook Callback Handler dari Midtrans
 * POST /api/payment/notification
 */
const handlePaymentNotification = async (req, res) => {
  try {
    const notificationJson = req.body;

    const orderId = notificationJson.order_id;
    const transactionStatus = notificationJson.transaction_status;
    const fraudStatus = notificationJson.fraud_status;
    const statusCode = notificationJson.status_code;
    const grossAmount = notificationJson.gross_amount;
    const signatureKey = notificationJson.signature_key;

    // A. Verifikasi Signature Key dari Midtrans demi keamanan
    const hash = crypto
      .createHash("sha512")
      .update(
        `${orderId}${statusCode}${grossAmount}${process.env.MIDTRANS_SERVER_KEY}`,
      )
      .digest("hex");

    if (hash !== signatureKey) {
      console.warn(
        `[MIDTRANS WARN] Invalid Signature Key untuk order: ${orderId}`,
      );
      return res
        .status(403)
        .json({ status: "error", message: "Signature Key tidak valid" });
    }

    console.log(
      `[MIDTRANS NOTIF] Order: ${orderId} | Status: ${transactionStatus}`,
    );

    // B. Cari Data Rental di MySQL
    const [rentals] = await db.query(
      "SELECT rental_id, bike_id, duration_minutes FROM rentals WHERE midtrans_order_id = ?",
      [orderId],
    );

    if (rentals.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Data rental tidak ditemukan" });
    }

    const rental = rentals[0];
    const bikeId = rental.bike_id;

    // C. Penanganan Status Transaksi
    if (
      transactionStatus === "settlement" ||
      (transactionStatus === "capture" && fraudStatus === "accept")
    ) {
      // --- PEMBAYARAN SUKSES ---
      const startTime = new Date();
      const endTime = new Date(
        startTime.getTime() + rental.duration_minutes * 60000,
      );

      // 1. Update status transaksi rental di MySQL
      await db.query(
        `UPDATE rentals 
         SET payment_status = 'SETTLED', rental_status = 'ACTIVE', start_time = ?, end_time = ? 
         WHERE rental_id = ?`,
        [startTime, endTime, rental.rental_id],
      );

      // 2. Update status sepeda di MySQL (Status RENTED & lock_state FALSE)
      await db.query(
        `UPDATE bikes SET status = 'RENTED', lock_state = FALSE WHERE bike_id = ?`,
        [bikeId],
      );

      // 3. Update status Redis Hash
      await redisClient.hSet(`bike:${bikeId}:location`, {
        lock_state: "false",
        updated_at: new Date().toISOString(),
      });

      // 4. PUBLISH PERINTAH MQTT UNLOCK KE ESP32
      const commandTopic = `bike/command/${bikeId}`;
      mqttClient.publish(
        commandTopic,
        JSON.stringify({
          action: "UNLOCK",
          message: "Pembayaran sukses, selamat berkendara!",
          duration_minutes: rental.duration_minutes,
          timestamp: new Date().toISOString(),
        }),
        { qos: 1 },
      );

      // 5. Ambil data user (nama & nomor HP)
      const [rentalsWithUser] = await db.query(
        `SELECT r.bike_id, r.duration_minutes, u.name, u.phone_number 
   FROM rentals r 
   JOIN users u ON r.user_id = u.user_id 
   WHERE r.rental_id = ?`,
        [rental.rental_id],
      );

      if (rentalsWithUser.length > 0) {
        const uData = rentalsWithUser[0];
        // Kirim Struk WhatsApp secara asynchronous (tanpa menghambat HTTP response webhook)
        sendPaymentReceipt(
          uData.phone_number,
          uData.name,
          uData.bike_id,
          uData.duration_minutes,
        );
      }

      console.log(`[MIDTRANS SUCCESS] Sepeda ${bikeId} berhasil DIBUKA!`);
    } else if (["cancel", "deny", "expire"].includes(transactionStatus)) {
      // --- PEMBAYARAN GAGAL / EXPIRED ---
      await db.query(
        `UPDATE rentals SET payment_status = 'EXPIRED', rental_status = 'CANCELLED' WHERE rental_id = ?`,
        [rental.rental_id],
      );
      await db.query(
        `UPDATE bikes SET status = 'AVAILABLE' WHERE bike_id = ?`,
        [bikeId],
      );
      console.log(`[MIDTRANS EXPIRED] Transaksi ${orderId} dibatalkan.`);
    }

    return res
      .status(200)
      .json({ status: "success", message: "Webhook berhasil diproses" });
  } catch (error) {
    console.error(
      "[WEBHOOK ERROR] Gagal memproses callback Midtrans:",
      error.message,
    );
    return res.status(500).json({ status: "error", message: error.message });
  }
};

module.exports = {
  createRentTransaction,
  handlePaymentNotification,
};
