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

/* ---------- Общий раунд-луп REDPILL (классика) ----------
   Тайминги ДОЛЖНЫ совпадать с фронтендом (T_BET/T_LOCK/T_SPIN/T_RESULT в index.html),
   иначе анимация шара на клиенте разъедется с реальным моментом раскрытия исхода. */
export const T_BET = Number(required('T_BET', '7000'));
export const T_LOCK = Number(required('T_LOCK', '700'));
export const T_SPIN = Number(required('T_SPIN', '4200'));
export const T_RESULT = Number(required('T_RESULT', '3000'));

/* Та же математика, что на клиенте: выплата = 2*RTP (обычно ×1.94, в бусте ×1.98). */
export const RTP = Number(required('RTP', '0.97'));
export const BOOST_ROUNDS = Number(required('BOOST_ROUNDS', '7'));
export const BOOST_RTP = Number(required('BOOST_RTP', '0.99'));
export const BET_MIN = Number(required('BET_MIN', '10'));

/* ---------- Вывод средств ---------- */
// Секретный токен для /admin/withdrawals — придумай длинную случайную строку,
// это твой личный доступ к подтверждению выплат, храни в секрете как пароль.
export const ADMIN_TOKEN = required('ADMIN_TOKEN', '');
// Минимальная сумма вывода в USDT — защита от спама копеечными заявками.
export const MIN_WITHDRAWAL_USDT = Number(required('MIN_WITHDRAWAL_USDT', '2'));

if (!ADMIN_TOKEN) {
  console.warn('[config] ADMIN_TOKEN не задан — /admin/withdrawals будет недоступен, пока не зададите его.');
}

if (!BOT_TOKEN) {
  console.warn('[config] BOT_TOKEN не задан — проверка initData и звёзды работать не будут.');
}
if (!CRYPTO_PAY_TOKEN) {
  console.warn('[config] CRYPTO_PAY_TOKEN не задан — крипто-пополнения работать не будут.');
}
