const API_URL = 'https://api.citronus.com/public/v1/jsonrpc';

// Номер JSON-RPC запроса — У КАЖДОГО СВОЙ. Citronus дедуплицирует по паре (id + тело):
// тот же id с тем же телом — запрос не выполняется, возвращается сохранённый ответ.
// С постоянными номерами график, стакан и цена показывали устаревшие данные.
let _rpcSeq = 0;
function nextRpcId() { return `${Date.now().toString(36)}-${(++_rpcSeq).toString(36)}`; }

// Общая математика сетки — из grid-core.js (единый источник, тот же код в воркере).
const { truncate, parseLevel } = GridCore;

// Лимиты формы Spot Grid — из того же общего модуля (единый источник значений).
const { GRID_COUNT_MIN, GRID_COUNT_MAX, MIN_USDT_PER_GRID, MAX_USDT_PER_GRID, MIN_STEP_PCT } = GridCore.LIMITS;

// Соответствие текст вкладки → код интервала в API
const INTERVAL_MAP = {
  '15м': '15m',
  '1ч':  '1h',
  '4ч':  '4h',
  '1Д':  '1D',
};

// Длительность каждого интервала в секундах (для отслеживания закрытия свечи)
const INTERVAL_SECONDS = {
  '15m':   15 * 60,
  '1h':    60 * 60,
  '4h':  4 * 60 * 60,
  '1D': 24 * 60 * 60,
};

const POLL_MS = 3000; // опрашиваем API каждые 3 секунды,

// Глобальные ссылки
let chart        = null;
let candleSeries = null;
let pollingTimer = null;

// Версия запроса графика — защита от гонки при быстрой смене таймфрейма
let chartRequestId = 0;

let currentInterval = '1h';

// Данные последней свечи — нужны для live-обновления текущей незакрытой свечи
let lastCandleTime = null;
let lastCandleOpen = null;
let lastCandleHigh = null;
let lastCandleLow  = null;

// Текущая цена токена (обновляется из тикера)
let currentPrice = null;

// Синяя горизонтальная линия текущей цены на графике
let currentPriceLine = null;

// Массив объектов PriceLine — линии сетки ордеров на графике
let gridPriceLines = [];

// Индекс уровня сетки, ближайшего к цене на момент последней отрисовки линий
// (null — линии не нарисованы). Сравнивая с актуальным значением на каждом
// тике цены, ловим момент «цена пересекла уровень сетки» — от ближайшего
// уровня зависят раскраска линий, разбивка buy/sell и инфо-блок обмена.
let lastClosestIdx = null;

// id выбранного API-ключа (нужен для кнопки обновления баланса)
let currentKeyId = null;

// Имена уже созданных ботов пользователя — для живой проверки уникальности
// имени (дубликат подсвечивается под полем сразу при вводе). Наполняется в
// loadExistingBotNames(); сервер остаётся источником истины при создании.
let existingBotNames = new Set();

// Список ботов пользователя (для предупреждения о втором боте на том же ключе).
// Наполняется в loadExistingBotNames() из кэша и затем с сервера.
let userBots = [];

// Режим редактирования: null — создание нового бота, объект — правка существующего.
// Заполняется в setupEditMode() по параметру ?edit=<botId>.
let editingBot = null;

// Время последнего запроса баланса — ограничиваем 1 запрос в 3 секунды
let lastBalanceFetch = 0;

// Версия запроса баланса — защита от гонки при быстрой смене API-ключа
let balanceRequestId = 0;

// Доступный баланс пользователя (обновляется при fetchBalance)
let balanceUSDT  = 0;
let balanceCITRO = 0;
let balanceLoaded = false; // true после первой успешной загрузки

// Текущая выбранная валюта депозита
let currentDepositToken = 'USDT';

// Таймер дебаунса проверки лимитов депозита
let minDepositTimer = null;

// Проверку минимума депозита считаем по последней цене (без стакана): наш минимум
// 1 USDT/сетка даёт запас ~×10 к биржевому ~0.1 USDT, поэтому упрощение безопасно.
// Сами значения лимитов — в GridCore.LIMITS (деструктуризация вверху файла).

// Уникальный префикс нашего сообщения — чтобы не затирать чужие ошибки в поле
const MIN_ERR_PREFIX = 'При заданном количестве сеток';


// ТОЧКА ВХОДА
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  setupIntervalTabs();
  setupViewTabs();         // переключатель график / стакан / таблица
  fetchTicker();
  fetchAndRender('1h');
  setupApiKeyDropdown();   // кастомный список API-ключей
  setupDepositDropdown();  // кастомный список валюты депозита
  setupValidation();       // валидация числовых полей
  setupDropdownClose();    // закрывать дропдауны по клику снаружи
  setupGridLines();        // отрисовка сетки ордеров на графике
  setupSmartTooltips();    // умное позиционирование тултипов
  setupBalanceRefresh();   // кнопка обновления баланса
  setupGridTable();        // пересчёт таблицы ордеров при изменении полей
  setupConfirmModal();     // модал подтверждения создания бота
  setupEditMode();         // режим редактирования по ?edit=<botId>
  loadExistingBotNames();  // живая проверка уникальности имени бота
  setupFieldA11y();        // авто-aria-invalid по aria-describedby
  setupVisibilityPause();  // пауза опросов биржи, когда вкладка в фоне
});


// ИНИЦИАЛИЗАЦИЯ ГРАФИКА (один раз)
function initChart() {
  const container = document.getElementById('chart');

  chart = LightweightCharts.createChart(container, {
    autoSize: true,
    layout: {
      background: { color: '#111927' },
      textColor:  '#6b7280',
      fontSize:   11,
    },
    grid: {
      vertLines: { color: '#1e2d40' },
      horzLines: { color: '#1e2d40' },
    },
    crosshair: {
      // Normal = перекрестье следует за курсором мыши, а не магнитится к свече
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#00d4ff', labelBackgroundColor: '#161c27' },
      horzLine: { color: '#00d4ff', labelBackgroundColor: '#161c27' },
    },
    timeScale: {
      borderColor:    '#1e2d40',
      timeVisible:    true,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: '#1e2d40',
    },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor:         '#22c55e',
    downColor:       '#ef4444',
    borderUpColor:   '#22c55e',
    borderDownColor: '#ef4444',
    wickUpColor:     '#22c55e',
    wickDownColor:   '#ef4444',

    // Отключаем встроенную метку последней цены на шкале Y:
    // она дублировала бы нашу синюю линию currentPriceLine
    lastValueVisible: false,

    // Динамическая шкала Y: минимальный шаг 0.00001,
    // при зуме деления автоматически укрупняются / уменьшаются
    priceFormat: {
      type:     'price',
      precision: 5,
      minMove:   0.00001,
    },
  });

  setupCrosshairMarker();
}


// МАРКЕР "+" НА ПЕРЕКРЕСТЬЕ
//
// Позиция берётся из param.point события subscribeCrosshairMove —
// это те же координаты, которые библиотека использует для отрисовки
// самого перекрестья, поэтому совпадение гарантировано.
//
// param.point === null означает мышь над шкалой цены или времени —
// там маркер прячем и возвращаем стандартный курсор браузера.
function setupCrosshairMarker() {
  const marker  = document.getElementById('crosshair-marker');
  const chartEl = document.getElementById('chart');
  if (!marker || !chartEl || !chart) return;

  chart.subscribeCrosshairMove(param => {
    if (param.point) {
      // Над областью свечей: прячем системный курсор, показываем "+"
      // Math.round устраняет субпиксельное дрожание
      chartEl.classList.add('no-cursor');
      marker.style.display = 'block';
      marker.style.left = Math.round(param.point.x) + 'px';
      marker.style.top  = Math.round(param.point.y) + 'px';
    } else {
      // Над шкалой цены или времени: возвращаем стандартный курсор
      chartEl.classList.remove('no-cursor');
      marker.style.display = 'none';
    }
  });

  // Мышь покинула блок графика — убираем маркер и курсор
  chartEl.addEventListener('mouseleave', () => {
    marker.style.display = 'none';
    chartEl.classList.remove('no-cursor');
  });
}


// ВКЛАДКИ ИНТЕРВАЛА
function setupIntervalTabs() {
  const tabs = document.querySelectorAll('.interval-tab');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('active')) return;

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      currentInterval = INTERVAL_MAP[tab.textContent.trim()];
      fetchAndRender(currentInterval);
    });
  });
}


// ПЕРЕКЛЮЧАТЕЛЬ ВИДА: график / стакан / таблица
// 3 иконки в шапке переключают, что показано в левом блоке.
// Слои "стакан" и "таблица" лежат поверх графика.
function setupViewTabs() {
  const tabs          = document.querySelectorAll('.view-tab');
  const intervalTabs  = document.querySelector('.chart-wrapper .interval-tabs');
  const orderbookView = document.getElementById('orderbook-view');
  const tableView     = document.getElementById('grid-table-view');
  if (!tabs.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('active')) return;

      // Подсветка активной иконки
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const view = tab.dataset.view;

      // Показываем нужный слой (график всегда снизу — его открывают, пряча слои)
      orderbookView.hidden = (view !== 'orderbook');
      tableView.hidden     = (view !== 'table');

      // Таймфрейм нужен только на графике — в стакане/таблице прячем
      if (intervalTabs) intervalTabs.style.display = (view === 'chart') ? '' : 'none';

      // Стакан опрашиваем только пока открыт его вид (в остальных — останавливаем)
      if (view === 'orderbook') startOrderbook();
      else                      stopOrderbook();

      if (view === 'table')     openGridTable();
    });
  });
}

// СТАКАН ОРДЕРОВ
// Публичный метод orderbook. Опрашиваем раз в 3 сек, пока открыт
// вид "Стакан". Цену последней сделки берём из глобальной currentPrice
// (её обновляет поллинг графика) — лишних запросов не делаем.
let orderbookTimer       = null;  // таймер опроса стакана
let orderbookFirstRender = true;  // первый рендер — проматываем к центру
let obPrevMid            = null;  // прошлая цена — для стрелки направления
let obBestAsk            = null;  // лучший ask (минимальный) — для расчёта спреда
let obBestBid            = null;  // лучший bid (максимальный) — для расчёта спреда

// Запуск опроса при открытии вида "Стакан"
function startOrderbook() {
  orderbookFirstRender = true;

  // Показываем заглушку загрузки, только если данных ещё нет
  const asksEl  = document.getElementById('ob-asks');
  const loading = document.getElementById('ob-loading');
  if (loading && asksEl && asksEl.children.length === 0) loading.style.display = 'flex';

  fetchAndRenderOrderbook();                                       // сразу
  orderbookTimer = setInterval(fetchAndRenderOrderbook, POLL_MS);  // и далее каждые 3 сек
}

// Остановка опроса при уходе со стакана
function stopOrderbook() {
  if (orderbookTimer) clearInterval(orderbookTimer);
  orderbookTimer = null;
}

// Один цикл: запрос стакана → отрисовка
async function fetchAndRenderOrderbook() {
  let ob;
  try {
    ob = await fetchOrderbook();
  } catch {
    return; // сетевая ошибка — молча ждём следующий тик
  }
  if (!ob) return;
  renderOrderbook(ob);
}

// Запрос к публичному методу orderbook
async function fetchOrderbook() {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'orderbook',
      params:  { category: 'spot', symbol: 'CITRO/USDT' },
      id:      nextRpcId()
    })
  });
  const json = await res.json();
  return json.result;
}

// Отрисовка стакана: аски сверху, цена посередине, биды снизу
function renderOrderbook(ob) {
  const asksEl = document.getElementById('ob-asks');
  const bidsEl = document.getElementById('ob-bids');
  if (!asksEl || !bidsEl) return;

  // Парсим строки [price, size] в числа
  const asks = (ob.a || []).map(parseLevel).filter(Boolean);
  const bids = (ob.b || []).map(parseLevel).filter(Boolean);

  // Аски — по возрастанию цены (лучший/нижний — первый)
  asks.sort((x, y) => x.price - y.price);
  // Биды — по убыванию цены (лучший/верхний — первый)
  bids.sort((x, y) => y.price - x.price);

  const asksHtml = buildSideHtml(asks, 'ask');
  const bidsHtml = buildSideHtml(bids, 'bid');

  // Сохраняем позицию скролла, чтобы при обновлении список не "прыгал"
  const prevAsksScroll = asksEl.scrollTop;
  const prevBidsScroll = bidsEl.scrollTop;

  asksEl.innerHTML = asksHtml;
  bidsEl.innerHTML = bidsHtml;

  if (orderbookFirstRender) {
    asksEl.scrollTop = asksEl.scrollHeight; // лучший аск (низ) — у центра
    bidsEl.scrollTop = 0;                   // лучший бид (верх) — у центра
    orderbookFirstRender = false;
  } else {
    asksEl.scrollTop = prevAsksScroll;
    bidsEl.scrollTop = prevBidsScroll;
  }

  // Запоминаем лучшие цены для расчёта спреда
  // asks отсортированы по возрастанию → asks[0] = минимальный (лучший)
  // bids отсортированы по убыванию  → bids[0] = максимальный (лучший)
  obBestAsk = asks.length > 0 ? asks[0].price : null;
  obBestBid = bids.length > 0 ? bids[0].price : null;

  // Прячем заглушку загрузки
  const loading = document.getElementById('ob-loading');
  if (loading) loading.style.display = 'none';

  updateObMid();
}

