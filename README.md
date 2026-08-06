# REDPILL backend

Бэкенд для Mini App REDPILL: баланс игроков, пополнение через **Telegram Stars**
и **крипту** (Crypto Pay API / @CryptoBot), история транзакций.
WebSocket-часть — пока заготовка под общий раунд-луп (см. `src/server.js`), это
следующий шаг после пополнений.

## Что уже работает
- Проверка подлинности Telegram Mini App (валидация `initData` по HMAC)
- Баланс игрока в SQLite (`users`), полная история транзакций (`transactions`)
- `POST /api/topup/stars` — создание инвойса на Telegram Stars
- `POST /api/topup/crypto` — создание инвойса на USDT/TON через @CryptoBot
- Вебхуки, которые реально зачисляют монеты после подтверждения оплаты
- Идемпотентность — повторный вебхук от Telegram/CryptoBot не задвоит зачисление

## 1. Установка

```bash
npm install
cp .env.example .env
```

Заполни `.env`:

| Переменная | Где взять |
|---|---|
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → твой бот → API Token |
| `CRYPTO_PAY_TOKEN` | Открой [@CryptoBot](https://t.me/CryptoBot) → Crypto Pay → My Apps → Create App |
| `PUBLIC_URL` | Публичный HTTPS-адрес ЭТОГО бэкенда после деплоя (см. ниже) |
| `CORS_ORIGIN` | HTTPS-адрес фронтенда (Mini App) |
| `TELEGRAM_WEBHOOK_SECRET` | Придумай случайную строку — защита от поддельных запросов к вебхуку |
| `COINS_PER_STAR` / `COINS_PER_USDT` | Твоя экономика — сколько игровых монет за 1 Star / 1 USDT |

## 2. Локальный запуск (для теста)

```bash
npm run dev
# сервер поднимется на http://localhost:8080
curl http://localhost:8080/health   # должен вернуть {"ok":true}
```

Для локального теста вебхуков используй туннель (например `ngrok http 8080`) и
временно пропиши его https-адрес в `PUBLIC_URL`.

## 3. Деплой на сервер

### Вариант А — Docker (проще всего)

```bash
git clone <твой-репозиторий> redpill-backend
cd redpill-backend
cp .env.example .env   # и заполни как выше
docker compose up -d --build
```

### Вариант Б — вручную на VPS (Ubuntu)

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# сам проект
git clone <твой-репозиторий> redpill-backend
cd redpill-backend
npm install --omit=dev
cp .env.example .env   # и заполни

# держим процесс живым через pm2
sudo npm install -g pm2
pm2 start src/server.js --name redpill-backend
pm2 save
pm2 startup   # выведет команду — выполни её, чтобы pm2 поднимался при перезагрузке сервера
```

### Вариант В — Railway

Railway сам подхватит `Dockerfile` и `railway.toml` из репозитория — компилировать
`better-sqlite3` вручную не придётся.

1. Залей папку `redpill-backend` в GitHub-репозиторий (Railway проще всего деплоит из GitHub).
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → выбери репозиторий.
3. **⚠️ Обязательно добавь Volume**, иначе база данных обнулится при следующем деплое:
   Service → **Settings** → **Volumes** → **Add Volume** → mount path `/app/data`.
   Без этого шага SQLite-файл живёт на эфемерном диске контейнера и стирается
   при каждом передеплое — потеряешь все балансы и историю.
4. Service → **Variables** → добавь все переменные из `.env.example`
   (`BOT_TOKEN`, `CRYPTO_PAY_TOKEN`, `CORS_ORIGIN`, `COINS_PER_STAR`, `COINS_PER_USDT`,
   `TELEGRAM_WEBHOOK_SECRET`; `DB_PATH` можно оставить по умолчанию — совпадает с mount path).
   Переменную `PORT` не трогай — Railway подставляет её сам.
5. После первого деплоя Railway выдаст домен вида `your-app.up.railway.app`
   (или подключи свой домен в Settings → Networking). Впиши его в переменную
   `PUBLIC_URL` (с `https://`) и сделай **Redeploy**, чтобы бэкенд узнал свой публичный адрес.
6. Проверь: `https://your-app.up.railway.app/health` → `{"ok":true}`.
7. Зарегистрируй вебхук Telegram — этот скрипт просто дёргает Bot API снаружи,
   выполнять его на самом Railway не обязательно, достаточно локально:
   ```bash
   # локально, с .env где BOT_TOKEN и PUBLIC_URL = твой Railway-домен
   node scripts/setWebhook.js
   ```
8. В [@CryptoBot](https://t.me/CryptoBot) → Crypto Pay → My Apps → Webhooks укажи
   `https://your-app.up.railway.app/webhook/cryptopay`.

### HTTPS обязателен

*(Если деплоишь на Railway — у тебя уже есть HTTPS из коробки, этот раздел только для ручного VPS.)*

Telegram не откроет ни Mini App, ни вебхук без валидного HTTPS-сертификата.
Проще всего — Caddy (сам получает сертификат Let's Encrypt):

```
# /etc/caddy/Caddyfile
your-backend-domain.com {
    reverse_proxy localhost:8080
}
```

```bash
sudo apt install caddy
sudo systemctl restart caddy
```

Либо nginx + certbot, если уже используешь nginx.

## 4. Регистрация вебхука в Telegram

После деплоя (когда `PUBLIC_URL` в `.env` указывает на реальный HTTPS-адрес):

```bash
node scripts/setWebhook.js
```

Это скажет Telegram слать апдейты об оплатах на `PUBLIC_URL/webhook/telegram`.

## 5. Настройка Crypto Pay вебхука

В [@CryptoBot](https://t.me/CryptoBot) → Crypto Pay → My Apps → твоё приложение →
Webhooks → укажи `https://your-backend-domain.com/webhook/cryptopay`.

## 6. Подключение фронтенда

В `index.html` игры пропиши:

```js
const BACKEND_URL = 'https://your-backend-domain.com';
```

Это автоматически выключит демо-режим (`SOCIAL_DEMO`) и активирует реальные
запросы к бэкенду для баланса и пополнений (окно "+" рядом с балансом).

## 7. Проверка перед реальным запуском

- [ ] `/health` отвечает `{"ok":true}` на боевом домене
- [ ] Тестовое пополнение Stars проходит и монеты реально зачисляются
- [ ] Тестовое пополнение крипты (можно на `testnet` через `@CryptoTestnetBot`) проходит
- [ ] Повторный вебхук (например, ретрай от Telegram) НЕ зачисляет монеты дважды — проверено идемпотентностью по `provider_id`
- [ ] `.env` не закоммичен в git
- [ ] Прочитал раздел про лицензирование азартных игр в своей юрисдикции — это НЕ техническая деталь, а юридическое требование

## Дальше

Раунд-луп (общий для всех игроков, серверный provably-fair RNG) — следующий
шаг, каркас уже в `src/server.js` (`WebSocketServer` на `/ws`). Логику фаз
(`T_BET`/`T_LOCK`/`T_SPIN`/`T_RESULT`) и генерацию исхода нужно перенести сюда
из клиентской `genOutcome()` в `index.html` — сейчас это единственная часть
игры, которая ещё считается на клиенте.
