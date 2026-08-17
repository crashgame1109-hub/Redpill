// Авторитетный игровой цикл REDPILL (классика) — общий для ВСЕХ подключённых игроков.
// Раньше исход считался в браузере каждого игрока отдельно (ненадёжно и небезопасно
// для реальных денег); теперь единственный источник истины — этот модуль на сервере.
import crypto from 'node:crypto';
import { getUser, debitForBet, payoutBetAndBumpRounds } from './db.js';
import { T_BET, T_LOCK, T_SPIN, T_RESULT, RTP, BOOST_ROUNDS, BOOST_RTP, BET_MIN } from './config.js';

function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function randHex(n) { return crypto.randomBytes(n).toString('hex'); }

let broadcastAll = () => {};
let sendToUser = () => {};
/** Подключает функции рассылки — вызывается один раз из server.js при старте. */
export function setBroadcasters(allFn, toUserFn) { broadcastAll = allFn; sendToUser = toUserFn; }

let phase = 'idle';           // 'bet' | 'lock' | 'spin' | 'result'
let nonce = 0;
let serverSeed = '', commitHash = '';
let outcome = null;
let bets = [];                 // ставки ТЕКУЩЕГО раунда: [{tgId, who, side, amount, payoutMult}]
let phaseTimer = null;
let phaseStartedAt = 0;

function inBoost(roundsPlayed) { return roundsPlayed < BOOST_ROUNDS; }
function payoutMultFor(roundsPlayed) { return +(2 * (inBoost(roundsPlayed) ? BOOST_RTP : RTP)).toFixed(2); }

/** Полное состояние текущего раунда — отправляется клиенту сразу при подключении,
 *  чтобы он мгновенно синхронизировался, даже если раунд уже идёт (не с начала). */
export function getCurrentState() {
  return {
    type: 'state', phase, nonce, commitHash,
    tBet: T_BET, tLock: T_LOCK, tSpin: T_SPIN, tResult: T_RESULT,
    phaseStartedAt, serverTime: Date.now(),
    outcome: (phase === 'spin' || phase === 'result') ? outcome : null,
    bets: bets.map(b => ({ id: b.tgId, who: b.who, side: b.side, amount: b.amount })),
  };
}

function startBetting() {
  phase = 'bet'; nonce++; bets = [];
  serverSeed = randHex(16);
  commitHash = sha256(serverSeed);
  outcome = null;
  phaseStartedAt = Date.now();
  broadcastAll({ type: 'round_start', nonce, commitHash, tBet: T_BET, tLock: T_LOCK, tSpin: T_SPIN, tResult: T_RESULT, serverTime: phaseStartedAt });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(lockBets, T_BET);
}

function lockBets() {
  phase = 'lock'; phaseStartedAt = Date.now();
  broadcastAll({ type: 'round_lock', nonce });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(spin, T_LOCK);
}

function spin() {
  phase = 'spin'; phaseStartedAt = Date.now();
  // Исход уже был предопределён коммитом (serverSeed) до открытия ставок — сейчас
  // просто вычисляем и раскрываем его, подделать задним числом невозможно.
  const h = sha256(`${serverSeed}:${nonce}:matrix`);
  const u = parseInt(h.slice(0, 8), 16) / 4294967296;
  outcome = u < 0.5 ? 'red' : 'blue';
  broadcastAll({ type: 'round_spin', nonce, outcome });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(settle, T_SPIN);
}

function settle() {
  phase = 'result'; phaseStartedAt = Date.now();
  const publicResults = [];
  for (const b of bets) {
    const win = b.side === outcome;
    const payout = win ? Math.round(b.amount * b.payoutMult) : 0;
    const user = payoutBetAndBumpRounds(b.tgId, payout, nonce);
    publicResults.push({ id: b.tgId, win });
    // Баланс — личная информация, шлём только самому игроку, не всем подряд.
    sendToUser(b.tgId, {
      type: 'balance', balance: user.balance, reason: 'round', nonce, win, payout,
      roundsPlayed: user.rounds_played, boostLeft: Math.max(0, BOOST_ROUNDS - user.rounds_played),
      payoutMult: payoutMultFor(user.rounds_played),
    });
  }
  broadcastAll({ type: 'round_settle', nonce, revealedSeed: serverSeed, commitHash, outcome, results: publicResults });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(startBetting, T_RESULT);
}

/** Разместить ставку от имени tgId. Возвращает {ok:true,...} либо {ok:false,error}. */
export function placeBet(tgId, who, side, amountRaw) {
  if (phase !== 'bet') return { ok: false, error: 'betting_closed' };
  if (side !== 'red' && side !== 'blue') return { ok: false, error: 'invalid_side' };
  const amount = Math.round(Number(amountRaw));
  if (!Number.isFinite(amount) || amount < BET_MIN) return { ok: false, error: 'invalid_amount' };
  if (bets.some(b => b.tgId === tgId)) return { ok: false, error: 'already_bet' };

  const user = getUser(tgId);
  if (!user) return { ok: false, error: 'no_user' };
  const payoutMult = payoutMultFor(user.rounds_played);

  const updated = debitForBet(tgId, amount, nonce);
  if (!updated) return { ok: false, error: 'insufficient_balance' };

  bets.push({ tgId, who: who || 'Игрок', side, amount, payoutMult });
  broadcastAll({ type: 'bet', nonce, id: tgId, who: who || 'Игрок', side, amount });
  return { ok: true, balance: updated.balance, payoutMult };
}

export function getBoostInfoFor(roundsPlayed) {
  return { payoutMult: payoutMultFor(roundsPlayed), boostLeft: Math.max(0, BOOST_ROUNDS - roundsPlayed) };
}

export function startRoundLoop() {
  startBetting();
}
