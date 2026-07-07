//  RUNNER — действия с биржей: сверка сетки (запуск/достройка) и остановка.
//  Здесь — реальные create_order / cancel_order + записи в БД.
//
//  Принципы безопасности (самовосстановление):
//   • reconcileBot вызывается каждый тик для активного бота и приводит его
//     сетку к плану: СВЕЖИЙ цикл (нет строк) → обмен + запись намерений;
//     НЕПОЛНАЯ сетка (есть строки 'placing') → доставляем недостающее.
//   • Перед каждым размещением сверяемся с active_orders по (сторона, цена):
//     если ордер уже на бирже — «усыновляем» строку, а не выставляем дубль.
//     Это делает повтор create_order безопасным.
//   • Намерения пишем ОДНИМ батчем (атомарно): либо вся сетка записана, либо
//     ни одной строки — не бывает «частичных намерений».
//   • Обмен (market) делаем РОВНО один раз за цикл — только в свежем цикле
//     (когда у бота ещё нет ни одного открытого/размещаемого ордера).
//   • Остановка помечает ордер 'cancelled' ТОЛЬКО когда его уже нет в
//     active_orders (подтверждённая отмена). Живые переотменяем на след. тике.
//
//  deps = { supabase, citronus, apiKey, secret, log }
//  ctx  = { market, ob, price, balance, openOrdersCount, activeOrders, botRows }
const engine   = require('./engine');
const GridCore = require('../bots/spot-grid/grid-core.js');
const { withRetry } = require('./net');
const { sb, SB_TIMEOUT_MS } = require('./db');
const { ORDER_LIMIT, ORDER_LIMIT_MESSAGE } = require('../api/_exchange');

const SYMBOL = 'CITRO/USDT';

// Сравнение цен с допуском (намного меньше шага цены 1e-5, но больше floating-шума).
const PRICE_EPS = 1e-7;
function priceEq(a, b) { return Math.abs(a - b) < PRICE_EPS; }

// Встречный SELL ставим чуть меньше полученного объёма: комиссия (0.05%) удерживается
// из ПОЛУЧЕННОГО актива, поэтому после исполнения buy у нас на руках ~q·0.9995 CITRO.
// Продаём q·0.999 — этого точно хватит из проце́нтов самой сделки (самофундирование).
// Встречный BUY берёт полный объём: он покупается на USDT по БОЛЕЕ НИЗКОЙ цене, чем
// продали, поэтому полученного USDT заведомо хватает (запас = шаг сетки).
const COUNTER_SELL_HAIRCUT = 0.001;

// Сколько тиков подряд «недоставленной» сетки терпим, прежде чем остановить
// бота с ошибкой (иначе он молча и бесконечно ретраит непроходящие ордера).
const PLACE_FAIL_MAX = 20;              // ~40 c при тике 2 c
const placeFailStreak = new Map();      // bot.id → тиков подряд с непоставленными ордерами

// Ищет среди активных ордеров биржи ордер той же стороны и цены.
function findActive(active, side, price) {
  return (active || []).find((o) => o.side === side && priceEq(o.price, price)) || null;
}

// Запись ВСЕХ намерений сетки одним батчем (атомарно). Уникальный индекс
// (bot_id, level_index) where status in (placing,open) защищает от дублей:
// если строки уже созданы (ответ прошлой попытки потерялся) — батч упрётся в
// 23505, тогда просто возвращаем уже существующие строки.
async function insertIntentsBatch(supabase, bot, orders, log) {
  const payload = orders.map((o) => ({
    bot_id: bot.id, level_index: o.levelIndex, side: o.side,
    price: o.price, amount: o.qty, status: 'placing'
  }));
  const cols = 'id, level_index, side, price, amount, status, exchange_order_id';
  return withRetry(async () => {
    const res = await supabase.from('bot_orders').insert(payload).select(cols)
      .abortSignal(AbortSignal.timeout(SB_TIMEOUT_MS));
    if (!res.error) return res.data;
    if (res.error.code === '23505') {                 // строки уже есть — берём текущие
      const ex = await supabase.from('bot_orders').select(cols)
        .eq('bot_id', bot.id).in('status', ['placing', 'open'])
        .abortSignal(AbortSignal.timeout(SB_TIMEOUT_MS));
      if (!ex.error && ex.data && ex.data.length) return ex.data;
    }
    const e = new Error(res.error.message || 'insert error'); e.code = res.error.code; throw e;
  }, { attempts: 4, label: 'запись намерений сетки', log });
}

