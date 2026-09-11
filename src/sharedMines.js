// Общая доска Reel: 36 шариков (18 красных / 1 зелёный / 17 синих — зелёный как
// зеро в рулетке: редкий и с огромной выплатой). Доска одна на всех — состав
// цветов честно зафиксирован через commit/reveal в начале раунда, — но ячейки
// НЕ эксклюзивны: разные игроки МОГУТ отмечать один и тот же шарик, каждый
// из них независимо проверяет его цвет против своей собственной ставки. Раз
// ячейки не эксклюзивны, у каждой ставки — свой личный "остаток" шариков по
// цветам (не общий на стол), честный множитель считается по нему же.
//
// Игрок выбирает цвет + ставку, затем в ТОМ ЖЕ окне времени отмечает один или
// несколько шариков на сетке — БЕЗ немедленного раскрытия цвета (цвет секрет
// до конца раунда). Когда время выходит, вся доска раскрывается разом всем
// сразу, и по всем отмеченным ячейкам (все-или-ничего, см. evaluateBet)
// пересчитывается честный множитель T/R.
//
// Важно про приём пиков: сервер НИКОГДА не отклоняет попытку молча из-за того,
// что игрок "уже проиграл" внутренне (скрытое состояние) — иначе сам факт
// отказа принять клик был бы утечкой информации ("о, значит я уже промазал").
// Вместо этого игрок может сделать до своего личного лимита попыток ВСЕГДА
// (обычный цвет — до потолка глубины раунда, редкий зелёный — только 1, см.
// maxPicksFor), а честная оценка "всё совпало или нет" считается при раскрытии.
import crypto from 'node:crypto';
import { debitForBet, creditCoins } from './db.js';
import { MINES_T_BET, MINES_N, MINES_RED_COUNT, MINES_BLUE_COUNT, MINES_GREEN_COUNT, MINES_MAX_DEPTH, RTP, BET_MIN, MINES_GOLDEN_INTERVAL_MS, MINES_GOLDEN_RTP, MINES_GOLDEN_MAX_DEPTH, MINES_INTRO_MS } from './config.js';

function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function randHex(n) { return crypto.randomBytes(n).toString('hex'); }

let broadcastAll = () => {};
let sendToUser = () => {};
export function setMinesBroadcasters(allFn, toUserFn) { broadcastAll = allFn; sendToUser = toUserFn; }

const COLORS = ['red', 'green', 'blue'];
const COLOR_COUNTS = { red: MINES_RED_COUNT, green: MINES_GREEN_COUNT, blue: MINES_BLUE_COUNT };

let phase = 'idle';          // 'bet' (приём ставок + выбор шариков) | 'ended' (пауза между раундами)
let nonce = 0;
let serverSeed = '', commitHash = '';
let board = [];               // [{color}] длиной MINES_N — цвет каждой ячейки, известен только серверу до конца раунда
let bets = new Map();         // tgId -> {who, color, amount, status, picks:[{cellIndex,color,isMatch,T,R}], pickedSet, remaining}
let totalPicksCount = 0;      // сколько отметок всего сделано за раунд всеми игроками вместе — просто индикатор "стол живой"
let phaseTimer = null;
let phaseStartedAt = 0;
// Золотой раунд: раз в час (см. разбор математики в config.js) — RTP и потолок
// глубины ЭТОГО раунда фиксируются в момент старта ставок и не меняются до конца.
let lastGoldenBucket = -1;
let isGolden = false;
let roundRTP = RTP;
let roundMaxDepth = MINES_MAX_DEPTH;

/** Зелёный — редчайший цвет (всего 1 шарик на всю доску), поэтому по нему
 *  разрешена только ОДНА отметка за раунд, а не общий потолок глубины —
 *  дальше и нечего отмечать честно (шарик всего один). */
function maxPicksFor(color) {
  return color === 'green' ? 1 : roundMaxDepth;
}

