//  RUNNER — действия с биржей: сверка сетки (запуск/достройка) и остановка.
//  Здесь — реальные create_order / cancel_order + записи в БД.
//
//  Принципы безопасности (самовосстановление):
//   • reconcileBot вызывается каждый тик для активного бота и приводит его
//     сетку к плану: СВЕЖИЙ цикл (нет строк) → обмен + запись намерений;
//     НЕПОЛНАЯ сетка (есть строки 'placing') → доставляем недостающее.
//   • Перед каждым размещением сверяемся с active_orders: если НАШ ордер уже на
//     бирже — «усыновляем» строку, а не выставляем дубль. Это делает повтор
//     create_order безопасным. «Наш» = совпали сторона и цена И номер не закреплён
//     ни за одной строкой bot_orders И объём не больше нашего — иначе бот забрал бы
//     чужой ордер, ведь active_orders отдаётся на ВЕСЬ аккаунт (см. findActive).
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
const { withRetry, sleep } = require('./net');
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

// Запас при докомпенсации объёма до стартового: встречный ордер ставим не больше,
// чем свободный баланс × этот коэффициент — защита от «дрожи» баланса/округления,
// чтобы ордер гарантированно был обеспечен (тот же смысл, что у хайрката).
const TOPUP_SAFETY = 0.999;

// Проверка обмена. Биржа отвечает на рыночный ордер `status: "placed"` — это «принят»,
// а НЕ «исполнен». Подтверждено 07.08.2026: рыночная продажа 109.14 CITRO получила в
// истории статус «Завершено» при нулевом исполнении, деньги не конвертировались, и
// сетка была обречена ещё до постановки. Поэтому ответу не верим, а перечитываем
// баланс — он и есть ответ на вопрос «можем ли мы теперь собрать сетку». Даём бирже
// несколько секунд на зачисление; не подтвердилось — сетку не строим вовсе.
const FUND_CHECK_TRIES    = 4;
const FUND_CHECK_PAUSE_MS = 1500;
// Допуск: обмен почти никогда не попадает в потребность копейка в копейку — мешают
// комиссия рыночного ордера и дрожь стакана. Недобор в пределах процента нормален и
// добирается ужатием последнего ордера под факт. А вот неисполнившийся обмен — это
// недобор в десятки процентов, его этот допуск не пропустит.
const FUND_TOLERANCE = 0.01;

// Сколько тиков подряд «недоставленной» сетки терпим, прежде чем остановить бота с
// ошибкой (его ордера затем снимет handleCancellations). Неполная сетка недопустима:
// для пользователя пропавший уровень = сломанный продукт, поэтому лучше быстро снять
// всё и показать причину, чем долго держать наполовину собранную сетку.
const PLACE_FAIL_MAX = 5;               // ~10 c при тике 2 c
const placeFailStreak = new Map();      // bot.id → тиков подряд с непоставленными ордерами

// Допуск при сравнении объёмов (объёмы округлены до сотых, шум — на уровне 1e-9).
const AMOUNT_EPS = 1e-9;

// Ищет среди открытых ордеров биржи НАШ ордер — тот, что мы, возможно, уже выставили
// этой строкой, но не успели записать. Кроме стороны и цены проверяем ещё два условия,
// иначе бот присвоит чужой ордер (active_orders отдаётся на ВЕСЬ аккаунт):
//   • номер не закреплён ни за одной строкой bot_orders — иначе это ордер другого бота;
//   • объём не больше нашего — наш ордер такого объёма и есть, а частичное исполнение
//     объём только уменьшает; больший объём означает чужой ордер (например ручной).
// claimed = null (не смогли прочитать занятые номера) → не усыновляем вовсе.
function findActive(active, side, price, qty, claimed) {
  if (!claimed) return null;
  return (active || []).find((o) =>
    o.side === side && priceEq(o.price, price) &&
    !claimed.has(String(o.id)) &&
    (!Number.isFinite(o.amount) || !Number.isFinite(qty) || o.amount <= qty + AMOUNT_EPS)
  ) || null;
}

// Номера ордеров, уже закреплённых за какой-либо строкой — по ВСЕМ ботам, включая
// останавливающиеся. Такой ордер точно не «наш потерянный», присваивать его нельзя.
// Не прочитали — возвращаем null: лучше выставить ордер заново, чем забрать чужой.
async function loadClaimedIds(supabase, log) {
  try {
    const rows = await sb(() => supabase.from('bot_orders')
      .select('exchange_order_id').in('status', ['open', 'placing'])
      .not('exchange_order_id', 'is', null), { label: 'занятые номера ордеров', log });
    return new Set((rows || []).map((r) => String(r.exchange_order_id)));
  } catch (e) {
    log(`  ! занятые номера ордеров не прочитаны (${e.message}) — усыновление в этот тик пропускаю`);
    return null;
  }
}

// ЧЕМ ЗАКОНЧИЛАСЬ ПОПЫТКА ПОСТАВИТЬ ОРДЕР.
// Если биржа ОТВЕТИЛА отказом по существу (не хватает средств, лимит, кривые параметры)
// — ордера точно нет, повторять безопасно. А вот «ответа не было» (таймаут, обрыв) и
// внутренняя ошибка сервера (HTTP 5xx или code вида internal_server_error) о судьбе
// ордера не говорят НИЧЕГО: он мог быть создан до того, как у биржи упало. Раньше нас
// невольно прикрывала её дедупликация — одинаковый повтор второй ордер не создавал; с
// уникальными номерами запросов эта страховка исчезла, и слепой повтор даст ДВА живых
// ордера на уровне, причём второй не отслеживается и не снимется при остановке.
function ambiguousOutcome(e) {
  if (!e) return false;
  if (!e.citronus && !e.httpStatus) return true;          // ответа не было вовсе
  if (e.httpStatus >= 500) return true;                    // сервер биржи упал
  const code = (e.citronus && e.citronus.code) ? String(e.citronus.code) : '';
  return /internal|server[\s_-]?error|timeout/i.test(`${code} ${e.message || ''}`);
}

