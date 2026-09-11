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

/* ---------- Общая доска Reel (36 шариков, 3 цвета: красный/синий/золотой) ----------
   Золотой — как зеро в рулетке: всего 1 шарик на всю доску, зато честный множитель
   на нём сразу огромный (36/1 × RTP ≈ ×34.92 на первом же попадании, и он тут же
   "выбивает" остаток золотых до нуля — значит доводить до потолка глубины не нужно,
   выплата срабатывает как одноразовый джекпот). Красный/синий делят оставшиеся
   35 шариков почти поровну. Одна фаза на раунд: приём ставок + выбор шариков —
   доска раскрывается целиком, когда время выходит (см. sharedMines.js). */
export const MINES_T_BET = Number(required('MINES_T_BET', '11000'));
// Первые MINES_INTRO_MS каждого раунда — окно "сначала выбери цвет" на клиенте
// (надпись "Выбери цвет!" 1 сек + отсчёт 3-2-1). Сервер тоже не принимает отметки
// шариков в это время — иначе боты/быстрые игроки создавали бы впечатление, что
// шарики уже выбирают, пока остальные ещё выбирают цвет. Должно совпадать с тем,
// что реально показывает клиент (см. startMinesIntroLock во фронтенде).
export const MINES_INTRO_MS = Number(required('MINES_INTRO_MS', '4000'));
export const MINES_N = Number(required('MINES_N', '36'));
export const MINES_RED_COUNT = Number(required('MINES_RED_COUNT', '18'));
export const MINES_BLUE_COUNT = Number(required('MINES_BLUE_COUNT', '17'));
export const MINES_GREEN_COUNT = Number(required('MINES_GREEN_COUNT', '1')); // 18+17+1=36
// Потолок глубины — без него честный множитель на дальних шагах улетает в
// миллиарды (см. анализ: 12/12 подряд даёт ×1.2 млрд при шансе 1 к 1.25 млрд).
// На глубине 7 потолок ~×10200 — сопоставимо со "Сложным" в одиночном Mines (×6925).
export const MINES_MAX_DEPTH = Number(required('MINES_MAX_DEPTH', '7'));

/* ---------- Золотой раунд Mines (раз в час, реально бОльшие выплаты) ----------
   Математика честных игр этого типа устроена так, что RTP определяется ИСКЛЮЧИТЕЛЬНО
   константой RTP в формуле (выплата = честныйМножитель × RTP) — она не зависит от
   того, сколько шариков какого цвета на доске и до какой глубины разрешено идти.
   Это значит: можно поднять потолок глубины и саму RTP-константу ТОЛЬКО на один
   раунд в час, и математика останется прежней (казино всё ещё в плюсе, раз RTP<1),
   а "смешанный" RTP за целый час почти не сдвинется, потому что золотой раунд —
   это лишь 1 раунд из ~180 за час (при цикле ~20 сек на раунд):
     (179×0.97 + 1×0.99) / 180 ≈ 0.9701 — то есть заявленные 97% остаются правдой.
   При этом САМ золотой раунд для игрока реально выгоднее: и множители на глубину
   растут сильнее (потолок ×12 вместо ×7), и сама выплата на 2 процентных пункта
   щедрее (RTP 0.99 вместо 0.97). */
export const MINES_GOLDEN_INTERVAL_MS = Number(required('MINES_GOLDEN_INTERVAL_MS', String(60 * 60 * 1000))); // раз в час
export const MINES_GOLDEN_RTP = Number(required('MINES_GOLDEN_RTP', '0.99'));
export const MINES_GOLDEN_MAX_DEPTH = Number(required('MINES_GOLDEN_MAX_DEPTH', '12'));

/* ---------- Вывод средств ---------- */
// Секретный токен для /admin/withdrawals — придумай длинную случайную строку,
// это твой личный доступ к подтверждению выплат, храни в секрете как пароль.
export const ADMIN_TOKEN = required('ADMIN_TOKEN', '');
// Минимальная сумма вывода в USDT — защита от спама копеечными заявками.
export const MIN_WITHDRAWAL_USDT = Number(required('MIN_WITHDRAWAL_USDT', '2'));

// Необязательно: домен (без https://), на котором должна открываться сама
// страница админ-панели, например "admin.твой-домен.com". Одна и та же
// программа, один и тот же деплой — просто когда запрос приходит именно на
// этот домен, вместо игры сервер отдаёт страницу панели (см. server.js).
// Не задан — панель всё равно доступна по пути /admin-panel на основном домене.
export const ADMIN_HOST = required('ADMIN_HOST', '');

if (!ADMIN_TOKEN) {
  console.warn('[config] ADMIN_TOKEN не задан — /admin/withdrawals будет недоступен, пока не зададите его.');
}

if (!BOT_TOKEN) {
  console.warn('[config] BOT_TOKEN не задан — проверка initData и звёзды работать не будут.');
}
if (!CRYPTO_PAY_TOKEN) {
  console.warn('[config] CRYPTO_PAY_TOKEN не задан — крипто-пополнения работать не будут.');
}
