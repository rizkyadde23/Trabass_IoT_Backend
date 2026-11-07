const axios = require('axios');
const mqttClient = require('../config/mqtt');
require('dotenv').config();

/**
 * Mengirim pesan WhatsApp via Fonnte API dengan Fallback ke MQTT/GSM SMS
 * @param {string} target Nomor WhatsApp (contoh: '08123456789' atau '628123456789')
 * @param {string} message Isi pesan notifikasi
 * @param {string} bikeId ID Sepeda (opsional, untuk fallback GSM)
 */
const sendWhatsApp = async (target, message, bikeId = null) => {
  try {
    const response = await axios.post(
      'https://api.fonnte.com/send',
      {
        target: target,
        message: message,
        countryCode: '62' // Default Indonesia
      },
      {
        headers: {
          Authorization: process.env.FONNTE_TOKEN
        },
        timeout: 5000 // Timeout 5 detik
      }
    );

    if (response.data && response.data.status) {
      console.log(`[WA SENT] WhatsApp berhasil terkirim ke ${target}`);
      return true;
    } else {
      throw new Error(response.data.reason || 'Gagal terkirim dari Fonnte');
    }
  } catch (error) {
    console.error(`[WA ERROR] Gagal kirim WA ke ${target}:`, error.message);

    // -------------------------------------------------------------
    // FALLBACK MECHANISM: Jika WA gagal/offline, minta GSM Module ESP32 kirim SMS
    // -------------------------------------------------------------
    if (bikeId) {
      console.warn(`[SMS FALLBACK] Mengirim instruksi SMS via ESP32 GSM Module untuk ${bikeId}...`);
      const commandTopic = `bike/command/${bikeId}`;
      mqttClient.publish(commandTopic, JSON.stringify({
        action: 'SEND_SMS',
        target_phone: target,
        message: message.substring(0, 140) // Batasi 140 karakter SMS
      }), { qos: 1 });
    }
    return false;
  }
};

/**
 * Template Pesan Bukti Pembayaran Sukses
 */
const sendPaymentReceipt = async (userPhone, userName, bikeId, durationMinutes) => {
  const text = 
`🚴 *SEHATYUK BICYCLE RENTAL* 🚴

Halo *${userName}*,
Pembayaran sewa sepeda berhasil dikonfirmasi! Kunci sepeda telah terbuka otomatis.

📌 *Detail Sewa:*
• ID Sepeda: *${bikeId}*
• Durasi Sewa: *${durationMinutes} Menit*
• Status Kunci: *UNLOCKED (Terbuka)*

Selamat berkendara & utamakan keselamatan! Jika durasi habis, sepeda akan terkunci otomatis.`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Peringatan Sisa Waktu Sewa
 */
const sendTimeWarning = async (userPhone, bikeId, remainingMinutes) => {
  const text = 
`⚠️ *PERINGATAN DURA SI SEWA* ⚠️

Sepeda *${bikeId}* tersisa waktu *${remainingMinutes} Menit* lagi!

Harap segera kembalikan sepeda ke pangkalan atau lakukan perpanjangan waktu sewa melalui aplikasi agar sepeda tidak terkunci secara otomatis.`;

  return await sendWhatsApp(userPhone, text, bikeId);
};

/**
 * Template Peringatan Keamanan Darurat (Ke Admin / User)
 */
const sendSecurityAlert = async (targetPhone, bikeId, reason) => {
  const text = 
`🚨 *ALERT KEAMANAN SEPEDA* 🚨

Perhatian! Terdeteksi indikasi anomali pada armada sepeda *${bikeId}*:
• Indikasi: *${reason}*
• Waktu: *${new Date().toLocaleString('id-ID')}*

Sistem telah membunyikan alarm sirene secara otomatis pada sepeda.`;

  return await sendWhatsApp(targetPhone, text, bikeId);
};

module.exports = {
  sendWhatsApp,
  sendPaymentReceipt,
  sendTimeWarning,
  sendSecurityAlert
};