// Строки с неопределённым исходом. Держим в памяти воркера ограниченное время: метка
// нужна только до ближайшей успешной сверки с биржей. Перезапуск метки теряет — тогда
// сработает обычное усыновление, оно и так идёт перед каждой постановкой.
const UNKNOWN_TTL_MS   = 10 * 60 * 1000;
const unknownPlacement = new Map();     // bot_orders.id → когда была неопределённая попытка
function markUnknown(rowId)  { unknownPlacement.set(rowId, Date.now()); }
function clearUnknown(rowId) { unknownPlacement.delete(rowId); }
function isUnknown(rowId) {
  const at = unknownPlacement.get(rowId);
  if (at == null) return false;
  if (Date.now() - at > UNKNOWN_TTL_MS) { unknownPlacement.delete(rowId); return false; }
  return true;
}

// Помешают ли обмену НАШИ ЖЕ ордера. Биржа не даёт рыночному ордеру исполниться о
// собственные лимитки того же аккаунта — и сообщает об этом крайне неудачно: ордер
// помечается «завершённым» с нулевым исполнением, деньги не конвертируются, а сетка
// остаётся без средств (подтверждено на бирже 07.08.2026). Поэтому смотрим ЗАРАНЕЕ:
// проходим стакан на объём обмена и проверяем, нет ли в этом диапазоне цен наших
// ордеров встречной стороны. Есть — обмен не отправляем вовсе.
// Возвращает мешающий ордер или null. Нет стакана/списка ордеров — null (не мешаем).
function selfTradeBlocker(conv, ob, active) {
  const buying = conv.from.t === 'USDT';            // рыночная ПОКУПКА съедает аски
  const raw    = (buying ? (ob && ob.a) : (ob && ob.b)) || [];
  const levels = raw.map(GridCore.parseLevel).filter(Boolean)
    .sort((x, y) => (buying ? x.price - y.price : y.price - x.price));
  if (levels.length === 0) return null;

  // Идём от лучшей цены, пока не наберём объём обмена (USDT при покупке, CITRO при
  // продаже), и запоминаем худшую цену, до которой обмен дошёл бы.
  let need = conv.from.amt, worst = levels[0].price;
  for (const lvl of levels) {
    worst = lvl.price;
    const take = buying ? lvl.size * lvl.price : lvl.size;
    if (need <= take) break;
    need -= take;
  }

  const side = buying ? 'sell' : 'buy';             // наши ордера встречной стороны
  return (active || []).find((o) => o.side === side &&
    (buying ? o.price <= worst + PRICE_EPS : o.price >= worst - PRICE_EPS)) || null;
}