/** Детерминированная перетасовка на основе seed+nonce — каждый шаг тасовки
 *  берёт следующий хеш, поэтому результат полностью проверяем по раскрытому сиду. */
function buildBoard(seed, roundNonce) {
  const cells = [];
  for (const c of COLORS) for (let i = 0; i < COLOR_COUNTS[c]; i++) cells.push(c);
  let counter = 0;
  const nextRand = () => {
    const h = sha256(`${seed}:${roundNonce}:mines:${counter++}`);
    return parseInt(h.slice(0, 8), 16) / 4294967296;
  };
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(nextRand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.map(color => ({ color }));
}

export function getMinesState() {
  return {
    type: 'mines_state', phase, nonce, commitHash,
    tBet: MINES_T_BET, maxDepth: roundMaxDepth, golden: isGolden,
    phaseStartedAt, serverTime: Date.now(),
    board: phase === 'ended' ? board.map(c => c.color) : null, // доска не хранит "занятость" — ячейки больше не эксклюзивны
    claimedCount: totalPicksCount,
    bets: [...bets.entries()].map(([id, b]) => ({ id, who: b.who, color: b.color, amount: b.amount, status: b.status })),
  };
}

function startBetting() {
  phase = 'bet'; nonce++; bets.clear(); totalPicksCount = 0;
  // Золотой раунд — первый раунд, чья фаза ставок стартует в новом часовом "бакете".
  // Переживает перезапуск сервера почти всегда штатно: в редком случае рестарта
  // ровно на границе часа возможен лишний золотой раунд подряд — не проблема для
  // экономики (RTP всё равно <1), скорее приятный бонус игрокам.
  const bucket = Math.floor(Date.now() / MINES_GOLDEN_INTERVAL_MS);
  isGolden = bucket !== lastGoldenBucket;
  if (isGolden) lastGoldenBucket = bucket;
  roundRTP = isGolden ? MINES_GOLDEN_RTP : RTP;
  roundMaxDepth = isGolden ? MINES_GOLDEN_MAX_DEPTH : MINES_MAX_DEPTH;
  serverSeed = randHex(16);
  commitHash = sha256(serverSeed);
  board = buildBoard(serverSeed, nonce);
  phaseStartedAt = Date.now();
  broadcastAll({ type: 'mines_round_start', nonce, commitHash, tBet: MINES_T_BET, maxDepth: roundMaxDepth, golden: isGolden, serverTime: phaseStartedAt });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(endRound, MINES_T_BET);
}

/** Все-или-ничего: честный множитель = произведение T/R по ВСЕМ отмеченным
 *  ячейкам (именно тем T/R, что были в момент каждой отметки — так сохраняется
 *  100% RTP, см. разбор в config.js), а выплата идёт, только если ВСЕ отмеченные
 *  совпали с цветом ставки. Один-единственный промах среди отметок — и вся
 *  ставка сгорает целиком, сколько бы точных попаданий ни было до него. */
function evaluateBet(bet) {
  let fairMult = 1, allMatch = true;
  for (const p of bet.picks) {
    fairMult *= (p.T / p.R);
    if (!p.isMatch) allMatch = false;
  }
  return { fairMult, allMatch, depth: bet.picks.length };
}

function endRound() {
  phase = 'ended';
  for (const [tgId, bet] of bets) {
    if (bet.picks.length === 0) {
      sendToUser(tgId, { type: 'mines_player_result', nonce, result: 'no_picks', win: false });
      broadcastAll({ type: 'mines_bet_result', id: tgId, win: false });
      continue;
    }
    const { fairMult, allMatch, depth } = evaluateBet(bet);
    if (!allMatch) {
      sendToUser(tgId, { type: 'mines_player_result', nonce, result: 'miss', win: false, picks: bet.picks, depth });
      broadcastAll({ type: 'mines_bet_result', id: tgId, win: false });
      continue;
    }
    const cumMult = fairMult * roundRTP;
    const payout = Math.round(bet.amount * cumMult);
    const user = creditCoins(tgId, payout, { type: 'payout', payload: JSON.stringify({ round: nonce, mode: 'mines_shared' }) });
    const capped = depth >= maxPicksFor(bet.color);
    sendToUser(tgId, {
      type: 'mines_player_result', nonce, result: capped ? 'max_win' : 'win', win: true,
      payout, cumMult, balance: user.balance, picks: bet.picks, depth,
    });
    // Транслируем факт выигрыша всем — это то, что питает бегущую строку крупных
    // выигрышей за столом у остальных игроков (см. minesWinFeed на клиенте).
    broadcastAll({ type: 'mines_win_feed', by: tgId, who: bet.who, payout, cumMult, color: bet.color, golden: isGolden });
    // И отдельно — лёгкий сигнал "чья ставка сыграла" для списка ставок у всех
    // (галочка/крестик в UI), независимо от того, крупный это выигрыш или нет.
    broadcastAll({ type: 'mines_bet_result', id: tgId, win: true });
  }
  broadcastAll({ type: 'mines_round_end', nonce, revealedSeed: serverSeed, commitHash, board: board.map(c => c.color) });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(startBetting, 2500);
}

export function placeMinesBet(tgId, who, color, amountRaw) {
  if (phase !== 'bet') return { ok: false, error: 'betting_closed' };
  if (!COLORS.includes(color)) return { ok: false, error: 'invalid_color' };
  const amount = Math.round(Number(amountRaw));
  if (!Number.isFinite(amount) || amount < BET_MIN) return { ok: false, error: 'invalid_amount' };
  if (bets.has(tgId)) return { ok: false, error: 'already_bet' };

  const updated = debitForBet(tgId, amount, nonce, 'mines_shared');
  if (!updated) return { ok: false, error: 'insufficient_balance' };

  bets.set(tgId, {
    who: who || 'Игрок', color, amount, status: 'active', picks: [], pickedSet: new Set(),
    // Личный "остаток" шариков по цветам для ЭТОЙ ставки — раз ячейки больше не
    // эксклюзивны между игроками, у каждого своя независимая честная выборка
    // из одного и того же известного состава доски (18/1/17).
    remaining: { total: MINES_N, red: MINES_RED_COUNT, green: MINES_GREEN_COUNT, blue: MINES_BLUE_COUNT },
  });
  broadcastAll({ type: 'mines_bet_placed', nonce, id: tgId, who: who || 'Игрок', color, amount });
  return { ok: true, balance: updated.balance };
}

/** Отмена своей же ставки — доступна, только пока игрок ещё НЕ отметил ни одного
 *  шарика. Полный возврат суммы. */
export function cancelMinesBet(tgId) {
  if (phase !== 'bet') return { ok: false, error: 'betting_closed' };
  const bet = bets.get(tgId);
  if (!bet) return { ok: false, error: 'no_bet' };
  if (bet.picks.length > 0) return { ok: false, error: 'already_picked' };
  bets.delete(tgId);
  const user = creditCoins(tgId, bet.amount, { type: 'refund', payload: JSON.stringify({ round: nonce, mode: 'mines_shared' }) });
  broadcastAll({ type: 'mines_bet_cancelled', nonce, id: tgId });
  return { ok: true, balance: user.balance };
}

/** Игрок отмечает ячейку — БЕЗ немедленного раскрытия цвета (выбор номера, как
 *  в лото/кено). Ячейки НЕ эксклюзивны: разные игроки МОГУТ отметить один и тот
 *  же шарик — каждый честно проверяется по СВОЕЙ собственной цепочке T/R.
 *  Нельзя только повторно отметить ЭТУ ЖЕ ячейку самому себе. Приём отмечается
 *  всегда, пока не исчерпан личный лимит попыток (maxPicksFor) — сервер никогда
 *  не отказывает молча из-за скрытого промаха, чтобы отказ не был утечкой.
 *  Первые MINES_INTRO_MS каждого раунда — окно "сначала выбери цвет" на клиенте
 *  (надпись + отсчёт 3-2-1): отметки в это время сервер тоже не принимает, чтобы
 *  ни у кого — ни у ботов, ни у настоящих игроков — не создавалось впечатление,
 *  что шарики уже выбирают, пока остальные ещё только выбирают цвет. */
export function pickMinesCell(tgId, cellIndex) {
  if (phase !== 'bet') return { ok: false, error: 'not_pick_phase' };
  if (Date.now() - phaseStartedAt < MINES_INTRO_MS) return { ok: false, error: 'intro_lock' };
  const bet = bets.get(tgId);
  if (!bet) return { ok: false, error: 'no_bet' };
  const cap = maxPicksFor(bet.color);
  if (bet.picks.length >= cap) return { ok: false, error: 'depth_reached' };
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= MINES_N) return { ok: false, error: 'invalid_cell' };
  if (bet.pickedSet.has(cellIndex)) return { ok: false, error: 'already_picked_this_cell' };

  const cell = board[cellIndex];
  const T = bet.remaining.total;
  const R = bet.remaining[bet.color];
  const isMatch = cell.color === bet.color;
  bet.remaining.total--; bet.remaining[cell.color]--;
  bet.pickedSet.add(cellIndex);
  bet.picks.push({ cellIndex, color: cell.color, isMatch, T, R });
  totalPicksCount++;

  // Разным игрокам можно отмечать одни и те же шарики — трансляция чисто
  // информационная ("доска живая"), она НЕ блокирует клик ни для кого другого.
  broadcastAll({ type: 'mines_cell_picked', nonce, cellIndex, by: tgId, who: bet.who, claimedCount: totalPicksCount });
  return { ok: true, picksLeft: cap - bet.picks.length };
}

