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
  
  // Automatis subscribe ke seluruh data telemetri sepeda
  client.subscribe('bike/telemetry/+', (err) => {
    if (!err) {
      console.log('[MQTT] Subscribed ke topik: bike/telemetry/+');
    } else {
      console.error('[MQTT ERROR] Gagal subscribe ke topik:', err.message);
    }
  });
});

client.on('error', (err) => {
  console.error('[MQTT ERROR] Connection Error:', err.message);
});

module.exports = client;