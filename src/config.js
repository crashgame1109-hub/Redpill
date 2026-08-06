import 'dotenv/config';

function required(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  return v;
}

export const BOT_TOKEN = required('BOT_TOKEN', '');
export const CRYPTO_PAY_TOKEN = required('CRYPTO_PAY_TOKEN', '');
export const CRYPTO_PAY_NETWORK = required('CRYPTO_PAY_NETWORK', 'mainnet');
export const PORT = Number(required('PORT', '8080'));
export const PUBLIC_URL = required('PUBLIC_URL', '');
export const CORS_ORIGIN = required('CORS_ORIGIN', '*');
export const COINS_PER_STAR = Number(required('COINS_PER_STAR', '100'));
export const COINS_PER_USDT = Number(required('COINS_PER_USDT', '1000'));
export const TELEGRAM_WEBHOOK_SECRET = required('TELEGRAM_WEBHOOK_SECRET', 'change-me');
export const DB_PATH = required('DB_PATH', './data/redpill.db');

export const CRYPTO_PAY_API_BASE = CRYPTO_PAY_NETWORK === 'testnet'
  ? 'https://testnet-pay.crypt.bot/api'
  : 'https://pay.crypt.bot/api';

if (!BOT_TOKEN) {
  console.warn('[config] BOT_TOKEN не задан — проверка initData и звёзды работать не будут.');
}
if (!CRYPTO_PAY_TOKEN) {
  console.warn('[config] CRYPTO_PAY_TOKEN не задан — крипто-пополнения работать не будут.');
}