// Строит HTML строк одной стороны с накопительным объёмом и полосами глубины.
// side: 'ask' — рисуем сверху вниз (дальние → ближние), 'bid' — (ближние → дальние)
function buildSideHtml(levels, side) {
  if (levels.length === 0) return '';

  // Накопительная сумма от лучшего уровня (индекс 0) наружу
  const cum = [];
  let running = 0;
  for (let i = 0; i < levels.length; i++) {
    running += levels[i].size;
    cum[i] = running;
  }
  const maxCum = cum[cum.length - 1] || 1; // общий объём стороны — для ширины полос

  // Для асков порядок вывода обратный (дальний аск сверху, лучший — снизу)
  const order = side === 'ask'
    ? [...levels.keys()].reverse()
    : [...levels.keys()];

  return order.map(i => {
    const widthPct = (cum[i] / maxCum) * 100;
    return `<div class="ob-row ob-${side}">
      <span class="ob-bar" style="width:${widthPct.toFixed(1)}%"></span>
      <span class="ob-price">${levels[i].price.toFixed(5)}</span>
      <span class="ob-amount">${obFormatSize(levels[i].size)}</span>
      <span class="ob-total">${obFormatSize(cum[i])}</span>
    </div>`;
  }).join('');
}

// Обновляет центральную цену последней сделки + стрелку направления
function updateObMid() {
  const priceEl = document.getElementById('ob-mid-price');
  const usdEl   = document.getElementById('ob-mid-usd');
  if (!priceEl) return;

  if (currentPrice === null) {
    priceEl.textContent = '—';
    if (usdEl) usdEl.textContent = '';
    return;
  }

  // Направление последнего изменения — для стрелки и цвета
  const up = obPrevMid === null ? true : currentPrice >= obPrevMid;
  priceEl.textContent = currentPrice.toFixed(5) + (up ? '  ↑' : '  ↓');
  priceEl.classList.toggle('is-up', up);
  priceEl.classList.toggle('is-down', !up);

  if (usdEl) usdEl.textContent = '≈ ' + truncate(currentPrice, 2).toFixed(2) + ' USD';

  obPrevMid = currentPrice;

  // Спред: лучший ask − лучший bid, абсолютный и в процентах
  const spreadEl = document.getElementById('ob-mid-spread');
  if (spreadEl) {
    if (obBestAsk !== null && obBestBid !== null && obBestAsk > obBestBid) {
      const spreadAbs = obBestAsk - obBestBid;
      const spreadPct = (spreadAbs / obBestBid) * 100;
      spreadEl.textContent =
        'Spread: ' + spreadAbs.toFixed(5) + ' / ' + truncate(spreadPct, 2).toFixed(2) + '%';
    } else {
      spreadEl.textContent = '';
    }
  }
}

// Вспомогательные функции стакана

// Формат объёма: ≥1000 → "1.12K", иначе 4 знака после запятой
function obFormatSize(n) {
  if (n >= 1000) return truncate(n / 1000, 2).toFixed(2) + 'K';
  return truncate(n, 4).toFixed(4);
}

// ТАБЛИЦА ОРДЕРОВ СЕТКИ
// Предварительный список лимитных ордеров по текущим настройкам.
// Конвертация валют считается ПО ОРДЕРБУКУ (проходим уровни),
// а не по последней цене — ликвидности мало, важна точность.

// Иконки монет (COIN_ICON) — общий объект из common.js.

let gridTableTimer = null; // debounce-таймер пересчёта при вводе

// Навешиваем пересчёт на изменение всех влияющих полей
function setupGridTable() {
  ['price-low', 'price-high', 'grid-count',
   'deposit-amount', 'deposit-usdt', 'deposit-citro'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', onGridSettingsChanged);
  });
}

// Таблица сейчас открыта?
function isTableViewActive() {
  const view = document.getElementById('grid-table-view');
  return view && !view.hidden;
}

// Реакция на изменение настроек сетки/депозита.
// Сразу прячем устаревшие данные (показываем загрузку), считаем с задержкой —
// чтобы не дёргать стакан на каждое нажатие клавиши.
function onGridSettingsChanged() {
  const reason = gridInputsReason();

  if (reason) {
    // Поля не готовы: подсказка в таблице, инфо-блок прячем
    if (isTableViewActive()) showGridMessage(reason);
    hideBotSummary();
    clearTimeout(gridTableTimer);
    return;
  }

  // Поля готовы: мгновенно прячем старое (показываем загрузку), считаем с задержкой
  if (isTableViewActive()) showGridLoading();
  clearTimeout(gridTableTimer);
  gridTableTimer = setTimeout(recomputeGrid, 400);
}

// Открытие вкладки "Таблица": показать загрузку/подсказку и сразу пересчитать
function openGridTable() {
  const reason = gridInputsReason();
  if (reason) showGridMessage(reason);
  else        showGridLoading();
  recomputeGrid();
}

// Основной пересчёт: берём СВЕЖИЙ стакан, считаем ордера и обмен валют,
// и только после получения данных обновляем таблицу и инфо-блок.
async function recomputeGrid() {
  const reason = gridInputsReason();

  if (reason) {
    if (isTableViewActive()) showGridMessage(reason);
    hideBotSummary();
    return;
  }

  let ob;
  try {
    ob = await fetchOrderbook();
  } catch {
    ob = null;
  }

  // Стакан не получен (сеть или биржа вернула ответ без result) — не падаем
  if (!ob) {
    if (isTableViewActive()) showGridMessage('Не удалось получить данные стакана. Попробуйте позже.');
    hideBotSummary();
    return;
  }

  const { orders, conversion } = computeGridOrders(ob);

  if (isTableViewActive()) showGridTable(orders);
  updateBotSummary(conversion);
}


// Переключение состояний слоя таблицы: подсказка / загрузка / данные

function showGridMessage(text) {
  const msg = document.getElementById('gt-message');
  if (msg) { msg.textContent = text; msg.hidden = false; }
  toggleHidden('gt-loading', true);
  toggleHidden('gt-table',   true);
}

function showGridLoading() {
  toggleHidden('gt-message', true);
  toggleHidden('gt-loading', false);
  toggleHidden('gt-table',   true);
}

function showGridTable(orders) {
  const rows = document.getElementById('gt-rows');
  if (rows) rows.innerHTML = orders.map(gtRowHtml).join('');
  toggleHidden('gt-message', true);
  toggleHidden('gt-loading', true);
  toggleHidden('gt-table',   false);
  syncTradeColumnWidth(); // подгоняем ширину колонки «Сделка» под содержимое
}

// Подгоняет ширину колонки «Сделка» под самое широкое значение, чтобы суммы
// не обрезались при больших числах. Переменная применяется и к шапке, и к
// строкам (общий grid-шаблон) — колонки и зазоры остаются выровненными,
// заголовки — по центру своих колонок.
function syncTradeColumnWidth() {
  const table = document.getElementById('gt-table');
  const rows  = document.getElementById('gt-rows');
  if (!table || !rows) return;

  // Сбрасываем прежнюю ширину, чтобы мерить по дефолтной колонке.
  table.style.removeProperty('--gt-trade-w');

  let needed = 0;
  rows.querySelectorAll('.gt-trade').forEach(el => {
    const kids = el.children;
    if (!kids.length) return;
    // Натуральная ширина содержимого = от левого края первого ребёнка до правого
    // края последнего. Надёжнее scrollWidth, который при justify-content:center +
    // overflow:hidden измеряется неверно (занижает) → колонка получалась узкой.
    const w = kids[kids.length - 1].getBoundingClientRect().right
            - kids[0].getBoundingClientRect().left;
    if (w > needed) needed = w;
  });
  if (needed <= 0) return;

  // Не выталкиваем таблицу за пределы панели: резервируем место под «Тип» (60px),
  // минимум под «Цену» (~70px), два зазора (16px) и горизонтальные паддинги (16px).
  const reserve    = 60 + 70 + 16 * 2 + 16 * 2;
  const maxAllowed = Math.max(table.clientWidth - reserve, 120);
  const width      = Math.min(Math.ceil(needed) + 4, maxAllowed);

  table.style.setProperty('--gt-trade-w', width + 'px');
}

// Мелкий помощник: показать/скрыть элемент по id
function toggleHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}


// Инфо-блок перед кнопкой: что на что обменяется при создании

function updateBotSummary(conversion) {
  const box  = document.getElementById('bot-summary');
  const swap = document.getElementById('bot-summary-swap');
  if (!box || !swap) return;

  // Обмен не требуется (например, сетка целиком по одну сторону от цены и
  // депозит уже в нужной валюте) — прячем блок целиком, чтобы не показывать
  // противоречивое «обмен будет выполнен / обмен не требуется».
  if (!conversion) {
    box.hidden = true;
    return;
  }

  // "from" — точная сумма, "to" — оценка по стакану (поэтому ≈)
  swap.innerHTML = swapHtml(conversion);
  box.hidden = false;
}

// HTML строки обмена «сумма → сумма» — общий для инфо-блока
// под настройками и модала подтверждения создания
function swapHtml(conversion) {
  return `
    <span class="bot-summary-part">
      <img class="bot-summary-coin" src="${COIN_ICON[conversion.from.t]}" alt="${conversion.from.t}" />
      <b>${fmtAmt(conversion.from.amt)}</b>&nbsp;${conversion.from.t}
    </span>
    <svg class="bot-summary-arrow" width="22" height="14" viewBox="0 0 22 14" fill="none"
         stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
         stroke-linejoin="round" aria-hidden="true">
      <line x1="0" y1="7" x2="18" y2="7"/>
      <polyline points="12 1 19 7 12 13"/>
    </svg>
    <span class="bot-summary-part">
      <img class="bot-summary-coin" src="${COIN_ICON[conversion.to.t]}" alt="${conversion.to.t}" />
      <b>≈&nbsp;${fmtAmt(conversion.to.amt)}</b>&nbsp;${conversion.to.t}
    </span>
  `;
}

function hideBotSummary() {
  const box = document.getElementById('bot-summary');
  if (box) box.hidden = true;
}

// Возвращает текст подсказки, если данные не готовы, иначе '' (всё ок)
function gridInputsReason() {
  const PROMPT = 'Заполните поля «Депозит», «Нижняя граница», «Верхняя граница» и ' +
                 '«Количество сеток», чтобы увидеть список ордеров, которые выставит бот.';

  // Шаг 1: проверяем видимые ошибки валидации в полях
  // parseFloat('.05') = 0.05 — число корректное, но поле помечено ошибкой.
  // Если смотреть только на значение, такой ввод проходит проверку — это баг.
  // Поэтому сначала проверяем error-элементы, как это делает updateCreateBtn().
  const ERROR_FIELDS = [
    'deposit-amount-error', 'deposit-usdt-error', 'deposit-citro-error', 'deposit-both-error',
    'price-low-error', 'price-high-error', 'grid-count-error',
  ];
  // Ошибка «превышает баланс» НЕ блокирует предпросмотр: настройки валидны,
  // просто не на что запустить бота. Таблицу показываем, а кнопку «Создать бота»
  // гасит updateCreateBtn. Остальные ошибки (формат, минимум, диапазон) блокируют —
  // при них расчёт невозможен или невалиден.
  const hasBlockingError = ERROR_FIELDS.some(id => {
    const txt = document.getElementById(id)?.textContent.trim();
    return txt && txt !== ERR.exceedsBalance;
  });
  if (hasBlockingError) return PROMPT;

  // Шаг 2: проверяем логическую корректность значений
  const dep   = readDeposit();
  const depOk = dep.mode === 'BOTH' ? (dep.usdt > 0 && dep.citro > 0) : (dep.amount > 0);

  const low   = parseFloat(document.getElementById('price-low').value);
  const high  = parseFloat(document.getElementById('price-high').value);
  const count = parseInt(document.getElementById('grid-count').value, 10);

  const lowOk   = low > 0;
  const highOk  = high > 0 && high > low;
  const countOk = Number.isInteger(count) && count >= GRID_COUNT_MIN && count <= GRID_COUNT_MAX;

  if (!(depOk && lowOk && highOk && countOk)) return PROMPT;
  if (currentPrice === null) return 'Загрузка текущей цены…';
  return '';
}

