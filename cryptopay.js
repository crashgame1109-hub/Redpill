// Crypto Pay API — платёжный сервис @CryptoBot, нативный для Telegram.
// Получить токен: открой @CryptoBot → Crypto Pay → My Apps → Create App.
// Документация: https://help.crypt.bot/crypto-pay-api (сверься перед продакшеном —
// детали API могут обновляться, здесь реализовано по актуальной на момент написания схеме).
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { CRYPTO_PAY_TOKEN, CRYPTO_PAY_API_BASE } from './config.js';

async function callApi(method, body) {
  const res = await fetch(`${CRYPTO_PAY_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Crypto-Pay-API-Token': CRYPTO_PAY_TOKEN,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Crypto Pay API ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

/**
 * Создаёт инвойс на оплату криптой.
 * asset: 'USDT' | 'TON' | 'BTC' | ... (см. getCurrencies в доке Crypto Pay)
 * amount: сумма в этом активе (строка или число, например 5 USDT)
 */
export function createCryptoInvoice({ asset, amount, description, payload }) {
  return callApi('createInvoice', {
    asset,
    amount: String(amount),
    description,
    payload,
    paid_btn_name: 'callback',
    paid_btn_url: undefined, // можно указать ссылку возврата в Mini App
  });
}

export function getInvoices(params = {}) {
  return callApi('getInvoices', params);
}

/**
 * Отправляет крипту на баланс пользователя внутри @CryptoBot (реальная выплата
 * при выводе). userId — Telegram user id получателя (тот же, что в initData).
 * spendId — обязательный уникальный ключ идемпотентности: повторный вызов с тем
 * же spendId НЕ создаст второй перевод, даже если сеть оборвалась и запрос ушёл
 * дважды. См. актуальную доку перед продакшеном — метод/параметры могут меняться.
 */
export function transferCrypto({ userId, asset, amount, spendId, comment }) {
  return callApi('transfer', {
    user_id: userId,
    asset,
    amount: String(amount),
    spend_id: spendId,
    comment: comment || 'REDPILL withdrawal',
  });
}

/**
 * Проверка подписи вебхука Crypto Pay.
 * signature = HMAC_SHA256(rawBody, key = SHA256(CRYPTO_PAY_TOKEN)) в hex.
 * rawBody должен быть ИМЕННО тем сырым телом запроса, что прислал CryptoBot —
 * поэтому в express для этого роута используется express.raw(), см. server.js.
 */
export function verifyCryptoPayWebhook(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const secret = crypto.createHash('sha256').update(CRYPTO_PAY_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(signatureHeader, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
