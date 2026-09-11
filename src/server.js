import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PORT, CORS_ORIGIN, ADMIN_HOST } from './config.js';
import { balanceRouter } from './routes/balance.js';
import { topupRouter } from './routes/topup.js';
import { webhookRouter } from './routes/webhooks.js';
import { withdrawRouter } from './routes/withdraw.js';
import { adminRouter, setLiveStateGetter } from './routes/admin.js';
import { validateInitData } from './telegram.js';
import { getOrCreateUser } from './db.js';
import { setBroadcasters, getCurrentState, placeBet, startRoundLoop, getBoostInfoFor, getAdminLiveState as getClassicLiveState } from './roundLoop.js';
import { setMinesBroadcasters, getMinesState, placeMinesBet, cancelMinesBet, pickMinesCell, unpickMinesCell, startMinesLoop, getAdminLiveState as getMinesLiveState } from './sharedMines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));

// ВАЖНО: вебхук Crypto Pay должен получать СЫРОЕ тело (нужно для проверки подписи),
// поэтому регистрируем express.raw() именно для этого пути ДО общего express.json().
app.use('/webhook/cryptopay', express.raw({ type: '*/*' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* Админ-панель — тот же самый бэкенд, тот же деплой, но открывается как
 * будто отдельный сайт: если запрос пришёл на домен из ADMIN_HOST (например
 * "admin.твой-домен.com"), корень "/" отдаёт страницу панели вместо игры.
 * Настрой в DNS второй домен/поддомен, указывающий на ЭТОТ ЖЕ сервер, и
 * пропиши его в ADMIN_HOST — переключать код или гонять два деплоя не нужно.
 * Путь /admin-panel работает всегда, независимо от домена — как запасной
 * вариант, если отдельный домен ещё не настроен. */
app.get('/', (req, res, next) => {
  if (ADMIN_HOST && req.hostname === ADMIN_HOST) return res.sendFile(path.join(__dirname, 'admin.html'));
  next();
});
app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.use('/api', balanceRouter);
app.use('/api/topup', topupRouter);
app.use('/api/withdraw', withdrawRouter);
app.use('/admin', adminRouter);
app.use('/webhook', webhookRouter);

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

const server = createServer(app);

/* ---------------------------------------------------------------------------
 * WebSocket — общий раунд для ВСЕХ подключённых игроков: один и тот же таймер,
 * один и тот же честно сгенерированный на СЕРВЕРЕ исход, реальные ставки на
 * серверном балансе, видимые всем, плюс общий чат. Никакой игровой логики
 * на клиенте больше нет — он только отображает то, что говорит сервер.
 * ------------------------------------------------------------------------- */
const wss = new WebSocketServer({ server, path: '/ws' });

// tgId -> Set<ws>  (у игрока может быть несколько вкладок/устройств одновременно)
const connectionsByUser = new Map();
const CHAT_MAX_LEN = 200;
const CHAT_HISTORY_MAX = 40;
let chatHistory = []; // последние сообщения — новым подключившимся показываем контекст

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* noop */ } }
}
function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((ws) => { if (ws.readyState === ws.OPEN) { try { ws.send(data); } catch { /* noop */ } } });
}
function sendToUser(tgId, msg) {
  const set = connectionsByUser.get(String(tgId));
  if (!set) return;
  for (const ws of set) send(ws, msg);
}

setBroadcasters(broadcastAll, sendToUser);
setMinesBroadcasters(broadcastAll, sendToUser);

// Реальное число уникальных онлайн-игроков (по tgId — несколько вкладок одного
// и того же человека считаются за одного), а не число ставок в текущем раунде
// (то, что уже показывает Reel — это отдельная, отдельно не трогаемая метрика).
function broadcastOnlineCount() {
  broadcastAll({ type: 'online_count', count: connectionsByUser.size });
}
setLiveStateGetter(() => ({
  online: connectionsByUser.size,
  classic: getClassicLiveState(),
  mines: getMinesLiveState(),
}));

