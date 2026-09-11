import { Router } from 'express';
import { listPendingWithdrawals, getWithdrawal, markWithdrawalPaid, rejectWithdrawal } from '../db.js';
import { transferCrypto, getBalance } from '../cryptopay.js';
import { ADMIN_TOKEN } from '../config.js';
import {
  getEconomyByPeriod, getByMode, getPlayersOverview, getRevenue,
  getTopPlayers, listPlayers, getPlayerDetail, getRecentTransactions, listGames,
} from '../adminStats.js';

export const adminRouter = Router();

/** Даёт админ-роутеру доступ к "живому" (не из БД, а прямо сейчас в памяти)
 *  состоянию раундов и числу онлайн-игроков — вызывается один раз из server.js
 *  при старте, чтобы не тянуть циклический импорт server.js <-> routes/admin.js. */
let getLiveState = () => ({ online: 0, classic: null, mines: null });
export function setLiveStateGetter(fn) { getLiveState = fn; }

/** Простейшая защита: заголовок x-admin-token должен совпадать с ADMIN_TOKEN из .env.
 *  Пароль для входа в саму панель (admin.html) — тот же токен, просто вводится
 *  один раз и хранится в sessionStorage браузера, а не зашивается в файл. */
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

/** GET /admin/stats — всё для главной сводки одним запросом: живое состояние
 *  раундов, экономика по периодам, разбивка по режимам, игроки, доход, баланс
 *  кошелька бота в Crypto Pay (реальная крипта, из которой платятся выводы). */
adminRouter.get('/stats', async (req, res) => {
  let wallet = null, walletError = null;
  try {
    const balances = await getBalance();
    wallet = (balances || []).map(b => ({ asset: b.currency_code, available: Number(b.available), onhold: Number(b.onhold || 0) }));
  } catch (e) {
    // Не валим всю сводку, если Crypto Pay недоступен/токен не настроен — просто
    // покажем остальное, а баланс кошелька будет отмечен как недоступный.
    walletError = e.message;
  }
  try {
    res.json({
      live: getLiveState(),
      economy: getEconomyByPeriod(),
      byMode: getByMode(),
      players: getPlayersOverview(),
      revenue: getRevenue(),
      topPlayers: getTopPlayers(10),
      wallet, walletError,
      ts: Date.now(),
    });
  } catch (e) {
    console.error('[admin/stats]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

/** GET /admin/players?search=&limit=&offset= — список игроков с поиском и пагинацией */
adminRouter.get('/players', (req, res) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const search = String(req.query.search || '').trim();
    res.json(listPlayers({ limit, offset, search }));
  } catch (e) {
    console.error('[admin/players]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

/** GET /admin/players/:tgId — полная карточка одного игрока */
adminRouter.get('/players/:tgId', (req, res) => {
  try {
    const detail = getPlayerDetail(req.params.tgId);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    res.json(detail);
  } catch (e) {
    console.error('[admin/players/:tgId]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

/** GET /admin/transactions?type=&limit= — лента транзакций (для вкладки "Транзакции") */
adminRouter.get('/transactions', (req, res) => {
  try {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const type = req.query.type ? String(req.query.type) : null;
    res.json({ transactions: getRecentTransactions({ limit, type }) });
  } catch (e) {
    console.error('[admin/transactions]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});

/** GET /admin/games?mode=&limit=&offset= — список сыгранных игр (каждая ставка
 *  сопоставлена со своим исходом), с фильтром по режиму — для вкладки "Игры" */
adminRouter.get('/games', (req, res) => {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const mode = req.query.mode ? String(req.query.mode) : '';
    res.json(listGames({ limit, offset, mode }));
  } catch (e) {
    console.error('[admin/games]', e);
    res.status(500).json({ error: 'internal_error', message: e.message });
  }
});