// Приведение сетки активного бота к плану. Возвращает число выставленных ордеров.
async function reconcileBot(bot, ctx, deps) {
  const { supabase, citronus, apiKey, secret, log } = deps;
  const active = ctx.activeOrders || [];
  let rows = (ctx.botRows || []).slice();

  // СВЕЖИЙ ЦИКЛ: ни одного открытого/размещаемого ордера
  if (rows.length === 0) {
    log(`▶ запуск бота "${bot.name}" (${bot.id.slice(0, 8)}…)`);

    const plan = engine.planStart(bot, ctx);
    if (!plan.canPlace) {
      log(`  ОТМЕНА: ${plan.reason}`);
      await sb(() => supabase.from('bots')
        .update({ status: 'inactive', status_message: plan.reason, updated_at: new Date().toISOString() })
        .eq('id', bot.id), { label: 'bots→inactive (нельзя запустить)', log }).catch(() => {});
      return 0;
    }

    // Лимит биржи (100 ордеров на АККАУНТ) — финальная защита перед обменом/
    //    размещением. Считаем открытые ордера всего аккаунта (все пары). Если
    //    проверить не удалось (сеть) — продолжаем: если лимит и правда превышен,
    //    лишние ордера просто не встанут при размещении.
    try {
      const rawAll = await citronus.getActiveOrders(apiKey, secret, null); // null → все пары
      const accOpen = Array.isArray(rawAll) ? rawAll.length
        : (rawAll && Array.isArray(rawAll.orders) ? rawAll.orders.length
        : (rawAll && Array.isArray(rawAll.list)   ? rawAll.list.length : 0));
      const need = plan.orders.length;
      if (accOpen + need > ORDER_LIMIT) {
        log(`  ✗ запуск отменён: на аккаунте ${accOpen} открытых + ${need} новых > ${ORDER_LIMIT}`);
        await sb(() => supabase.from('bots')
          .update({ status: 'inactive', status_message: ORDER_LIMIT_MESSAGE, updated_at: new Date().toISOString() })
          .eq('id', bot.id), { label: 'bots→inactive (лимит ордеров)', log }).catch(() => {});
        return 0;
      }
    } catch (e) {
      log(`  ! не удалось проверить лимит ордеров аккаунта (${e.message}) — продолжаю запуск`);
    }

    // Обмен на старте (market). Защита от повторной конвертации: обмениваем
    //    ТОЛЬКО если баланса ещё НЕ хватает на сетку. Если баланс уже покрывает
    //    нужды — обмен уже выполнялся (на прерванном тике), второй раз НЕ
    //    конвертируем. Так исключается двойная рыночная конвертация при рестарте.
    let didRebalance = false;
    const needCitro = plan.orders.reduce((s, o) => s + (o.side === 'sell' ? o.qty   : 0), 0);
    const needUsdt  = plan.orders.reduce((s, o) => s + (o.side === 'buy'  ? o.quote : 0), 0);
    const bal = ctx.balance || { USDT: 0, CITRO: 0 };
    const alreadyFunded = (bal.CITRO + 1e-8 >= needCitro) && (bal.USDT + 1e-8 >= needUsdt);

    if (plan.conversion && !alreadyFunded) {
      const cv = plan.conversion;
      const data = cv.from.t === 'USDT'
        ? { symbol: SYMBOL, action: 'buy',  type: 'market', total:  String(engine.floorTo(cv.from.amt, 6)) }
        : { symbol: SYMBOL, action: 'sell', type: 'market', amount: String(engine.floorTo(cv.from.amt, 2)) };
      try {
        log(`  обмен (market ${data.action}): ${JSON.stringify(data)}`);
        const res = await citronus.createOrder(data, apiKey, secret);
        didRebalance = true;
        log(`  ✓ обмен выполнен: id=${res.id} status=${res.status}`);
        await sb(() => supabase.from('bot_trades').upsert({
          bot_id: bot.id, exchange_order_id: res.id || null, side: data.action, kind: 'rebalance',
          price:  res.price          != null ? parseFloat(res.price)          : null,
          amount: res.current_amount != null ? parseFloat(res.current_amount) : null,
          total:  res.total          != null ? parseFloat(res.total)          : null,
          fee:    res.fee            != null ? parseFloat(res.fee)            : null,
          raw: res, filled_at: new Date().toISOString()
        }, { onConflict: 'bot_id,exchange_order_id,kind', ignoreDuplicates: true }),
          { label: 'bot_trades (обмен)', log, attempts: 2 }).catch((e) => log(`  ! лог обмена не записан (не критично): ${e.message}`));
      } catch (e) {
        log(`  ✗ ОШИБКА обмена: ${e.message} — запуск прерван, бот не активирован`);
        await sb(() => supabase.from('bots')
          .update({ status: 'inactive', status_message: 'Ошибка обмена: ' + e.message, updated_at: new Date().toISOString() })
          .eq('id', bot.id), { label: 'bots→inactive (обмен)', log }).catch(() => {});
        return 0;
      }
    } else if (plan.conversion) {
      log(`  обмен пропущен: баланс уже покрывает сетку (CITRO ${bal.CITRO}≥${needCitro}, USDT ${bal.USDT}≥${needUsdt}) — обмен уже выполнялся`);
    } else {
      log('  обмен не требуется');
    }

    // Запись ВСЕХ намерений одним батчем (атомарно — все строки или ни одной).
    try {
      rows = await insertIntentsBatch(supabase, bot, plan.orders, log);
    } catch (e) {
      if (didRebalance) {
        // Обмен прошёл, но сетку записать не смогли. Не повторяем обмен автоматически
        // (риск двойной конвертации) — останавливаем и зовём человека проверить баланс.
        const msg = 'Обмен выполнен, но сетку не удалось записать (проблема с БД). Бот остановлен — проверьте баланс перед повторным запуском.';
        log(`  ✗ ${msg} (${e.message})`);
        await sb(() => supabase.from('bots')
          .update({ status: 'inactive', status_message: msg, updated_at: new Date().toISOString() })
          .eq('id', bot.id), { label: 'bots→inactive (намерения после обмена)', log }).catch(() => {});
      } else {
        // Обмена не было — повтор безопасен: оставляем active, попробуем снова на след. тике.
        log(`  ✗ не удалось записать намерения сетки (${e.message}) — повтор на следующем тике`);
        await sb(() => supabase.from('bots')
          .update({ status_message: 'Готовлю сетку (проблема с БД), повтор…', updated_at: new Date().toISOString() })
          .eq('id', bot.id), { label: 'bots статус (намерения)', log }).catch(() => {});
      }
      return 0;
    }
  }

  // РАЗМЕЩЕНИЕ/ДОСТРОЙКА: ставим все строки в статусе 'placing'
  const placingRows = rows.filter((r) => r.status === 'placing');
  if (placingRows.length === 0) { placeFailStreak.delete(bot.id); return 0; } // всё выставлено

  let placed = 0, failed = 0, adopted = 0;
  for (const row of placingRows) {
    // Уже на бирже? (ответ прошлой попытки потерялся) → усыновляем, не дублируем.
    const m = findActive(active, row.side, row.price);
    if (m) {
      await sb(() => supabase.from('bot_orders')
        .update({ exchange_order_id: m.id, status: 'open', updated_at: new Date().toISOString() })
        .eq('id', row.id), { label: `усыновление ур.${row.level_index}`, log }).catch(() => {});
      adopted++; placed++;
      log(`  ✓ уровень ${row.level_index}: ордер уже на бирже (id=${m.id}) — усыновлён`);
      continue;
    }
    const data = { symbol: SYMBOL, action: row.side, type: 'limit',
                   price: String(row.price), amount: String(row.amount) };
    try {
      const res = await citronus.createOrder(data, apiKey, secret);
      await sb(() => supabase.from('bot_orders')
        .update({ exchange_order_id: res.id || null, status: 'open', updated_at: new Date().toISOString() })
        .eq('id', row.id), { label: `bot_orders→open ур.${row.level_index}`, log });
      placed++;
      log(`  ✓ ${row.side} ${row.amount} CITRO @ ${row.price} → id=${res.id} (${res.status})`);
    } catch (e) {
      failed++;
      log(`  ✗ ${row.side} ${row.amount} CITRO @ ${row.price} — ОШИБКА: ${e.message} (повтор на следующем тике)`);
    }
  }

  // Итог
  if (failed === 0) {
    placeFailStreak.delete(bot.id);
    log(`▶ "${bot.name}": сетка собрана (выставлено ${placed}${adopted ? `, усыновлено ${adopted}` : ''})`);
    await sb(() => supabase.from('bots')
      .update({ status_message: null, updated_at: new Date().toISOString() })
      .eq('id', bot.id), { label: 'bots очистка сообщения', log }).catch(() => {});
  } else {
    // Считаем подряд идущие неудачи; после PLACE_FAIL_MAX останавливаем бота
    // с ошибкой, а не ретраим вечно молча (его ордера снимет handleCancellations).
    const streak = (placeFailStreak.get(bot.id) || 0) + 1;
    placeFailStreak.set(bot.id, streak);
    if (streak >= PLACE_FAIL_MAX) {
      placeFailStreak.delete(bot.id);
      const msg = `Не удалось выставить ${failed} ордеров сетки за ${streak} попыток. Проверьте баланс, лимит ордеров и параметры бота, затем запустите заново.`;
      log(`✗ "${bot.name}": ${msg}`);
      await sb(() => supabase.from('bots')
        .update({ status: 'inactive', status_message: msg, updated_at: new Date().toISOString() })
        .eq('id', bot.id), { label: 'bots→inactive (сетка не встаёт)', log }).catch(() => {});
    } else {
      log(`▶ "${bot.name}": выставлено ${placed}/${placingRows.length}, не встало ${failed} (попытка ${streak}/${PLACE_FAIL_MAX}) — дострою`);
      await sb(() => supabase.from('bots')
        .update({ status_message: `Достраиваю сетку: ${failed} ордеров не встало, повтор… (${streak}/${PLACE_FAIL_MAX})`, updated_at: new Date().toISOString() })
        .eq('id', bot.id), { label: 'bots статус (достройка)', log }).catch(() => {});
    }
  }
  return placed;
}

