const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authController = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

// ---------------------------------------------------------------------------
// Route publik
// ---------------------------------------------------------------------------
router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);

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
