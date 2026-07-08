//  РАСЧЁТ СТАТИСТИКИ И ПРИБЫЛИ (P&L) — чистая функция, без БД/сети.
//  Используется веткой list.js?stats=1. Файл с префиксом «_» Vercel НЕ считает
//  за отдельную serverless-функцию (как _crypto/_cors/_validation).
//
//  Модель прибыли — «шаг сетки на продажу»:
//    • каждая ПРОДАЖА CITRO даёт прибыль = проданный объём × шаг сетки (CITRO
//      продан на уровень выше, встречная покупка встаёт уровнем ниже — разница
//      цен уровней и есть прибыль сетки на этот объём);
//    • ПОКУПКА прибыли не приносит (PnL = 0): её объём будет продан позже;
//    • стартовый обмен валюты (kind='rebalance') в статистику НЕ входит — это
//      условие запуска бота, а не результат его работы.
//  Шаг сетки = (верхняя граница − нижняя) / число сеток (из config бота).
//  Комиссия берётся ФАКТОМ из сделки (уже в USDT); если факта нет — по ставке из
//  markets, и лишь в крайнем случае — запасные 0.05% (см. feeOf / DEFAULT_COMMISSION).
const DEFAULT_COMMISSION = 0.0005;
const PAIR = 'CITRO/USDT';
const TYPE_LABEL = { spot_grid: 'Spot Grid' };

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

// Комиссия сделки (в USDT). Приоритет — ФАКТ из записи (её воркер уже приводит к
// USDT). Если факта нет (старые записи) — оцениваем по ставке из markets на сторону.
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

// Шаг сетки в USDT: (верхняя граница − нижняя) / число сеток. 0 — если конфиг неполон.
function gridStep(bot) {
  const cfg = bot.config || {};
  const low = num(cfg.priceLow), high = num(cfg.priceHigh), count = num(cfg.gridCount);
  return (high > low && count > 0) ? (high - low) / count : 0;
}

// bots — все боты пользователя (включая удалённых).
// allTrades — все их сделки (порядок не важен, отсортируем сами).
function computeStats(bots, allTrades, opts = {}) {
  const rateBuy  = Number.isFinite(+opts.commissionBuy)  ? +opts.commissionBuy  : DEFAULT_COMMISSION;
  const rateSell = Number.isFinite(+opts.commissionSell) ? +opts.commissionSell : DEFAULT_COMMISSION;

  // Только фактические исполнения сетки. Стартовый обмен (rebalance) — мимо.
  const fillsByBot = new Map();
  for (const t of (allTrades || [])) {
    if (t.kind !== 'fill') continue;
    if (!fillsByBot.has(t.bot_id)) fillsByBot.set(t.bot_id, []);
    fillsByBot.get(t.bot_id).push(t);
  }

  const botRows = [];
  const tradeRows = [];
  let sumPnl = 0, sumFees = 0, sumVol = 0, sumCount = 0;

  for (const bot of bots) {
    const fills = fillsByBot.get(bot.id) || [];
    const typeLabel = TYPE_LABEL[bot.strategy] || bot.strategy || '—';
    const step = gridStep(bot);

    let bPnl = 0, bFees = 0, bVol = 0;
    for (const f of fills) {
      const price = num(f.price), amount = num(f.amount);
      const vol = amount * price;
      const fee = feeOf(f, rateBuy, rateSell);
      // Прибыль сетки: продажа → проданный объём × шаг; покупка → 0.
      const pnl = f.side === 'sell' ? amount * step : 0;
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

module.exports = { computeStats };