// Запись «намерения» ОДНОГО встречного ордера. Возвращает строку {id} или
// null, если уровень уже занят (23505) — тогда встречный не нужен.
async function insertCounterIntent(supabase, bot, levelIndex, side, price, qty, log) {
  return withRetry(async () => {
    const res = await supabase.from('bot_orders')
      .insert({ bot_id: bot.id, level_index: levelIndex, side, price, amount: qty, status: 'placing' })
      .select('id').single()
      .abortSignal(AbortSignal.timeout(SB_TIMEOUT_MS));
    if (!res.error) return res.data;
    if (res.error.code === '23505') return null;     // уровень уже занят — встречный не ставим
    const e = new Error(res.error.message || 'insert error'); e.code = res.error.code; throw e;
  }, { attempts: 4, label: `встречный: запись ур.${levelIndex}`, log });
}

// Выставление встречного ордера по уже записанной строке намерения.
// Идемпотентно: если ордер с такой (стороной, ценой) уже на бирже — усыновляем.
// При ошибке create_order строка остаётся 'placing' → её достроит reconcileBot.
async function placeCounterOrder(deps, bot, row, side, price, qty, activeOrders) {
  const { supabase, citronus, apiKey, secret, log } = deps;
  const m = findActive(activeOrders, side, price);
  if (m) {
    await sb(() => supabase.from('bot_orders')
      .update({ exchange_order_id: m.id, status: 'open', updated_at: new Date().toISOString() })
      .eq('id', row.id), { label: `встречный adopt ур.`, log }).catch(() => {});
    log(`  ✓ встречный ${side} @ ${price}: уже на бирже (id=${m.id}) — усыновлён`);
    return;
  }
  try {
    const res = await citronus.createOrder(
      { symbol: SYMBOL, action: side, type: 'limit', price: String(price), amount: String(qty) }, apiKey, secret);
    await sb(() => supabase.from('bot_orders')
      .update({ exchange_order_id: res.id || null, status: 'open', updated_at: new Date().toISOString() })
      .eq('id', row.id), { label: 'встречный→open', log });
    log(`  ✓ встречный ${side} ${qty} CITRO @ ${price} → id=${res.id} (${res.status})`);
  } catch (e) {
    log(`  ✗ встречный ${side} ${qty} CITRO @ ${price} — ОШИБКА: ${e.message} (достроится на следующем тике)`);
  }
}

