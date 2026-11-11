const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');
const settingsController = require('../controllers/settingsController');
const commandController = require('../controllers/commandController');
const incidentController = require('../controllers/incidentController');
const bikeController = require('../controllers/bikeController');
const authMiddleware = require('../middlewares/authMiddleware');
const adminMiddleware = require('../middlewares/adminMiddleware');

// ---------------------------------------------------------------------------
// Route publik
// ---------------------------------------------------------------------------
// Registrasi ringan penyewa (hasil scan QR): identitas = Nomor WA.
router.post('/auth/quick-register', authController.quickRegister);

// Login admin dengan username atau email + password.
router.post('/auth/login', authController.login);

// Validasi dini sepeda hasil scan QR untuk halaman registrasi.
router.get('/bikes/:bike_id/availability', bikeController.getBikeAvailability);

// Endpoint Konfigurasi Tarif & Batas Sewa
router.get('/config/pricing', paymentController.getPaymentConfig);

// Endpoint Webhook HTTP Notification dari Midtrans
router.post('/payment/notification', paymentController.handlePaymentNotification);

// ---------------------------------------------------------------------------
// Route terlindungi (wajib JWT)
// ---------------------------------------------------------------------------
router.use(authMiddleware);

// Profil user yang sedang login
router.get('/auth/me', authController.getMe);

// Dashboard admin: daftar seluruh armada
router.get('/admin/bikes', adminMiddleware, adminController.getBikes);

// Kelola armada: tambah, ubah, dan hapus sepeda
router.post('/admin/bikes', adminMiddleware, adminController.createBike);
router.put('/admin/bikes/:bike_id', adminMiddleware, adminController.updateBike);
router.delete('/admin/bikes/:bike_id', adminMiddleware, adminController.deleteBike);

// Detail satu sepeda & riwayat telemetri perception layer
router.get('/admin/bikes/:bike_id', adminMiddleware, adminController.getBikeDetail);
router.get('/admin/bikes/:bike_id/telemetry', adminMiddleware, adminController.getBikeTelemetry);

// Pengaturan admin: pangkalan, radius geofence, dan pricing
router.get('/admin/settings', adminMiddleware, settingsController.getSettings);
router.put('/admin/settings', adminMiddleware, settingsController.updateSettings);

// Remote control: force lock, force unlock, dan matikan alarm
router.post('/admin/bike-command', adminMiddleware, commandController.sendBikeCommand);

// Riwayat insiden keamanan dan audit perintah admin
router.get('/admin/incidents', adminMiddleware, incidentController.getIncidents);
router.get('/admin/command-logs', adminMiddleware, commandController.getCommandLogs);

// Endpoint Membuat Transaksi Sewa & Snap Token
router.post('/rent/create-transaction', paymentController.createRentTransaction);

// Endpoint Extend Transaksi Untuk Menambah Waktu
router.post('/rent/extend-transaction', paymentController.extendRentTransaction);

// Endpoint Finish Untuk Mengakhiri Sesi Sewa
router.post('/rent/finish', paymentController.finishRentSession);

// Endpoint Konfirmasi Pembayaran (verifikasi status ke Midtrans)
router.post('/rent/confirm-payment', paymentController.confirmRentPayment);

// Endpoint Cek Status Pembayaran (read-only, untuk polling frontend)
router.get('/rent/status/:order_id', paymentController.getRentStatus);

module.exports = router;
