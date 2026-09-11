import { Router } from 'express';
import { requireTelegramAuth } from '../middleware/auth.js';
import { createWithdrawalRequest, listTransactions } from '../db.js';
import { COINS_PER_USDT, MIN_WITHDRAWAL_USDT } from '../config.js';

export const withdrawRouter = Router();
withdrawRouter.use(requireTelegramAuth);

const ASSETS = ['USDT', 'TON'];

/** POST /api/withdraw  { asset, amountReal, destination } — ставит заявку в очередь
 *  на ручное подтверждение. Списывает монеты СРАЗУ, чтобы нельзя было потратить дважды. */
withdrawRouter.post('/', async (req, res) => {
  try {
    const asset = String(req.body?.asset || '').toUpperCase();
    const amountReal = Number(req.body?.amountReal);
    const destination = String(req.body?.destination || '').trim();

    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'unsupported_asset' });
    if (!Number.isFinite(amountReal) || amountReal < MIN_WITHDRAWAL_USDT) {
      return res.status(400).json({ error: 'amount_too_small', min: MIN_WITHDRAWAL_USDT });
    }
    if (!destination) return res.status(400).json({ error: 'destination_required' });

    // Курс вывода = курс пополнения (симметрично, чтобы не было арбитража между покупкой и продажей монет).
    const coins = Math.round(amountReal * COINS_PER_USDT);
    const tgId = req.tgUser.tg_id;

    const result = createWithdrawalRequest(tgId, coins, asset, amountReal, destination);
    if (!result) return res.status(400).json({ error: 'insufficient_balance' });

    res.json({ ok: true, balance: result.balance, withdrawalId: result.id, status: 'pending' });
  } catch (e) {
    console.error('[withdraw]', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** GET /api/withdraw/history — список своих заявок на вывод (для истории в приложении) */
withdrawRouter.get('/history', (req, res) => {
  const rows = listTransactions(req.tgUser.tg_id, 60).filter(t => t.type === 'withdrawal');
  res.json({ withdrawals: rows });
});
