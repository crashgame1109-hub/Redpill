import { Router } from 'express';
import { answerPreCheckoutQuery } from '../telegram.js';
import { verifyCryptoPayWebhook } from '../cryptopay.js';
import { creditCoins, findTxByProviderId } from '../db.js';
import { TELEGRAM_WEBHOOK_SECRET } from '../config.js';

export const webhookRouter = Router();

/**
 * Telegram шлёт сюда все апдейты бота (мы подписаны только на pre_checkout_query
 * и message — см. telegram.js setWebhook). Секретный токен в заголовке защищает
 * от поддельных запросов не от Telegram.
 */
webhookRouter.post('/telegram', async (req, res) => {
  const secret = req.header('x-telegram-bot-api-secret-token');
  if (secret !== TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(401);

  const update = req.body;
  try {
    if (update.pre_checkout_query) {
      // Telegram спрашивает разрешения списать звёзды — должны ответить за 10 секунд.
      const q = update.pre_checkout_query;
      await answerPreCheckoutQuery(q.id, true);
    } else if (update.message?.successful_payment) {
      const sp = update.message.successful_payment;
      const providerId = sp.telegram_payment_charge_id;

      // Идемпотентность: если этот платёж уже зачислён (Telegram может повторить апдейт) — пропускаем.
      if (!findTxByProviderId(providerId)) {
        const { tgId, coins } = JSON.parse(sp.invoice_payload);
        creditCoins(tgId, coins, {
          type: 'stars', status: 'paid',
          amountReal: sp.total_amount, asset: 'XTR',
          providerId, payload: sp.invoice_payload,
        });
        console.log(`[webhook/telegram] +${coins} монет пользователю ${tgId} (Stars, charge ${providerId})`);
      }
    }
  } catch (e) {
    console.error('[webhook/telegram] ошибка обработки апдейта', e);
    // Telegram всё равно должен получить 200, иначе будет бесконечно ретраить —
    // ошибку логируем, но не роняем вебхук.
  }
  res.sendStatus(200);
});

/**
 * Crypto Pay (@CryptoBot) шлёт сюда событие invoice_paid.
 * ВАЖНО: этот роут должен получать СЫРОЕ тело запроса для проверки подписи —
 * см. app.use(..., express.raw(...)) в server.js именно для пути /webhook/cryptopay.
 */
webhookRouter.post('/cryptopay', (req, res) => {
  const signature = req.header('crypto-pay-api-signature');
  const rawBody = req.body; // Buffer, благодаря express.raw()

  if (!verifyCryptoPayWebhook(rawBody, signature)) {
    console.warn('[webhook/cryptopay] неверная подпись — запрос отклонён');
    return res.sendStatus(401);
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return res.sendStatus(400); }

  try {
    if (payload.update_type === 'invoice_paid') {
      const inv = payload.payload; // объект инвойса
      const providerId = String(inv.invoice_id);
      if (!findTxByProviderId(providerId)) {
        const { tgId, coins } = JSON.parse(inv.payload);
        creditCoins(tgId, coins, {
          type: 'crypto', status: 'paid',
          amountReal: Number(inv.amount), asset: inv.asset,
          providerId, payload: inv.payload,
        });
        console.log(`[webhook/cryptopay] +${coins} монет пользователю ${tgId} (${inv.amount} ${inv.asset}, invoice ${providerId})`);
      }
    }
  } catch (e) {
    console.error('[webhook/cryptopay] ошибка обработки', e);
  }
  res.sendStatus(200);
});
