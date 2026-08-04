//  ОБЩИЕ ПРОВЕРКИ АККАУНТА НА БИРЖЕ ДЛЯ СЕРВЕРНЫХ ФУНКЦИЙ (api/).
//  САМОДОСТАТОЧНЫЙ модуль: подпись приватных запросов — здесь же (тот же формат,
//  что в api/keys/balance.js и worker/citronus.js). НЕ зависит от worker/ — иначе
//  Vercel не включал бы worker-файлы в бандл функции (api → worker не бандлится).
//  Префикс «_» → Vercel НЕ считает файл за отдельную serverless-функцию.
//
//  Зачем: при запуске бота проверяем ОБЩИЙ лимит биржи (100 открытых ордеров на
//  АККАУНТ) и предупреждаем, если на ТОМ ЖЕ аккаунте уже работает другой spot-grid
//  бот. Аккаунт-идентификатора биржа не отдаёт, поэтому «тот же аккаунт» определяем
//  по ПЕРЕСЕЧЕНИЮ id ордеров: ключ видит все открытые ордера своего аккаунта
//  (active_orders без символа) — если среди них есть ордера другого нашего
//  активного бота, значит он на этом же аккаунте.
const crypto = require('crypto');
const { decrypt } = require('./_crypto');

const API_URL     = 'https://api.citronus.com/public/v1/jsonrpc';
const RECV_WINDOW = '5000';
const REQUEST_TIMEOUT_MS = 6000;

// Номер JSON-RPC запроса — У КАЖДОГО СВОЙ. Citronus дедуплицирует по паре (id + тело):
// тот же id с тем же телом — запрос не выполняется, возвращается сохранённый ответ.
// С константой '1' повторный запрос тех же данных отдавал устаревший результат.
let _rpcSeq = 0;
function nextRpcId() { return `${Date.now().toString(36)}-${(++_rpcSeq).toString(36)}`; }

const ORDER_LIMIT = 100; // лимит открытых ордеров на аккаунт (Citronus, account-wide)
const ORDER_LIMIT_MESSAGE =
  'При заданном количестве сеток будет превышен лимит биржи в 100 лимитных ордеров. ' +
  'Закройте ордера на бирже или уменьшите количество сеток для бота.';

// Подписанный приватный вызов: HMAC-SHA256(secret, timestamp+apiKey+recvWindow+body),
// заголовки X-CITRO-*. Один запрос, без повторов (при сбое вызывающий считает
// проверку «непройденной» и разрешает запуск — страхует воркер).
async function signedRequest(method, params, apiKey, secret) {
  const timestamp = Date.now().toString();
  const body      = JSON.stringify({ jsonrpc: '2.0', method, params, id: nextRpcId() });
  const message   = timestamp + apiKey + RECV_WINDOW + body;
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':        'application/json; charset=utf-8',
      'X-CITRO-API-KEY':     apiKey,
      'X-CITRO-TIMESTAMP':   timestamp,
      'X-CITRO-RECV-WINDOW': RECV_WINDOW,
      'X-CITRO-SIGNATURE':   signature,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let json = null;
  try { json = await res.json(); } catch { /* не JSON — оставляем null */ }
  if (!res.ok) {
    const e = new Error((json && json.error && json.error.message) || ('HTTP ' + res.status));
    e.httpStatus = res.status;
    throw e;
  }
  if (json && json.error) {
    const e = new Error(json.error.message || 'Citronus error');
    e.citronus = json.error;
    throw e;
  }
  return json ? json.result : null;
}

// Последняя цена CITRO/USDT — публичный метод (без подписи). С ТАЙМАУТОМ и
// проверкой ответа: «зависшая» биржа не должна держать serverless-функцию до
// её жёсткого лимита. Возвращает число или null (при любой проблеме).
async function fetchLastPrice(symbol = 'CITRO/USDT') {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tickers',
      params: { category: 'spot', symbol }, id: nextRpcId() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  let json = null;
  try { json = await res.json(); } catch { return null; }
  const price = parseFloat(json && json.result && json.result.last_price);
  return Number.isFinite(price) ? price : null;
}

