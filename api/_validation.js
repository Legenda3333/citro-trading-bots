//  СЕРВЕРНАЯ ВАЛИДАЦИЯ — зеркало клиентских правил + потолки длины.
//  Единый источник истины для бэкенда. Клиентская валидация — это UX,
//  серверная — защита: UI обходится прямым POST.
//
//  Файл с префиксом «_» Vercel не превращает в эндпоинт,
//  но он доступен другим функциям через require().

// Грубый потолок длины — чтобы не гонять regex/bcrypt по гигантской строке.
const ABSOLUTE_MAX = 1024;

const PATTERNS = {
  login:     /^[a-zA-Z0-9]{4,30}$/,
  password:  /^[\x21-\x7E]{8,32}$/,
  name:      /^[^\x00-\x1F\x7F]{1,32}$/,   // любые печатаемые, без управляющих, 1..32
  apiKey:    /^[A-Za-z0-9-]{1,128}$/,
  apiSecret: /^[A-Za-z0-9]{1,128}$/,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Приводит значение к строке (или '' для не-строк) — защита от объектов/массивов.
function str(v) {
  return typeof v === 'string' ? v : '';
}

// true, если строка явно слишком длинная (до regex/bcrypt).
function tooLong(v) {
  return str(v).length > ABSOLUTE_MAX;
}

function isUuid(v) {
  return UUID_RE.test(str(v));
}


//  SPOT GRID — серверное зеркало бизнес-правил формы бота.
//  Те же значения, что в bots/spot-grid/grid-core.js (GridCore.LIMITS),
//  чтобы прямой POST в обход UI не создал невалидного бота. Импортировать
//  grid-core сюда нельзя (правило сборки Vercel: api/ ↛ bots/) — держим синхронно.

// Лимиты на одну сетку (ордер) и на сетку в целом
const GRID = {
  MIN_USDT_PER_GRID: 1,        // минимум стоимости одного ордера, USDT
  MAX_USDT_PER_GRID: 10000,    // максимум стоимости одного ордера, USDT
  MIN_STEP_PCT:      0.02,     // шаг сетки ≥ 2% текущей цены
  COUNT_MIN:         2,
  COUNT_MAX:         100,
  PRICE_TICK:        0.00001,  // шаг цены биржи (CITRO/USDT): уровни не должны совпасть после округления
};

// Допуск к ценозависимым границам. Цена тикера на сервере может чуть
// отличаться от той, по которой форму проверял клиент; без допуска депозит
// у самой границы мог бы получить отказ сервера. 5% поглощают дрожь цены.
const GRID_TOLERANCE = 0.05;

// Конечное число (не NaN/Infinity и именно number, а не строка)
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Проверка конфигурации Spot Grid бота.
//   config — { deposit:{mode, amount | usdt+citro}, priceLow, priceHigh, gridCount }
//   price  — последняя цена с биржи (нужна для конвертации CITRO→USDT и шага)
// Возвращает { ok:true, config:<нормализованный> } либо { ok:false, error }.
function validateSpotGridConfig(config, price) {
  if (!config || typeof config !== 'object') {
    return { ok: false, error: 'Некорректные параметры бота' };
  }

  const { deposit, priceLow, priceHigh, gridCount } = config;

  // Депозит
  if (!deposit || typeof deposit !== 'object') {
    return { ok: false, error: 'Некорректный депозит' };
  }
  const mode = deposit.mode;
  if (mode !== 'USDT' && mode !== 'CITRO' && mode !== 'BOTH') {
    return { ok: false, error: 'Некорректная валюта депозита' };
  }

  let depUsdt = 0, depCitro = 0, depAmount = 0;
  if (mode === 'BOTH') {
    depUsdt  = deposit.usdt;
    depCitro = deposit.citro;
    if (!isFiniteNumber(depUsdt) || !isFiniteNumber(depCitro) || depUsdt <= 0 || depCitro <= 0) {
      return { ok: false, error: 'Сумма депозита должна быть больше нуля' };
    }
  } else {
    depAmount = deposit.amount;
    if (!isFiniteNumber(depAmount) || depAmount <= 0) {
      return { ok: false, error: 'Сумма депозита должна быть больше нуля' };
    }
  }

  // Ценовой диапазон
  if (!isFiniteNumber(priceLow) || !isFiniteNumber(priceHigh) || priceLow <= 0) {
    return { ok: false, error: 'Некорректные границы диапазона' };
  }
  if (priceHigh <= priceLow) {
    return { ok: false, error: 'Верхняя граница должна быть больше нижней' };
  }

  // Количество сеток
  if (!Number.isInteger(gridCount) || gridCount < GRID.COUNT_MIN || gridCount > GRID.COUNT_MAX) {
    return { ok: false, error: `Количество сеток: целое число от ${GRID.COUNT_MIN} до ${GRID.COUNT_MAX}` };
  }

  // Ценозависимые проверки
  if (!isFiniteNumber(price) || price <= 0) {
    return { ok: false, error: 'Не удалось получить текущую цену для проверки' };
  }

  // Стоимость депозита в USDT (CITRO считаем по последней цене — как на клиенте)
  let totalUSDT;
  if (mode === 'USDT')       totalUSDT = depAmount;
  else if (mode === 'CITRO') totalUSDT = depAmount * price;
  else                       totalUSDT = depUsdt + depCitro * price;

  const perGrid    = totalUSDT / gridCount;
  const minPerGrid = GRID.MIN_USDT_PER_GRID * (1 - GRID_TOLERANCE);
  const maxPerGrid = GRID.MAX_USDT_PER_GRID * (1 + GRID_TOLERANCE);
  if (perGrid < minPerGrid) {
    return { ok: false, error: 'Сумма депозита меньше минимально допустимой' };
  }
  if (perGrid > maxPerGrid) {
    return { ok: false, error: 'Сумма депозита превышает максимально допустимую' };
  }

  // Минимальный шаг сетки ≥ 2% цены (защита от вырожденной сетки)
  const step = (priceHigh - priceLow) / gridCount;
  if (step < price * GRID.MIN_STEP_PCT * (1 - GRID_TOLERANCE)) {
    return { ok: false, error: 'Слишком маленький шаг сетки' };
  }

  // Шаг сетки не должен быть меньше шага цены биржи: иначе два соседних уровня
  // при округлении к шагу цены дадут одну и ту же биржевую цену (два ордера на
  // одной цене). Практически бьёт только по вырожденной сетке при очень низкой цене.
  if (step < GRID.PRICE_TICK) {
    return { ok: false, error: 'Слишком маленький шаг сетки' };
  }

  // Нормализованный config — в БД кладём только проверенные поля
  const normalized = {
    deposit: mode === 'BOTH'
      ? { mode, usdt: depUsdt, citro: depCitro }
      : { mode, amount: depAmount },
    priceLow,
    priceHigh,
    gridCount,
  };
  return { ok: true, config: normalized };
}

module.exports = { PATTERNS, ABSOLUTE_MAX, str, tooLong, isUuid, GRID, validateSpotGridConfig };
