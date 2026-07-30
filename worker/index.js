//  ТОРГОВЫЙ ВОРКЕР — постоянно работающий процесс (вне Vercel).
//  Модель «желаемое состояние → сверка»: веб-приложение пишет в БД,
//  воркер приводит биржу в соответствие.
//
//  Каждый тик (POLL_MS):
//   • handleReconcile  — для активных ботов приводит сетку к плану
//                        (свежий старт ИЛИ достройка неполной сетки);
//   • handleCancellations — снимает ордера ботов, которые перестали быть
//                        активными (с подтверждением по active_orders).
//  Сверка идемпотентна и устойчива к сбоям сети (см. runner.js / net.js).
//
//  Запуск локально из КОРНЯ проекта:  node worker/index.js
//  (берёт переменные из .env в корне; нужен Node 18+ ради global fetch)

// Загрузка .env из корня проекта (без внешних зависимостей)
const fs   = require('fs');
const path = require('path');
(function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;                 // пустые строки и комментарии (#) пропускаем
      const key = m[1];
      if (key in process.env) continue; // уже задано в окружении — не перезаписываем
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      process.env[key] = val;
    }
  } catch { /* .env нет (напр. в проде секреты заданы окружением) — это нормально */ }
})();

const { createClient } = require('@supabase/supabase-js');
const crypto           = require('crypto');
const { decrypt }      = require('../api/_crypto');
const citronus         = require('./citronus');
const runner           = require('./runner');
const { sb }           = require('./db');
const lease            = require('./lease');

const POLL_MS = 2000; // как часто опрашиваем (на аккаунт ~1 запрос/тик, лимит биржи — 5/сек)

// «Ключ» единственного воркера (leader lease)
// Торгует только процесс, держащий ключ. TTL с запасом больше периода
// сердцебиения, чтобы ключ не «протухал» между продлениями, даже если тик долгий.
const LEASE_TTL_SEC = 20;    // на сколько берём ключ
const HEARTBEAT_MS  = 5000;  // как часто продлеваем (сильно меньше TTL)
const INSTANCE_ID   = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
let   leader        = false; // держим ли ключ прямо сейчас (торгуем только тогда)

// Периодическая уборка «отработанных» записей
// Ведущий воркер раз в CLEANUP_INTERVAL_MS удаляет то, что больше НИКТО не читает:
// из bot_orders — старые filled/cancelled (активные open/placing НЕ трогаем),
// из auth_attempts — записи старше окна лимита. Статистика (таблица bot_trades)
// НЕ затрагивается вообще. Отработанное держим ещё KEEP_TERMINAL_MS — про запас.
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // как часто убираем — раз в 30 минут
const KEEP_TERMINAL_MS    = 60 * 60 * 1000; // отработанное храним ещё час, затем удаляем

// Проверяем обязательные переменные
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ENCRYPTION_KEY'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[worker] не заданы переменные:', missing.join(', '), '— проверьте .env в корне');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function log(...args) {
  console.log(new Date().toISOString(), '[worker]', ...args);
}

// Один цикл: сверка сеток активных ботов + отмена у остановленных
async function tick() {
  if (!leader) return; // не держим ключ — не торгуем (мы резервный воркер)
  await handleReconcile();
  await handleCancellations();
}

// Загружает ключ по id и расшифровывает секрет → { apiKey, secret } или null
async function loadKey(keyId) {
  let key;
  try {
    key = await sb(() => supabase.from('api_keys')
      .select('api_key, api_secret_encrypted').eq('id', keyId).maybeSingle(),
      { label: 'загрузка ключа', log });
  } catch (e) { log('ключ не загружен:', keyId, e.message); return null; }
  if (!key) { log('ключ не найден:', keyId); return null; }
  try { return { apiKey: key.api_key, secret: decrypt(key.api_secret_encrypted) }; }
  catch { log('не удалось расшифровать ключ', keyId); return null; }
}

