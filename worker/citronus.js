//  КЛИЕНТ CITRONUS ДЛЯ ВОРКЕРА
//  Подписанные приватные запросы к бирже.
//  Подпись: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + body),
//  заголовки X-CITRO-*. Формат — тот же, что в api/keys/balance.js.
//
//  Приватные методы: get_balance, active_orders, create_order, cancel_order,
//  orders_history. Публичные (без подписи): markets, orderbook, tickers.
const crypto = require('crypto');
const { withRetry, sleep } = require('./net');

const API_URL     = 'https://api.citronus.com/public/v1/jsonrpc';
const RECV_WINDOW = '5000';

// Таймаут запроса. Без него «зависший» ответ биржи заморозил бы весь цикл
// воркера (бот молча перестал бы реагировать) — для денег недопустимо.
const REQUEST_TIMEOUT_MS = 5000;

// Ограничитель частоты запросов к бирже — ОТДЕЛЬНАЯ очередь на каждый ключ
// Лимит биржи — 5 запросов/сек НА КАЖДЫЙ API-ключ (подтверждено документацией).
// Держим минимум 350 мс между запросами ОДНОГО ключа (≤~2.9/сек — большой запас
// к 5). У каждого ключа своя очередь, поэтому аккаунты НЕ мешают друг другу:
// сколько бы ботов ни работало, каждый ключ укладывается в свой лимит независимо.
// Публичные запросы (без ключа: график/стакан/цена/рынок) идут в общей очереди
// 'public' — их немного (примерно раз в тик).
const MIN_REQUEST_INTERVAL_MS = 350;
const _rateBuckets = new Map();      // ключ (или 'public') → { chain: Promise, lastAt: number }
function rateLimit(bucket) {
  let st = _rateBuckets.get(bucket);
  if (!st) { st = { chain: Promise.resolve(), lastAt: 0 }; _rateBuckets.set(bucket, st); }
  st.chain = st.chain.then(async () => {
    const wait = st.lastAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    st.lastAt = Date.now();
  });
  return st.chain;
}

// Повторяем только СЕТЕВЫЕ сбои (нет ответа сервера). Любой ОТВЕТ биржи —
// JSON-RPC error (err.citronus) или HTTP-статус (err.httpStatus) — это
// определённый ответ, а не временный сбой связи; повторять бессмысленно.
const retryNetworkOnly = (e) => !e.citronus && !e.httpStatus;

// Один HTTP-вызов JSON-RPC с таймаутом. Бросает:
//   • при сетевой ошибке/таймауте — без доп. полей (это «нет ответа»);
//   • при HTTP-ошибке — err.httpStatus (и err.authError для 401/403);
//   • при JSON-RPC error от биржи — err.citronus.
async function rpcFetch(headers, body, bucket) {
  await rateLimit(bucket);           // не чаще лимита биржи на ЭТОТ ключ (см. rateLimit)
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, { method: 'POST', headers, body, signal: controller.signal });

    // Тело может быть не-JSON (напр. HTML-страница ошибки) — разбираем безопасно.
    let json = null;
    try { json = await res.json(); } catch { /* не JSON — оставляем null */ }

    // HTTP-ошибка (4xx/5xx). 401/403 — почти наверняка проблема с ключом/доступом.
    if (!res.ok) {
      const err = new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
      err.httpStatus = res.status;
      if (json && json.error) err.citronus = json.error;
      if (res.status === 401 || res.status === 403) err.authError = true;
      throw err;
    }

    // Ошибка уровня JSON-RPC (HTTP 200, но в теле error).
    if (json && json.error) {
      const err = new Error(json.error.message || 'Citronus error');
      err.citronus = json.error;
      throw err;
    }

    return json ? json.result : null;
  } finally {
    clearTimeout(timer); // снимаем таймер в любом исходе
  }
}

