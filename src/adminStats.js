// Агрегирующие запросы для админ-панели. Всё считается напрямую из таблиц
// users/transactions — никаких выдуманных/захардкоженных цифр. Разбивка по
// режимам (classic/mines_shared) опирается на поле mode в payload ставок и
// выплат (см. db.js — debitForBet/payoutBetAndBumpRounds/creditCoins).
import { db } from './db.js';

const DAY_MS = 86400000;
const MODES = ['classic', 'mines_shared'];

function periodStats(sinceTs) {
  const bet = db.prepare(`
    SELECT COUNT(*) n, COALESCE(SUM(-coins),0) sum, COUNT(DISTINCT tg_id) players
    FROM transactions WHERE type='bet' AND created_at>=?
  `).get(sinceTs);
  const payout = db.prepare(`
    SELECT COALESCE(SUM(coins),0) sum FROM transactions WHERE type='payout' AND created_at>=?
  `).get(sinceTs);
  const staked = bet.sum, paid = payout.sum;
  return {
    bets: bet.n, players: bet.players, staked, paid,
    profit: staked - paid,
    rtp: staked > 0 ? paid / staked : null,
  };
}

/** Экономика по периодам — сутки/7 дней/30 дней/всё время. */
export function getEconomyByPeriod() {
  const now = Date.now();
  return {
    day: periodStats(now - DAY_MS),
    week: periodStats(now - 7 * DAY_MS),
    month: periodStats(now - 30 * DAY_MS),
    allTime: periodStats(0),
  };
}

/** Разбивка по режимам (REDPILL classic / Reel mines_shared) за всё время.
 *  Для транзакций ДО того, как появилась разметка по режиму (см. фикс в db.js),
 *  mode будет NULL — они не попадут ни в одну из строк ниже (честно, без догадок). */
export function getByMode() {
  return MODES.map(mode => {
    const bet = db.prepare(`
      SELECT COUNT(*) n, COALESCE(SUM(-coins),0) sum, COUNT(DISTINCT tg_id) players, COALESCE(AVG(-coins),0) avgBet
      FROM transactions WHERE type='bet' AND json_extract(payload,'$.mode')=?
    `).get(mode);
    const payout = db.prepare(`
      SELECT COALESCE(SUM(coins),0) sum, COALESCE(MAX(coins),0) maxWin
      FROM transactions WHERE type='payout' AND json_extract(payload,'$.mode')=?
    `).get(mode);
    return {
      mode,
      label: mode === 'classic' ? 'REDPILL' : 'Reel',
      bets: bet.n, players: bet.players, staked: bet.sum, paid: payout.sum,
      profit: bet.sum - payout.sum,
      rtp: bet.sum > 0 ? payout.sum / bet.sum : null,
      avgBet: Math.round(bet.avgBet), maxWin: payout.maxWin,
    };
  });
}

/** Игроки — общая картина. */
export function getPlayersOverview() {
  const now = Date.now();
  const total = db.prepare(`SELECT COUNT(*) n FROM users`).get().n;
  const newToday = db.prepare(`SELECT COUNT(*) n FROM users WHERE created_at>=?`).get(now - DAY_MS).n;
  const activeToday = db.prepare(`SELECT COUNT(DISTINCT tg_id) n FROM transactions WHERE type='bet' AND created_at>=?`).get(now - DAY_MS).n;
  const activeWeek = db.prepare(`SELECT COUNT(DISTINCT tg_id) n FROM transactions WHERE type='bet' AND created_at>=?`).get(now - 7 * DAY_MS).n;
  const paying = db.prepare(`SELECT COUNT(DISTINCT tg_id) n FROM transactions WHERE type IN ('stars','crypto') AND status='paid'`).get().n;
  const balances = db.prepare(`SELECT COALESCE(SUM(balance),0) n FROM users`).get().n;
  return { total, newToday, activeToday, activeWeek, paying, balances };
}

/** Доход в реальных деньгах — раздельно по звёздам и по каждому крипто-активу
 *  (без выдуманной конвертации в доллары и БЕЗ сложения USDT+TON в одну кучу —
 *  это разные активы с разным курсом, складывать их напрямую некорректно). */
export function getRevenue() {
  const starsGross = db.prepare(`SELECT COALESCE(SUM(amount_real),0) n, COUNT(*) c FROM transactions WHERE type='stars' AND status='paid'`).get();
  const cryptoByAsset = db.prepare(`
    SELECT asset, COALESCE(SUM(amount_real),0) n, COUNT(*) c
    FROM transactions WHERE type='crypto' AND status='paid' GROUP BY asset
  `).all();
  const withdrawnByAsset = db.prepare(`
    SELECT asset, COALESCE(SUM(amount_real),0) n, COUNT(*) c
    FROM transactions WHERE type='withdrawal' AND status='paid' GROUP BY asset
  `).all();
  const pendingByAsset = db.prepare(`
    SELECT asset, COUNT(*) n, COALESCE(SUM(amount_real),0) sum
    FROM transactions WHERE type='withdrawal' AND status='pending' GROUP BY asset
  `).all();
  const cryptoCount = cryptoByAsset.reduce((s, r) => s + r.c, 0);
  // Чистая прибыль — отдельно по каждому активу (доход минус выводы ТОГО ЖЕ актива;
  // звёзды вывести нельзя — см. withdraw.js, ASSETS=['USDT','TON'] — поэтому для
  // звёзд чистая прибыль равна всему доходу целиком, вычитать там нечего).
  const netByAsset = cryptoByAsset.map(c => {
    const withdrawn = withdrawnByAsset.find(w => w.asset === c.asset);
    return { asset: c.asset, net: c.n - (withdrawn ? withdrawn.n : 0) };
  });
  return {
    starsSum: starsGross.n, starsCount: starsGross.c, starsNet: starsGross.n,
    cryptoByAsset, cryptoCount,
    withdrawnByAsset, netByAsset,
    payCount: starsGross.c + cryptoCount,
    pendingByAsset, pendingWithdrawalsCount: pendingByAsset.reduce((s, r) => s + r.n, 0),
  };
}