// Активные ордера аккаунта в едином виде [{id,side,price,amount}].
// БРОСАЕТ при сбое — вызывающий решает, что делать (важно: НЕЛЬЗЯ молча вернуть
// [], иначе stopBot решит, что ордеров нет, и пометит живые «отменёнными»).
async function loadActiveOrders(apiKey, secret) {
  // ── ВРЕМЕННАЯ ДИАГНОСТИКА (Шаг 0) ─────────────────────────────────────────────
  // Изучаем паттерн ответов active_orders у Citronus: как часто приходит пусто и
  // что именно приходит. Все строки помечены [diag] — легко отфильтровать и убрать.
  const t0  = Date.now();
  const raw = await citronus.getActiveOrders(apiKey, secret);         // символьный (CITRO/USDT)
  const parsed = citronus.parseActiveOrders(raw, log);
  const ms  = Date.now() - t0;
  const rawLen = Array.isArray(raw) ? raw.length
    : (raw && Array.isArray(raw.orders) ? raw.orders.length
    : (raw && Array.isArray(raw.list)   ? raw.list.length
    : (raw == null ? 'null' : 'obj')));
  log(`[diag] active_orders(symbol): сырых=${rawLen} разобрано=${parsed.length} за ${ms}мс`);

  // Пусто у символьного? Тут же сравним с запросом БЕЗ символа (все пары, тот же ключ) —
  // это покажет, символьный вызов отдаёт пусто или биржа вообще ничего не отдаёт воркеру.
  // Плюс печатаем сырой ответ символьного, чтобы отличить настоящий [] от иного формата.
  if (parsed.length === 0) {
    try {
      const rawAll    = await citronus.getActiveOrders(apiKey, secret, null);
      const parsedAll = citronus.parseActiveOrders(rawAll, log);
      log(`[diag] ПУСТО(symbol): no-symbol разобрано=${parsedAll.length}; сырой(symbol)=${JSON.stringify(raw).slice(0, 200)}`);
    } catch (e) {
      log(`[diag] сравнение no-symbol не удалось: ${e && e.message}`);
    }
  }
  // [diag] Свежа ли orders_history тем же ключом? Пишем новейший «терминальный» ордер
  // (id/статус/дата) — видно, как быстро история отражает снятия/исполнения по сравнению
  // с active_orders. Так узнаем: тормозит только active_orders или история тоже.
  try {
    const hraw  = await citronus.getOrdersHistory(apiKey, secret, { symbol: 'CITRO/USDT', page: 1, pageSize: 5 });
    const hlist = Array.isArray(hraw) ? hraw
      : (hraw && Array.isArray(hraw.items)  ? hraw.items
      : (hraw && Array.isArray(hraw.orders) ? hraw.orders
      : (hraw && Array.isArray(hraw.list)   ? hraw.list : [])));
    const h0 = hlist[0];
    if (h0) log(`[diag] orders_history: всего=${hlist.length}, новейший id=${h0.id != null ? h0.id : h0.order_id} статус=${h0.status} создан=${h0.create_date}`);
    else    log(`[diag] orders_history: пусто`);
  } catch (e) { log(`[diag] orders_history проба не удалась: ${e && e.message}`); }

  return parsed;
  // ── КОНЕЦ ДИАГНОСТИКИ ─────────────────────────────────────────────────────────
}

// Детекция фатального отказа ключа
// Если биржа УСТОЙЧИВО отклоняет запросы по ключу (вероятно ключ отозван или
// недействителен), останавливаем ботов аккаунта с понятной причиной — она
// всплывёт как «Ошибка» в UI. Считаем подряд идущие отказы; сетевые сбои не в счёт.
const keyFailCount = new Map();   // api_key_id → тиков подряд с отказом биржи
const KEY_FAIL_THRESHOLD = 3;     // ~3 тика (≈6 c) устойчивого отказа = фатально

// Останавливает всех ботов аккаунта с причиной (status_message → «Ошибка» в UI).
async function markKeyError(bots, message) {
  for (const b of bots) {
    await sb(() => supabase.from('bots')
      .update({ status: 'inactive', status_message: message, updated_at: new Date().toISOString() })
      .eq('id', b.id), { label: 'bots→ошибка ключа', log }).catch(() => {});
  }
}