// Подписанный приватный вызов. opts.retries — сколько ПОПЫТОК всего
// (1 = без повторов; для чтений ставим 3). timestamp/подпись считаем на
// КАЖДОЙ попытке заново — иначе устаревший timestamp не пройдёт recvWindow.
async function signedRequest(method, params, apiKey, secret, opts = {}) {
  const { retries = 1, log } = opts;
  return withRetry(() => {
    const timestamp = Date.now().toString();
    const body      = JSON.stringify({ jsonrpc: '2.0', method, params, id: '1' });
    const message   = timestamp + apiKey + RECV_WINDOW + body;
    const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return rpcFetch({
      'Content-Type':        'application/json; charset=utf-8',
      'X-CITRO-API-KEY':     apiKey,
      'X-CITRO-TIMESTAMP':   timestamp,
      'X-CITRO-RECV-WINDOW': RECV_WINDOW,
      'X-CITRO-SIGNATURE':   signature
    }, body, apiKey);              // очередь этого запроса — по ключу (лимит на ключ)
  }, { attempts: retries, label: method, log, shouldRetry: retryNetworkOnly });
}

// Доступные балансы spot-кошелька → { USDT, CITRO }.  (чтение — с повторами)
async function getBalance(apiKey, secret) {
  const result = await signedRequest('get_balance', { category: 'spot', include_null: true }, apiKey, secret, { retries: 4 });
  const list   = Array.isArray(result) ? result : [];
  const avail  = (coin) => {
    const item = list.find(b => b.coin_name === coin);
    return item ? parseFloat(item.available) : 0;
  };
  return { USDT: avail('USDT'), CITRO: avail('CITRO') };
}

// Активные ордера (приватный метод, чтение — с повторами). symbol по умолчанию
// CITRO/USDT; передайте null/'' → запрос БЕЗ фильтра по паре, т.е. открытые
// ордера ВСЕГО аккаунта (нужно для проверки общего лимита в 100 ордеров).
async function getActiveOrders(apiKey, secret, symbol = 'CITRO/USDT') {
  const data = symbol ? { symbol } : {};
  return signedRequest('active_orders', { category: 'spot', data }, apiKey, secret, { retries: 4 });
}

// Приводим ответ active_orders к единому виду [{ id, side, price, amount, raw }].
// Форма ответа биржи точно не зафиксирована — разбираем максимально терпимо
// (разные возможные имена полей). При первом разборе логируем образец.
let _activeShapeLogged = false;
function parseActiveOrders(raw, log) {
  const list = Array.isArray(raw) ? raw
             : (raw && Array.isArray(raw.orders) ? raw.orders
             : (raw && Array.isArray(raw.list)   ? raw.list : []));
  const parsed = list.map((o) => {
    const id      = o.order_id != null ? o.order_id : (o.id != null ? o.id : (o.orderId != null ? o.orderId : null));
    const sideRaw = String(o.action != null ? o.action : (o.side != null ? o.side : (o.direction || ''))).toLowerCase();
    const side    = sideRaw.includes('buy') ? 'buy' : (sideRaw.includes('sell') ? 'sell' : sideRaw);
    const price   = parseFloat(o.price != null ? o.price : (o.order_price != null ? o.order_price : o.limit_price));
    const amount  = parseFloat(o.amount != null ? o.amount
                    : (o.current_amount != null ? o.current_amount
                    : (o.original_amount != null ? o.original_amount
                    : (o.qty != null ? o.qty : o.quantity))));
    return { id, side, price, amount, raw: o };
  }).filter((o) => o.id != null && (o.side === 'buy' || o.side === 'sell') && Number.isFinite(o.price));

  if (log && !_activeShapeLogged && list.length > 0) {
    _activeShapeLogged = true;
    const p0 = parsed[0] ? { id: parsed[0].id, side: parsed[0].side, price: parsed[0].price, amount: parsed[0].amount } : null;
    log(`active_orders: разобрано ${parsed.length}/${list.length}; сырой: ${JSON.stringify(list[0]).slice(0, 400)} → разобрано: ${JSON.stringify(p0)}`);
  }
  return parsed;
}

// Создать ордер. data = { symbol, action, type, price?, amount?|total? } —
// строки/числа по формату биржи. Возвращает result (id, status, ...).
// ВАЖНО: БЕЗ автоповтора — повтор create_order может создать дубль (риск денег).
// Безопасный повтор решает runner.js: если биржа ОТВЕТИЛА отказом, ордера точно нет
// и повтор безвреден; если ответа не было — ищем «сироту» (runner.findOrphan).
async function createOrder(data, apiKey, secret) {
  return signedRequest('create_order', { category: 'spot', data }, apiKey, secret);
}