// Комиссия ОДНОГО исполнения в USDT. Из orders_history комиссия приходит в
// ПОЛУЧЕННОМ активе: покупка → в CITRO (base) → умножаем на цену; продажа → уже в
// USDT (quote). Если истории нет — оцениваем по ставке из markets (в USDT).
// price у нас всегда известна (bot_orders.price NOT NULL), поэтому вернём число.
function feeUsdt(side, hist, price, base, rate) {
  if (hist && Number.isFinite(hist.fee)) {
    return (side === 'buy' && price != null) ? hist.fee * price : hist.fee;
  }
  return (price != null && base != null) ? rate * price * base : 0;
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
  const freshCycle = rows.length === 0;   // свежий запуск: снимок баланса устарел (обмен идёт внутри)
  let freshBalance = null;                // баланс, перечитанный ПОСЛЕ обмена (см. ниже)

  // СВЕЖИЙ ЦИКЛ: ни одного открытого/размещаемого ордера
  if (rows.length === 0) {
    log(`▶ запуск бота "${bot.name}" (${bot.id.slice(0, 8)}…)`);

    // Снимок открытых ордеров пары на момент запуска — видно, что биржа отдаёт на
    // самом деле и насколько это свежо. Именно по этому списку бот решает, не стоит
    // ли ордер уровня уже на бирже, поэтому в момент сборки сетки он важнее всего.
    log(`  active_orders (${SYMBOL}) на момент запуска: ${active.length}`);
    for (const o of active) log(`    · ${o.side} ${o.amount} @ ${o.price} (id=${o.id})`);

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
      log(`  открытых ордеров на аккаунте (все пары): ${accOpen}, ставим ${need}, лимит ${ORDER_LIMIT}`);
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

      // Наши же ордера на пути обмена → биржа его не исполнит. Не отправляем вовсе.
      const blocker = selfTradeBlocker(cv, ctx.ob, active);
      if (blocker) {
        const msg = 'Обмен невозможен: по цене обмена стоят ваши собственные ордера. Биржа не позволяет торговать с самим собой.';
        log(`  ✗ ${msg} (мешает ${blocker.side} @ ${blocker.price}, id=${blocker.id})`);
        await sb(() => supabase.from('bots')
          .update({ status: 'inactive', status_message: msg, updated_at: new Date().toISOString() })
          .eq('id', bot.id), { label: 'bots→inactive (обмен: сделка с самим собой)', log }).catch(() => {});
        return 0;
      }

      const data = cv.from.t === 'USDT'
        ? { symbol: SYMBOL, action: 'buy',  type: 'market', total:  String(engine.floorTo(cv.from.amt, 6)) }
        : { symbol: SYMBOL, action: 'sell', type: 'market', amount: String(engine.floorTo(cv.from.amt, 2)) };
      try {
        log(`  обмен (market ${data.action}): ${JSON.stringify(data)}`);
        const res = await citronus.createOrder(data, apiKey, secret);
        didRebalance = true;
        log(`  ✓ обмен принят биржей: id=${res.id} status=${res.status} — проверяю, исполнился ли он`);

        // ПОДТВЕРЖДЕНИЕ ОБМЕНА по балансу (см. FUND_CHECK_TRIES).
        let funded = false, fresh = null;
        for (let i = 1; i <= FUND_CHECK_TRIES; i++) {
          if (i > 1) await sleep(FUND_CHECK_PAUSE_MS);
          try { fresh = await citronus.getBalance(apiKey, secret); }
          catch (e) { log(`  ! баланс после обмена не прочитан (${e.message}) — повтор`); continue; }
          const okCitro = fresh.CITRO + 1e-8 >= needCitro * (1 - FUND_TOLERANCE);
          const okUsdt  = fresh.USDT  + 1e-8 >= needUsdt  * (1 - FUND_TOLERANCE);
          if (okCitro && okUsdt) { funded = true; break; }
          log(`  · после обмена средств пока не хватает (CITRO ${fresh.CITRO}/${needCitro}, USDT ${fresh.USDT}/${needUsdt}) — жду ${i}/${FUND_CHECK_TRIES}`);
        }

        // Факт обмена берём из истории завершённых: у рыночного ордера поля price/
        // current_amount/total приходят пустыми, реальные цифры есть только там.
        let hc = null;
        if (res.id) {
          try {
            const hm = await citronus.getOrdersHistoryMap(apiKey, secret, { symbol: SYMBOL, wantedIds: [res.id], maxPages: 2 });
            hc = hm.get(String(res.id)) || null;
          } catch (e) { log(`  ! факт обмена из истории не прочитан (${e.message})`); }
        }
        const cAmount = hc && Number.isFinite(hc.amount) ? hc.amount
                      : (res.current_amount != null ? parseFloat(res.current_amount) : null);
        const cPrice  = hc && Number.isFinite(hc.price) ? hc.price
                      : (res.price != null ? parseFloat(res.price) : null);
        const cFee    = hc && Number.isFinite(hc.fee) ? hc.fee
                      : (res.fee != null ? parseFloat(res.fee) : null);
        const cTotal  = (cPrice != null && cAmount != null) ? cPrice * cAmount
                      : (res.market_total_current != null ? parseFloat(res.market_total_current)
                      : (res.total != null ? parseFloat(res.total) : null));
        log(`  обмен по факту: исполнено ${cAmount != null ? cAmount : '?'} по цене ${cPrice != null ? cPrice : '?'} (статус в истории: ${hc && hc.status ? hc.status : 'нет записи'})`);

        await sb(() => supabase.from('bot_trades').upsert({
          bot_id: bot.id, exchange_order_id: res.id || null, side: data.action, kind: 'rebalance',
          price: cPrice, amount: cAmount, total: cTotal, fee: cFee,
          raw: { response: res, history: hc }, filled_at: new Date().toISOString()
        }, { onConflict: 'bot_id,exchange_order_id,kind', ignoreDuplicates: true }),
          { label: 'bot_trades (обмен)', log, attempts: 2 }).catch((e) => log(`  ! лог обмена не записан (не критично): ${e.message}`));

        // Обмен не дал нужных средств → сетку НЕ выставляем вовсе: неполная сетка
        // недопустима, а половина ордеров при уже потраченном обмене — худший исход.
        if (!funded) {
          const msg = 'Обмен на бирже не исполнился, сетка не выставлена. Проверьте баланс и запустите бота заново.';
          log(`  ✗ ${msg}`);
          await sb(() => supabase.from('bots')
            .update({ status: 'inactive', status_message: msg, updated_at: new Date().toISOString() })
            .eq('id', bot.id), { label: 'bots→inactive (обмен не исполнился)', log }).catch(() => {});
          return 0;
        }
        // Свежий баланс пригодится при постановке: если обмен недобрал процент,
        // последний ордер ужмётся под факт, а не упадёт с «недостаточно средств».
        freshBalance = fresh;
        log(`  ✓ средства подтверждены: CITRO ${fresh.CITRO} при нужных ${needCitro}, USDT ${fresh.USDT} при нужных ${needUsdt}`);
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

    // Запоминаем СТАРТОВЫЙ объём ордера сетки (все ордера сетки одинаковы) — от него
    // handleFills «докомпенсирует» объём встречных ордеров, чтобы позиция не таяла
    // из-за комиссий. Best-effort: сбой записи не критичен (без base_qty докомпенсация
    // просто не включится, бот работает как раньше).
    const baseQty = plan.orders.length ? plan.orders[0].qty : null;
    if (baseQty != null) {
      await sb(() => supabase.from('bots')
        .update({ base_qty: baseQty }).eq('id', bot.id),
        { label: 'bots.base_qty', log, attempts: 2 }).catch(() => {});
    }
  }

  // РАЗМЕЩЕНИЕ/ДОСТРОЙКА: ставим все строки в статусе 'placing'
  const placingRows = rows.filter((r) => r.status === 'placing');
  if (placingRows.length === 0) { placeFailStreak.delete(bot.id); return 0; } // всё выставлено

  // СТРАХОВКА ПО СРЕДСТВАМ: ужимаем ордер под реально свободный баланс, чтобы биржа не
  // отклоняла его по нехватке средств → эскалация в стоп. В свежем цикле снимок из тика
  // устарел (он до обмена), поэтому берём баланс, перечитанный ПОСЛЕ обмена; если обмена
  // не было — снимок и так актуален. Параметры рынка — из тика.
  const market  = ctx.market || {};
  const baseDec = Number.isInteger(market.trade_base_precision) ? market.trade_base_precision : 2;
  const minQty  = parseFloat(market.min_order_qty) || 1;
  const minAmt  = parseFloat(market.min_order_amt) || 0.1;
  const bal     = freshCycle ? freshBalance : (ctx.balance || null);

  // Читаем ОДИН раз на всю пачку: чьи ордера уже заняты (см. findActive).
  const claimed = await loadClaimedIds(supabase, log);

  let placed = 0, failed = 0, adopted = 0;
  for (const row of placingRows) {
    // Уже на бирже? (ответ прошлой попытки потерялся) → усыновляем, не дублируем.
    const m = findActive(active, row.side, row.price, Number(row.amount), claimed);
    if (m) {
      await sb(() => supabase.from('bot_orders')
        .update({ exchange_order_id: m.id, status: 'open', updated_at: new Date().toISOString() })
        .eq('id', row.id), { label: `усыновление ур.${row.level_index}`, log }).catch(() => {});
      clearUnknown(row.id);
      adopted++; placed++;
      log(`  ✓ уровень ${row.level_index}: ордер уже на бирже (id=${m.id}) — усыновлён`);
      continue;
    }
    // Прошлая попытка по этой строке закончилась неопределённо — ордер мог встать.
    // Единственная проверка «не встал ли он» — сверка выше, а она работает только когда
    // прочитаны занятые номера. Не прочитаны → вслепую не выставляем, ждём следующего
    // тика: лишний ордер на уровне хуже, чем задержка (а если не прояснится, бота
    // остановит общий счётчик неудач).
    if (isUnknown(row.id) && !claimed) {
      failed++;
      log(`  ? ур.${row.level_index}: прошлая попытка без определённого ответа, проверить нечем — жду, чтобы не выставить дубль`);
      continue;
    }
    // Ужатие под факт. Если реально свободного меньше объёма — ужимаем ордер (иначе биржа
    // отклонит по средствам). НО при очень низком снимке (вероятно задержка зачисления) НЕ
    // ужимаем — ставим полный и доверяем бирже, иначе «недопродали» бы то, что на бирже есть.
    let amount = Number(row.amount);
    if (bal) {
      const p    = Number(row.price);
      const free = row.side === 'sell' ? bal.CITRO : (p > 0 ? bal.USDT / p : 0);
      const cap  = engine.floorTo(Math.max(0, free) * TOPUP_SAFETY, baseDec);
      if (cap >= minQty && cap * p >= minAmt && cap < amount) amount = cap;   // ужимаем только когда есть смысл
    }
    const data = { symbol: SYMBOL, action: row.side, type: 'limit',
                   price: String(row.price), amount: String(amount) };
    let res;
    try {
      res = await citronus.createOrder(data, apiKey, secret);
    } catch (e) {
      failed++;
      // ВРЕМЕННАЯ ДИАГНОСТИКА (04.08.2026): биржа отвечает «Internal server error» на
      // отдельные ордера, хотя тот же ордер из отдельного скрипта проходит. Печатаем
      // ответ биржи целиком (кроме текста там бывают code и data) и тело, которое реально
      // ушло. Секретов в теле нет — ключ и подпись живут в заголовках. Убрать после разбора.
      const err = e.citronus || null;
      if (ambiguousOutcome(e)) {
        // Биржа не сказала, создан ордер или нет. Метим строку: перед повтором
        // обязательно сверимся с её списком ордеров (см. проверку выше по циклу).
        markUnknown(row.id);
        log(`  ? ${row.side} ${amount} CITRO @ ${row.price} — биржа не дала определённого ответа (${e.message}); перед повтором проверю, не встал ли ордер`);
      } else {
        log(`  ✗ ${row.side} ${amount} CITRO @ ${row.price} — ОШИБКА: ${e.message} (повтор на следующем тике)`);
      }
      log(`    [диаг] http=${e.httpStatus || '—'} код=${(err && err.code) || '—'} данные=${JSON.stringify(err && err.data) || '—'} ответ=${JSON.stringify(err) || '—'}`);
      log(`    [диаг] отправляли: ${JSON.stringify(data)}`);
      continue;
    }
    // create_order ПРОШЁЛ — ордер на бирже. Пишем его id. Если запись сорвётся — ОТМЕНЯЕМ
    // выставленный ордер (иначе «сирота» → на след. тике переставим → ДУБЛЬ на уровне). Строка
    // останется 'placing' → переставится чисто. Так закрываем дубли без биржевой идемпотентности.
    try {
      const patch = { exchange_order_id: res.id || null, status: 'open', updated_at: new Date().toISOString() };
      if (amount !== Number(row.amount)) patch.amount = amount;   // ужали — сохраняем фактический объём
      await sb(() => supabase.from('bot_orders').update(patch)
        .eq('id', row.id), { label: `bot_orders→open ур.${row.level_index}`, log });
      clearUnknown(row.id);     // выставлено и записано — неопределённости больше нет
      if (bal) { if (row.side === 'sell') bal.CITRO -= amount; else bal.USDT -= amount * Number(row.price); } // резервируем в снимке
      placed++;
      if (amount !== Number(row.amount))
        log(`  ✓ ${row.side} ${amount} CITRO @ ${row.price} (ужат под баланс с ${row.amount}) → id=${res.id}`);
      else
        log(`  ✓ ${row.side} ${amount} CITRO @ ${row.price} → id=${res.id} (${res.status})`);
    } catch (writeErr) {
      failed++;
      log(`  ! ур.${row.level_index}: ордер ${res && res.id} выставлен, но не записан (${writeErr.message}) — отменяю во избежание дубля`);
      if (res && res.id) {
        try { await citronus.cancelOrder(res.id, apiKey, secret); log(`  ↩ ${res.id} отменён (дубль предотвращён)`); }
        catch (cErr) {
          // Сироту снять не удалось — он мог остаться живым. Метим строку: на следующем
          // тике сверка подберёт именно его вместо постановки нового.
          markUnknown(row.id);
          log(`  ! не снял сироту ${res.id}: ${cErr.message} — попробую подобрать его на следующем тике`);
        }
      }
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

// Выставление ордера по уже записанной строке ('placing') → 'open'. Идемпотентно:
// если НАШ ордер с такой (стороной, ценой) уже на бирже — усыновляем (проверки «наш ли
// он» — в findActive). При ошибке create_order строка остаётся 'placing' → её достроит
// reconcileBot. what — только для лога («встречный», «остаток»).
async function placeRow(deps, bot, row, side, price, qty, activeOrders, claimed, what = 'ордер') {
  const { supabase, citronus, apiKey, secret, log } = deps;
  const m = findActive(activeOrders, side, price, qty, claimed);
  if (m) {
    await sb(() => supabase.from('bot_orders')
      .update({ exchange_order_id: m.id, status: 'open', updated_at: new Date().toISOString() })
      .eq('id', row.id), { label: `${what} adopt`, log }).catch(() => {});
    clearUnknown(row.id);
    log(`  ✓ ${what} ${side} @ ${price}: уже на бирже (id=${m.id}) — усыновлён`);
    return;
  }
  // Прошлая попытка закончилась неопределённо, а сверить не с чем → не выставляем
  // вслепую. Строка остаётся 'placing', её доставит reconcileBot (см. там же).
  if (isUnknown(row.id) && !claimed) {
    log(`  ? ${what} ${side} @ ${price}: прошлая попытка без определённого ответа, проверить нечем — жду`);
    return;
  }
  let res;
  try {
    res = await citronus.createOrder(
      { symbol: SYMBOL, action: side, type: 'limit', price: String(price), amount: String(qty) }, apiKey, secret);
  } catch (e) {
    if (ambiguousOutcome(e)) {
      markUnknown(row.id);
      log(`  ? ${what} ${side} ${qty} CITRO @ ${price} — биржа не дала определённого ответа (${e.message}); перед повтором проверю`);
    } else {
      log(`  ✗ ${what} ${side} ${qty} CITRO @ ${price} — ОШИБКА: ${e.message} (достроится на следующем тике)`);
    }
    return;
  }
  // create_order прошёл. Если запись id сорвётся — отменяем ордер (иначе «сирота» → дубль).
  try {
    await sb(() => supabase.from('bot_orders')
      .update({ exchange_order_id: res.id || null, status: 'open', updated_at: new Date().toISOString() })
      .eq('id', row.id), { label: `${what}→open`, log });
    clearUnknown(row.id);
    log(`  ✓ ${what} ${side} ${qty} CITRO @ ${price} → id=${res.id} (${res.status})`);
  } catch (writeErr) {
    log(`  ! ${what} ${side} @ ${price}: ордер ${res && res.id} выставлен, но не записан (${writeErr.message}) — отменяю во избежание дубля`);
    if (res && res.id) {
      try { await citronus.cancelOrder(res.id, apiKey, secret); log(`  ↩ ${res.id} отменён (дубль предотвращён)`); }
      catch (cErr) {
        markUnknown(row.id);
        log(`  ! не снял сироту ${res.id}: ${cErr.message} — попробую подобрать его на следующем тике`);
      }
    }
  }
}

// РЕАКЦИЯ НА ИСПОЛНЕНИЕ
// Открытый ордер, исчезнувший из active_orders у АКТИВНОГО бота, считаем
// исполненным (мы его не отменяли). Встречный ставим на соседний уровень (buy на
// i → sell на i+1; sell на i → buy на i-1) — ТОЛЬКО если тот уровень пуст.
//
// ЧАСТИЧНОЕ ИСПОЛНЕНИЕ + ОТМЕНА. Если часть ордера исполнилась, а остаток сняли,
// уровень не закрываем: копим прогресс (bot_orders.partial) и дозаполняем уровень
// остатком (было − исполнено). Когда уровень доисполнится — пишем ОДНУ сделку на
// суммарный объём/комиссию (id последнего ордера) и ставим встречный на суммарный
// объём. Так частичная отмена не «раздувает» встречный и даёт одну чистую сделку.
//
// АТОМАРНОСТЬ. Закрытие завершённых уровней (filled) + вставку встречных ('placing')
// + запись сделок делаем ОДНИМ вызовом apply_fills (одна транзакция в БД). Внутри
// транзакция СНАЧАЛА освобождает уровни исполнившихся ордеров, и лишь ПОТОМ вставляет
// встречные — поэтому уникальный индекс уровня не может «съесть» встречный ни при
// цепочке соседних исполнений, ни в «кольцевом» случае. Применяется всё либо целиком,
// либо никак: при сбое ордера остаются 'open' и распознаются как исполнения снова на
// следующем тике. Реальные create_order на бирже делаем ПОСЛЕ коммита (по вставленным
// строкам); ошибка постановки оставляет строку 'placing' — её доставит reconcileBot.
async function handleFills(bot, botRows, ctx, deps) {
  const { supabase, citronus, apiKey, secret, log } = deps;
  const { activeOrders = [], baseDec = 2, priceDec = 5, minQty = 1, minAmt = 0.1,
          commissionBuy = 0, commissionSell = 0, balance = null } = ctx;
  const cfg = bot.config || {};

  // Докомпенсация объёма: q0 — стартовый объём ордера сетки, bal — свободный баланс
  // на ключ (общий, уменьшаем по мере резервирования в этом тике). Любой из них
  // может отсутствовать → докомпенсация просто не сработает (работаем как раньше).
  const q0  = Number.isFinite(Number(bot.base_qty)) ? Number(bot.base_qty) : 0;
  const bal = balance;

  // Наши выставленные ордера (open + есть биржевой id).
  const openRows = botRows.filter(r => r.status === 'open' && r.exchange_order_id);
  if (openRows.length === 0) return;

  // ДЕТЕКЦИЯ ИСПОЛНЕНИЙ — ПОЛНОСТЬЮ ПО ИСТОРИИ (active_orders для этого больше НЕ используем).
  // У Citronus orders_history свежая, а active_orders отстаёт — и на ВЫБЫТИИ исполнившегося
  // ордера задержка бывает до минут. Поэтому берём из истории терминальные (исполнен/отменён)
  // ордера и сверяем со своими открытыми:
  //   • реальные филлы ловятся быстро (по свежей истории), без задержки active_orders;
  //   • фантома нет — нет записи в истории → ордер жив, ничего не засчитываем.
  // История постраничная (новые сверху); maxPages=2 хватает — терминальные события свежие.
  // Историю не прочитали → в этот тик не детектим (безопасно; повторим на следующем).
  let histMap = new Map();
  try {
    const wantedIds = openRows.map(r => r.exchange_order_id).filter(Boolean);
    histMap = await citronus.getOrdersHistoryMap(apiKey, secret, { symbol: SYMBOL, wantedIds, maxPages: 2 });
  } catch (e) {
    log(`  ! история ордеров не получена — исполнения в этот тик пропускаю: ${e.message}`);
    return;
  }

  // Кандидаты = наши открытые ордера, которые в истории уже ТЕРМИНАЛЬНЫ (исполнены/отменены).
  // Сопоставляем по номеру (id) как строки: у нас он текстом, биржа может отдать числом.
  const filled = openRows.filter(r => histMap.has(String(r.exchange_order_id)));
  if (filled.length === 0) return;

  // Чьи ордера уже заняты — нужно при постановке встречных и остатков (см. findActive).
  // Читаем один раз и только когда что-то реально исполнилось.
  const claimed = await loadClaimedIds(supabase, log);

  // Цены уровней — той же функцией grid-core, что и при создании (точное совпадение).
  const grid = GridCore.computeGridLevels(cfg.priceLow, cfg.priceHigh, cfg.gridCount, filled[0].price);
  if (!grid) { log(`  ! "${bot.name}": не удалось пересчитать уровни сетки`); return; }
  const levels = grid.levels, count = cfg.gridCount;

  // Занятые уровни = открытые/размещаемые, КРОМЕ только что исполнившихся.
  const occupied = new Set(botRows.filter(r => r.status === 'open' || r.status === 'placing').map(r => r.level_index));
  for (const f of filled) occupied.delete(f.level_index);

  // Разбираем каждый исчезнувший ордер на ТРИ случая (по orders_history):
  //   A. отменён, НИЧЕГО не исполнено → восстанавливаем такой же ордер (не сделка);
  //   B. отменён, ЧАСТЬ исполнена     → копим прогресс уровня (partial) и переставляем
  //      ОСТАТОК (объём = было − исполнено). Встречный и сделку пока НЕ делаем — уровень
  //      ещё не завершён. Если остаток ниже минимума биржи — завершаем уровень на факте (→C);
  //   C. исполнен полностью            → уровень завершён: ОДНА сделка на суммарный
  //      объём/комиссию (с учётом ранее накопленного) и встречный на суммарный объём.
  //      Случаи C собираем в completions и применяем АТОМАРНО (apply_fills).
  const completions = [];   // {f, base, fee, quote, price} — завершённые уровни
  let heldAlive  = 0;       // сколько «пропавших» ордеров признано живыми (нет подтверждения историей)
  for (const f of filled) {
    const hc       = histMap.get(String(f.exchange_order_id)) || {};
    const dealsAmt = Number.isFinite(hc.amount) ? hc.amount : null;   // фактически исполнено (BASE)
    const isCancel = hc.status && /cancel/i.test(hc.status);
    const prev     = (f.partial && typeof f.partial === 'object') ? f.partial : null; // накоплено ранее
    const executed = dealsAmt != null && dealsAmt > 1e-9;            // история подтверждает исполнение

    // САНИТИ-ПРОВЕРКА. Кандидаты уже отобраны как терминальные по истории, поэтому сюда
    // «терминальный, но ни исполнения (deals_amount>0), ни отмены» попадёт лишь при странной
    // записи истории. Тогда НЕ фабрикуем сделку — считаем ордер живым, перепроверим позже.
    if (!isCancel && !executed) {
      occupied.add(f.level_index);
      heldAlive++;   // по каждому НЕ логируем (засоряет) — сведём в одну строку после цикла
      continue;
    }

    // A. Полная отмена (ничего не исполнилось) → восстановить ордер тем же объёмом.
    if (isCancel && !(dealsAmt != null && dealsAmt > 1e-9)) {
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
      occupied.add(f.level_index);
      continue;
    }

    // Факт ЭТОГО куска (из истории; если её нет — по строке). price у нас всегда есть.
    const pieceBase  = dealsAmt != null ? dealsAmt : Number(f.amount);
    const rate       = f.side === 'buy' ? commissionBuy : commissionSell;
    const piecePrice = Number.isFinite(hc.price) ? hc.price : (f.price != null ? Number(f.price) : null);
    const pieceFee   = feeUsdt(f.side, hc, piecePrice, pieceBase, rate);
    const pieceQuote = piecePrice != null ? piecePrice * pieceBase : 0;

    // Накопленный ИТОГ уровня = ранее накопленное + этот кусок.
    const accBase  = (prev ? Number(prev.base)  || 0 : 0) + pieceBase;
    const accFee   = (prev ? Number(prev.fee)   || 0 : 0) + pieceFee;
    const accQuote = (prev ? Number(prev.quote) || 0 : 0) + pieceQuote;
    const accPrice = accBase > 0 && accQuote > 0 ? accQuote / accBase : piecePrice; // средневзвешенная

    // B. Частично исполнен и СНЯТ → дозаполняем уровень остатком (было − исполнено).
    if (isCancel) {
      const remaining  = engine.floorTo(Number(f.amount) - pieceBase, baseDec);
      const levelPrice = engine.roundTo(f.price != null ? Number(f.price) : levels[f.level_index], priceDec);
      if (remaining >= minQty && remaining * levelPrice >= minAmt) {
        // Копим прогресс и переставляем ОСТАТОК тем же уровнем/стороной. Идемпотентно:
        // строка уходит в 'placing' (повторно как исполнение не считается); при сбое
        // постановки её достроит reconcileBot. Встречный и сделку НЕ делаем — рано.
        await sb(() => supabase.from('bot_orders')
          .update({ partial: { base: accBase, fee: accFee, quote: accQuote },
                    amount: remaining, status: 'placing', exchange_order_id: null,
                    updated_at: new Date().toISOString() })
          .eq('id', f.id), { label: `частичное: прогресс ур.${f.level_index}`, log });
        await placeRow(deps, bot, { id: f.id }, f.side, levelPrice, remaining, activeOrders, claimed, 'остаток');
        log(`  ◐ частично исполнен ${f.side} (ур.${f.level_index}): +${pieceBase}, остаток снят → переставлен ${remaining} (всего по уровню ${accBase})`);
        occupied.add(f.level_index);
        continue;
      }
      // Остаток ниже минимума биржи — уровень завершаем на фактически исполненном.
      log(`  ◑ частично исполнен ${f.side} (ур.${f.level_index}): +${pieceBase}; остаток ${remaining} ниже минимума — уровень завершён на ${accBase}`);
      completions.push({ f, base: accBase, fee: accFee, quote: accQuote, price: accPrice });
      continue;
    }

    // C. Полное исполнение (возможно — доисполнение ранее накопленного уровня).
    if (prev) log(`  ● доисполнен ${f.side} @ ${f.price} (ур.${f.level_index}): +${pieceBase}, всего ${accBase} — id=${f.exchange_order_id}`);
    else      log(`  ● исполнен ${f.side} @ ${f.price} (ур.${f.level_index}, id=${f.exchange_order_id})`);
    completions.push({ f, base: accBase, fee: accFee, quote: accQuote, price: accPrice });
  }

  // Редкий случай: запись в истории есть, но она ни «исполнено», ни «отменено» (странный
  // статус). Такие уровни считаем живыми и ждём. В норме heldAlive=0.
  if (heldAlive > 0) log(`  · "${bot.name}": ${heldAlive} ур. с неоднозначной записью истории — считаю живыми`);

  if (completions.length === 0) return;

  // Готовим АТОМАРНЫЙ батч по ЗАВЕРШЁННЫМ уровням: id к закрытию (sourceIds), встречные
  // (counters) и сделки (trades). Решение «ставить ли встречный» — по in-memory occupied
  // (уже без исполнившихся уровней): не нужен, если уровень занят ЖИВЫМ ордером или на
  // него уже нацелен другой встречный из этого тика. Порядок обработки на корректность
  // не влияет — гонку уровней снимает сама транзакция (см. apply_fills).
  const sourceIds = [];
  const counters  = [];   // {level_index, side, price, amount}
  const trades    = [];

  for (const c of completions) {
    const { f, base, fee, quote, price } = c;
    sourceIds.push(f.id);

    const targetIdx  = f.side === 'buy' ? f.level_index + 1 : f.level_index - 1;
    const targetSide = f.side === 'buy' ? 'sell' : 'buy';

    if (targetIdx < 0 || targetIdx > count) {
      log(`  · встречный вне диапазона сетки (ур.${targetIdx}) — пропуск`);
    } else if (occupied.has(targetIdx)) {
      log(`  · уровень ${targetIdx} занят — встречный не ставим (правило «только если пусто»)`);
    } else {
      const targetPrice = engine.roundTo(levels[targetIdx], priceDec);
      // Базовый (безопасный) объём считаем от ПОЛНОГО объёма уровня (base): продажа
      // чуть меньше полученного (комиссия удержана в CITRO), покупка — полный объём.
      const fallbackQty = targetSide === 'sell'
        ? engine.floorTo(base * (1 - COUNTER_SELL_HAIRCUT), baseDec)
        : engine.floorTo(base, baseDec);

      // ДОКОМПЕНСАЦИЯ: стремимся вернуть объём к стартовому q0, добирая недостающее из
      // накопленной прибыли/пыли. ЖЁСТКИЙ ПОТОЛОК — свободный баланс (× запас): никогда
      // не ставим больше, чем реально свободно. Полученное от этого уровня (base) может
      // ещё не отразиться в снимке баланса (задержка зачисления) — учитываем явно.
      let qty = fallbackQty;
      if (q0 > qty && bal) {
        let room;
        if (targetSide === 'sell') {                                     // покупка → у нас CITRO
          const received = base * (1 - commissionBuy);
          room = bal.CITRO < received ? bal.CITRO + received : bal.CITRO;
        } else {                                                         // продажа → у нас USDT
          const received = base * (f.price != null ? Number(f.price) : targetPrice) * (1 - commissionSell);
          const usdt = bal.USDT < received ? bal.USDT + received : bal.USDT;
          room = usdt / targetPrice;
        }
        const affordable = engine.floorTo(room * TOPUP_SAFETY, baseDec);
        const topped = Math.min(q0, affordable);
        if (topped > qty) qty = topped;
      }

      if (qty < minQty || qty * targetPrice < minAmt) {
        log(`  · встречный ${targetSide} ${qty} @ ${targetPrice} ниже минимума биржи — пропуск`);
      } else {
        counters.push({ level_index: targetIdx, side: targetSide, price: targetPrice, amount: qty });
        occupied.add(targetIdx);
        if (bal) {
          if (targetSide === 'sell') bal.CITRO -= qty;
          else                       bal.USDT  -= qty * targetPrice;
        }
        if (qty > fallbackQty) log(`  ↑ объём встречного добран до ${qty} (старт ${q0})`);
      }
    }

    // ОДНА сделка на весь уровень (с учётом ранее накопленного). id — ПОСЛЕДНЕГО
    // ордера; комиссия и объём — суммарные; PnL статистика посчитает от объёма.
    trades.push({
      exchange_order_id: f.exchange_order_id || null,
      side: f.side, kind: 'fill', level_index: f.level_index,
      price:  price,
      amount: base,
      total:  quote > 0 ? quote : (price != null ? price * base : null),
      fee:    fee,
      raw: { detected: 'gone_from_active_orders', level_index: f.level_index },
      filled_at: new Date().toISOString()
    });
  }

  // АТОМАРНОЕ применение одной транзакцией. При сбое (сеть/БД) НИЧЕГО не изменилось:
  // ордера остаются 'open' и распознаются как исполнения снова на следующем тике.
  // Дубли сделок отсекает уникальный индекс внутри функции.
  let placedCounters;
  try {
    placedCounters = await sb(() => supabase.rpc('apply_fills', {
      p_bot_id:     bot.id,
      p_source_ids: sourceIds,
      p_counters:   counters,
      p_trades:     trades
    }), { label: 'apply_fills (атомарное закрытие исполнений)', log, attempts: 3 });
  } catch (e) {
    log(`  ! атомарное закрытие исполнений не удалось (${e.message}) — повтор на следующем тике`);
    return;
  }

  // Выставляем встречные на бирже по реально созданным строкам (идемпотентно): если
  // ордер уже на бирже — усыновляем; при ошибке строка остаётся 'placing' → reconcileBot.
  for (const c of (placedCounters || [])) {
    await placeRow(deps, bot, { id: c.id }, c.side, Number(c.price), Number(c.amount), activeOrders, claimed, 'встречный');
  }
}

// Остановка бота: снимаем все его открытые/размещаемые ордера.
// Обратной конвертации при остановке НЕ делаем. Статус бота уже inactive (из UI).
// НА active_orders НЕ полагаемся (у Citronus он отстаёт): снятие подтверждаем по успеху
// cancel_order, а при неуспехе — по истории. Это убирает и цикл отмены, и «мнимое снятие».
async function stopBot(bot, ctx, deps) {
  const { supabase, citronus, apiKey, secret, log } = deps;

  let rows;
  try {
    rows = await sb(() => supabase.from('bot_orders')
      .select('id, exchange_order_id, side, price, status, level_index, partial')
      .eq('bot_id', bot.id)
      .in('status', ['open', 'placing']), { label: 'чтение ордеров для отмены', log });
  } catch (e) { log(`✗ stopBot чтение ордеров: ${e.message}`); return; }
  if (!rows || rows.length === 0) return;

  // Перед снятием фиксируем в статистику УЖЕ исполненную часть уровней, которые
  // дозаполнялись остатком (partial). Иначе этот реально исполненный объём потеряется
  // из PnL при остановке. Идемпотентно — дубль отсекает уникальный индекс сделок.
  for (const row of rows) {
    const p    = (row.partial && typeof row.partial === 'object') ? row.partial : null;
    const base = p ? Number(p.base) || 0 : 0;
    if (base <= 1e-9) continue;
    const fee   = Number(p.fee)   || 0;
    const quote = Number(p.quote) || 0;
    await sb(() => supabase.from('bot_trades')
      .upsert({
        bot_id: bot.id,
        exchange_order_id: row.exchange_order_id || `partial:${row.id}`,
        side: row.side, kind: 'fill', level_index: row.level_index,
        price:  quote > 0 ? quote / base : null,
        amount: base,
        total:  quote > 0 ? quote : null,
        fee:    fee,
        raw: { detected: 'partial_on_stop', level_index: row.level_index },
        filled_at: new Date().toISOString()
      }, { onConflict: 'bot_id,exchange_order_id,kind', ignoreDuplicates: true }),
      { label: `частичное при стопе ур.${row.level_index}`, log, attempts: 2 })
      .then(() => log(`  ✎ зафиксирована исполненная часть уровня ${row.level_index}: ${base} CITRO`))
      .catch((e) => log(`  ! частичное при стопе ур.${row.level_index} не записано: ${e.message}`));
  }

  log(`■ остановка "${bot.name}": ${rows.length} ордеров к снятию`);
  let remaining = 0;
  for (const row of rows) {
    // Ордер не выставлен на бирже (placing без номера) → на бирже его нет, просто снимаем строку.
    if (!row.exchange_order_id) {
      await sb(() => supabase.from('bot_orders')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', row.id), { label: 'bot_orders→cancelled (не на бирже)', log }).catch(() => {});
      log(`  ✓ ${row.side} @ ${row.price}: не был на бирже → снят`);
      continue;
    }
    try {
      await citronus.cancelOrder(row.exchange_order_id, apiKey, secret);
      // Отмена принята биржей → ордер снят. Помечаем сразу, НЕ ждём active_orders.
      await sb(() => supabase.from('bot_orders')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', row.id), { label: 'bot_orders→cancelled', log }).catch(() => {});
      log(`  ✓ ${row.side} @ ${row.price} (id=${row.exchange_order_id}): отмена принята → снят`);
    } catch (e) {
      // Отмена не прошла: ордер уже терминальный (исполнен/снят) ИЛИ временный сбой. Смотрим
      // историю. Если запись есть — терминальный: и если ИСПОЛНИЛСЯ прямо перед отменой
      // (deals_amount>0 и не отмена) — фиксируем сделку, чтобы не потерять её в статистике.
      // Затем снимаем строку. Записи в истории нет → временный сбой → повтор на след. тике.
      let hc = null;
      try {
        const hm = await citronus.getOrdersHistoryMap(apiKey, secret,
          { symbol: SYMBOL, wantedIds: [row.exchange_order_id], maxPages: 2 });
        hc = hm.get(String(row.exchange_order_id)) || null;
      } catch { /* историю не прочитали — считаем не подтверждённым, повтор */ }
      if (hc) {
        const filledBase = Number.isFinite(hc.amount) ? hc.amount : 0;
        const isCancel   = hc.status && /cancel/i.test(hc.status);
        if (!isCancel && filledBase > 1e-9) {
          const price = Number.isFinite(hc.price) ? hc.price : Number(row.price);
          await sb(() => supabase.from('bot_trades').upsert({
            bot_id: bot.id, exchange_order_id: row.exchange_order_id, side: row.side, kind: 'fill',
            level_index: row.level_index, price, amount: filledBase, total: price * filledBase,
            fee: feeUsdt(row.side, hc, price, filledBase, 0),
            raw: { detected: 'filled_on_stop', level_index: row.level_index }, filled_at: new Date().toISOString()
          }, { onConflict: 'bot_id,exchange_order_id,kind', ignoreDuplicates: true }),
            { label: 'сделка при стопе', log, attempts: 2 }).catch(() => {});
          log(`  ● ${row.side} @ ${row.price}: исполнился перед отменой — сделка записана`);
        }
        await sb(() => supabase.from('bot_orders')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', row.id), { label: 'bot_orders→cancelled (терминальный)', log }).catch(() => {});
        log(`  ✓ ${row.side} @ ${row.price}: терминальный по истории → снят`);
      } else {
        remaining++;
        log(`  ! отмена ${row.exchange_order_id} не прошла (${e.message}) — повтор на следующем тике`);
      }
    }
  }
  if (remaining > 0) log(`■ "${bot.name}": ещё ${remaining} ордеров снимаются — повтор на следующем тике`);
  else               log(`■ остановка "${bot.name}" завершена`);
}

module.exports = { reconcileBot, handleFills, stopBot };