// Похоже ли на ошибку авторизации/доступа (отозванный/неверный ключ, плохая
// подпись, нет прав). Подтверждённый формат Citronus: HTTP 200 + JSON-RPC
// error code 'auth_required' («Authorization required for this method»).
// Также покрываем HTTP 401/403 и прочие auth-формулировки — на всякий случай.
function isAuthError(e) {
  if (e.authError) return true;                              // HTTP 401/403
  const code = (e.citronus && e.citronus.code) ? String(e.citronus.code) : '';
  const text = `${code} ${e.message || ''}`.toLowerCase();
  return /auth|unauthor|signature|api[\s_-]?key|permission|forbidden|access denied/.test(text);
}

// СВЕРКА: для каждого активного бота приводим сетку к плану
// Работа нужна, если у бота НЕТ ордеров (свежий старт) ИЛИ есть строки 'placing'
// (неполная сетка). Боты, у которых все ордера уже 'open', пропускаем.
async function handleReconcile() {
  let bots;
  try {
    bots = await sb(() => supabase.from('bots')
      .select('id, name, api_key_id, status, config, base_qty').eq('status', 'active'),
      { label: 'чтение активных ботов', log });
  } catch (e) { log('ошибка чтения активных ботов:', e.message); return; }
  if (!bots || bots.length === 0) return;

  // Текущие ордера этих ботов (open/placing) — по ним решаем, кому нужна работа
  const ids = bots.map(b => b.id);
  let rows;
  try {
    rows = await sb(() => supabase.from('bot_orders')
      .select('id, bot_id, level_index, side, price, amount, status, exchange_order_id, partial')
      .in('bot_id', ids).in('status', ['open', 'placing']),
      { label: 'чтение текущих ордеров', log });
  } catch (e) { log('ошибка чтения bot_orders:', e.message); return; }

  const byBot = new Map();
  for (const r of (rows || [])) {
    if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
    byBot.get(r.bot_id).push(r);
  }

  // Кому нужен свежий запуск (нет ордеров) или достройка (есть 'placing') —
  // для них дополнительно понадобятся стакан/цена/баланс.
  const needWork = bots.filter(b => {
    const r = byBot.get(b.id) || [];
    return r.length === 0 || r.some(x => x.status === 'placing');
  });

  // Параметры рынка (точность/минимумы) — нужны и для реакции на исполнение,
  // и для свежего старта. Не получили — берём безопасные значения CITRO/USDT.
  let market = null;
  try { market = await citronus.getMarket(); }
  catch (e) { log('параметры рынка не получены, беру значения по умолчанию:', e.message); }
  const baseDec  = (market && Number.isInteger(market.trade_base_precision)) ? market.trade_base_precision : 2;
  const priceDec = (market && (String(market.quote_tick_size).split('.')[1] || '').length) || 5;
  const minQty   = (market && parseFloat(market.min_order_qty)) || 1;
  const minAmt   = (market && parseFloat(market.min_order_amt)) || 0.1;

  // Стакан/цена — только если есть кому делать свежий запуск (для расчёта плана).
  let ob = null, price = null;
  if (needWork.length) {
    try { ob = await citronus.getOrderbook(); price = await citronus.getPrice(); }
    catch (e) { log('стакан/цена не получены (свежий запуск пропустим):', e.message); }
  }

  // Группируем ВСЕХ активных ботов по ключу — реакция на исполнение нужна всем.
  const byKey = new Map();
  for (const b of bots) {
    if (!byKey.has(b.api_key_id)) byKey.set(b.api_key_id, []);
    byKey.get(b.api_key_id).push(b);
  }

  for (const [keyId, keyBots] of byKey) {
    if (!leader) return; // потеряли ключ в этом тике — дальше ордера не трогаем
    const creds = await loadKey(keyId);
    if (!creds) continue;

    let activeOrders;
    try {
      activeOrders = await loadActiveOrders(creds.apiKey, creds.secret);
      keyFailCount.delete(keyId);                 // успех — сбрасываем счётчик отказов
    } catch (e) {
      if (isAuthError(e)) {                        // биржа отвергает КЛЮЧ (auth) — вероятно отозван/недействителен
        const n = (keyFailCount.get(keyId) || 0) + 1;
        keyFailCount.set(keyId, n);
        log(`ключ ${keyId} отвергнут биржей (${n}/${KEY_FAIL_THRESHOLD}): ${e.message}`);
        if (n >= KEY_FAIL_THRESHOLD) {
          log(`✗ ключ ${keyId}: устойчивый отказ авторизации — останавливаю ботов аккаунта`);
          await markKeyError(keyBots, 'Ключ API не принят биржей. Проверьте или обновите ключ на бирже.');
          keyFailCount.delete(keyId);
        }
      } else if (e.citronus || e.httpStatus) {     // иной ответ-ошибка биржи (не auth) — для чтения необычно, считаем временным
        log(`active_orders: ответ-ошибка биржи (не ключ), пропуск тика: ${e.message}`);
      } else {                                     // нет ответа сервера — сетевой сбой
        log('active_orders не получены (сеть, пропуск аккаунта):', e.message);
      }
      continue;                                    // без active_orders аккаунт в этот тик не трогаем
    }
    let openOrdersCount = activeOrders.length;

    // Баланс нужен и для свежего запуска, и для докомпенсации объёма встречных
    // ордеров (см. handleFills). Берём ОДИН раз на ключ за тик (лимит запросов
    // держит по-ключевой ограничитель — превысить его этот вызов не может).
    let balance = null;
    try { balance = await citronus.getBalance(creds.apiKey, creds.secret); }
    catch (e) { log('баланс не получен (свежий запуск/докомпенсация пропустятся):', e.message); }

    const fillCtx = { activeOrders, baseDec, priceDec, minQty, minAmt, balance,
      commissionBuy:  (market && parseFloat(market.commission_limit_buy))  || 0,
      commissionSell: (market && parseFloat(market.commission_limit_sell)) || 0 };
    const deps    = { supabase, citronus, apiKey: creds.apiKey, secret: creds.secret, log };

    for (const bot of keyBots) {
      const botRows = byBot.get(bot.id) || [];

      // 1) Реакция на исполнение ордеров (для уже работающих ботов)
      try { await runner.handleFills(bot, botRows, fillCtx, deps); }
      catch (e) { log(`ошибка реакции на исполнение "${bot.name}":`, e.message); }

      // 2) Свежий запуск / достройка сетки
      const isFresh    = botRows.length === 0;
      const hasPlacing = botRows.some(r => r.status === 'placing');
      if (isFresh && (!market || !ob || !price || !balance)) {
        log(`  пропуск свежего запуска "${bot.name}" — в этом тике нет рынка/стакана/цены/баланса`);
        continue;
      }
      if (!isFresh && !hasPlacing) continue; // всё стоит — достраивать нечего

      // Сверку одного бота изолируем: непредвиденная ошибка не должна прерывать
      // обработку остальных ботов в этом тике (так же изолирован и handleFills).
      let placed = 0;
      try {
        placed = await runner.reconcileBot(
          bot,
          { market, ob, price, balance, openOrdersCount, activeOrders, botRows },
          deps
        );
      } catch (e) {
        log(`ошибка сверки сетки "${bot.name}":`, e.message);
      }
      openOrdersCount += placed; // учитываем для следующего бота на том же ключе
    }
  }
}

