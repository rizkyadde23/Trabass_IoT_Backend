const redis = require('redis');
require('dotenv').config();

const client = redis.createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
});

client.on('error', (err) => console.error('[REDIS ERROR] Client Error:', err.message));
client.on('connect', () => console.log('[REDIS] Berhasil terhubung ke Redis Server'));

(async () => {
  try {
    await client.connect();
  } catch (error) {
    console.error('[REDIS ERROR] Gagal melakukan koneksi:', error.message);
  }
})();

module.exports = client;