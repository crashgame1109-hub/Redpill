import { validateInitData } from '../telegram.js';
import { getOrCreateUser } from '../db.js';

/**
 * Ожидает initData в заголовке 'x-telegram-init-data' (клиент шлёт
 * Telegram.WebApp.initData как есть, без парсинга).
 * НИКОГДА не доверяй user id, присланному в теле запроса напрямую —
 * только то, что прошло проверку подписи здесь.
 */
export function requireTelegramAuth(req, res, next) {
  const initData = req.header('x-telegram-init-data');
  const check = validateInitData(initData);
  if (!check.ok) {
    return res.status(401).json({ error: 'unauthorized', reason: check.reason });
  }
  const tgId = String(check.user.id);
  const username = check.user.username || check.user.first_name || null;
  req.tgUser = getOrCreateUser(tgId, username);
  next();
}