/** Игрок передумал насчёт КОНКРЕТНОГО шарика — повторный клик по уже своей же
 *  отмеченной ячейке снимает именно эту отметку (а не всю ставку целиком —
 *  для этого есть отдельная cancelMinesBet). Честно устроено математически:
 *  T/R остальных, уже сделанных отметок никак не меняются задним числом (они
 *  так и остаются зафиксированы на момент СВОЕГО клика), а личный "остаток"
 *  игрока просто откатывается назад — ровно так, как будто снятого шарика
 *  никогда не отмечали. Доказано отдельно (закон полного матожидания): EV
 *  остаётся в точности ставка×RTP при любом порядке отметок/отмен, поскольку
 *  цвет отменяемого шарика игроку всё равно никогда не показывается. Сам
 *  шарик при этом никуда не девается — его можно отметить заново (или другой)
 *  тем же кликом позже, в пределах того же раунда. */
export function unpickMinesCell(tgId, cellIndex) {
  if (phase !== 'bet') return { ok: false, error: 'not_pick_phase' };
  const bet = bets.get(tgId);
  if (!bet) return { ok: false, error: 'no_bet' };
  const idx = bet.picks.findIndex(p => p.cellIndex === cellIndex);
  if (idx === -1) return { ok: false, error: 'not_picked_by_you' };

  const [removed] = bet.picks.splice(idx, 1);
  bet.remaining.total++; bet.remaining[removed.color]++;
  bet.pickedSet.delete(cellIndex);

  const cap = maxPicksFor(bet.color);
  return { ok: true, picksLeft: cap - bet.picks.length };
}

/** Снимок текущего состояния раунда — для админ-панели ("Прямо сейчас"), без
 *  разглашения ничего лишнего (никаких приватных данных других игроков). */
export function getAdminLiveState() {
  let betsAmount = 0;
  for (const b of bets.values()) betsAmount += b.amount;
  return { phase, nonce, golden: isGolden, betsCount: bets.size, betsAmount };
}

export function startMinesLoop() {
  startBetting();
}
