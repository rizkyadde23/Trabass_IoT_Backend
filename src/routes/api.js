const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Endpoint Konfigurasi Tarif & Batas Sewa
router.get('/config/pricing', paymentController.getPaymentConfig);

// Endpoint Membuat Transaksi Sewa & Snap Token
router.post('/rent/create-transaction', paymentController.createRentTransaction);

// Endpoint Webhook HTTP Notification dari Midtrans
router.post('/payment/notification', paymentController.handlePaymentNotification);

// Endpoint Extend Transaksi Untuk Menambah Waktu
router.post('/rent/extend-transaction', paymentController.extendRentTransaction);

// Endpoint Finish Untuk Mengakhiri Sesi Sewa
router.post('/rent/finish', paymentController.finishRentSession);

// Endpoint Konfirmasi Pembayaran (verifikasi status ke Midtrans)
router.post('/rent/confirm-payment', paymentController.confirmRentPayment);

// Endpoint Cek Status Pembayaran (read-only, untuk polling frontend)
router.get('/rent/status/:order_id', paymentController.getRentStatus);

module.exports = router;