// Отменить ордер по его id (order_id — на уровне params, не в data).
// Без автоповтора; повторную отмену с подтверждением ведёт runner.stopBot.
async function cancelOrder(orderId, apiKey, secret) {
  return signedRequest('cancel_order', { category: 'spot', order_id: orderId }, apiKey, secret);
}

// Публичные методы (без подписи). opts.retries — кол-во попыток.
async function publicRequest(method, params, opts = {}) {
  const { retries = 1, log } = opts;
  return withRetry(() => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: '1' });
    return rpcFetch({ 'Content-Type': 'application/json; charset=utf-8' }, body, 'public');
  }, { attempts: retries, label: method, log, shouldRetry: retryNetworkOnly });
}

// Параметры пары (минимумы, точность, шаг цены, комиссия)  (чтение — с повторами)
async function getMarket(symbol = 'CITRO/USDT') {
  return publicRequest('markets', { category: 'spot', symbol }, { retries: 4 });
}

// Стакан { a:[[price,size]...], b:[[price,size]...] }  (чтение — с повторами)
async function getOrderbook(symbol = 'CITRO/USDT') {
  return publicRequest('orderbook', { category: 'spot', symbol }, { retries: 4 });
}

// Текущая цена (last_price) числом или null  (чтение — с повторами)
async function getPrice(symbol = 'CITRO/USDT') {
  const t = await publicRequest('tickers', { category: 'spot', symbol }, { retries: 4 });
  const p = parseFloat(t && t.last_price);
  return Number.isFinite(p) ? p : null;
}

// История ордеров аккаунта (приватный метод, чтение — с повторами). Нужна, чтобы
// взять ФАКТИЧЕСКИЕ данные исполнения: средневзвешенную цену, исполненный объём и
// реальную комиссию (в QUOTE/USDT). Новейшие сверху.
async function getOrdersHistory(apiKey, secret, { symbol = 'CITRO/USDT', page = 1, pageSize = 100 } = {}) {
  return signedRequest('orders_history', {
    category: 'spot', page, page_size: pageSize,
    data: { symbol, history: 'true', order_by: '-create_date' }
  }, apiKey, secret, { retries: 4 });
}

// Отметка времени ЗАВЕРШЕНИЯ ордера (мс). Нужна для замера, через сколько завершённый
// ордер доезжает до orders_history (см. lagText в runner.js). create_date сюда НЕ
// включаем: это момент создания, а не завершения.
// ПРОВЕРЕНО 04.08.2026: в записи Citronus такого поля НЕТ (есть только create_date),
// поэтому ts всегда null. Оставлено на случай, если биржа его добавит — заработает само.
const HIST_TS_KEYS = ['finish_date', 'finished_at', 'finish_time', 'close_date', 'closed_at',
                      'last_deal_date', 'deal_date', 'update_date', 'updated_at', 'mtime'];
