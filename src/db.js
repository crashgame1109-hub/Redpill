// SQLite — простая, надёжная и не требует отдельного сервера БД.
// Файл создаётся автоматически при первом запуске (DB_PATH из .env).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './config.js';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_id       TEXT PRIMARY KEY,
    username    TEXT,
    balance     INTEGER NOT NULL DEFAULT 0,
    rounds_played INTEGER NOT NULL DEFAULT 0,   -- для честного буста новичка (решает сервер, не клиент)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id       TEXT NOT NULL,
    type        TEXT NOT NULL,      -- 'stars' | 'crypto' | 'test' | 'bet' | 'payout'
    status      TEXT NOT NULL,      -- 'pending' | 'paid' | 'failed'
    amount_real REAL,               -- сумма в реальных деньгах (звёзды/USDT), если применимо
    asset       TEXT,               -- 'XTR' | 'USDT' | 'TON' | ...
    coins       INTEGER NOT NULL,   -- зачислено/списано игровых монет (может быть отрицательным)
    provider_id TEXT,               -- id инвойса у провайдера (telegram_payment_charge_id / invoice_id)
    payload     TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tx_tg_id ON transactions(tg_id);
  CREATE INDEX IF NOT EXISTS idx_tx_provider_id ON transactions(provider_id);
`);

export function getOrCreateUser(tgId, username) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (tg_id, username, balance, rounds_played, created_at, updated_at)
    VALUES (?, ?, 0, 0, ?, ?)
    ON CONFLICT(tg_id) DO UPDATE SET username=excluded.username
  `).run(tgId, username ?? null, now, now);
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
}

export function getUser(tgId) {
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
}

// Атомарное начисление/списание монет + запись транзакции (в одной SQLite-транзакции)
export const creditCoins = db.transaction((tgId, coins, tx) => {
  const now = Date.now();
  db.prepare(`
    UPDATE users SET balance = balance + ?, updated_at = ? WHERE tg_id = ?
  `).run(coins, now, tgId);
  db.prepare(`
    INSERT INTO transactions (tg_id, type, status, amount_real, asset, coins, provider_id, payload, created_at)
    VALUES (@tgId, @type, @status, @amountReal, @asset, @coins, @providerId, @payload, @createdAt)
  `).run({
    tgId, type: tx.type, status: tx.status ?? 'paid',
    amountReal: tx.amountReal ?? null, asset: tx.asset ?? null,
    coins, providerId: tx.providerId ?? null, payload: tx.payload ?? null,
    createdAt: now,
  });
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
});

/** Списывает ставку, только если хватает баланса (атомарно). Возвращает
 *  обновлённого пользователя, либо null, если денег не хватило (ставка отклоняется). */
export const debitForBet = db.transaction((tgId, amount, roundNonce) => {
  const u = db.prepare('SELECT balance FROM users WHERE tg_id = ?').get(tgId);
  if (!u || u.balance < amount) return null;
  const now = Date.now();
  db.prepare(`UPDATE users SET balance = balance - ?, updated_at = ? WHERE tg_id = ?`).run(amount, now, tgId);
  db.prepare(`
    INSERT INTO transactions (tg_id, type, status, coins, payload, created_at)
    VALUES (?, 'bet', 'paid', ?, ?, ?)
  `).run(tgId, -amount, JSON.stringify({ round: roundNonce }), now);
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
});

/** Зачисляет выигрыш и в той же транзакции увеличивает счётчик сыгранных раундов
 *  (нужен для буста новичка — сервер, а не клиент, решает, когда он заканчивается). */
export const payoutBetAndBumpRounds = db.transaction((tgId, payout, roundNonce) => {
  const now = Date.now();
  if (payout > 0) {
    db.prepare(`UPDATE users SET balance = balance + ?, rounds_played = rounds_played + 1, updated_at = ? WHERE tg_id = ?`)
      .run(payout, now, tgId);
    db.prepare(`
      INSERT INTO transactions (tg_id, type, status, coins, payload, created_at)
      VALUES (?, 'payout', 'paid', ?, ?, ?)
    `).run(tgId, payout, JSON.stringify({ round: roundNonce }), now);
  } else {
    db.prepare(`UPDATE users SET rounds_played = rounds_played + 1, updated_at = ? WHERE tg_id = ?`).run(now, tgId);
  }
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
});

export function findTxByProviderId(providerId) {
  return db.prepare('SELECT * FROM transactions WHERE provider_id = ?').get(providerId);
}

export function listTransactions(tgId, limit = 60) {
  return db.prepare(`
    SELECT * FROM transactions WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(tgId, limit);
}

/* ---------- Вывод средств ----------
   Заявка списывает баланс СРАЗУ (чтобы нельзя было потратить те же монеты дважды,
   пока заявка висит в очереди), но помечается статусом 'pending' — реальная выплата
   уходит только после ручного подтверждения оператором через /admin/withdrawals. */
export const createWithdrawalRequest = db.transaction((tgId, coins, asset, amountReal, destination) => {
  const u = db.prepare('SELECT balance FROM users WHERE tg_id = ?').get(tgId);
  if (!u || u.balance < coins) return null;
  const now = Date.now();
  db.prepare(`UPDATE users SET balance = balance - ?, updated_at = ? WHERE tg_id = ?`).run(coins, now, tgId);
  const info = db.prepare(`
    INSERT INTO transactions (tg_id, type, status, amount_real, asset, coins, payload, created_at)
    VALUES (?, 'withdrawal', 'pending', ?, ?, ?, ?, ?)
  `).run(tgId, amountReal, asset, -coins, JSON.stringify({ destination }), now);
  return { id: info.lastInsertRowid, balance: db.prepare('SELECT balance FROM users WHERE tg_id = ?').get(tgId).balance };
});

export function listPendingWithdrawals() {
  return db.prepare(`SELECT * FROM transactions WHERE type='withdrawal' AND status='pending' ORDER BY created_at ASC`).all();
}
export function getWithdrawal(id) {
  return db.prepare(`SELECT * FROM transactions WHERE id=? AND type='withdrawal'`).get(id);
}
export function markWithdrawalPaid(id, providerId) {
  db.prepare(`UPDATE transactions SET status='paid', provider_id=? WHERE id=?`).run(providerId, id);
}
/** Отклонить заявку — возвращает списанные монеты игроку обратно. */
export const rejectWithdrawal = db.transaction((id) => {
  const tx = db.prepare(`SELECT * FROM transactions WHERE id=? AND type='withdrawal'`).get(id);
  if (!tx || tx.status !== 'pending') return null;
  const now = Date.now();
  db.prepare(`UPDATE users SET balance = balance + ?, updated_at = ? WHERE tg_id = ?`).run(-tx.coins, now, tx.tg_id);
  db.prepare(`UPDATE transactions SET status='failed' WHERE id=?`).run(id);
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tx.tg_id);
});