// Считывает депозит с учётом выбранной валюты (USDT / CITRO / BOTH)
function readDeposit() {
  const isBoth = document.getElementById('deposit-both')?.style.display !== 'none';
  if (isBoth) {
    return {
      mode:  'BOTH',
      usdt:  parseFloat(document.getElementById('deposit-usdt').value)  || 0,
      citro: parseFloat(document.getElementById('deposit-citro').value) || 0,
    };
  }
  return {
    mode:   currentDepositToken, // 'USDT' или 'CITRO'
    amount: parseFloat(document.getElementById('deposit-amount').value) || 0,
  };
}

// Уровни сетки (обёртка над GridCore)
// Берёт значения из полей формы + текущую цену и зовёт общий модуль.
// Возвращает { levels, closestIdx, count } или null. Используется линиями
// на графике (updateGridLines) и проверкой «цена пересекла уровень».
function readGridLevelsFromForm() {
  const low   = parseFloat(document.getElementById('price-low')?.value);
  const high  = parseFloat(document.getElementById('price-high')?.value);
  const count = parseInt(document.getElementById('grid-count')?.value, 10);
  return GridCore.computeGridLevels(low, high, count, currentPrice);
}

// Рассчитывает массив ордеров и обмен по настройкам и стакану.
// Вся математика — в общем модуле GridCore (тот же код использует движок).
function computeGridOrders(ob) {
  const config = {
    deposit:   readDeposit(),
    priceLow:  parseFloat(document.getElementById('price-low').value),
    priceHigh: parseFloat(document.getElementById('price-high').value),
    gridCount: parseInt(document.getElementById('grid-count').value, 10),
  };
  return GridCore.computeGridPlan(config, ob, currentPrice);
}

// HTML одной строки таблицы
function gtRowHtml(o) {
  const label = o.type === 'sell' ? 'Sell' : 'Buy';
  const cls   = o.type === 'sell' ? 'gt-sell' : 'gt-buy';
  return `<div class="gt-row">
    <span class="gt-type ${cls}">${label}</span>
    <span class="gt-price">${o.price.toFixed(5)}</span>
    <span class="gt-trade">
      <img class="gt-coin" src="${COIN_ICON[o.from.t]}" alt="${o.from.t}" />
      <span class="gt-amt">${fmtAmt(o.from.amt)}</span>
      <svg class="gt-arrow" width="22" height="14" viewBox="0 0 22 14" fill="none"
           stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
           stroke-linejoin="round" aria-hidden="true">
        <!-- Длинная горизонтальная стрелка вправо -->
        <line x1="0" y1="7" x2="18" y2="7"/>
        <polyline points="12 1 19 7 12 13"/>
      </svg>
      <img class="gt-coin" src="${COIN_ICON[o.to.t]}" alt="${o.to.t}" />
      <span class="gt-amt">${fmtAmt(o.to.amt)}</span>
    </span>
  </div>`;
}

// Формат суммы: усечение до 2 знаков, без лишних нулей (625, 714.28, 1000)
function fmtAmt(n) {
  return String(truncate(n, 2));
}


// ПОЛНАЯ ЗАГРУЗКА ГРАФИКА (при смене интервала или первом открытии)
async function fetchAndRender(interval) {
  const reqId = ++chartRequestId; // этот запрос — самый свежий
  stopPolling(); // останавливаем старый поллинг до конца загрузки
  showLoading(true);

  let candles;
  try {
    candles = await fetchOHLCV(interval, 10000);
  } catch (err) {
    if (reqId !== chartRequestId) return; // запрос устарел (сменили таймфрейм)
    console.error('Ошибка загрузки OHLCV:', err);
    showLoading(false);
    showError('Не удалось загрузить данные графика');
    return;
  }

  // Подоспел более новый запрос — не рендерим устаревшие данные
  if (reqId !== chartRequestId) return;

  showLoading(false);

  if (!candles || candles.length === 0) {
    showError('Нет данных для выбранного интервала');
    return;
  }

  const data = buildChartData(candles);

  if (data.length === 0) {
    showError('Нет корректных данных для выбранного интервала');
    return;
  }

  try {
    candleSeries.setData(data);
    chart.timeScale().fitContent();
  } catch (err) {
    console.error('Ошибка отрисовки графика:', err);
    showError('Не удалось отобразить данные');
    return;
  }

  // Данные успешно отрисованы — убираем оверлей ошибки, если он висел
  hideChartError();

  // Запоминаем последнюю свечу для live-обновлений
  saveLastCandle(data[data.length - 1]);

  startPolling(); // запускаем живое обновление

  // Перерисовываем линии сетки (пропадают при setData, восстанавливаем)
  updateGridLines();
}


// ПОЛЛИНГ: запускается после загрузки графика
function startPolling() {
  stopPolling();
  pollingTimer = setInterval(pollUpdate, POLL_MS);
}

function stopPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = null;
}


// ПАУЗА ОПРОСОВ В ФОНЕ
// Пока вкладка скрыта — не дёргаем биржу (экономим лимит 3 req/s).
// При возврате возобновляем опросы и сразу обновляем данные.
function setupVisibilityPause() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Вкладка ушла в фон — останавливаем оба опроса
      stopPolling();
      stopOrderbook();
      return;
    }

    // Вкладка снова видима:
    // график — возобновляем, если он был загружен, и сразу подтягиваем тик
    if (lastCandleTime !== null) {
      startPolling();
      pollUpdate();
    }
    // стакан — возобновляем, только если открыт его вид
    const obView = document.getElementById('orderbook-view');
    if (obView && !obView.hidden) startOrderbook();
  });
}

async function pollUpdate() {
  // 1. Получаем актуальную цену
  let ticker;
  try {
    ticker = await fetchTickerData();
  } catch {
    return; // сетевая ошибка — молча пропускаем тик
  }
  if (!ticker) return; // биржа вернула ответ без result — пропускаем тик

  // 2. Обновляем цену в шапке
  updatePriceDisplay(ticker);

  const currentPrice = parseFloat(ticker.last_price);
  if (isNaN(currentPrice) || lastCandleTime === null) return;

  // 3. Обновляем текущую незакрытую свечу на графике
  //    Это дешевле, чем перезагружать весь OHLCV
  lastCandleHigh = Math.max(lastCandleHigh, currentPrice);
  lastCandleLow  = Math.min(lastCandleLow,  currentPrice);

  try {
    candleSeries.update({
      time:  lastCandleTime,
      open:  lastCandleOpen,
      high:  lastCandleHigh,
      low:   lastCandleLow,
      close: currentPrice,
    });
  } catch { /* Lightweight Charts иногда выбрасывает при граничных данных */ }

  // 4. Проверяем, закрылась ли текущая свеча
  //    Если текущее время прошло границу закрытия — загружаем новые свечи
  const nowSeconds       = Math.floor(Date.now() / 1000);
  const candleClosesAt   = lastCandleTime + INTERVAL_SECONDS[currentInterval];

  if (nowSeconds >= candleClosesAt) {
    await refreshLatestCandles();
  }
}


// Подгружает только последние несколько свечей и добавляет новые на график
// Вызывается когда обнаружено закрытие текущей свечи
async function refreshLatestCandles() {
  let candles;
  try {
    candles = await fetchOHLCV(currentInterval, 5);
  } catch {
    return;
  }

  if (!candles || candles.length === 0) return;

  const bars = buildChartData(candles);
  if (bars.length === 0) return;

  try {
    // update() умнее setData(): добавляет новые бары или обновляет последний
    bars.forEach(bar => candleSeries.update(bar));
  } catch { return; }

  // Обновляем данные последней свечи
  saveLastCandle(bars[bars.length - 1]);
}


// TICKER: разовый вызов при загрузке страницы
async function fetchTicker() {
  try {
    const ticker = await fetchTickerData();
    updatePriceDisplay(ticker);
  } catch (err) {
    console.error('Ошибка загрузки тикера:', err);
  }
}

// Делает запрос к API и возвращает объект тикера
async function fetchTickerData() {
  const res  = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'tickers',
      params:  { category: 'spot', symbol: 'CITRO/USDT' },
      id:      nextRpcId()
    })
  });
  const json = await res.json();
  return json.result;
}

function updatePriceDisplay(ticker) {
  if (!ticker) return; // пустой ответ биржи — не трогаем отображение

  const price     = parseFloat(ticker.last_price);
  const changePct = parseFloat(ticker.change_24h);

  // Цена впервые стала известна? (для разовой перерисовки сетки/таблицы ниже)
  const priceWasUnknown = currentPrice === null;

  // Цену и линию обновляем только при валидном значении — иначе оставляем
  // прежнее и не пишем «NaN USDT»
  if (!isNaN(price)) {
    currentPrice = price;
    updateCurrentPriceLine();
    document.getElementById('current-price').textContent =
      price.toFixed(5) + ' USDT';
  }

  // Изменение за 24ч — тоже только при валидном значении
  if (!isNaN(changePct)) {
    const changeEl = document.getElementById('price-change');
    changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
    changeEl.className   = 'price-change ' + (changePct >= 0 ? 'positive' : 'negative');
  }

  // Пересчёты, зависящие от цены. Запускаем в двух случаях:
  //  • цена пришла ВПЕРВЫЕ — поля могли заполнить до её загрузки, расчёты ждали;
  //  • цена ПЕРЕСЕКЛА уровень сетки — от ближайшего уровня зависят раскраска
  //    линий, разбивка buy/sell в таблице и инфо-блок обмена. Без этого после
  //    движения цены страница показывала бы устаревший расчёт (а модал
  //    подтверждения — свежий).
  // Проверка дешёвая и без запросов к бирже; запрос стакана (внутри
  // onGridSettingsChanged) уходит только при реальном изменении уровня.
  // При ошибке в полях сетки сравниваем с null — как в updateGridLines,
  // иначе сравнение «дребезжало» бы на каждом тике.
  const closestNow = hasGridFieldError()
    ? null
    : (readGridLevelsFromForm()?.closestIdx ?? null);

  if ((priceWasUnknown && currentPrice !== null) || closestNow !== lastClosestIdx) {
    checkDepositLimits(); // лимиты зависят от цены
    validateGridStep();   // минимальный шаг тоже зависит от цены
    updateGridLines();    // перерисует линии и обновит lastClosestIdx
    onGridSettingsChanged();
  }
}


// OHLCV ЗАПРОС
async function fetchOHLCV(interval, limit = 10000) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method:  'ohlcv',
      params: {
        category: 'spot',
        symbol:   'CITRO/USDT',
        interval: interval,
        data:     { limit }
      },
      id: nextRpcId()
    })
  });

  const json = await response.json();
  return json.result;
}


// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ

// Преобразует сырые свечи из API в формат Lightweight Charts
// Фильтрует null/NaN и сортирует по возрастанию времени
function buildChartData(candles) {
  return candles
    .filter(c => c[1] !== null && c[2] !== null && c[3] !== null && c[4] !== null)
    .map(c => ({
      time:  Math.floor(c[0] / 1000),
      open:  parseFloat(c[1]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
    }))
    .filter(c => !isNaN(c.open) && !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close))
    .sort((a, b) => a.time - b.time); // API возвращает разный порядок для разных интервалов
}

// Сохраняет данные последней свечи для live-обновлений через pollUpdate
function saveLastCandle(bar) {
  lastCandleTime = bar.time;
  lastCandleOpen = bar.open;
  lastCandleHigh = bar.high;
  lastCandleLow  = bar.low;
}

function showLoading(visible) {
  document.getElementById('chart-loading').style.display = visible ? 'flex' : 'none';
}

function showError(message) {
  if (candleSeries) candleSeries.setData([]);
  const container = document.getElementById('chart');
  const existing  = container.querySelector('.chart-error');
  if (existing) {
    existing.textContent = message;
  } else {
    const el = document.createElement('div');
    el.className   = 'chart-error';
    el.textContent = message;
    container.appendChild(el);
  }
}

