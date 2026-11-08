const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Endpoint Membuat Transaksi Sewa & Snap Token
router.post('/rent/create-transaction', paymentController.createRentTransaction);

// Endpoint Webhook HTTP Notification dari Midtrans
router.post('/payment/notification', paymentController.handlePaymentNotification);

//Endpoint Extend Transaksi Untuk Menambah Waktu
router.post('/rent/extend-transaction', paymentController.extendRentTransaction);

// Endpoint Finish Untuk Mengakhiri Sesi Sewa
router.post('/rent/finish', paymentController.finishRentSession);

module.exports = router;