// РЕАКЦИЯ НА ИСПОЛНЕНИЕ
// Открытый ордер, исчезнувший из active_orders у АКТИВНОГО бота, считаем
// исполненным (мы его не отменяли). Записываем сделку, помечаем 'filled' и
// ставим встречный на соседний уровень — ТОЛЬКО если тот уровень пуст.
//   buy исполнен на уровне i  → SELL на i+1 (выше);
//   sell исполнен на уровне i → BUY  на i-1 (ниже).
// ВАЖНО для надёжности: исполнение «закрываем» (пишем сделку + filled) лишь
// ПОСЛЕ того, как намерение встречного записано в БД (или встречный не нужен).
// Если намерение записать не удалось — не закрываем, повторим на следующем тике.
async function handleFills(bot, botRows, ctx, deps) {
  const { supabase, citronus, apiKey, secret, log } = deps;
  const { activeOrders = [], baseDec = 2, priceDec = 5, minQty = 1, minAmt = 0.1,
          commissionBuy = 0, commissionSell = 0 } = ctx;
  const cfg = bot.config || {};

  // Кандидаты: наши выставленные (open + есть биржевой id) ордера…
  const openRows = botRows.filter(r => r.status === 'open' && r.exchange_order_id);
  // …номера которых больше НЕТ среди живых ордеров биржи → исполнены. Сопоставляем
  // СТРОГО по номеру (id), приводя к строке с обеих сторон: у нас он хранится
  // текстом, а биржа может отдать числом. По цене больше НЕ проверяем — иначе чужой
  // ордер (другой бот/ручной) на той же цене маскировал бы исполнение.
  const filled = openRows.filter(r =>
    !activeOrders.some(o => String(o.id) === String(r.exchange_order_id)));
  if (filled.length === 0) return;

  // ФАКТ исполнения берём из orders_history (реальные цена/объём/комиссия). История
  // ПОСТРАНИЧНАЯ (новые сверху): читаем ровно столько страниц, чтобы найти именно
  // «пропавшие» в этом цикле ордера (filled). Иначе недавняя отмена за пределами
  // первой страницы потерялась бы, и отменённый ордер можно было бы принять за
  // исполнение — с ложным встречным ордером. Обычно всё на первой странице.
  let histMap = new Map();
  try {
    const wantedIds = filled.map(f => f.exchange_order_id).filter(Boolean);
    histMap = await citronus.getOrdersHistoryMap(apiKey, secret, { symbol: SYMBOL, wantedIds });
  } catch (e) {
    log(`  ! история ордеров не получена — комиссию оценим по ставке: ${e.message}`);
  }

  // Цены уровней — той же функцией grid-core, что и при создании (точное совпадение).
  const grid = GridCore.computeGridLevels(cfg.priceLow, cfg.priceHigh, cfg.gridCount, filled[0].price);
  if (!grid) { log(`  ! "${bot.name}": не удалось пересчитать уровни сетки`); return; }
  const levels = grid.levels, count = cfg.gridCount;

  // Занятые уровни = открытые/размещаемые, КРОМЕ только что исполнившихся.
  const occupied = new Set(botRows.filter(r => r.status === 'open' || r.status === 'placing').map(r => r.level_index));
  for (const f of filled) occupied.delete(f.level_index);

  for (const f of filled) {
    // ОТМЕНА vs ИСПОЛНЕНИЕ по orders_history. Если ордер отменён (status
    // canceled, ничего не исполнено) — это НЕ сделка (пользователь/биржа сняли
    // его). Бот активен → ВОССТАНАВЛИВАЕМ сетку: ставим такой же лимитный ордер,
    // встречный не ставим, статус не трогаем.
    const hc = histMap.get(String(f.exchange_order_id));
    if (hc && hc.status && /cancel/i.test(hc.status) && !(Number.isFinite(hc.amount) && hc.amount > 1e-9)) {
      try {
        const res = await citronus.createOrder(
          { symbol: SYMBOL, action: f.side, type: 'limit', price: String(f.price), amount: String(f.amount) }, apiKey, secret);
        await sb(() => supabase.from('bot_orders')
          .update({ exchange_order_id: res.id || null, updated_at: new Date().toISOString() })
          .eq('id', f.id), { label: `восстановление ур.${f.level_index}`, log }).catch(() => {});
        log(`  ↻ ордер ${f.side} @ ${f.price} (ур.${f.level_index}) отменён на бирже — восстановлен (id=${res.id})`);
      } catch (e) {
        log(`  ! не удалось восстановить ур.${f.level_index}: ${e.message} — повтор на следующем тике`);
      }
      occupied.add(f.level_index); // уровень снова занят — другие встречные сюда не целятся
      continue;
    }

    log(`  ● исполнен ${f.side} @ ${f.price} (ур.${f.level_index}, id=${f.exchange_order_id})`);

    const targetIdx  = f.side === 'buy' ? f.level_index + 1 : f.level_index - 1;
    const targetSide = f.side === 'buy' ? 'sell' : 'buy';
    let counterSecured = true; // можно ли закрывать исполнение

    if (targetIdx < 0 || targetIdx > count) {
      log(`  · встречный вне диапазона сетки (ур.${targetIdx}) — пропуск`);
    } else if (occupied.has(targetIdx)) {
      log(`  · уровень ${targetIdx} занят — встречный не ставим (правило «только если пусто»)`);
    } else {
      const targetPrice = engine.roundTo(levels[targetIdx], priceDec);
      // размер: sell — чуть меньше полученного (комиссия), buy — полный (фундируется USDT)
      const qty = targetSide === 'sell'
        ? engine.floorTo(f.amount * (1 - COUNTER_SELL_HAIRCUT), baseDec)
        : engine.floorTo(f.amount, baseDec);

      if (qty < minQty || qty * targetPrice < minAmt) {
        log(`  · встречный ${targetSide} ${qty} @ ${targetPrice} ниже минимума биржи — пропуск`);
      } else {
        try {
          const row = await insertCounterIntent(supabase, bot, targetIdx, targetSide, targetPrice, qty, log);
          if (row === null) {
            log(`  · уровень ${targetIdx} уже занят (гонка) — встречный не нужен`);
          } else {
            occupied.add(targetIdx);
            await placeCounterOrder(deps, bot, row, targetSide, targetPrice, qty, activeOrders);
          }
        } catch (e) {
          counterSecured = false; // намерение встречного не записано → исполнение НЕ закрываем
          log(`  ! встречный к ур.${f.level_index} не записан (${e.message}) — закроем исполнение на следующем тике`);
        }
      }
    }

    if (!counterSecured) continue; // не пишем сделку и не помечаем filled — повтор на следующем тике

    // ФАКТ исполнения: цена/объём/комиссия из orders_history. Если ордера там ещё
    // нет — цена лимитки и наш объём точны для полностью исполненной лимитки, а
    // комиссию считаем по реальной ставке из markets (в QUOTE/USDT, на обе стороны).
    const h          = histMap.get(String(f.exchange_order_id)) || {};
    const fillPrice  = Number.isFinite(h.price)  ? h.price  : (f.price  != null ? Number(f.price)  : null);
    const fillAmount = Number.isFinite(h.amount) ? h.amount : (f.amount != null ? Number(f.amount) : null);
    const rate       = f.side === 'buy' ? commissionBuy : commissionSell;
    const fillFee    = Number.isFinite(h.fee) ? h.fee
                     : ((fillPrice != null && fillAmount != null) ? rate * fillPrice * fillAmount : null);
    const feeSource  = Number.isFinite(h.fee) ? 'orders_history' : 'estimate';

    // Сделку пишем ИДЕМПОТЕНТНО. Если ордер уже записан (напр. на прошлом тике
    // пометка filled не прошла и мы попали сюда повторно) — БАЗА сама отклонит
    // дубль по уникальному индексу (bot_id, exchange_order_id, kind), поэтому
    // прибыль в статистике не задвоится. upsert с ignoreDuplicates = «вставить, а
    // при конфликте ничего не делать» — атомарно, без окна между проверкой и вставкой.
    try {
      const inserted = await sb(() => supabase.from('bot_trades')
        .upsert({
          bot_id: bot.id, exchange_order_id: f.exchange_order_id || null, side: f.side, kind: 'fill',
          price:  fillPrice,
          amount: fillAmount,
          total:  (fillPrice != null && fillAmount != null) ? fillPrice * fillAmount : null,
          fee:    fillFee,
          raw: { detected: 'gone_from_active_orders', level_index: f.level_index, fee_source: feeSource },
          filled_at: new Date().toISOString()
        }, { onConflict: 'bot_id,exchange_order_id,kind', ignoreDuplicates: true })
        .select('id'),
        { label: 'bot_trades (fill)', log, attempts: 2 });
      if (!(inserted && inserted.length)) {
        log(`  · сделка по id=${f.exchange_order_id} уже записана — повтор пропущен`);
      }
    } catch (e) {
      log(`  ! лог исполнения не записан: ${e && e.message}`);
    }

    await sb(() => supabase.from('bot_orders')
      .update({ status: 'filled', updated_at: new Date().toISOString() })
      .eq('id', f.id), { label: `bot_orders→filled ур.${f.level_index}`, log }).catch((e) => log(`  ! не пометил filled ур.${f.level_index}: ${e.message}`));
  }
}