wss.on('connection', (ws) => {
  ws.tgId = null;
  ws.username = null;

  // Сразу шлём текущее состояние раунда — даже неавторизованный видит общий раунд и чат.
  send(ws, getCurrentState());
  send(ws, getMinesState());
  send(ws, { type: 'chat_history', messages: chatHistory });
  send(ws, { type: 'online_count', count: connectionsByUser.size });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'auth') {
      const check = validateInitData(msg.initData);
      if (!check.ok) { send(ws, { type: 'auth_fail', reason: check.reason }); return; }
      const tgId = String(check.user.id);
      const username = check.user.username || check.user.first_name || 'Игрок';
      const user = getOrCreateUser(tgId, username);
      ws.tgId = tgId; ws.username = username;
      if (!connectionsByUser.has(tgId)) connectionsByUser.set(tgId, new Set());
      connectionsByUser.get(tgId).add(ws);
      const boost = getBoostInfoFor(user.rounds_played);
      send(ws, { type: 'auth_ok', tgId, username, balance: user.balance, roundsPlayed: user.rounds_played, ...boost });
      broadcastOnlineCount(); // новый уникальный игрок мог зайти — обновляем счётчик у всех
      return;
    }

    if (msg.type === 'bet') {
      if (!ws.tgId) { send(ws, { type: 'error', context: 'bet', message: 'not_authenticated' }); return; }
      const result = placeBet(ws.tgId, ws.username, msg.side, msg.amount);
      if (!result.ok) { send(ws, { type: 'error', context: 'bet', message: result.error }); return; }
      send(ws, { type: 'bet_ok', balance: result.balance });
      return;
    }

    if (msg.type === 'mines_bet') {
      if (!ws.tgId) { send(ws, { type: 'error', context: 'mines_bet', message: 'not_authenticated' }); return; }
      const result = placeMinesBet(ws.tgId, ws.username, msg.color, msg.amount);
      if (!result.ok) { send(ws, { type: 'error', context: 'mines_bet', message: result.error }); return; }
      send(ws, { type: 'mines_bet_ok', balance: result.balance });
      return;
    }

    if (msg.type === 'mines_bet_cancel') {
      if (!ws.tgId) { send(ws, { type: 'error', context: 'mines_bet_cancel', message: 'not_authenticated' }); return; }
      const result = cancelMinesBet(ws.tgId);
      if (!result.ok) { send(ws, { type: 'error', context: 'mines_bet_cancel', message: result.error }); return; }
      send(ws, { type: 'mines_bet_cancel_ok', balance: result.balance });
      return;
    }

    if (msg.type === 'mines_click') {
      if (!ws.tgId) { send(ws, { type: 'error', context: 'mines_click', message: 'not_authenticated' }); return; }
      const result = pickMinesCell(ws.tgId, msg.cellIndex);
      if (!result.ok) { send(ws, { type: 'error', context: 'mines_click', message: result.error }); return; }
      return;
    }

    if (msg.type === 'mines_unclick') {
      if (!ws.tgId) { send(ws, { type: 'error', context: 'mines_unclick', message: 'not_authenticated' }); return; }
      const result = unpickMinesCell(ws.tgId, msg.cellIndex);
      if (!result.ok) { send(ws, { type: 'error', context: 'mines_unclick', message: result.error }); return; }
      send(ws, { type: 'mines_cell_unpicked', cellIndex: msg.cellIndex, picksLeft: result.picksLeft });
      return;
    }

    if (msg.type === 'chat') {
      if (!ws.tgId) { send(ws, { type: 'error', context: 'chat', message: 'not_authenticated' }); return; }
      const text = String(msg.text || '').slice(0, CHAT_MAX_LEN).trim();
      if (!text) return;
      const chatMsg = { type: 'chat', who: ws.username, text, ts: Date.now() };
      chatHistory.push(chatMsg);
      if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift();
      broadcastAll(chatMsg);
      return;
    }
  });

  ws.on('close', () => {
    if (ws.tgId && connectionsByUser.has(ws.tgId)) {
      const set = connectionsByUser.get(ws.tgId);
      set.delete(ws);
      if (set.size === 0) { connectionsByUser.delete(ws.tgId); broadcastOnlineCount(); } // ушёл последний коннект этого игрока — он теперь офлайн
    }
  });
});

startRoundLoop();
startMinesLoop();

server.listen(PORT, () => {
  console.log(`REDPILL backend слушает порт ${PORT}`);
});