// Убирает оверлей ошибки графика (если он есть) — вызывается после успешной загрузки
function hideChartError() {
  const container = document.getElementById('chart');
  const existing  = container?.querySelector('.chart-error');
  if (existing) existing.remove();
}


// КАСТОМНЫЙ ДРОПДАУН: API-КЛЮЧИ
// Берём ключи из localStorage-кэша (те же данные, что на странице API-ключей).
// Запрос к серверу не делаем — кэш уже актуален после первого входа.
function setupApiKeyDropdown() {
  const wrapper = document.getElementById('api-select');
  const btn     = document.getElementById('api-select-btn');
  const list    = document.getElementById('api-select-list');
  if (!wrapper || !btn || !list) return;

  // 1) СРАЗУ рисуем из кэша: список нужен уже сейчас — сразу после нас setupEditMode()
  //    в режиме правки выбирает ключ кликом по готовому пункту.
  const shown = getApiKeysFromCache();
  renderKeyItems(shown);

  // 2) Затем сверяемся с сервером — он источник истины. Ключ мог появиться или пропасть
  //    в другой вкладке, а кэш об этом не знает. Сравниваем с тем, что РЕАЛЬНО нарисовали
  //    (shown), а не с кэшем: кэш общий на все вкладки и мог измениться под нами — тогда
  //    сравнение с ним соврало бы «не изменилось». Перерисовываем только при реальных
  //    отличиях, чтобы не дёргать форму под руками. Периодического опроса тут нет
  //    сознательно: перестраивать список посреди заполнения формы — плохо.
  apiGet('/api/keys/list')
    .then(({ keys }) => {
      const fresh = keys || [];
      makeCache('apiKeys').write(fresh);
      if (JSON.stringify(fresh) !== JSON.stringify(shown)) renderKeyItems(fresh);
    })
    .catch(() => {});   // сеть недоступна — остаёмся на кэше

  // Открываем / закрываем список по клику на кнопку
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllDropdowns(wrapper);
    wrapper.classList.toggle('is-open');
  });
}

// Пересобирает пункты списка ключей, СОХРАНЯЯ текущий выбор:
//   • выбранный ключ на месте → остаётся выбранным (подпись обновляем — его могли переименовать);
//   • выбранного ключа больше нет (удалён в другой вкладке) → снимаем выбор, иначе форма
//     ссылалась бы на несуществующий ключ; кнопка создания сама погаснет.
function renderKeyItems(keys) {
  const wrapper = document.getElementById('api-select');
  const btn     = document.getElementById('api-select-btn');
  const list    = document.getElementById('api-select-list');
  if (!wrapper || !btn || !list) return;

  const addLink  = list.querySelector('.select-item--action');
  const selected = wrapper.dataset.selectedKeyId || null;

  list.querySelectorAll('.select-item--key').forEach(el => el.remove());

  keys.forEach(key => {
    const item = document.createElement('button');
    item.type      = 'button';
    item.className = 'select-item select-item--key';
    item.dataset.keyId = key.id; // нужен для программного выбора в режиме правки
    item.innerHTML = `
      <img src="https://citronus.com/favicon.svg" class="option-icon" alt="Citronus" />
      <span>${escapeHtml(key.name)}</span>
    `;
    if (key.id === selected) item.classList.add('is-active');   // восстанавливаем подсветку

    // При выборе ключа — обновляем кнопку-триггер и сохраняем id
    item.addEventListener('click', () => {
      list.querySelectorAll('.select-item--key').forEach(el => el.classList.remove('is-active'));
      item.classList.add('is-active');

      setKeyBtnLabel(key);

      // Сохраняем выбранный ключ и пересчитываем кнопку создания
      wrapper.dataset.selectedKeyId = key.id;
      currentKeyId = key.id;
      wrapper.classList.remove('is-open');
      updateCreateBtn();

      // Меняем текст тултипа баланса — ключ теперь выбран
      const balanceTip = document.getElementById('balance-info-tooltip');
      if (balanceTip) {
        balanceTip.textContent = 'Ваш доступный баланс для спотовой торговли.';
      }

      // Загружаем баланс по выбранному ключу
      fetchBalance(key.id);
      // Заранее тянем состояние аккаунта (свободные слоты + другой активный бот),
      // чтобы окно подтверждения сразу знало про лимит 100 ордеров.
      refreshAccountState();
    });

    list.insertBefore(item, addLink);
  });

  if (!selected) return;
  const still = keys.find(k => k.id === selected);
  if (still) setKeyBtnLabel(still);   // мог смениться только текст (переименование)
  else       clearKeySelection();     // ключ удалён — честно сбрасываем выбор
}

// Подпись кнопки-триггера с выбранным ключом
function setKeyBtnLabel(key) {
  const btn = document.getElementById('api-select-btn');
  if (!btn) return;
  btn.innerHTML = `
    <div class="select-value">
      <img src="https://citronus.com/favicon.svg" class="select-val-icon" alt="Citronus" />
      <span>${escapeHtml(key.name)}</span>
    </div>
    <svg class="select-arrow" width="14" height="14" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  `;
}

// Возврат к исходному состоянию «Выбрать» (как в разметке)
function clearKeySelection() {
  const wrapper = document.getElementById('api-select');
  const btn     = document.getElementById('api-select-btn');
  if (!wrapper || !btn) return;
  delete wrapper.dataset.selectedKeyId;
  currentKeyId = null;
  btn.innerHTML = `
    <span class="select-placeholder">Выбрать</span>
    <svg class="select-arrow" width="14" height="14" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  `;
  updateCreateBtn();
}

// Читает кэш API-ключей (тот же, что наполняет страница API-ключей)
function getApiKeysFromCache() {
  const cached = makeCache('apiKeys').read();
  return Array.isArray(cached) ? cached : [];
}

// ЗАГРУЗКА БАЛАНСА
// Вызывается при выборе API ключа.
// Обращается к нашему бэкенду, который расшифровывает
// секрет и делает подписанный запрос к Citronus.

// Форматирование баланса: 2 знака, ОТБРАСЫВАНИЕ (не округление), без лишних нулей.
// 12.787 → "12.78"   10.20 → "10.2"   10.00 → "10"
// Math.floor(n * 100) / 100 отсекает, а не округляет дробную часть.
function formatBalance(n) {
  const truncated = Math.floor(n * 100) / 100;
  return String(truncated);
}

async function fetchBalance(keyId) {
  const reqId   = ++balanceRequestId; // этот запрос баланса — самый свежий
  const token   = localStorage.getItem('token');
  const usdtEl  = document.getElementById('balance-usdt');
  const citroEl = document.getElementById('balance-citro');

  lastBalanceFetch = Date.now();

  // Новый запрос: прежний баланс относился к другому ключу. Сбрасываем его и
  // снятую на его основе ошибку «превышает баланс», чтобы проверки депозита не
  // опирались на чужой/устаревший баланс (в т.ч. если новый запрос упадёт).
  balanceLoaded = false;
  ['deposit-amount-error', 'deposit-usdt-error', 'deposit-citro-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.textContent === ERR.exceedsBalance) el.textContent = '';
  });
  updateCreateBtn();

  usdtEl.textContent  = '...';
  citroEl.textContent = '...';

  try {
    const res  = await fetch('/api/keys/balance?keyId=' + keyId, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();

    if (reqId !== balanceRequestId) return; // выбрали другой ключ — ответ устарел

    if (!res.ok) {
      usdtEl.textContent  = '—';
      citroEl.textContent = '—';
      return;
    }

    balanceUSDT   = data.usdt;
    balanceCITRO  = data.citro;
    balanceLoaded = true;

    usdtEl.textContent  = formatBalance(data.usdt);
    citroEl.textContent = formatBalance(data.citro);

    // Проверяем введённые суммы депозита после обновления баланса.
    // Таблицу/инфо обновлять не нужно: их видимость от баланса не зависит
    // (ошибка «превышает баланс» гасит только кнопку, см. gridInputsReason).
    checkDepositBalance();

  } catch {
    if (reqId !== balanceRequestId) return; // устарел — не трогаем UI
    usdtEl.textContent  = '—';
    citroEl.textContent = '—';
  }
}


// ПРОВЕРКА: сумма депозита не превышает баланс
// Вызывается при вводе суммы и после загрузки баланса.
// Если баланс ещё не загружен — проверка не проводится.
function checkDepositBalance() {
  if (!balanceLoaded) return;

  const MSG = ERR.exceedsBalance;
  const isBothMode = document.getElementById('deposit-both')?.style.display !== 'none';

  if (isBothMode) {
    // Режим USDT + CITRO: проверяем каждое поле отдельно
    setDepositError('deposit-usdt',
      'deposit-usdt-error',
      parseFloat(document.getElementById('deposit-usdt')?.value || 0),
      balanceUSDT, MSG);

    setDepositError('deposit-citro',
      'deposit-citro-error',
      parseFloat(document.getElementById('deposit-citro')?.value || 0),
      balanceCITRO, MSG);
  } else {
    const limit = currentDepositToken === 'CITRO' ? balanceCITRO : balanceUSDT;
    setDepositError('deposit-amount',
      'deposit-amount-error',
      parseFloat(document.getElementById('deposit-amount')?.value || 0),
      limit, MSG);
  }

  updateCreateBtn();
}

// Устанавливает или снимает ошибку превышения баланса для одного поля
function setDepositError(inputId, errorId, amount, limit, message) {
  const errorEl = document.getElementById(errorId);
  if (!errorEl) return;

  // Не перезаписываем ошибку валидации символов (если она уже стоит)
  if (errorEl.textContent && errorEl.textContent !== message) return;

  if (amount > 0 && amount > limit) {
    errorEl.textContent = message;
  } else {
    // Снимаем только нашу ошибку
    if (errorEl.textContent === message) errorEl.textContent = '';
  }
}


// ПРОВЕРКА МИНИМАЛЬНОГО ДЕПОЗИТА
// Биржа требует MIN_USDT_PER_GRID USDT на каждый шаг сетки.
// При депозите в CITRO или CITRO+USDT — конвертируем по бидам
// стакана (не по цене последней сделки), чтобы расчёт был точным.

// Запускает проверку с задержкой — не дёргаем стакан при каждом нажатии клавиши
function scheduleMinDepositCheck() {
  clearTimeout(minDepositTimer);
  minDepositTimer = setTimeout(() => {
    checkDepositLimits();
    // Лимит мог до этого перекрывать ошибку баланса в том же поле — переоцениваем
    // баланс, чтобы «превышает баланс» показалась, когда лимит её больше не блокирует.
    checkDepositBalance();
    // Ошибка лимита/баланса влияет на показ «Таблицы ордеров» и инфо-блока
    // (см. gridInputsReason). Поэтому ПОСЛЕ пересчёта обновляем таблицу/инфо —
    // иначе при исправлении суммы на допустимую таблица застревала бы на подсказке.
    onGridSettingsChanged();
  }, 350);
}

// Проверка лимитов депозита на одну сетку — и МИНИМУМ, и МАКСИМУМ.
// Конвертация CITRO↔USDT — по последней цене (currentPrice), без стакана:
// наш минимум (1 USDT/сетка) ~×10 от биржевого, поэтому упрощение безопасно.
// Точный расчёт самой таблицы по-прежнему идёт по стакану (computeGridOrders).
// Сообщение формируется в единицах той валюты, которую ввёл пользователь.
function checkDepositLimits() {
  const count = parseInt(document.getElementById('grid-count')?.value, 10);

  // Кол-во сеток некорректно или цены ещё нет — снимаем ошибки лимитов
  if (!Number.isInteger(count) || count < GRID_COUNT_MIN || count > GRID_COUNT_MAX || !(currentPrice > 0)) {
    clearMinDepositErrors();
    updateCreateBtn();
    return;
  }

  const dep     = readDeposit();
  const isBoth  = dep.mode === 'BOTH';
  const errorId = isBoth ? 'deposit-both-error' : 'deposit-amount-error';

  // Стоимость депозита в USDT (CITRO считаем по последней цене)
  let totalUSDT;
  if (isBoth) {
    const usdtAmt  = dep.usdt  || 0;
    const citroAmt = dep.citro || 0;
    if (usdtAmt <= 0 || citroAmt <= 0) { clearMinDepositErrors(); updateCreateBtn(); return; }
    totalUSDT = usdtAmt + citroAmt * currentPrice;
  } else {
    const amount = dep.amount || 0;
    if (amount <= 0) { clearMinDepositErrors(); updateCreateBtn(); return; }
    totalUSDT = dep.mode === 'CITRO' ? amount * currentPrice : amount;
  }

  const perGridUSDT = totalUSDT / count;

  let msg = '';
  if (perGridUSDT < MIN_USDT_PER_GRID)      msg = limitMessage('min', dep.mode, count);
  else if (perGridUSDT > MAX_USDT_PER_GRID) msg = limitMessage('max', dep.mode, count);

  setMinDepositError(errorId, msg);
  updateCreateBtn();
}