// Грузим креды ключа с проверкой владения пользователем.
async function loadKeyCreds(supabase, keyId, userId) {
  const { data: key, error } = await supabase
    .from('api_keys')
    .select('api_key, api_secret_encrypted, user_id')
    .eq('id', keyId)
    .maybeSingle();
  if (error || !key || key.user_id !== userId) return null;
  try { return { apiKey: key.api_key, secret: decrypt(key.api_secret_encrypted) }; }
  catch { return null; }
}

function rawOrderList(raw) {
  return Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.orders) ? raw.orders
    : (raw && Array.isArray(raw.list) ? raw.list : []));
}

// Работает ли ключ: подписанный get_balance должен вернуть result. Ошибку биржи
// (неверный ключ/подпись/нет прав) трактуем как «невалиден» → false; сетевой сбой
// (нет ответа) — пробрасываем, чтобы вызывающий показал «биржа недоступна».
async function keyIsValid(apiKey, secret) {
  try {
    const r = await signedRequest('get_balance', { category: 'spot' }, apiKey, secret);
    return r !== undefined && r !== null;
  } catch (e) {
    if (e.citronus || e.httpStatus) return false;
    throw e;
  }
}

// Открытые ордера ВСЕГО аккаунта (все пары) → { count, ids:Set<string> }.
// active_orders без symbol → биржа возвращает ордера по всем парам.
async function fetchAccountOrders(apiKey, secret) {
  const raw  = await signedRequest('active_orders', { category: 'spot', data: {} }, apiKey, secret);
  const list = rawOrderList(raw);
  const ids  = new Set();
  for (const o of list) {
    const id = o.order_id != null ? o.order_id : (o.id != null ? o.id : o.orderId);
    if (id != null) ids.add(String(id));
  }
  return { count: list.length, ids };
}

// Префлайт перед запуском бота. ПОЛНОСТЬЮ защищён: никогда не бросает исключение —
// при любой ошибке возвращает verified:false, и тогда вызывающий РАЗРЕШАЕТ запуск
// (лимит подстрахует воркер при размещении). Так проверка лимита не может «уронить»
// создание/запуск бота 500-й.
async function accountPreflight(supabase, { userId, keyId, gridCount, excludeBotId }) {
  try {
    const creds = await loadKeyCreds(supabase, keyId, userId);
    if (!creds) return { verified: false, reason: 'key' };

    let acc;
    try { acc = await fetchAccountOrders(creds.apiKey, creds.secret); }
    catch (e) { return { verified: false, reason: 'exchange', message: e && e.message }; }

    const free = ORDER_LIMIT - acc.count;
    const overLimit = Number.isFinite(gridCount) && gridCount > free;

    // Есть ли ДРУГОЙ активный spot-grid бот на ЭТОМ ЖЕ аккаунте (пересечение id)?
    // Эта часть — best-effort: её сбой не должен влиять на проверку лимита.
    let sameAccountActiveBot = false;
    try {
      let q = supabase.from('bots').select('id')
        .eq('user_id', userId).eq('strategy', 'spot_grid').eq('status', 'active').is('deleted_at', null);
      if (excludeBotId) q = q.neq('id', excludeBotId);
      const { data: activeBots } = await q;
      const activeIds = (activeBots || []).map(b => b.id);
      if (activeIds.length) {
        const { data: ords } = await supabase.from('bot_orders')
          .select('exchange_order_id')
          .in('bot_id', activeIds)
          .in('status', ['open', 'placing']);
        sameAccountActiveBot = (ords || []).some(o =>
          o.exchange_order_id != null && acc.ids.has(String(o.exchange_order_id)));
      }
    } catch (e) {
      console.error('accountPreflight same-account check failed (non-fatal):', e && e.message);
    }

    return { verified: true, openOrders: acc.count, free, overLimit, sameAccountActiveBot, limit: ORDER_LIMIT };
  } catch (e) {
    console.error('accountPreflight failed (allow launch, worker guards):', e && e.message);
    return { verified: false, reason: 'error', message: e && e.message };
  }
}

module.exports = { ORDER_LIMIT, ORDER_LIMIT_MESSAGE, loadKeyCreds, fetchAccountOrders, accountPreflight, signedRequest, keyIsValid, fetchLastPrice };
