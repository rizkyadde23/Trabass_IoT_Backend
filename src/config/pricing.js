const toFiniteNumber = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const initialPricePerMinute = toFiniteNumber(
  process.env.RENTAL_PRICE_PER_MINUTE,
  1000,
);

/**
 * Konfigurasi harga bersifat mutable agar bisa diperbarui dari halaman
 * Pengaturan admin tanpa restart backend. Nilai awal diambil dari .env.
 */
const pricing = {
  initialPricePerMinute,
  extensionPricePerMinute: toFiniteNumber(
    process.env.EXTENSION_PRICE_PER_MINUTE,
    initialPricePerMinute,
  ),
  minRentalMinutes: toFiniteNumber(process.env.MIN_RENTAL_MINUTES, 15),
  maxRentalMinutes: toFiniteNumber(process.env.MAX_RENTAL_MINUTES, 1440),
  paymentExpiryMinutes: toFiniteNumber(
    process.env.PAYMENT_EXPIRY_MINUTES,
    15,
  ),
};

module.exports = pricing;