// Формирует текст ошибки лимита (min/max) в единицах введённой валюты.
function limitMessage(kind, mode, count) {
  const word      = kind === 'min' ? 'минимальная' : 'максимальная';
  const perGrid   = kind === 'min' ? MIN_USDT_PER_GRID : MAX_USDT_PER_GRID;
  const totalUSDT = perGrid * count;

  if (mode === 'BOTH') {
    const tail = kind === 'min'
      ? 'меньше минимально допустимой суммы'
      : 'превышает максимально допустимую сумму';
    return `${MIN_ERR_PREFIX} указанное число USDT и CITRO ${tail}`;
  }
  if (mode === 'CITRO') {
    const amtCitro = truncate(totalUSDT / currentPrice, 2);
    return `${MIN_ERR_PREFIX} ${word} сумма депозита составляет ${amtCitro} CITRO`;
  }
  return `${MIN_ERR_PREFIX} ${word} сумма депозита составляет ${totalUSDT} USDT`;
}

// Устанавливает ошибку минимума в поле, не затрагивая чужие ошибки.
// Перезаписывает только: пустое поле ИЛИ уже наша ошибка (по PREFIX).
function setMinDepositError(errorId, msg) {
  const el = document.getElementById(errorId);
  if (!el) return;
  const current = el.textContent;
  if (current && !current.startsWith(MIN_ERR_PREFIX)) return; // чужая ошибка — не трогаем
  el.textContent = msg;
}

// Снимает все ошибки минимума (только наши, по PREFIX)
function clearMinDepositErrors() {
  ['deposit-amount-error', 'deposit-usdt-error', 'deposit-citro-error', 'deposit-both-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.textContent.startsWith(MIN_ERR_PREFIX)) el.textContent = '';
  });
}


// КНОПКА ОБНОВЛЕНИЯ БАЛАНСА
// Максимум 1 запрос в 3 секунды — защита от лишней
// нагрузки на лимит API биржи (5 запросов/сек).
function setupBalanceRefresh() {
  const btn = document.getElementById('balance-refresh');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!currentKeyId) return; // ключ ещё не выбран

    const now = Date.now();
    if (now - lastBalanceFetch < 3000) return; // слишком часто — игнорируем

    // Запускаем анимацию вращения (800 мс — одно полное вращение)
    btn.classList.add('is-spinning');
    setTimeout(() => btn.classList.remove('is-spinning'), 800);

    fetchBalance(currentKeyId);
  });
}


// Умное позиционирование тултипов (setupSmartTooltips) — общий помощник из common.js.


// КАСТОМНЫЙ ДРОПДАУН: ВАЛЮТА ДЕПОЗИТА
function setupDepositDropdown() {
  const wrapper    = document.getElementById('deposit-select');
  const btn        = document.getElementById('deposit-select-btn');
  const list       = document.getElementById('deposit-select-list');
  const display    = document.getElementById('deposit-display');
  const single     = document.getElementById('deposit-single');
  const both       = document.getElementById('deposit-both');
  const unitLabel  = document.getElementById('deposit-unit');
  if (!wrapper || !btn || !list) return;

  // Иконки монет для обновления триггера
  const ICONS = {
    USDT:  'https://s3.eu-central-2.wasabisys.com/citronus/icons/coins/USDT.svg',
    CITRO: 'https://s3.eu-central-2.wasabisys.com/citronus/icons/coins/CITRO.svg',
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllDropdowns(wrapper);
    wrapper.classList.toggle('is-open');
  });

  // Обработка выбора пункта
  list.querySelectorAll('.select-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();

      // Снимаем активность со всех, ставим на выбранный
      list.querySelectorAll('.select-item').forEach(i => i.classList.remove('is-active'));
      item.classList.add('is-active');

      const token = item.dataset.token;
      currentDepositToken = token;

      // Очищаем поля суммы при смене валюты депозита
      ['deposit-amount', 'deposit-usdt', 'deposit-citro'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      ['deposit-amount-error', 'deposit-usdt-error', 'deposit-citro-error'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
      });

      // Обновляем кнопку-триггер
      if (token === 'BOTH') {
        display.innerHTML =
          `<div class="option-icons-pair">
             <img class="select-val-icon" src="${ICONS.USDT}"  alt="USDT"  />
             <img class="select-val-icon option-icon--overlap" src="${ICONS.CITRO}" alt="CITRO" />
           </div>
           <span>USDT + CITRO</span>`;
      } else {
        display.innerHTML =
          `<img class="select-val-icon" src="${ICONS[token]}" alt="${token}" />
           <span>${token}</span>`;
      }

      // Переключаем поля суммы
      if (token === 'BOTH') {
        single.style.display = 'none';
        both.style.display   = 'grid';
      } else {
        single.style.display = 'flex';
        both.style.display   = 'none';
        if (unitLabel) unitLabel.textContent = token;
      }

      wrapper.classList.remove('is-open');
      updateCreateBtn();           // пересчитываем кнопку при смене валюты депозита
      onGridSettingsChanged();     // и таблицу/инфо-блок при смене валюты депозита
      clearMinDepositErrors();     // снимаем старую ошибку минимума (валюта изменилась)
      scheduleMinDepositCheck();   // и считаем заново для новой валюты
    });
  });
}


// ЗАКРЫТИЕ ДРОПДАУНОВ ПО КЛИКУ СНАРУЖИ

// Закрывает все дропдауны, кроме исключения (если передан)
function closeAllDropdowns(except) {
  document.querySelectorAll('.custom-select.is-open').forEach(el => {
    if (el !== except) el.classList.remove('is-open');
  });
}

// Глобальный обработчик: клик в любом месте = закрыть все дропдауны
function setupDropdownClose() {
  document.addEventListener('click', () => closeAllDropdowns());
}


// ВАЛИДАЦИЯ ЧИСЛОВЫХ ПОЛЕЙ
// Принимает только цифры (и точку для дробных).
// При попытке ввести недопустимый символ — удаляет его
// и показывает сообщение об ошибке под полем.
function setupValidation() {
  // Депозит — максимум 2 знака, запятая → точка, значение > 0
  setupNumericField('deposit-amount', 'deposit-amount-error', { integer: false, maxDecimals: 2, convertComma: true, positive: true });
  setupNumericField('deposit-usdt',   'deposit-usdt-error',   { integer: false, maxDecimals: 2, convertComma: true, positive: true });
  setupNumericField('deposit-citro',  'deposit-citro-error',  { integer: false, maxDecimals: 2, convertComma: true, positive: true });

  // После каждого ввода суммы: проверяем баланс + проверяем минимум на сетку
  ['deposit-amount', 'deposit-usdt', 'deposit-citro'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', checkDepositBalance);
    document.getElementById(id)?.addEventListener('input', scheduleMinDepositCheck);
  });

  // Цены сетки — максимум 5 знаков, запятая → точка, значение > 0
  setupNumericField('price-low',  'price-low-error',  { integer: false, maxDecimals: 5, convertComma: true, positive: true });
  setupNumericField('price-high', 'price-high-error', { integer: false, maxDecimals: 5, convertComma: true, positive: true });

  // Целое число, диапазон 2–100
  setupNumericField('grid-count', 'grid-count-error', { integer: true, min: GRID_COUNT_MIN, max: GRID_COUNT_MAX });

  // При изменении кол-ва сеток пересчитываем минимум депозита
  document.getElementById('grid-count')?.addEventListener('input', scheduleMinDepositCheck);

  // Кросс-валидация: верхняя граница > нижней
  setupPriceRangeValidation();

  // Минимальный шаг сетки (покрытие комиссий + защита от вырожденной сетки)
  ['price-low', 'price-high', 'grid-count'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', validateGridStep);
    el.addEventListener('blur',  validateGridStep);
  });

  // Поле названия бота: живая проверка уникальности имени.
  // При вводе снимаем прежнюю ошибку и сразу сверяем имя со списком уже
  // созданных ботов — дубликат подсвечивается под полем мгновенно.
  const botName = document.getElementById('bot-name');
  if (botName) {
    botName.addEventListener('input', () => {
      const err = document.getElementById('bot-name-error');
      if (err) err.textContent = '';
      validateBotName();
    });
    botName.addEventListener('blur', validateBotName);
  }

  setupInvalidStateSync();
}


// Синхронизирует класс is-invalid на input с наличием текста в его field-error.
// Предполагает соглашение: errorId = inputId + '-error'.
// Исключение: deposit-both-error подсвечивает сразу оба поля режима USDT+CITRO.
function setupInvalidStateSync() {
  document.querySelectorAll('.field-error[id]').forEach(errorEl => {
    if (errorEl.id === 'deposit-both-error') {
      // Специальный случай: ошибка относится к обоим полям сразу
      const usdtInput  = document.getElementById('deposit-usdt');
      const citroInput = document.getElementById('deposit-citro');
      new MutationObserver(() => {
        const hasError = !!errorEl.textContent.trim();
        if (usdtInput)  usdtInput.classList.toggle('is-invalid', hasError);
        if (citroInput) citroInput.classList.toggle('is-invalid', hasError);
      }).observe(errorEl, { childList: true, characterData: true, subtree: true });
      return;
    }

    const inputId = errorEl.id.replace(/-error$/, '');
    const input = document.getElementById(inputId);
    if (!input) return;
    new MutationObserver(() => {
      input.classList.toggle('is-invalid', !!errorEl.textContent.trim());
    }).observe(errorEl, { childList: true, characterData: true, subtree: true });
  });
}


// КНОПКА "СОЗДАТЬ БОТА"
// Активна только когда все поля заполнены корректно
function updateCreateBtn() {
  const btn = document.getElementById('create-btn');
  if (!btn) return;

  // 1. Название бота — любой непустой текст
  const nameOk = !!document.getElementById('bot-name')?.value.trim();

  // 2. API ключ выбран из дропдауна
  const keyOk = !!document.getElementById('api-select')?.dataset.selectedKeyId;

  // 3. Депозит: зависит от текущего режима (одна валюта или обе)
  const isBothMode = document.getElementById('deposit-both')?.style.display !== 'none';
  let depositOk;
  if (isBothMode) {
    const usdt  = parseFloat(document.getElementById('deposit-usdt')?.value);
    const citro = parseFloat(document.getElementById('deposit-citro')?.value);
    depositOk = usdt > 0 && citro > 0;
  } else {
    const amount = parseFloat(document.getElementById('deposit-amount')?.value);
    depositOk = amount > 0;
  }

  // 4. Ценовые границы: оба заполнены и верхняя > нижней
  const low  = parseFloat(document.getElementById('price-low')?.value);
  const high = parseFloat(document.getElementById('price-high')?.value);
  const lowOk  = low  > 0;
  const highOk = high > 0 && high > low;

  // 5. Количество сеток: целое число в диапазоне 2–100
  const gridVal = parseInt(document.getElementById('grid-count')?.value, 10);
  const gridOk  = Number.isInteger(gridVal) && gridVal >= GRID_COUNT_MIN && gridVal <= GRID_COUNT_MAX;

  // Блокируем при ошибках в полях (дубликат имени, превышение баланса, формат и т.п.)
  const errorFields = [
    'bot-name-error',
    'deposit-amount-error', 'deposit-usdt-error', 'deposit-citro-error', 'deposit-both-error',
    'price-low-error', 'price-high-error', 'grid-count-error',
  ];
  const hasFieldError = errorFields.some(id =>
    document.getElementById(id)?.textContent.trim()
  );

  // Кнопка активна, когда форма валидна — и при создании, и при запуске
  // существующего бота. (Гейта «только при изменениях» нет: запуск ведётся
  // через эту страницу, и неизменённый, но валидный бот должен запускаться;
  // а если цена ушла и конфиг стал невалидным — поля сами заблокируют кнопку.)
  btn.disabled = !(nameOk && keyOk && depositOk && lowOk && highOk && gridOk && !hasFieldError);
}