// Остановка бота: снимаем все его открытые/размещаемые ордера.
// Обратной конвертации при остановке НЕ делаем. Статус бота уже inactive (из UI).
// Ордер помечаем 'cancelled' ТОЛЬКО когда его уже нет в active_orders —
// иначе при сбое отмены мы бы «потеряли» живой ордер на бирже.
async function stopBot(bot, ctx, deps) {
  const { supabase, citronus, apiKey, secret, log } = deps;
  const active = ctx.activeOrders || [];

  let rows;
  try {
    rows = await sb(() => supabase.from('bot_orders')
      .select('id, exchange_order_id, side, price, status')
      .eq('bot_id', bot.id)
      .in('status', ['open', 'placing']), { label: 'чтение ордеров для отмены', log });
  } catch (e) { log(`✗ stopBot чтение ордеров: ${e.message}`); return; }
  if (!rows || rows.length === 0) return;

  log(`■ остановка "${bot.name}": ${rows.length} ордеров к снятию`);
  let remaining = 0;
  for (const row of rows) {
    // Ордер ещё на бирже? Если у строки есть номер — сопоставляем СТРОГО по нему
    // (как строки), чтобы не задеть чужой ордер на той же цене. Номера нет (ордер
    // не подтверждён) — тогда по (сторона, цена).
    const m = row.exchange_order_id
      ? active.find((o) => String(o.id) === String(row.exchange_order_id))
      : active.find((o) => o.side === row.side && priceEq(o.price, row.price));

    if (!m) {
      // На бирже его НЕТ → отмена подтверждена (или ордер исполнился) → cancelled.
      await sb(() => supabase.from('bot_orders')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', row.id), { label: 'bot_orders→cancelled', log }).catch(() => {});
      log(`  ✓ ${row.side} @ ${row.price}: снят (подтверждено)`);
    } else {
      // Ещё жив → просим отмену. Статус НЕ меняем — подтвердим на следующем тике.
      remaining++;
      try {
        await citronus.cancelOrder(m.id, apiKey, secret);
        log(`  → запрошена отмена ${row.side} @ ${row.price} (id=${m.id})`);
      } catch (e) {
        log(`  ! отмена ${m.id} не прошла: ${e.message} — повтор на следующем тике`);
      }
    }
  }
  if (remaining > 0) log(`■ "${bot.name}": ещё ${remaining} ордеров снимаются — подтвердим на следующем тике`);
  else               log(`■ остановка "${bot.name}" завершена`);
}

module.exports = { reconcileBot, handleFills, stopBot };
