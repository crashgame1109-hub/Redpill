import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { PORT, CORS_ORIGIN } from './config.js';
import { balanceRouter } from './routes/balance.js';
import { topupRouter } from './routes/topup.js';
import { webhookRouter } from './routes/webhooks.js';

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));

// ВАЖНО: вебхук Crypto Pay должен получать СЫРОЕ тело (нужно для проверки подписи),
// поэтому регистрируем express.raw() именно для этого пути ДО общего express.json().
app.use('/webhook/cryptopay', express.raw({ type: '*/*' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api', balanceRouter);
app.use('/api/topup', topupRouter);
app.use('/webhook', webhookRouter);

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

const server = createServer(app);

/* ---------------------------------------------------------------------------
 * WebSocket — заготовка под общий раунд-луп (все игроки видят один и тот же
 * раунд одновременно). Сейчас это только каркас подключения; логику фаз
 * (приём ставок → закрытие → вращение → результат) и серверный provably-fair
 * RNG нужно перенести сюда из клиентской genOutcome()/startBetting() —
 * это следующий шаг, отдельный от пополнений баланса. Пополнения (Stars/крипта)
 * уже полностью рабочие и не зависят от WebSocket-части.
 * ------------------------------------------------------------------------- */
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', message: 'REDPILL WS подключен (заготовка под общий раунд-луп)' }));
  ws.on('message', (raw) => {
    // TODO: обработка sendBet/sendChat от клиента (net.sendBet/net.sendChat в index.html)
  });
});

server.listen(PORT, () => {
  console.log(`REDPILL backend слушает порт ${PORT}`);
});