// ОТМЕНА: боты с ордерами, которые больше НЕ активны (остановлены)
async function handleCancellations() {
  let rows;
  try {
    rows = await sb(() => supabase.from('bot_orders')
      .select('bot_id').in('status', ['open', 'placing']),
      { label: 'чтение bot_orders (отмена)', log });
  } catch (e) { log('ошибка чтения bot_orders:', e.message); return; }
  if (!rows || rows.length === 0) return;

  const botIds = [...new Set(rows.map(r => r.bot_id))];
  let bots;
  try {
    bots = await sb(() => supabase.from('bots')
      .select('id, name, api_key_id, status').in('id', botIds),
      { label: 'чтение ботов (отмена)', log });
  } catch (e) { log('ошибка чтения ботов (отмена):', e.message); return; }

  const toStop = (bots || []).filter(b => b.status !== 'active');
  if (toStop.length === 0) return;

  // Группируем по ключу — active_orders запрашиваем один раз на аккаунт
  const byKey = new Map();
  for (const b of toStop) {
    if (!byKey.has(b.api_key_id)) byKey.set(b.api_key_id, []);
    byKey.get(b.api_key_id).push(b);
  }

  for (const [keyId, keyBots] of byKey) {
    if (!leader) return; // потеряли ключ в этом тике — дальше ордера не трогаем
    const creds = await loadKey(keyId);
    if (!creds) continue;

    // Если активные ордера не прочитать — НЕ запускаем stopBot: иначе он решит,
    // что ордеров нет, и пометит живые «отменёнными» (а отменить их мы не смогли).
    let activeOrders;
    try { activeOrders = await loadActiveOrders(creds.apiKey, creds.secret); }
    catch (e) { log('active_orders не получены при отмене (пропуск аккаунта):', e.message); continue; }

    for (const bot of keyBots) {
      await runner.stopBot(bot, { activeOrders },
        { supabase, citronus, apiKey: creds.apiKey, secret: creds.secret, log });
    }
  }
}

