import { Router } from 'express';
import { listPendingWithdrawals, getWithdrawal, markWithdrawalPaid, rejectWithdrawal } from '../db.js';
import { transferCrypto } from '../cryptopay.js';
import { ADMIN_TOKEN } from '../config.js';

export const adminRouter = Router();

/** Простейшая защита: заголовок x-admin-token должен совпадать с ADMIN_TOKEN из .env.
 *  Это НЕ полноценная админ-панель — просто ручной, безопасный способ подтверждать
 *  выплаты, пока нет отдельного антифрод/модерационного интерфейса. */
adminRouter.use((req, res, next) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'admin_token_not_configured' });
  const token = req.header('x-admin-token');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

/** GET /admin/withdrawals — очередь заявок, ждущих подтверждения */
adminRouter.get('/withdrawals', (req, res) => {
  res.json({ withdrawals: listPendingWithdrawals() });
});

/** POST /admin/withdrawals/:id/approve — реально отправляет крипту и закрывает заявку */
adminRouter.post('/withdrawals/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const tx = getWithdrawal(id);
  if (!tx || tx.status !== 'pending') return res.status(404).json({ error: 'not_found_or_already_processed' });

  try {
    // spend_id обязателен для идемпотентности — используем id заявки, чтобы повторный
    // клик "Подтвердить" не отправил деньги дважды.
    const transfer = await transferCrypto({
      userId: tx.tg_id, asset: tx.asset, amount: tx.amount_real,
      spendId: `redpill_wd_${tx.id}`, comment: `REDPILL withdrawal #${tx.id}`,
    });
    markWithdrawalPaid(id, transfer.transfer_id || transfer.id || String(id));
    res.json({ ok: true, transfer });
  } catch (e) {
    console.error('[admin/withdrawals/approve]', e);
    res.status(500).json({ error: 'transfer_failed', message: e.message });
  }
});

/** POST /admin/withdrawals/:id/reject — отклоняет заявку и возвращает монеты игроку */
adminRouter.post('/withdrawals/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const user = rejectWithdrawal(id);
  if (!user) return res.status(404).json({ error: 'not_found_or_already_processed' });
  res.json({ ok: true, refundedBalance: user.balance });
});
