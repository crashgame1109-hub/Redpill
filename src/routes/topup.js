import { Router } from 'express';
import { requireTelegramAuth } from '../middleware/auth.js';
import { createStarsInvoiceLink } from '../telegram.js';
import { createCryptoInvoice } from '../cryptopay.js';
import { COINS_PER_STAR, COINS_PER_USDT } from '../config.js';

export const topupRouter = Router();
topupRouter.use(requireTelegramAuth);

// Разумные пресеты сумм — подстрой под свою экономику
const STAR_PRESETS = [50, 150, 500, 1500];   // звёзды
const CRYPTO_ASSETS = ['USDT', 'TON'];       // что принимаем в криптовалюте

/** POST /api/topup/stars  { amountStars }  → { url } — открыть через Telegram.WebApp.openInvoice */
topupRouter.post('/stars', async (req, res) => {
  try {
    const amountStars = Number(req.body?.amountStars);
    if (!Number.isFinite(amountStars) || amountStars < 1 || amountStars > 100000) {
      return res.status(400).json({ error: 'invalid amountStars' });
    }
    const coins = Math.round(amountStars * COINS_PER_STAR);
    const tgId = req.tgUser.tg_id;

    // Всё, что нужно для зачисления, кладём прямо в payload — Telegram вернёт его
    // без изменений в апдейте successful_payment (см. routes/webhooks.js).
    const payload = JSON.stringify({ tgId, coins, ts: Date.now() });

    const url = await createStarsInvoiceLink({
      title: 'Пополнение REDPILL',
      description: `${coins.toLocaleString('ru-RU')} монет за ${amountStars} ⭐`,
      payload,
      amountStars,
    });

    res.json({ url, coins, amountStars });
  } catch (e) {
    console.error('[topup/stars]', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** POST /api/topup/crypto  { asset, amount }  → { payUrl, invoiceId } */
topupRouter.post('/crypto', async (req, res) => {
  try {
    const asset = String(req.body?.asset || '').toUpperCase();
    const amount = Number(req.body?.amount);
    if (!CRYPTO_ASSETS.includes(asset)) return res.status(400).json({ error: 'unsupported asset' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });

    const tgId = req.tgUser.tg_id;
    // Конвертация монет считаем от USDT-эквивалента; для простоты TON/BTC и т.п.
    // здесь тоже считаем 1:1 с их номиналом — уточни курс под реальные активы сам.
    const coins = Math.round(amount * COINS_PER_USDT);
    const payload = JSON.stringify({ tgId, coins, ts: Date.now() });

    const invoice = await createCryptoInvoice({
      asset,
      amount,
      description: `Пополнение REDPILL на ${coins.toLocaleString('ru-RU')} монет`,
      payload,
    });

    res.json({ payUrl: invoice.pay_url || invoice.bot_invoice_url, invoiceId: invoice.invoice_id, coins });
  } catch (e) {
    console.error('[topup/crypto]', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

topupRouter.get('/presets', (req, res) => {
  res.json({ stars: STAR_PRESETS, cryptoAssets: CRYPTO_ASSETS, coinsPerStar: COINS_PER_STAR, coinsPerUsdt: COINS_PER_USDT });
});