/** Топ игроков по суммарным ставкам (всё время). */
export function getTopPlayers(limit = 15) {
  return db.prepare(`
    SELECT u.tg_id, u.username, u.balance,
      COALESCE((SELECT SUM(-coins) FROM transactions WHERE tg_id=u.tg_id AND type='bet'),0) totalStaked,
      COALESCE((SELECT SUM(coins) FROM transactions WHERE tg_id=u.tg_id AND type='payout'),0) totalPaid,
      COALESCE((SELECT MAX(coins) FROM transactions WHERE tg_id=u.tg_id AND type='payout'),0) maxWin,
      COALESCE((SELECT COUNT(*) FROM transactions WHERE tg_id=u.tg_id AND type='bet'),0) betsCount
    FROM users u
    ORDER BY totalStaked DESC
    LIMIT ?
  `).all(limit);
}

/** Список игроков с пагинацией + поиском по имени/id — для раздела "Игроки". */
export function listPlayers({ limit = 50, offset = 0, search = '' } = {}) {
  const like = `%${search}%`;
  const rows = db.prepare(`
    SELECT tg_id, username, balance, rounds_played, created_at, updated_at
    FROM users
    WHERE (? = '' OR username LIKE ? OR tg_id LIKE ?)
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(search, like, like, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) n FROM users WHERE (? = '' OR username LIKE ? OR tg_id LIKE ?)
  `).get(search, like, like).n;
  return { rows, total };
}

/** Полная карточка одного игрока — для клика по строке в списке/топе. */
export function getPlayerDetail(tgId) {
  const user = db.prepare(`SELECT * FROM users WHERE tg_id=?`).get(tgId);
  if (!user) return null;
  const bet = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(-coins),0) sum FROM transactions WHERE tg_id=? AND type='bet'`).get(tgId);
  const payout = db.prepare(`SELECT COALESCE(SUM(coins),0) sum, COALESCE(MAX(coins),0) maxWin FROM transactions WHERE tg_id=? AND type='payout'`).get(tgId);
  const deposits = db.prepare(`SELECT COALESCE(SUM(amount_real),0) sum, COUNT(*) n FROM transactions WHERE tg_id=? AND type IN ('stars','crypto') AND status='paid'`).get(tgId);
  const withdrawals = db.prepare(`SELECT COALESCE(SUM(amount_real),0) sum, COUNT(*) n FROM transactions WHERE tg_id=? AND type='withdrawal' AND status='paid'`).get(tgId);
  const recentTx = db.prepare(`SELECT * FROM transactions WHERE tg_id=? ORDER BY created_at DESC LIMIT 50`).all(tgId);
  return {
    user,
    staked: bet.sum, betsCount: bet.n,
    paid: payout.sum, maxWin: payout.maxWin,
    profit: bet.sum - payout.sum,
    depositsSum: deposits.sum, depositsCount: deposits.n,
    withdrawalsSum: withdrawals.sum, withdrawalsCount: withdrawals.n,
    recentTx,
  };
}

/** Последние N транзакций (для вкладки "Транзакции"), с опциональным фильтром по типу. */
export function getRecentTransactions({ limit = 100, type = null } = {}) {
  if (type) return db.prepare(`SELECT * FROM transactions WHERE type=? ORDER BY created_at DESC LIMIT ?`).all(type, limit);
  return db.prepare(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?`).all(limit);
}

/** Список сыгранных игр — каждая ставка сопоставляется со своим исходом (выплата/
 *  возврат/ничего = проигрыш) по совпадению игрока+раунда+режима. Поддерживает
 *  фильтр по режиму (classic/mines_shared) для вкладки "Игры" в админке. Ставки
 *  без mode (сделанные ДО того, как разметка появилась) фильтром по режиму не
 *  находятся, но видны при значении "Все режимы". */
export function listGames({ limit = 50, offset = 0, mode = '' } = {}) {
  const modeFilter = mode ? `AND json_extract(b.payload,'$.mode') = @mode` : '';
  const rows = db.prepare(`
    SELECT
      b.id, b.tg_id, u.username, b.created_at,
      json_extract(b.payload,'$.round') as round,
      json_extract(b.payload,'$.mode') as mode,
      -b.coins as staked,
      p.coins as payout,
      CASE WHEN p.id IS NOT NULL THEN 'win'
           WHEN rf.id IS NOT NULL THEN 'refund'
           ELSE 'lose' END as result
    FROM transactions b
    LEFT JOIN users u ON u.tg_id = b.tg_id
    LEFT JOIN transactions p ON p.tg_id = b.tg_id AND p.type = 'payout'
      AND json_extract(p.payload,'$.round') = json_extract(b.payload,'$.round')
      AND (json_extract(p.payload,'$.mode') IS json_extract(b.payload,'$.mode'))
    LEFT JOIN transactions rf ON rf.tg_id = b.tg_id AND rf.type = 'refund'
      AND json_extract(rf.payload,'$.round') = json_extract(b.payload,'$.round')
      AND (json_extract(rf.payload,'$.mode') IS json_extract(b.payload,'$.mode'))
    WHERE b.type = 'bet' ${modeFilter}
    ORDER BY b.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ mode, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) n FROM transactions b WHERE b.type='bet' ${modeFilter}`).get({ mode }).n;
  return { rows, total };
}
