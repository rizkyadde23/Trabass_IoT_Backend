const axios = require("axios");
const mqttClient = require("../config/mqtt");
require("dotenv").config();

/**
 * Format tanggal agar konsisten saat ditampilkan di WhatsApp/SMS.
 */
const formatDateTime = (value) => {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("id-ID");
};

/**
 * Mengirim pesan WhatsApp via Fonnte API dengan Fallback ke MQTT/GSM SMS
 * @param {string} target Nomor WhatsApp (contoh: '08123456789' atau '628123456789')
 * @param {string} message Isi pesan notifikasi
 * @param {string} bikeId ID Sepeda (opsional, untuk fallback GSM)
 */
const sendWhatsApp = async (target, message, bikeId = null) => {
  if (!target) {
    console.warn("[WA SKIP] Nomor tujuan notifikasi tidak tersedia.");
    return false;
  }

  try {
    const response = await axios.post(
      "https://api.fonnte.com/send",
      {
        target: target,
        message: message,
        countryCode: "62", // Default Indonesia
      },
      {
        headers: {
          Authorization: process.env.FONNTE_TOKEN,
        },
        timeout: 5000, // Timeout 5 detik
      },
    );

    if (response.data && response.data.status) {
      console.log(`[WA SENT] WhatsApp berhasil terkirim ke ${target}`);
      return true;
    } else {
      throw new Error(response.data.reason || "Gagal terkirim dari Fonnte");
    }
  } catch (error) {
    console.error(`[WA ERROR] Gagal kirim WA ke ${target}:`, error.message);

    // -------------------------------------------------------------
    // FALLBACK MECHANISM: Jika WA gagal/offline, minta GSM Module ESP32 kirim SMS
    // -------------------------------------------------------------
    if (bikeId) {
      console.warn(
        `[SMS FALLBACK] Mengirim instruksi SMS via ESP32 GSM Module untuk ${bikeId}...`,
      );
      const commandTopic = `bike/command/${bikeId}`;
      mqttClient.publish(
        commandTopic,
        JSON.stringify({
          action: "SEND_SMS",
          target_phone: target,
          message: message.substring(0, 140), // Batasi 140 karakter SMS
        }),
        { qos: 1 },
      );
    }
    return false;
  }
};

/**
 * Template Pesan Bukti Pembayaran Sewa Baru
 */
const sendPaymentReceipt = async (
  userPhone,
  userName,
  bikeId,
  durationMinutes,
  endTime = null,
) => {
  const endTimeText = endTime
    ? `\n• Selesai: *${formatDateTime(endTime)}*`
    : "";

  const text = `🚴 *TRABASS BICYCLE RENTAL* 🚴

Halo *${userName}*,
Pembayaran sewa sepeda berhasil dikonfirmasi! Kunci sepeda telah terbuka otomatis.

📌 *Detail Sewa:*
• ID Sepeda: *${bikeId}*
• Durasi Sewa: *${durationMinutes} Menit*${endTimeText}
• Status Kunci: *UNLOCKED (Terbuka)*

Selamat berkendara & utamakan keselamatan! Jika durasi habis, sepeda akan terkunci otomatis.`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Pesan Bukti Perpanjangan Sewa
 */
const sendExtensionReceipt = async (
  userPhone,
  userName,
  bikeId,
  addedMinutes,
  newEndTime = null,
) => {
  const endTimeText = newEndTime
    ? `\n• Waktu selesai baru: *${formatDateTime(newEndTime)}*`
    : "";

  const text = `🚴 *TRABASS BICYCLE RENTAL* 🚴

Halo *${userName}*,
Perpanjangan sewa sepeda berhasil dikonfirmasi.

📌 *Detail Perpanjangan:*
• ID Sepeda: *${bikeId}*
• Tambahan Durasi: *${addedMinutes} Menit*${endTimeText}

Selamat berkendara & utamakan keselamatan!`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Pesan Konfirmasi Pengembalian Sepeda
 */
const sendReturnReceipt = async (userPhone, userName, bikeId) => {
  const text = `🚴 *TRABASS BICYCLE RENTAL* 🚴

Halo *${userName}*,
Sesi sewa sepeda *${bikeId}* telah berhasil diakhiri.

• Status Kunci: *LOCKED (Terkunci)*
• Waktu Pengembalian: *${formatDateTime(new Date())}*

Terima kasih telah menggunakan layanan kami.`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Peringatan Sisa Waktu Sewa
 */
const sendTimeWarning = async (userPhone, bikeId, remainingMinutes) => {
  const text = `⚠️ *PERINGATAN DURASI SEWA* ⚠️

Sepeda *${bikeId}* tersisa waktu *${remainingMinutes} Menit* lagi!

Harap segera kembalikan sepeda ke pangkalan atau lakukan perpanjangan waktu sewa melalui aplikasi agar sepeda tidak terkunci secara otomatis.`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Peringatan Waktu Sewa Habis
 */
const sendRentalExpired = async (userPhone, bikeId) => {
  const text = `⚠️ *WAKTU SEWA HABIS* ⚠️

Waktu sewa sepeda *${bikeId}* telah habis. Sistem telah mengunci sepeda secara otomatis dan mengaktifkan alarm.

Harap segera mengembalikan sepeda ke pangkalan resmi atau hubungi admin jika ingin memperpanjang sesi.`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Peringatan Keamanan Darurat (Ke Admin / User)
 */
const sendSecurityAlert = async (targetPhone, bikeId, reason) => {
  const text = `🚨 *ALERT KEAMANAN SEPEDA* 🚨

Perhatian! Terdeteksi indikasi anomali pada armada sepeda *${bikeId}*:
• Indikasi: *${reason}*
• Waktu: *${formatDateTime(new Date())}*

Sistem telah membunyikan alarm sirene secara otomatis pada sepeda.`;

  return await sendWhatsApp(targetPhone, text, bikeId);
};

/**
 * Template Peringatan Konflik Pembayaran
 * Dipakai ketika pembayaran sudah diterima Midtrans, tetapi sesi tidak dapat diaktifkan.
 */
const sendPaymentConflictAlert = async (
  targetPhone,
  bikeId,
  reason,
  orderId,
  isAdmin = false,
) => {
  const followUp = isAdmin
    ? "Mohon cek dashboard dan proses refund/manual action."
    : "Pembayaran Anda sudah diterima, tetapi sesi sewa tidak dapat diaktifkan. Admin akan menghubungi Anda untuk proses pengembalian dana.";

  const text = `🚨 *PEMBAYARAN PERLU TINDAK LANJUT* 🚨

Order ID: *${orderId || "-"}*
ID Sepeda: *${bikeId || "-"}*
Alasan: *${reason || "PAYMENT_CONFLICT"}*
Waktu: *${formatDateTime(new Date())}*

${followUp}`;

  return await sendWhatsApp(targetPhone, text, bikeId);
};

module.exports = {
  sendWhatsApp,
  sendPaymentReceipt,
  sendExtensionReceipt,
  sendReturnReceipt,
  sendTimeWarning,
  sendRentalExpired,
  sendSecurityAlert,
  sendPaymentConflictAlert,
};
