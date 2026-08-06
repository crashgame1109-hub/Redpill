// Запусти один раз после деплоя: node scripts/setWebhook.js
// Говорит Telegram, куда слать апдейты (pre_checkout_query, successful_payment).
import { setWebhook } from '../src/telegram.js';

setWebhook()
  .then((r) => { console.log('Вебхук зарегистрирован:', r); process.exit(0); })
  .catch((e) => { console.error('Не удалось зарегистрировать вебхук:', e.message); process.exit(1); });