// ЖИВАЯ ПРОВЕРКА УНИКАЛЬНОСТИ ИМЕНИ БОТА
// Имя сверяется со списком уже созданных ботов сразу при вводе — ошибка
// появляется под полем, не дожидаясь отправки. Сервер остаётся источником
// истины (повторно проверит при создании, на случай устаревшего списка).
function loadExistingBotNames() {
  // Мгновенно — из кэша «Мои боты» (тот же, что наполняет страница ботов)
  const cached = makeCache('bots').read();
  userBots = Array.isArray(cached) ? cached : [];
  userBots.forEach(b => { if (b && b.name) existingBotNames.add(b.name); });
  validateBotName();

  // Затем сверяемся с сервером (источник истины) и перепроверяем поле
  const token = localStorage.getItem('token');
  fetch('/api/bots/list', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.bots) return;
      userBots = data.bots;
      existingBotNames = new Set(data.bots.map(b => b.name).filter(Boolean));
      validateBotName();
    })
    .catch(() => {}); // сеть недоступна — остаёмся на данных из кэша
}

// Быстрый ОФЛАЙН-резерв для предупреждения: есть ли другой АКТИВНЫЙ spot-grid
// бот на том же API-ключе. Точную проверку «тот же аккаунт» (в т.ч. при разных
// ключах) делает префлайт на бэкенде; этот резерв используем, пока префлайт не
// ответил или биржа недоступна. Себя при редактировании исключаем.
function sameKeyActiveBotExists() {
  if (!currentKeyId) return false;
  return userBots.some(b =>
    b && b.strategy === 'spot_grid' &&
    b.status === 'active' &&
    b.api_key_id === currentKeyId &&
    b.id !== (editingBot && editingBot.id)
  );
}

// Показывает/снимает ошибку «такое имя уже есть» под полем названия.
// Управляет только своим текстом (ERR.botNameDuplicate), чужие ошибки не трогает.
function validateBotName() {
  const input = document.getElementById('bot-name');
  const err   = document.getElementById('bot-name-error');
  if (!input || !err) return;

  const name = input.value.trim();
  // Собственное имя редактируемого бота дубликатом не считаем
  const taken = name && existingBotNames.has(name) && name !== (editingBot && editingBot.name);
  if (taken) {
    err.textContent = ERR.botNameDuplicate;
  } else if (err.textContent === ERR.botNameDuplicate) {
    err.textContent = ''; // имя больше не занято — снимаем нашу ошибку
  }
  updateCreateBtn();
}


// МОДАЛ ПОДТВЕРЖДЕНИЯ СОЗДАНИЯ БОТА
// Открывается по кнопке «Создать бота». Сводка считается по СВЕЖЕМУ
// стакану в момент открытия — между заполнением формы и кликом цена
// могла измениться, поэтому данные со страницы не переиспользуем.

// Версия расчёта сводки — защита от гонки (закрыли модал и тут же открыли)
let confirmRequestId = 0;

function setupConfirmModal() {
  const createBtn = document.getElementById('create-btn');
  const closeBtn  = document.getElementById('confirm-close-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');
  if (!createBtn || !closeBtn || !cancelBtn) return;

  createBtn.addEventListener('click',  openConfirmModal);
  closeBtn.addEventListener('click',   closeConfirmModal);
  cancelBtn.addEventListener('click',  closeConfirmModal);

  // «Создать» (autostart=false) сохраняет бота; «Создать и запустить»
  // (autostart=true) дополнительно активирует его и показывает прогресс сетки.
  document.getElementById('confirm-create-btn')?.addEventListener('click', () => submitBot(false));
  document.getElementById('confirm-create-run-btn')?.addEventListener('click', () => submitBot(true));

  // Галочка принятия рисков управляет доступностью кнопок создания
  document.getElementById('confirm-risk-checkbox')
    ?.addEventListener('change', updateConfirmButtons);
}

// Отправка бота на сервер. autostart=true («…и запустить») → бот сразу active,
// и мы показываем прогресс выставления сетки (launchAndPoll), не уходя со страницы.
async function submitBot(autostart) {
  const createBtn = document.getElementById('confirm-create-btn');
  const runBtn    = document.getElementById('confirm-create-run-btn');
  const errEl     = document.getElementById('confirm-submit-error');
  const token     = localStorage.getItem('token');
  if (!createBtn || !runBtn) return;

  // Конфигурация из формы — ЧИСЛАМИ (сервер принимает только числа)
  const dep = readDeposit();
  const deposit = dep.mode === 'BOTH'
    ? { mode: 'BOTH', usdt: dep.usdt, citro: dep.citro }
    : { mode: dep.mode, amount: dep.amount };

  const payload = {
    name:      document.getElementById('bot-name').value.trim(),
    apiKeyId:  currentKeyId,
    strategy:  'spot_grid',
    autostart: autostart,   // «…и запустить» → бот сразу активен
    config: {
      deposit,
      priceLow:  parseFloat(document.getElementById('price-low').value),
      priceHigh: parseFloat(document.getElementById('price-high').value),
      gridCount: parseInt(document.getElementById('grid-count').value, 10),
    }
  };
  // В режиме правки добавляем id редактируемого бота
  if (editingBot) payload.botId = editingBot.id;

  // Блокируем обе кнопки на время запроса, показываем прогресс на нажатой
  if (errEl) errEl.hidden = true;
  const pressed     = autostart ? runBtn : createBtn;
  const restoreText = pressed.textContent;
  createBtn.disabled  = true;
  runBtn.disabled     = true;
  pressed.textContent = editingBot ? 'Сохранение…' : 'Создание…';

  try {
    const res  = await fetch(editingBot ? '/api/bots/update' : '/api/bots/create', {
      method:  editingBot ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      pressed.textContent = restoreText;

      // Дубликат имени: запоминаем имя для живой проверки и показываем ошибку
      // под полем «Название бота» (не в окне). Окно закрываем; кнопку «Создать
      // бота» гасит updateCreateBtn по непустой bot-name-error.
      if (data.code === 'duplicate_name') {
        existingBotNames.add(payload.name);
        const nameErr = document.getElementById('bot-name-error');
        if (nameErr) nameErr.textContent = ERR.botNameDuplicate;
        closeConfirmModal();
        updateCreateBtn();
        document.getElementById('bot-name')?.focus();
        return;
      }
      // Неверный формат имени (из UI практически недостижимо) — тоже под поле
      if (data.code === 'invalid_format' && data.field === 'name') {
        const nameErr = document.getElementById('bot-name-error');
        if (nameErr) nameErr.textContent = data.error || ERR.invalidValue;
        closeConfirmModal();
        updateCreateBtn();
        document.getElementById('bot-name')?.focus();
        return;
      }

      // Лимит ордеров: показываем в спец-блоке #confirm-limit (а не в submit-error),
      // чтобы не дублировать сообщение. С предзагрузкой лимита этот путь почти
      // недостижим (кнопки уже погашены), но оставляем как страховку.
      if (data.code === 'order_limit') {
        confirmOverLimit = true;
        const limitEl = document.getElementById('confirm-limit');
        if (limitEl) { limitEl.textContent = ORDER_LIMIT_MSG; limitEl.hidden = false; }
        updateConfirmButtons();
        return;
      }

      // Прочие ошибки (лимит ботов, бот уже активен, сеть и т.п.) — в окне
      if (errEl) {
        errEl.textContent = data.error || (editingBot ? 'Не удалось сохранить изменения' : 'Не удалось создать бота');
        errEl.hidden = false;
      }
      updateConfirmButtons(); // вернёт активность по галочке/готовности сводки
      return;
    }

    // Успех: обновляем кэш «Мои боты» (правка заменяет, создание добавляет)
    if (editingBot) replaceBotInCache(data.bot);
    else            addBotToCache(data.bot);

    // При «…и запустить» НЕ уходим сразу: показываем процесс выставления сетки
    // и переходим на «Мои боты» только когда все ордера реально встали.
    if (autostart && data.bot) {
      const expected = parseInt(payload.config.gridCount, 10);
      enterLaunchingMode();
      launchAndPoll(data.bot.id, expected);
      return;
    }
    window.location.href = '/bots/';

  } catch {
    if (errEl) {
      errEl.textContent = 'Нет соединения с сервером';
      errEl.hidden = false;
    }
    pressed.textContent = restoreText;
    updateConfirmButtons();
  }
}

// Добавляет нового бота в начало localStorage-кэша «Мои боты».
// Кэш привязан к userId — как у ключей (apiKeys_<userId>).
// Состояние «выставляется сетка» (между созданием бота и готовностью сетки)
// Пока true — окно подтверждения не закрывается (closeConfirmModal), чтобы
// пользователь не ушёл, пока ордера ещё выставляются воркером.
let isLaunching = false;

function setLaunchText(t) {
  const el = document.getElementById('confirm-launch-text');
  if (el) el.textContent = t;
}

// Переводит окно в режим запуска: прячем сводку и подвал, показываем спиннер.
function enterLaunchingMode() {
  isLaunching = true;
  const hide = (id) => { const el = document.getElementById(id); if (el) el.hidden = true; };
  hide('confirm-summary'); hide('confirm-error'); hide('confirm-loading');
  const launch = document.getElementById('confirm-launch');
  if (launch) launch.hidden = false;
  const ft = document.querySelector('#confirm-overlay .modal-ft');
  if (ft) ft.style.display = 'none';
  const closeBtn = document.getElementById('confirm-close-btn');
  if (closeBtn) closeBtn.disabled = true;
  const title = document.getElementById('confirm-title');
  if (title) title.textContent = 'Выставление ордеров';
  setLaunchText('Запуск бота: выставляется сетка…');
}

// Запуск не удался (воркер вернул бота в inactive с причиной). Показываем
// причину и единственную кнопку — перейти к «Мои боты».
function showLaunchError(msg) {
  isLaunching = false;
  const launch = document.getElementById('confirm-launch');
  if (launch) launch.hidden = true;
  const errEl = document.getElementById('confirm-error');
  if (errEl) { errEl.textContent = 'Не удалось запустить бота: ' + msg; errEl.hidden = false; }
  const ft = document.querySelector('#confirm-overlay .modal-ft');
  const createBtn = document.getElementById('confirm-create-btn');
  const runBtn    = document.getElementById('confirm-create-run-btn');
  if (createBtn) createBtn.style.display = 'none';
  if (runBtn)    runBtn.style.display = 'none';
  if (ft) ft.style.display = '';
  const cancel = document.getElementById('confirm-cancel-btn');
  if (cancel) { cancel.disabled = false; cancel.textContent = 'К «Мои боты»'; cancel.onclick = () => { window.location.href = '/bots/'; }; }
}

// Опрашивает статус запуска и уходит на «Мои боты», когда вся сетка выставлена.
// expected — сколько ордеров должно встать (= число сеток). На ошибку воркера
// показываем причину, по таймауту — всё равно уходим (бот активен).
async function launchAndPoll(botId, expected) {
  const token = localStorage.getItem('token');
  // Опрашиваем часто (≈раз в 0.6 с), чтобы прогресс рос плавно: 1/5, 2/5, …
  // Это запросы к нашему серверу (не к бирже), поэтому частый опрос безопасен.
  const POLL_MS = 600, TIMEOUT_MS = 90000;
  const t0 = Date.now();
  const goToBots = () => { window.location.href = '/bots/'; };
  setLaunchText(`Запуск бота: выставляется сетка… (0/${expected})`);

  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let data;
    try {
      const res = await fetch('/api/bots/list?launchStatus=' + encodeURIComponent(botId), {
        headers: { 'Authorization': 'Bearer ' + token },
        cache: 'no-store',          // прогресс запуска не берём из кэша браузера
      });
      if (!res.ok) continue;        // временная ошибка сервера — пробуем снова
      data = await res.json();
    } catch { continue; }           // сеть моргнула — пробуем снова

    // Воркер не смог запустить / остановил бота (нет средств, частично и т.п.)
    if (data.status !== 'active' && data.statusMessage) { showLaunchError(data.statusMessage); return; }

    setLaunchText(`Запуск бота: выставляется сетка… (${data.open || 0}/${expected})`);
    if ((data.open || 0) >= expected && (data.placing || 0) === 0) {
      isLaunching = false;
      setLaunchText('Сетка выставлена ✓');
      await new Promise(r => setTimeout(r, 700));
      goToBots();
      return;
    }
  }
  // Таймаут: бот активен, ордера ещё выставляются — уходим в «Мои боты».
  isLaunching = false;
  setLaunchText('Сетка ещё выставляется — открываю «Мои боты»…');
  await new Promise(r => setTimeout(r, 700));
  goToBots();
}

