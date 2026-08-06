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
    INSERT INTO users (tg_id, username, balance, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
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

export function findTxByProviderId(providerId) {
  return db.prepare('SELECT * FROM transactions WHERE provider_id = ?').get(providerId);
}

export function listTransactions(tgId, limit = 60) {
  return db.prepare(`
    SELECT * FROM transactions WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(tgId, limit);
}