// «Сердцебиение»: берём/продлеваем ключ отдельным таймером, независимо от
//    длительности тика (иначе долгий тик мог бы дать ключу «протухнуть»).
async function heartbeat() {
  try {
    leader = await lease.acquire(supabase, INSTANCE_ID, LEASE_TTL_SEC, log);
  } catch (e) {
    // Ключ не подтверждён — НЕ считаем себя ведущим (fail-closed): лучше
    // пропустить торговлю, чем рискнуть вторым активным воркером.
    leader = false;
    log('сердцебиение: ключ не подтверждён —', e && e.message);
  }
}

// Уборщик: удаляет отработанные записи. БЕЗ влияния на торговлю и статистику.
//    Чистит только ВЕДУЩИЙ (чтобы не делать одно и то же в двух копиях), best-effort.
async function janitor() {
  if (!leader) return;
  const cutoff = new Date(Date.now() - KEEP_TERMINAL_MS).toISOString();

  // 1) Отработанные ордера сетки (filled/cancelled) — их больше никто не читает.
  //    Активные (open/placing) НЕ трогаем; таблицу сделок bot_trades НЕ трогаем.
  try {
    await sb(() => supabase.from('bot_orders').delete()
      .in('status', ['filled', 'cancelled']).lt('updated_at', cutoff),
      { label: 'уборка bot_orders', log, attempts: 2 });
  } catch (e) { log('уборка bot_orders не удалась (не критично):', e && e.message); }

  // 2) Старые попытки входа: окно лимита — 2 минуты, всё старше уже бесполезно.
  try {
    await sb(() => supabase.from('auth_attempts').delete()
      .lt('created_at', cutoff),
      { label: 'уборка auth_attempts', log, attempts: 2 });
  } catch (e) { log('уборка auth_attempts не удалась (не критично):', e && e.message); }
}

// Главный цикл: тик только когда ключ у нас; иначе ждём (мы — резерв)
async function loop() {
  try {
    if (leader) await tick();
  } catch (e) { log('ошибка тика:', e.message); }
  setTimeout(loop, POLL_MS);
}

// Аккуратная остановка: отдаём ключ, чтобы резервный воркер подхватил без
//    паузы. Railway при деплое шлёт SIGTERM; локально — SIGINT (Ctrl+C).
let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`получен ${sig} — отдаю ключ и останавливаюсь`);
  setTimeout(() => process.exit(0), 3000).unref(); // не зависаем на выключении из-за БД
  await lease.release(supabase, INSTANCE_ID, log);
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`старт воркера (${INSTANCE_ID}), опрос каждые ${POLL_MS} мс — РЕАЛЬНАЯ ТОРГОВЛЯ. Беру ключ единственного воркера…`);

// Сначала пробуем взять ключ, затем запускаем цикл, продление и уборку.
heartbeat().then(() => {
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(janitor,   CLEANUP_INTERVAL_MS);
  janitor();   // разовая уборка накопившегося при старте (сработает, если мы ведущий)
  loop();
});