function addBotToCache(bot) {
  const cache = makeCache('bots');
  const list = cache.read() || [];
  list.unshift(bot);
  cache.write(list);
}

// Заменяет бота в кэше «Мои боты» (после сохранения правок)
function replaceBotInCache(bot) {
  const cache = makeCache('bots');
  const list = cache.read() || [];
  const i = list.findIndex(b => b.id === bot.id);
  if (i !== -1) list[i] = bot; else list.unshift(bot);
  cache.write(list);
}

// Читает кэш «Мои боты» (массив) для предзаполнения формы в режиме правки
function readBotsCache() {
  return makeCache('bots').read() || [];
}


// РЕЖИМ РЕДАКТИРОВАНИЯ
// При переходе с «Мои боты» по ?edit=<botId> страница открывается с уже
// подставленными настройками бота; кнопка создания превращается в «Внести
// изменения» (активна только при изменениях), а окно подтверждения — в
// «Подтвердите внесённые изменения» с кнопками «Сохранить» / «…и запустить».
function setupEditMode() {
  const editId = new URLSearchParams(location.search).get('edit');
  if (!editId) return; // обычный режим создания

  // Мгновенно — из кэша (страница ботов его наполняет)
  const bot = readBotsCache().find(b => b.id === editId);
  if (bot) { applyEditMode(bot); return; }

  // Нет в кэше (прямой переход по ссылке / устаревший кэш) — тянем с сервера
  const token = localStorage.getItem('token');
  fetch('/api/bots/list', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const b = data && data.bots ? data.bots.find(x => x.id === editId) : null;
      if (b) applyEditMode(b);
      else   window.location.replace('/bots/'); // бот не найден — назад к списку
    })
    .catch(() => {});
}

function applyEditMode(bot) {
  // Активного бота редактировать нельзя — UI на странице ботов блокирует кнопку,
  // здесь защищаемся от прямого перехода по ссылке.
  if (bot.status === 'active') { window.location.replace('/bots/'); return; }

  editingBot = bot;

  // Заголовки и подписи под режим правки
  const navTitle = document.querySelector('.bot-nav-title');
  if (navTitle) navTitle.textContent = 'Настройка бота';

  const createBtn = document.getElementById('create-btn');
  if (createBtn) createBtn.textContent = 'Запустить бота';

  const confirmTitle = document.getElementById('confirm-title');
  if (confirmTitle) confirmTitle.textContent = 'Подтвердите внесённые изменения';
  const cCreate = document.getElementById('confirm-create-btn');
  if (cCreate) cCreate.textContent = 'Сохранить';
  const cRun = document.getElementById('confirm-create-run-btn');
  if (cRun) cRun.textContent = 'Сохранить и запустить';

  prefillForm(bot);

  validateBotName();
  updateCreateBtn();
}

// Подставляет данные бота в поля формы (через события — чтобы отработала
// валидация, отрисовка сетки и пересчёт таблицы)
function prefillForm(bot) {
  const cfg = bot.config || {};

  // Имя
  const nameInput = document.getElementById('bot-name');
  if (nameInput) nameInput.value = bot.name || '';

  // API ключ — клик по нужному пункту (выставит currentKeyId, UI и подтянет баланс)
  const keyItem = document.querySelector(
    `#api-select-list .select-item--key[data-key-id="${CSS.escape(bot.api_key_id || '')}"]`);
  if (keyItem) keyItem.click();

  // Валюта депозита — выбираем режим (он переключит поля и очистит суммы)...
  const mode = (cfg.deposit && cfg.deposit.mode) || 'USDT';
  const depItem = document.querySelector(`#deposit-select-list .select-item[data-token="${mode}"]`);
  if (depItem) depItem.click();

  // ...затем заполняем суммы и параметры (через input/blur — запускаем валидацию)
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (!el || val == null) return;
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur',  { bubbles: true }));
  };

  if (mode === 'BOTH') {
    setVal('deposit-usdt',  cfg.deposit.usdt);
    setVal('deposit-citro', cfg.deposit.citro);
  } else {
    setVal('deposit-amount', cfg.deposit && cfg.deposit.amount);
  }

  setVal('price-low',  cfg.priceLow);
  setVal('price-high', cfg.priceHigh);
  setVal('grid-count', cfg.gridCount);
}

// true, когда сводка успешно загружена и показана (состояние 'summary')
let confirmSummaryReady = false;
// true, когда сетка не помещается в лимит биржи (100 ордеров) — блокирует кнопки
let confirmOverLimit = false;

// Переключает тело модала между состояниями: 'loading' | 'error' | 'summary'
function setConfirmState(state, errorText = '') {
  const loading = document.getElementById('confirm-loading');
  const error   = document.getElementById('confirm-error');
  const summary = document.getElementById('confirm-summary');

  if (loading) loading.hidden = state !== 'loading';
  if (summary) summary.hidden = state !== 'summary';
  if (error) {
    error.hidden      = state !== 'error';
    error.textContent = state === 'error' ? errorText : '';
  }

  confirmSummaryReady = state === 'summary';
  updateConfirmButtons();
}

// Кнопки «Создать» и «Создать и запустить» активны только при двух условиях:
// сводка успешно загружена И пользователь принял риски (галочка)
function updateConfirmButtons() {
  const agreed  = !!document.getElementById('confirm-risk-checkbox')?.checked;
  // Превышение лимита биржи блокирует и создание, и запуск (по требованию).
  const enabled = confirmSummaryReady && agreed && !confirmOverLimit;

  const createBtn = document.getElementById('confirm-create-btn');
  const runBtn    = document.getElementById('confirm-create-run-btn');
  if (createBtn) createBtn.disabled = !enabled;
  if (runBtn)    runBtn.disabled    = !enabled;
}

// Открытие модала: показываем загрузку, тянем свежий стакан, считаем сводку
async function openConfirmModal() {
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) return;

  // Кнопка активна только при валидной форме, но состояние могло устареть
  // (например, цена пропала после потери соединения) — перепроверяем
  if (gridInputsReason()) return;

  const reqId = ++confirmRequestId;

  // Согласие с рисками запрашиваем заново при каждом открытии —
  // это осознанное подтверждение перед каждым созданием бота
  const risk = document.getElementById('confirm-risk-checkbox');
  if (risk) risk.checked = false;

  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  setConfirmState('loading');

  // Свежий стакан — сводка считается по актуальным данным биржи
  let ob;
  try {
    ob = await fetchOrderbook();
  } catch {
    ob = null;
  }

  // Пока ждали ответ, модал закрыли (и могли открыть заново) — расчёт устарел
  if (reqId !== confirmRequestId) return;

  if (!ob) {
    setConfirmState('error', 'Не удалось получить данные биржи. Попробуйте позже.');
    return;
  }

  const { orders, conversion } = computeGridOrders(ob);
  renderConfirmSummary(orders, conversion);
  setConfirmState('summary');

  // Состояние аккаунта уже загружено при выборе ключа → блок/предупреждение
  // показываем СРАЗУ (без задержки). Фоном освежаем — вдруг ордера изменились.
  renderAccountChecks();
  refreshAccountState();
}

function closeConfirmModal() {
  if (isLaunching) return; // во время выставления сетки окно не закрываем
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  confirmRequestId++; // ответ запроса в полёте (если он есть) будет проигнорирован
}

// Заполняет строки сводки и блок обмена по рассчитанным ордерам
function renderConfirmSummary(orders, conversion) {
  const rowsEl  = document.getElementById('confirm-rows');
  const swapBox = document.getElementById('confirm-swap-box');
  const swapEl  = document.getElementById('confirm-swap');
  if (!rowsEl) return;

  // Имя выбранного API-ключа — из того же кэша, что и дропдаун
  const key     = getApiKeysFromCache().find(k => k.id === currentKeyId);
  const keyName = key ? key.name : '—';

  // Мини-иконка монеты для строк «Торговая пара» и «Депозит»
  const coin = t => `<img class="confirm-coin" src="${COIN_ICON[t]}" alt="${t}" />`;

  // Депозит в человекочитаемом виде (значения уже прошли валидацию полей)
  const dep = readDeposit();
  const depHtml = dep.mode === 'BOTH'
    ? `${coin('USDT')}${dep.usdt} USDT&nbsp;&nbsp;+&nbsp;&nbsp;${coin('CITRO')}${dep.citro} CITRO`
    : `${coin(dep.mode)}${dep.amount} ${dep.mode}`;

  const low   = document.getElementById('price-low').value;
  const high  = document.getElementById('price-high').value;
  const count = parseInt(document.getElementById('grid-count').value, 10);

  // Шаг сетки = (Верх − Низ) / Кол-во. Сетка арифметическая, поэтому шаг в цене
  // точный; приводим к аккуратному виду (без хвостовых нулей, без единицы).
  const stepNum = (parseFloat(high) - parseFloat(low)) / count;
  const step    = (isFinite(stepNum) && stepNum > 0) ? parseFloat(stepNum.toFixed(8)).toString() : '—';

  // Сколько ордеров каждого типа выставит бот при запуске
  const buys  = orders.filter(o => o.type === 'buy').length;
  const sells = orders.length - buys;

  // Пары «метка → готовый HTML значения». Пользовательский ввод
  // (название бота, имя ключа) экранируем; числа и иконки безопасны
  const rows = [
    ['Название бота',      escapeHtml(document.getElementById('bot-name').value.trim())],
    ['API ключ',           escapeHtml(keyName)],
    ['Торговая пара',      `${coin('CITRO')}CITRO / USDT`],
    ['Депозит',            depHtml],
    ['Диапазон цен',       `${low} — ${high}`],
    ['Количество сеток',   String(count)],
    ['Шаг сетки',          step],
    ['Ордера при запуске', `${buys} на покупку, ${sells} на продажу`],
  ];

  rowsEl.innerHTML = rows.map(([label, html]) => `
    <div class="confirm-row">
      <span class="confirm-row-label">${label}</span>
      <span class="confirm-row-value">${html}</span>
    </div>
  `).join('');

  // Блок обмена показываем, только если обмен реально потребуется
  if (conversion && swapEl && swapBox) {
    swapEl.innerHTML = swapHtml(conversion);
    swapBox.hidden = false;
  } else if (swapBox) {
    swapBox.hidden = true;
  }

  // Предупреждение + блок лимита — мгновенно из уже загруженного состояния
  // аккаунта (оно подтягивается при выборе ключа, см. refreshAccountState).
  renderAccountChecks();
}

// Тексты предупреждения/блокировки — единые (бэкенд шлёт тот же текст лимита).
const ACCOUNT_WARN_TEXT =
  'Обратите внимание, что на этом аккаунте уже запущен Spot Grid Bot по паре ' +
  'CITRO/USDT. Запуск нескольких ботов одновременно может привести к их ' +
  'некорректной работе.';
const ORDER_LIMIT_MSG =
  'При заданном количестве сеток будет превышен лимит биржи в 100 лимитных ' +
  'ордеров. Закройте ордера на бирже или уменьшите количество сеток для бота.';

// Показывает/прячет предупреждение о втором активном боте на аккаунте.
function setAccountWarning(show) {
  const keywarn = document.getElementById('confirm-keywarn');
  if (!keywarn) return;
  keywarn.textContent = ACCOUNT_WARN_TEXT;
  keywarn.hidden = !show;
}

// Состояние аккаунта по бирже: сколько ещё ордеров можно открыть (free) и есть ли
// другой активный бот. Грузится ЗАРАНЕЕ — при выборе ключа (refreshAccountState),
// чтобы окно подтверждения сразу знало про лимит, без задержки и «окна гонки»,
// в котором пользователь успевал бы отправить запрос до появления ошибки.
let accountState = { keyId: null, verified: false, free: Infinity, sameAccountActiveBot: false };

// Мгновенно (без сети) применяет известное состояние аккаунта к окну подтверждения:
// предупреждение о втором боте + жёсткий блок по лимиту (число сеток > свободно).
// Превышение зависит только от уже загруженного free и текущего числа сеток.
function renderAccountChecks() {
  const fresh = accountState.verified && accountState.keyId === currentKeyId;
  setAccountWarning(fresh ? accountState.sameAccountActiveBot : sameKeyActiveBotExists());

  const gc = parseInt(document.getElementById('grid-count')?.value, 10);
  confirmOverLimit = !!(fresh && Number.isFinite(gc) && gc > accountState.free);
  const limitEl = document.getElementById('confirm-limit');
  if (limitEl) {
    limitEl.textContent = ORDER_LIMIT_MSG;
    limitEl.hidden = !confirmOverLimit;
  }
  updateConfirmButtons();
}

