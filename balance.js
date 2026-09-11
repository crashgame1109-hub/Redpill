import { Router } from 'express';
import { requireTelegramAuth } from '../middleware/auth.js';
import { listTransactions } from '../db.js';

export const balanceRouter = Router();
balanceRouter.use(requireTelegramAuth);

/** GET /api/me → { tgId, username, balance } */
balanceRouter.get('/me', (req, res) => {
  const u = req.tgUser;
  res.json({ tgId: u.tg_id, username: u.username, balance: u.balance });
});

/** GET /api/history → последние транзакции (пополнения, ставки, выплаты) */
balanceRouter.get('/history', (req, res) => {
  const rows = listTransactions(req.tgUser.tg_id, 60);
  res.json({ transactions: rows });
});
