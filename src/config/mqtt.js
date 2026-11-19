const mqtt = require('mqtt');
require('dotenv').config();

const brokerUrl = process.env.MQTT_BROKER_URL;
const clientId = process.env.MQTT_CLIENT_ID;

const client = mqtt.connect(brokerUrl, {
  clientId: clientId,
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 1000,
});

client.on('connect', () => {
  console.log('[MQTT] Berhasil terhubung ke Mosquitto MQTT Broker');
  
  // Broker publik: pakai namespace trabass/ agar tidak tabrakan dengan
  // perangkat lain. Firmware publish ke trabass/<bikeId>/telemetry.
  client.subscribe('trabass/+/telemetry', (err) => {
    if (!err) {
      console.log('[MQTT] Subscribed ke topik: trabass/+/telemetry');
    } else {
      console.error('[MQTT ERROR] Gagal subscribe ke topik:', err.message);
    }
  });
});

client.on('error', (err) => {
  console.error('[MQTT ERROR] Connection Error:', err.message);
});

module.exports = client;