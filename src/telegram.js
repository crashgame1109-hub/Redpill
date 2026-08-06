import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { BOT_TOKEN, PUBLIC_URL, TELEGRAM_WEBHOOK_SECRET } from './config.js';

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const MAX_AUTH_AGE_SEC = 24 * 60 * 60; // 24 часа — старше считаем протухшим

/**
 * Проверка подписи Telegram WebApp initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Возвращает { ok, user, authDate } или { ok:false, reason }.
 */
export function validateInitData(initData) {
  if (!BOT_TOKEN) return { ok: false, reason: 'BOT_TOKEN не настроен на сервере' };
  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'initData отсутствует' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'нет hash в initData' };
  params.delete('hash');

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // timing-safe сравнение
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'подпись не совпадает' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || (Date.now() / 1000 - authDate) > MAX_AUTH_AGE_SEC) {
    return { ok: false, reason: 'initData устарела, перезапусти Mini App' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* noop */ }
  if (!user?.id) return { ok: false, reason: 'нет данных пользователя' };

  return { ok: true, user, authDate };
}

async function callApi(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

/** Создаёт ссылку-инвойс на оплату Telegram Stars. amountStars — целое число звёзд. */
export function createStarsInvoiceLink({ title, description, payload, amountStars }) {
  return callApi('createInvoiceLink', {
    title,
    description,
    payload,
    provider_token: '',      // для Stars provider_token всегда пустая строка
    currency: 'XTR',         // валюта Telegram Stars
    prices: [{ label: title, amount: Math.round(amountStars) }],
  });
}

export function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  return callApi('answerPreCheckoutQuery', {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });
}

export function sendMessage(chatId, text, extra = {}) {
  return callApi('sendMessage', { chat_id: chatId, text, ...extra });
}

/** Регистрирует вебхук бота на этом сервере. Вызывается один раз из scripts/setWebhook.js. */
export function setWebhook() {
  if (!PUBLIC_URL) throw new Error('PUBLIC_URL не задан в .env');
  return callApi('setWebhook', {
    url: `${PUBLIC_URL}/webhook/telegram`,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['pre_checkout_query', 'message'],
  });
}