// Подтягивает состояние аккаунта (свободные слоты + другой активный бот) по
// ТЕКУЩЕМУ ключу. Зовётся при выборе ключа и фоном при открытии окна. free не
// зависит от числа сеток, поэтому грузим заранее, а превышение считаем локально.
// verified=false (биржа недоступна) → не блокируем по лимиту (страхует воркер).
async function refreshAccountState() {
  const keyId = currentKeyId;
  if (!keyId) {
    accountState = { keyId: null, verified: false, free: Infinity, sameAccountActiveBot: false };
    renderAccountChecks();
    return;
  }
  const token = localStorage.getItem('token');
  let url = '/api/bots/list?accountCheck=' + encodeURIComponent(keyId);
  if (editingBot && editingBot.id) url += '&exclude=' + encodeURIComponent(editingBot.id);
  let pf = { verified: false };
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (r.ok) pf = await r.json();
  } catch { /* сеть недоступна — остаёмся с verified:false */ }

  if (currentKeyId !== keyId) return; // ключ сменили, пока ждали ответ — он устарел
  accountState = {
    keyId,
    verified: !!pf.verified,
    free: Number.isFinite(pf.free) ? pf.free : Infinity,
    sameAccountActiveBot: !!pf.sameAccountActiveBot,
  };
  renderAccountChecks();
}


// Навешивает валидацию на числовое поле по модели «показать ошибку, не исправлять».
// Недопустимый ввод остаётся в поле и подсвечивается ошибкой. Единственные
// автоисправления: запятая → точка и молчаливое отсечение лишних знаков дробной части.
//
// integer:      true  → только целые числа (точка/символы — ошибка)
// positive:     true  → значение должно быть > 0 (проверяется на blur)
// min / max           → допустимый диапазон целого (проверяется на blur)
// maxDecimals         → максимум знаков после точки (лишние молча отсекаются)
// convertComma: true  → запятая автоматически меняется на точку
function setupNumericField(inputId, errorId,
  { integer = false, min = null, max = null, maxDecimals = null, convertComma = false, positive = false } = {}) {

  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (!input || !error) return;

  const MSG_CHAR     = integer ? ERR.onlyIntegers : ERR.onlyNumbers;
  const MSG_FORMAT   = ERR.invalidValue;
  const MSG_POSITIVE = ERR.positive;

  // Сообщения, которыми владеет ИМЕННО это поле. «Чужие» ошибки (баланс,
  // минимальный депозит, «верхняя > нижней») это поле не затирает — их ведут
  // свои обработчики, которые срабатывают после нас.
  const ownMessages = [MSG_CHAR, MSG_FORMAT, MSG_POSITIVE];
  if (integer && min !== null && max !== null) {
    ownMessages.push(ERR.range(min, max));
  }

  // Ставит нашу ошибку; при её отсутствии снимает текст только если он наш.
  function applyError(msg) {
    if (msg) {
      error.textContent = msg;
    } else if (ownMessages.includes(error.textContent)) {
      error.textContent = '';
    }
    input.classList.toggle('is-invalid', !!error.textContent.trim());
    updateCreateBtn();
  }

  // Возвращает текст формат-ошибки для значения (или '' если формат корректен).
  // partial=true — мягкий режим во время набора (разрешает незавершённое «1.»).
  function formatError(v, partial) {
    if (v === '') return '';
    if (integer) {
      if (!/^\d+$/.test(v)) return MSG_CHAR;    // только цифры
      if (/^0\d/.test(v))   return MSG_FORMAT;  // ведущий ноль (06, 00) — недопустим
      return '';
    }

    if (!/^[0-9.]+$/.test(v))               return MSG_CHAR;   // буквы/символы
    if ((v.match(/\./g) || []).length > 1)  return MSG_FORMAT; // больше одной точки
    if (v.startsWith('.'))                  return MSG_FORMAT;  // .5
    if (/^0\d/.test(v))                     return MSG_FORMAT;  // ведущий ноль (05, 00)
    if (v.endsWith('.'))                    return partial ? '' : MSG_FORMAT; // 1.
    return '';
  }

  input.addEventListener('input', () => {
    // Автофикс 1: запятая → точка (только в дробных полях)
    if (convertComma && input.value.includes(',')) {
      const cursor = input.selectionStart;
      input.value = input.value.replace(/,/g, '.');
      input.setSelectionRange(cursor, cursor);
    }

    // Автофикс 2: молча отсекаем лишние знаки дробной части (без ошибки),
    // только если значение имеет вид числа с одной точкой
    if (!integer && maxDecimals !== null && /^\d*\.\d*$/.test(input.value)) {
      const [intPart, fracPart] = input.value.split('.');
      if (fracPart.length > maxDecimals) {
        const trimmed = intPart + '.' + fracPart.slice(0, maxDecimals);
        const removed = input.value.length - trimmed.length;
        const cursor  = Math.max(0, input.selectionStart - removed);
        input.value   = trimmed;
        input.setSelectionRange(cursor, cursor);
      }
    }

    applyError(formatError(input.value, true));
  });

  input.addEventListener('blur', () => {
    let msg = formatError(input.value, false);

    if (!msg && input.value !== '') {
      if (integer && min !== null && max !== null) {
        msg = getRangeError(input.value, min, max);
      } else if (positive && parseFloat(input.value) === 0) {
        msg = MSG_POSITIVE;
      }
    }

    applyError(msg);
  });
}


// КРОСС-ВАЛИДАЦИЯ ЦЕН: верхняя граница > нижней
// Проверяется при потере фокуса на любом из двух полей.
// Ошибка исчезает сразу, как только условие выполняется.
function setupPriceRangeValidation() {
  const lowInput  = document.getElementById('price-low');
  const highInput = document.getElementById('price-high');
  const lowError  = document.getElementById('price-low-error');
  const highError = document.getElementById('price-high-error');
  if (!lowInput || !highInput) return;

  const RANGE_MSG = ERR.upperGreaterLower;

  // Проверяет соотношение и проставляет / снимает ошибку
  function validate() {
    const low  = parseFloat(lowInput.value);
    const high = parseFloat(highInput.value);

    // Если хотя бы одно поле пустое или не число — не мешаем
    if (!lowInput.value || !highInput.value || isNaN(low) || isNaN(high)) {
      clearRangeError();
      return;
    }

    // Приоритет у формат-ошибок: если в одном из полей висит НЕ диапазонная
    // ошибка (формат, «> 0» и т.п.) — не перебиваем её диапазонной
    if ((lowError.textContent  && lowError.textContent  !== RANGE_MSG) ||
        (highError.textContent && highError.textContent !== RANGE_MSG)) {
      return;
    }

    if (high <= low) {
      // Показываем ошибку под верхней границей
      highError.textContent = RANGE_MSG;
    } else {
      clearRangeError();
    }
    updateCreateBtn();
  }

  // Снимает ошибку диапазона (только её, не трогая другие ошибки поля)
  function clearRangeError() {
    if (highError.textContent === RANGE_MSG) {
      highError.textContent = '';
      updateCreateBtn();
    }
  }

  // Проверяем при уходе с любого из двух полей
  lowInput.addEventListener('blur',  validate);
  highInput.addEventListener('blur', validate);

  // Живая проверка прямо во время ввода (не ждём blur)
  lowInput.addEventListener('input',  validate);
  highInput.addEventListener('input', validate);
}


// Проверка минимального шага сетки. Шаг = (верхняя − нижняя) / количество должен
// быть не меньше 1% текущей цены — иначе сделки не покрывают комиссии, а уровни
// сливаются (вырожденная сетка). Ошибка показывается под «Количество сеток».
function validateGridStep() {
  const errEl = document.getElementById('grid-count-error');
  if (!errEl) return;

  const low   = parseFloat(document.getElementById('price-low')?.value);
  const high  = parseFloat(document.getElementById('price-high')?.value);
  const count = parseInt(document.getElementById('grid-count')?.value, 10);
  const MSG   = ERR.tooSmallStep;

  // Поля неполные/невалидные или цены ещё нет — не мешаем; снимаем только нашу
  // ошибку, чужие (формат, диапазон) не трогаем.
  if (!(low > 0) || !(high > low) ||
      !Number.isInteger(count) || count < GRID_COUNT_MIN || count > GRID_COUNT_MAX ||
      !(currentPrice > 0)) {
    if (errEl.textContent === MSG) { errEl.textContent = ''; updateCreateBtn(); }
    return;
  }

  const step    = (high - low) / count;
  const minStep = currentPrice * MIN_STEP_PCT; // минимальный шаг — % от текущей цены

  if (step < minStep) {
    errEl.textContent = MSG;
  } else if (errEl.textContent === MSG) {
    errEl.textContent = '';
  }
  updateCreateBtn();
}


// Возвращает строку ошибки, если число вне диапазона, иначе ''
function getRangeError(value, min, max) {
  const num = Number(value);
  if (isNaN(num) || num < min || num > max) {
    return ERR.range(min, max);
  }
  return '';
}


// ЛИНИЯ ТЕКУЩЕЙ ЦЕНЫ НА ГРАФИКЕ
// Синяя сплошная горизонталь — всегда показывает актуальную цену токена.
// Обновляется каждый тик поллинга (каждые 3 секунды).
function updateCurrentPriceLine() {
  if (!candleSeries) return;

  // Удаляем старую линию
  if (currentPriceLine) {
    try { candleSeries.removePriceLine(currentPriceLine); } catch {}
    currentPriceLine = null;
  }

  if (currentPrice === null) return;

  // Рисуем новую в актуальной точке
  currentPriceLine = candleSeries.createPriceLine({
    price:            currentPrice,
    color:            '#00d4ff',  // акцентный синий — совпадает с цветом текста цены
    lineWidth:        1,
    lineStyle:        0,          // 0 = Solid (в отличие от пунктира у сетки)
    axisLabelVisible: true,
    title:            '',
  });
}


// СЕТКА ОРДЕРОВ НА ГРАФИКЕ
// Горизонтальные линии рассчитываются по трём полям:
//   нижняя граница, верхняя граница, количество сеток.
// Цвета: зелёный — покупка, жёлтый — ближайший к цене, красный — продажа.

// Навешиваем обработчики на три поля — перерисовываем при каждом изменении
function setupGridLines() {
  ['price-low', 'price-high', 'grid-count'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateGridLines);
  });
}

// Удаляем все ранее нарисованные линии с графика
function clearGridLines() {
  if (!candleSeries) { gridPriceLines = []; return; }
  gridPriceLines.forEach(line => {
    try { candleSeries.removePriceLine(line); } catch {}
  });
  gridPriceLines = [];
}

// Есть ли видимая ошибка валидации в полях сетки (границы, количество).
// При любой из них линии не рисуются и таблица скрывается.
function hasGridFieldError() {
  return ['price-low-error', 'price-high-error', 'grid-count-error']
    .some(id => document.getElementById(id)?.textContent.trim());
}

// Основная функция: рассчитывает уровни и рисует PriceLine для каждого
function updateGridLines() {
  clearGridLines();
  lastClosestIdx = null; // линии сняты; вернём значение ниже, если нарисуем

  // Нет графика или цена ещё не получена — ничего не рисуем
  if (!candleSeries || currentPrice === null) return;

  // В полях есть ошибка валидации — значение может быть «мусорным»
  // (символы больше не вырезаются), сетку не рисуем
  if (hasGridFieldError()) return;

  // Уровни сетки и ближайший к цене уровень (null — поля некорректны)
  const grid = readGridLevelsFromForm();
  if (!grid) return;

  const { levels, closestIdx } = grid;
  lastClosestIdx = closestIdx;

  // Рисуем линию для каждого уровня
  levels.forEach((price, idx) => {
    let color;
    if (idx === closestIdx) {
      color = '#eab308'; // жёлтый — нейтральный (ближайший к цене)
    } else if (price > levels[closestIdx]) {
      color = '#ef4444'; // красный — ордер на продажу
    } else {
      color = '#22c55e'; // зелёный — ордер на покупку
    }

    const line = candleSeries.createPriceLine({
      price,
      color,
      lineWidth:        1,
      lineStyle:        2,    // 2 = Dashed
      axisLabelVisible: true,
      title:            '',
    });

    gridPriceLines.push(line);
  });
}
