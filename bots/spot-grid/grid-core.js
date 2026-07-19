//  GRID-CORE — чистая математика спот-грид сетки.
//  ЕДИНЫЙ источник правды: используется и предпросмотром в браузере
//  (spot-grid.js), и торговым движком воркера в Node.
//  Никакого DOM и сети — только вход аргументами, выход значением.
//
//  Файл работает в обоих окружениях:
//    • браузер: <script src="grid-core.js"> → глобальный объект GridCore
//    • Node:    const GridCore = require('./grid-core')
;(function (root) {
  'use strict';

  // Биржевые параметры CITRO/USDT (из метода markets). Здесь — значения-дефолты
  // для предпросмотра в UI; воркер при запуске подставляет свежие из markets.
  // ВНИМАНИЕ: серверное зеркало этих ограничений — api/_validation.js (GRID).
  // Правило Vercel «api/ не импортирует из bots/» не даёт свести их в один модуль,
  // поэтому при изменении держите оба места в синхроне.
  var MARKET = {
    minOrderQty:   1,        // минимум базовой валюты (CITRO) в ордере
    minOrderAmt:   0.1,      // минимум стоимости ордера (USDT)
    citroDecimals: 2,        // trade_base_precision — знаков в количестве CITRO
    usdtDecimals:  6,        // trade_quote_precision — знаков в сумме USDT
    priceTick:     0.00001,  // шаг цены
  };

  // Лёгкий «хайркат» объёма (0.1% > комиссии 0.05%): на бирже выставляем чуть
  // меньше расчётного q — комиссия удерживается из ПОЛУЧЕННОГО актива, поэтому
  // после обмена на руках чуть меньше номинала. Держим хайркат ЗДЕСЬ (в общем
  // модуле), чтобы таблица ордеров в UI и движок воркера показывали/ставили
  // РОВНО одно и то же число.
  var QTY_HAIRCUT = 0.001;

  // Пользовательские лимиты формы Spot Grid — ЕДИНЫЙ источник для браузера
  // (spot-grid.js) и воркера. Серверное зеркало — api/_validation.js (GRID):
  // импортировать grid-core туда нельзя (правило сборки Vercel: api/ ↛ bots/),
  // поэтому при изменении держите оба места в синхроне.
  var LIMITS = {
    GRID_COUNT_MIN:    2,
    GRID_COUNT_MAX:    100,
    MIN_USDT_PER_GRID: 1,       // минимум стоимости одного ордера, USDT
    MAX_USDT_PER_GRID: 10000,   // максимум стоимости одного ордера, USDT
    MIN_STEP_PCT:      0.01,    // минимальный шаг сетки — 1% текущей цены
  };

  // Усечение (отбрасывание) до d знаков без округления — как принято в проекте
  function truncate(n, d) {
    var f = Math.pow(10, d);
    return Math.floor(n * f) / f;
  }

  // [price, size] из API → {price, size}; мусор отбраковывается
  function parseLevel(pair) {
    var price = parseFloat(pair[0]);
    var size  = parseFloat(pair[1]);
    if (isNaN(price) || isNaN(size)) return null;
    return { price: price, size: size };
  }

  // Уровни сетки + ближайший к цене уровень
  // Возвращает { levels, closestIdx, count } либо null, если данные некорректны.
  function computeGridLevels(low, high, count, price) {
    if (!(price > 0)) return null;
    if (!(low > 0) || !(high > low)) return null;
    if (!Number.isInteger(count) || count < LIMITS.GRID_COUNT_MIN || count > LIMITS.GRID_COUNT_MAX) return null;

    var step = (high - low) / count;
    // Кол-во знаков в шаге — чтобы избежать 0.10000000000000001
    var stepDecimals = (step.toString().split('.')[1] || '').length;
    var precision    = Math.min(stepDecimals + 1, 8);

    var levels = [];
    for (var i = 0; i <= count; i++) {
      levels.push(parseFloat((low + i * step).toFixed(precision)));
    }

    var closestIdx = 0;
    var closestDist = Math.abs(levels[0] - price);
    for (var j = 1; j < levels.length; j++) {
      var d = Math.abs(levels[j] - price);
      if (d < closestDist) { closestDist = d; closestIdx = j; }
    }

    return { levels: levels, closestIdx: closestIdx, count: count };
  }

  // Конвертация по ордербуку (проходим уровни от лучшей цены)

  // CITRO → USDT: продаём CITRO, проходя биды сверху вниз
  function convertCitroToUsdt(citro, bids) {
    var remaining = citro, usdt = 0;
    for (var i = 0; i < bids.length; i++) {
      var lvl = bids[i];
      if (remaining <= 0) break;
      if (remaining >= lvl.size) { usdt += lvl.size * lvl.price; remaining -= lvl.size; }
      else { usdt += remaining * lvl.price; remaining = 0; }
    }
    return usdt;
  }

  // Сколько USDT нужно, чтобы КУПИТЬ citro CITRO, проходя аски снизу вверх
  // (проход по стакану — согласованно с тем, как реально исполнится обмен).
  function usdtToBuyCitro(citro, asks) {
    var remaining = citro, usdt = 0;
    for (var i = 0; i < asks.length; i++) {
      var lvl = asks[i];
      if (remaining <= 0) break;
      if (remaining >= lvl.size) { usdt += lvl.size * lvl.price; remaining -= lvl.size; }
      else { usdt += remaining * lvl.price; remaining = 0; }
    }
    return usdt;
  }

  // Слишком ли мал обмен, чтобы биржа его исполнила (ниже минимального ордера).
  // Такой обмен не выставляем — и в UI не показываем блок обмена.
  function isConversionTooSmall(conv) {
    if (!conv) return true;
    var fromCitro = conv.from.t === 'CITRO';
    var citroAmt  = fromCitro ? conv.from.amt : conv.to.amt;
    var usdtAmt   = fromCitro ? conv.to.amt   : conv.from.amt;
    return citroAmt < MARKET.minOrderQty || usdtAmt < MARKET.minOrderAmt;
  }

  // Главная функция: план сетки по конфигу, стакану и текущей цене
  //   config = { deposit:{mode, amount | usdt+citro}, priceLow, priceHigh, gridCount }
  //   ob     = стакан { a:[[price,size]...], b:[[price,size]...] }
  //   price  = текущая цена (last_price)
  //
  // ЕДИНАЯ МОДЕЛЬ: каждый уровень торгует ФИКСИРОВАННЫЙ объём CITRO `q`.
  // q подбираем ПО СТАКАНУ (а не по последней цене), чтобы обмен дал ровно
  // столько CITRO/USDT, сколько нужно сетке — тогда план и обмен сходятся, и
  // ордера фундируемы. Один и тот же капитал (в любой валюте) даёт один план.
  // Если обмен слишком мал для биржи — депозит уже сбалансирован, берём q
  // по факту имеющегося (без обмена).
  //
  // Возвращает { orders, conversion }. У каждого ордера: qty (CITRO, без
  // округления — для движка) и from/to (усечённые — для отображения в UI).
  function computeGridPlan(config, ob, price) {
    var grid = computeGridLevels(config.priceLow, config.priceHigh, config.gridCount, price);
    if (!grid) return { orders: [], conversion: null };

    var levels = grid.levels, closestIdx = grid.closestIdx, count = grid.count;
    var numSells = count - closestIdx; // уровни выше — продажи
    var numBuys  = closestIdx;         // уровни ниже — покупки

    // Сумма цен уровней покупки (стоимость покупок = q × sumBuyPrices)
    var sumBuyPrices = 0;
    for (var i = 0; i < closestIdx; i++) sumBuyPrices += levels[i];

    // Что есть на руках по депозиту
    var dep = config.deposit || {};
    var haveUSDT = 0, haveCITRO = 0;
    if (dep.mode === 'USDT')       haveUSDT  = dep.amount || 0;
    else if (dep.mode === 'CITRO') haveCITRO = dep.amount || 0;
    else { haveUSDT = dep.usdt || 0; haveCITRO = dep.citro || 0; }

    var V = haveUSDT + haveCITRO * price;          // стоимость депозита в USDT
    if (!(V > 0)) return { orders: [], conversion: null };

    var asks = (ob.a || []).map(parseLevel).filter(Boolean).sort(function (a, b) { return a.price - b.price; });
    var bids = (ob.b || []).map(parseLevel).filter(Boolean).sort(function (a, b) { return b.price - a.price; });

    // Сколько USDT останется на покупки при объёме q, если докупить/продать
    // недостающее/лишнее CITRO ПО СТАКАНУ (обмен считаем так же, как он реально пройдёт).
    function usdtForBuysAt(q) {
      var citroDelta = q * numSells - haveCITRO;     // >0: докупаем CITRO; <0: продаём излишек
      if (citroDelta >= 0) return haveUSDT - usdtToBuyCitro(citroDelta, asks);
      return haveUSDT + convertCitroToUsdt(-citroDelta, bids);
    }

    // Подбираем q: usdtForBuysAt(q) == q×sumBuyPrices. Функция убывает по q → бинпоиск.
    // Верхняя граница — оценка по последней цене (истинное q не больше из-за спреда).
    var hiByLast = (sumBuyPrices + numSells * price) > 0 ? V / (sumBuyPrices + numSells * price) : 0;
    var hi = hiByLast > 0 ? hiByLast * 1.05
                          : (haveCITRO + (asks.length ? V / asks[0].price : 0)) / Math.max(numSells, 1);
    var lo = 0, q = 0;
    for (var it = 0; it < 60; it++) {
      var mid = (lo + hi) / 2;
      if (usdtForBuysAt(mid) >= mid * sumBuyPrices) { lo = mid; q = mid; }
      else hi = mid;
    }

    // Обмен по найденному q (ровно столько, сколько нужно сетке)
    var conversion = null;
    var citroDelta = q * numSells - haveCITRO;
    if (citroDelta > 0) {
      conversion = { from: { amt: usdtToBuyCitro(citroDelta, asks), t: 'USDT' }, to: { amt: citroDelta, t: 'CITRO' } };
    } else if (citroDelta < 0) {
      var sellAmt = -citroDelta;
      conversion = { from: { amt: sellAmt, t: 'CITRO' }, to: { amt: convertCitroToUsdt(sellAmt, bids), t: 'USDT' } };
    }

    // Слишком малый обмен биржа не исполнит → депозит уже почти сбалансирован:
    // берём q по факту имеющегося (без обмена), останется пыль.
    if (isConversionTooSmall(conversion)) {
      conversion = null;
      var qFromCitro = numSells > 0 ? haveCITRO / numSells : Infinity;
      var qFromUsdt  = sumBuyPrices > 0 ? haveUSDT / sumBuyPrices : Infinity;
      var qNoConv    = Math.min(qFromCitro, qFromUsdt);
      if (qNoConv < q) q = qNoConv;
    }

    // ФИНАЛЬНЫЙ объём ордера: «чистое» q минус хайркат, усечённое до точности
    // базовой валюты. Именно qFinal и выставляется на бирже, и показывается в
    // таблице — поэтому отображение и факт совпадают. (Обмен выше считается по
    // полному q, чтобы хватило на сетку; неиспользованная пыль ~0.1% остаётся.)
    var qFinal = truncate(q * (1 - QTY_HAIRCUT), MARKET.citroDecimals);

    // Ордера сверху вниз: продажи (по убыванию цены), затем покупки.
    var orders = [];
    for (var s = count; s > closestIdx; s--) {
      var sp = levels[s];
      orders.push({ type: 'sell', levelIndex: s, price: sp, qty: qFinal,
        from: { amt: qFinal, t: 'CITRO' }, to: { amt: truncate(qFinal * sp, 2), t: 'USDT' } });
    }
    for (var b2 = closestIdx - 1; b2 >= 0; b2--) {
      var bp = levels[b2];
      orders.push({ type: 'buy', levelIndex: b2, price: bp, qty: qFinal,
        from: { amt: truncate(qFinal * bp, 2), t: 'USDT' }, to: { amt: qFinal, t: 'CITRO' } });
    }

    return { orders: orders, conversion: conversion };
  }

  var api = {
    LIMITS: LIMITS,
    truncate: truncate,
    parseLevel: parseLevel,
    computeGridLevels: computeGridLevels,
    computeGridPlan: computeGridPlan,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GridCore = api;

})(typeof self !== 'undefined' ? self : this);
