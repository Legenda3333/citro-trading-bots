//  ДВИЖОК БОТА — расчёт плана запуска.
//  Использует общий модуль grid-core (тот же, что и предпросмотр в UI),
//  применяет точность/минимумы биржи и проверяет средства и лимит ордеров.
//
//  planStart() ТОЛЬКО СЧИТАЕТ И ПРОВЕРЯЕТ — ничего не выставляет; реальное
//  размещение ордеров (create_order) делает runner.reconcileBot.
const GridCore = require('../bots/spot-grid/grid-core.js');
const { ORDER_LIMIT } = require('../api/_exchange'); // единый источник лимита ордеров

// Округление ВНИЗ (отбрасывание) — для объёмов, чтобы не превысить баланс.
function floorTo(n, d) { const f = Math.pow(10, d); return Math.floor(n * f) / f; }
// Обычное округление — для цены к шагу биржи.
function roundTo(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }

// Допуск на дробную погрешность при сравнении баланса (НЕ «запас»):
// бот использует ровно сумму депозита, поэтому 100% баланса должно проходить.
const FUND_EPS = 1e-8;

// Считает план запуска бота и все проверки. НИЧЕГО не выставляет.
// Возвращает { canPlace, reason, conversion, orders, checks }.
function planStart(bot, ctx) {
  const { market, ob, price, balance, openOrdersCount } = ctx;
  const cfg = bot.config || {};

  // Точность/минимумы из markets (с разумными значениями по умолчанию)
  const baseDec  = Number.isInteger(market.trade_base_precision) ? market.trade_base_precision : 2;
  const priceDec = (String(market.quote_tick_size).split('.')[1] || '').length || 5;
  const minQty   = parseFloat(market.min_order_qty) || 1;    // мин. CITRO в ордере
  const minAmt   = parseFloat(market.min_order_amt) || 0.1;  // мин. стоимость в USDT

  // План из общего модуля (та же математика, что в «Таблице ордеров» UI)
  const plan = GridCore.computeGridPlan(cfg, ob, price);
  if (!plan.orders || plan.orders.length === 0) {
    return { canPlace: false, reason: 'план пуст (некорректная конфигурация или нет цены)',
             conversion: null, orders: [], checks: {} };
  }

  // Готовим ордера к формату биржи: цену — на шаг, объём — вниз до baseDec.
  // Хайркат уже учтён в grid-core (o.qty — финальный объём), поэтому здесь его
  // НЕ применяем повторно: и таблица в UI, и движок ставят одно и то же число.
  const orders = plan.orders.map(o => {
    const p     = roundTo(o.price, priceDec);
    const qty   = floorTo(o.qty, baseDec);
    const quote = floorTo(qty * p, 6);
    return { side: o.type, levelIndex: o.levelIndex, price: p, qty, quote,
             belowMin: (qty < minQty || quote < minAmt) };
  });

  // Проверка средств: на счёте должен быть депозит в указанной валюте
  let needUSDT = 0, needCITRO = 0;
  if (cfg.deposit.mode === 'USDT')       needUSDT  = cfg.deposit.amount;
  else if (cfg.deposit.mode === 'CITRO') needCITRO = cfg.deposit.amount;
  else { needUSDT = cfg.deposit.usdt; needCITRO = cfg.deposit.citro; }

  const fundsOk = balance.USDT + FUND_EPS >= needUSDT &&
                  balance.CITRO + FUND_EPS >= needCITRO;

  // Лимит открытых ордеров на аккаунте (общий; ORDER_LIMIT из api/_exchange)
  const gridCount  = orders.length;
  const totalAfter = openOrdersCount + gridCount;
  const limitOk    = totalAfter <= ORDER_LIMIT;

  // Все ли ордера проходят минимум биржи
  const anyBelowMin = orders.some(o => o.belowMin);

  // ПРИМЕЧАНИЕ: проскальзывание стартового обмена НЕ блокирует запуск. Для
  // CITRO/USDT спред 5–10% — норма, обмен должен выполняться в любом случае.
  // Объёмы grid-core считает проходом по стакану (реальные цены с учётом спреда),
  // поэтому сетка сфондирована корректно; остаточный риск покрывают идемпотентный
  // обмен (не повторится) и остановка бота, если часть ордеров так и не встанет.
  const canPlace = fundsOk && limitOk && !anyBelowMin;
  let reason = '';
  if (!fundsOk)         reason = `недостаточно средств (нужно ${needUSDT} USDT + ${needCITRO} CITRO, есть ${balance.USDT} USDT + ${balance.CITRO} CITRO)`;
  else if (!limitOk)    reason = `лимит ордеров: ${openOrdersCount} открыто + ${gridCount} новых = ${totalAfter} > ${ORDER_LIMIT}`;
  else if (anyBelowMin) reason = `есть ордера ниже минимума биржи (${minQty} CITRO / ${minAmt} USDT)`;

  return {
    canPlace, reason,
    conversion: plan.conversion,
    orders,
    checks: { needUSDT, needCITRO, fundsOk, openOrdersCount, gridCount, totalAfter, limitOk, anyBelowMin,
              baseDec, priceDec, minQty, minAmt }
  };
}

module.exports = { planStart, floorTo, roundTo };