function parseHistoryTs(o) {
  for (const k of HIST_TS_KEYS) {
    const v = o[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;   // мс или секунды
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// Карта id ордера → факт исполнения { price, amount, fee, status, ts } из orders_history.
// price = weighted_average_price (VWAP, QUOTE), amount = deals_amount (исполнено, BASE),
// fee = комиссия в QUOTE (USDT), ts = когда ордер завершился. Поля, которых нет, — null.
// При ПЕРВОМ разборе один раз логируем образец записи: так видно, какими словами биржа
// называет статусы и какие в записи есть отметки времени (форма ответа не зафиксирована).
let _historyShapeLogged = false;
function parseOrdersHistory(raw, log) {
  const list = Array.isArray(raw) ? raw
             : (raw && Array.isArray(raw.items)  ? raw.items
             : (raw && Array.isArray(raw.orders) ? raw.orders
             : (raw && Array.isArray(raw.list)   ? raw.list : [])));

  if (log && !_historyShapeLogged && list.length > 0) {
    _historyShapeLogged = true;
    log(`orders_history: образец записи: ${JSON.stringify(list[0]).slice(0, 700)}`);
  }

  const map = new Map();
  for (const o of list) {
    const id = o.id != null ? o.id : (o.order_id != null ? o.order_id : o.orderId);
    if (id == null) continue;
    const wap  = parseFloat(o.weighted_average_price);
    const deal = parseFloat(o.deals_amount);
    const fee  = parseFloat(o.fee);
    map.set(String(id), {
      price:   Number.isFinite(wap)  ? wap  : null,
      amount:  Number.isFinite(deal) ? deal : null,
      fee:     Number.isFinite(fee)  ? fee  : null,
      status:  o.status != null ? String(o.status) : null,
      ts:      parseHistoryTs(o),
      created: parseCreateTs(o),
    });
  }
  return map;
}

// Дата СОЗДАНИЯ ордера (мс). Она в истории есть всегда (ISO-8601) и по ней же биржа
// сортирует выдачу — на этом построено правило остановки листания.
function parseCreateTs(o) {
  const v = o.create_date != null ? o.create_date : o.created_at;
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Сколько страниц истории максимум читаем за один вызов (страховка от лишней
// нагрузки на биржу). 5 × page_size(100) = до 500 самых свежих ордеров — с большим
// запасом перекрывает одну сетку (≤100 ордеров) даже при активной торговле.
const HISTORY_MAX_PAGES = 5;

// Карта id → факт исполнения из orders_history, собранная ПОСТРАНИЧНО.
// orders_history отдаётся страницами (page/page_size, новые сверху). Читать только
// первую страницу опасно: недавно отменённый/исполненный ордер мог уехать за её
// пределы — и тогда отмену на бирже легко принять за исполнение (см. C-2).
// Поэтому читаем страницы, пока не найдём ВСЕ нужные ордера (wantedIds — id наших
// открытых ордеров) ИЛИ пока не кончится история/лимит страниц.
//
// ГЛАВНОЕ ПРАВИЛО ОСТАНОВКИ — notOlderThan (мс): дата создания САМОГО СТАРОГО нашего
// открытого ордера. Биржа умеет сортировать историю ТОЛЬКО по дате создания (по времени
// завершения сортировки нет), мы берём порядок «от новых к старым». Значит как только
// вся страница оказалась старше notOlderThan, дальше наших ордеров быть не может —
// листать бессмысленно. Без этого правила ордер, который стоял с запуска бота и
// исполнился только сегодня, ушёл бы за фиксированный лимит страниц и его исполнение
// не заметили бы НИКОГДА. В обычном случае правило срабатывает на первой же странице.
async function getOrdersHistoryMap(apiKey, secret,
  { symbol = 'CITRO/USDT', wantedIds = null, maxPages = HISTORY_MAX_PAGES, pageSize = 100,
    notOlderThan = null, log = null } = {}) {
  const map  = new Map();
  const want = wantedIds ? new Set([...wantedIds].map(String)) : null;

  let page = 1;
  let totalPages = 1;                 // уточним из ответа биржи (поле pages)
  while (true) {
    const raw = await getOrdersHistory(apiKey, secret, { symbol, page, pageSize });
    if (raw && Number.isFinite(+raw.pages)) totalPages = +raw.pages;

    const pageMap = parseOrdersHistory(raw, log);
    if (pageMap.size === 0) break;    // пустая страница — дальше читать нечего
    for (const [id, v] of pageMap) if (!map.has(id)) map.set(id, v);

    // Все интересующие id уже найдены — дальше листать смысла нет.
    if (want) {
      let allFound = true;
      for (const id of want) if (!map.has(id)) { allFound = false; break; }
      if (allFound) break;
    }

    // Вся страница старше наших открытых ордеров → глубже искать нечего.
    // Записи без разобранной даты не учитываем: не знаем — значит не останавливаемся.
    if (notOlderThan != null) {
      let oldestOnPage = null;
      for (const v of pageMap.values()) {
        if (v.created == null) continue;
        if (oldestOnPage == null || v.created < oldestOnPage) oldestOnPage = v.created;
      }
      if (oldestOnPage != null && oldestOnPage < notOlderThan) break;
    }

    page++;
    if (page > totalPages || page > maxPages) break;
  }
  return map;
}

module.exports = {
  getBalance, getActiveOrders, parseActiveOrders, createOrder, cancelOrder,
  getOrdersHistory, parseOrdersHistory, getOrdersHistoryMap,
  getMarket, getOrderbook, getPrice,
};
