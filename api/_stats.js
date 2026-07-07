//  РАСЧЁТ СТАТИСТИКИ И ПРИБЫЛИ (P&L) — чистая функция, без БД/сети.
//  Используется веткой list.js?stats=1. Файл с префиксом «_» Vercel НЕ считает
//  за отдельную serverless-функцию (как _crypto/_cors/_validation).
//
//  Прибыль — РЕАЛИЗОВАННАЯ по сматченным парам FIFO (как в грид-ботах Bybit/
//  BingX/Gainium/Phemex): каждая продажа закрывает самые ранние открытые
//  покупки, прибыль пары = (цена продажи − цена покупки) × объём. У покупки
//  PnL=0 (это «вход»). Стартовый инвентарь = один лот по цене старта —
//  несматченное матчим к стартовой цене (стандартный метод). Обмен (rebalance)
//  в статистику не входит, только задаёт стартовый объём CITRO и цену.
//  Комиссия берётся ФАКТОМ из сделки; если факта нет — по ставке из markets,
//  и лишь в крайнем случае — запасные 0.05% (см. feeOf / DEFAULT_COMMISSION).
//
//  ПРИМЕЧАНИЕ: это РЕАЛИЗОВАННАЯ (matched) прибыль — стандартная метрика грид-
//  ботов. Нереализованная прибыль по открытой позиции считается отдельно (можно
//  добавить позже). Цифру стоит сверить с фактом на боевом боте.
// Запасная ставка лимитной комиссии — ТОЛЬКО на крайний случай (не удалось взять
// ставку из markets И в сделке нет фактической комиссии). Боевые значения берём
// из markets (live) и из orders_history (факт). 0.0005 — последнее известное
// реальное значение для CITRO/USDT.
const DEFAULT_COMMISSION = 0.0005;
const PAIR = 'CITRO/USDT';
const TYPE_LABEL = { spot_grid: 'Spot Grid' };

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

// Комиссия сделки (в USDT). Приоритет — ФАКТ из записи (orders_history/ответ биржи);
// если фактической нет (старые записи) — оцениваем по ставке из markets на сторону.
function feeOf(t, rateBuy, rateSell) {
  if (t.fee != null && Number.isFinite(+t.fee)) return +t.fee;
  const rate = t.side === 'buy' ? rateBuy : rateSell;
  return rate * num(t.price) * num(t.amount);
}

// Нормализованный статус для UI (метку рисует клиент).
function botStatus(bot) {
  if (bot.deleted_at) return 'deleted';
  if (bot.status === 'active') return 'active';
  if (bot.status_message) return 'error';
  return 'inactive';
}

// Стартовый объём CITRO (q0) и цена-базис (p0) из депозита + обмена.
function deriveSeed(bot, rebalance, firstFillPrice) {
  const dep = (bot.config && bot.config.deposit) ? bot.config.deposit : {};
  let depCitro = 0;
  if (dep.mode === 'CITRO')      depCitro = num(dep.amount);
  else if (dep.mode === 'BOTH')  depCitro = num(dep.citro);
  // USDT-режим → депозитного CITRO нет (он докупается обменом)

  let q0 = depCitro;
  let p0 = firstFillPrice || 0;
  if (rebalance) {
    p0 = num(rebalance.price) || p0;
    const amt = num(rebalance.amount);
    if (rebalance.side === 'buy')       q0 = depCitro + amt;  // докупили CITRO
    else if (rebalance.side === 'sell') q0 = depCitro - amt;  // продали лишний CITRO
  }
  if (!(q0 > 0)) q0 = 0;
  if (!(p0 > 0)) p0 = firstFillPrice || 0;
  return { q0, p0 };
}

// bots — все боты пользователя (включая удалённых).
// allTrades — все их сделки (любой kind), порядок не важен (отсортируем сами).
function computeStats(bots, allTrades, opts = {}) {
  const rateBuy  = Number.isFinite(+opts.commissionBuy)  ? +opts.commissionBuy  : DEFAULT_COMMISSION;
  const rateSell = Number.isFinite(+opts.commissionSell) ? +opts.commissionSell : DEFAULT_COMMISSION;

  const fillsByBot = new Map();
  const rebByBot   = new Map();
  for (const t of (allTrades || [])) {
    if (t.kind === 'rebalance') {
      if (!rebByBot.has(t.bot_id)) rebByBot.set(t.bot_id, t); // обмен на старте
    } else if (t.kind === 'fill') {
      if (!fillsByBot.has(t.bot_id)) fillsByBot.set(t.bot_id, []);
      fillsByBot.get(t.bot_id).push(t);
    }
  }

  const botRows = [];
  const tradeRows = [];
  let sumPnl = 0, sumFees = 0, sumVol = 0, sumCount = 0;

  for (const bot of bots) {
    const fills = (fillsByBot.get(bot.id) || []).slice()
      .sort((a, b) => new Date(a.filled_at) - new Date(b.filled_at));
    const reb = rebByBot.get(bot.id) || null;
    const firstFillPrice = fills.length ? num(fills[0].price) : 0;
    const { q0, p0 } = deriveSeed(bot, reb, firstFillPrice);
    const typeLabel = TYPE_LABEL[bot.strategy] || bot.strategy || '—';

    // FIFO-очередь открытых покупок [{qty, price}]. Стартовый инвентарь —
    // один лот по цене старта (несматченное матчим к стартовой цене).
    const lots = [];
    if (q0 > 0) lots.push({ qty: q0, price: p0 });
    let bPnl = 0, bFees = 0, bVol = 0;

    for (const f of fills) {
      const price = num(f.price), amount = num(f.amount);
      const vol = amount * price;
      const fee = feeOf(f, rateBuy, rateSell);
      let pnl = 0;

      if (f.side === 'buy') {
        lots.push({ qty: amount, price });           // открыли позицию (вход)
      } else {                                       // продажа закрывает лоты FIFO
        let rem = amount;
        while (rem > 1e-9 && lots.length) {
          const lot = lots[0];
          const take = Math.min(rem, lot.qty);
          pnl += (price - lot.price) * take;         // прибыль пары: продал − купил
          lot.qty -= take; rem -= take;
          if (lot.qty <= 1e-9) lots.shift();
        }
        // если продали больше, чем открыто (rem>0) — у излишка нет базиса (PnL=0)
      }

      const net = pnl - fee;
      bPnl += pnl; bFees += fee; bVol += vol;
      tradeRows.push({
        id: f.exchange_order_id || null,
        botId: bot.id, botName: bot.name, type: typeLabel, pair: PAIR,
        side: f.side, pnl, fee, net, volume: vol, executedAt: f.filled_at,
      });
    }

    botRows.push({
      id: bot.id, name: bot.name, type: typeLabel, pair: PAIR,
      pnl: bPnl, fees: bFees, net: bPnl - bFees, volume: bVol,
      trades: fills.length, status: botStatus(bot),
    });
    sumPnl += bPnl; sumFees += bFees; sumVol += bVol; sumCount += fills.length;
  }

  tradeRows.sort((a, b) => new Date(b.executedAt) - new Date(a.executedAt)); // новые сверху

  return {
    summary: { pnl: sumPnl, fees: sumFees, net: sumPnl - sumFees, volume: sumVol, trades: sumCount },
    bots: botRows,
    trades: tradeRows,
  };
}

// Наружу отдаём только computeStats (нужен list.js). Остальное
// (botStatus/feeOf/deriveSeed/PAIR/DEFAULT_COMMISSION) — внутренние детали расчёта.
module.exports = { computeStats };
