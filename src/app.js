const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./config/db');
const redisClient = require('./config/redis');
const mqttClient = require('./config/mqtt');
const telemetryController = require('./controllers/telemetryController');
const { initTimerService } = require('./services/timerService');
const settingsService = require('./services/settingsService');
const incidentService = require('./services/incidentService');
const bikeCommandService = require('./services/bikeCommandService');
const apiRoutes = require('./routes/api'); // <--- Import Routes API

const app = express();

app.use(cors());
app.use(express.json());

// Mount API Routes
app.use('/api', apiRoutes); // <--- Register Prefix /api

// Listener Telemetri MQTT
mqttClient.on('message', (topic, message) => {
  if (topic.startsWith('bike/telemetry/')) {
    telemetryController.handleTelemetry(topic, message);
  }
});

// Health Check Endpoint
app.get('/health', async (req, res) => {
  try {
    const [dbRes] = await db.query('SELECT NOW() AS server_time');
    await redisClient.set('health_check', 'OK');
    const redisRes = await redisClient.get('health_check');

    return res.status(200).json({
      status: 'success',
      message: 'Backend, MySQL XAMPP, Redis, MQTT Broker & Payment Engine Berjalan Normal',
      timestamp: dbRes[0].server_time,
      redis_status: redisRes,
      mqtt_connected: mqttClient.connected
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

// Muat pengaturan tersimpan, siapkan tabel insiden, dan audit perintah
// sebelum server menerima request. Semua init menangani error sendiri agar
// kegagalan satu komponen tidak menghalangi backend berjalan.
Promise.allSettled([
  settingsService.init(),
  incidentService.init(),
  bikeCommandService.init(),
]).finally(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
    initTimerService();
  });
});