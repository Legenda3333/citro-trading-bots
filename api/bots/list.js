const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { applyCors } = require('../_cors');
const { str, isUuid } = require('../_validation');
const { computeStats } = require('../_stats');
const { accountPreflight } = require('../_exchange');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Комиссии в статистику берём ФАКТОМ из каждой сделки (их пишет воркер, уже в USDT).
// Отдельный запрос к бирже за ставками больше не нужен — для редких старых записей
// без сохранённой комиссии сработает запасная ставка внутри _stats (DEFAULT_COMMISSION,
// равная последнему реальному значению). Так эндпоинт статистики стал быстрым (только БД).

module.exports = async function handler(req, res) {
  applyCors(res, 'GET');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  // Статус запуска конкретного бота (для страницы настройки)
  // Полл /api/bots/list?launchStatus=<botId> возвращает прогресс выставления
  // сетки вместо полного списка. Сделано в этом же файле, чтобы не добавлять
  // отдельную serverless-функцию (на Hobby-плане Vercel лимит — 12 функций).
  const launchId = str(req.query && req.query.launchStatus).trim();
  if (launchId) {
    if (!isUuid(launchId)) {
      return res.status(400).json({ error: 'Некорректный идентификатор бота' });
    }
    const { data: bot, error: bErr } = await supabase
      .from('bots')
      .select('id, status, status_message')
      .eq('id', launchId)
      .eq('user_id', userId)
      .maybeSingle();
    if (bErr) {
      console.error('launch-status bot error:', bErr);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }
    if (!bot) return res.status(404).json({ error: 'Бот не найден' });

    const { data: rows, error: rErr } = await supabase
      .from('bot_orders')
      .select('status')
      .eq('bot_id', launchId)
      .in('status', ['placing', 'open']);
    if (rErr) {
      console.error('launch-status orders error:', rErr);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }

    let open = 0, placing = 0;
    for (const r of (rows || [])) {
      if (r.status === 'open') open++;
      else if (r.status === 'placing') placing++;
    }
    return res.status(200).json({ status: bot.status, statusMessage: bot.status_message || null, open, placing });
  }

  // Префлайт запуска: /api/bots/list?accountCheck=<keyId>&gridCount=N&exclude=<botId>
  // Возвращает { verified, openOrders, free, overLimit, sameAccountActiveBot }.
  // Нужно окну подтверждения: блок по лимиту 100 ордеров + предупреждение о
  // другом активном боте на том же аккаунте. Отдельной функции не заводим.
  const accountCheckKey = str(req.query && req.query.accountCheck).trim();
  if (accountCheckKey) {
    if (!isUuid(accountCheckKey)) {
      return res.status(400).json({ error: 'Некорректный идентификатор ключа' });
    }
    const gc = parseInt(req.query && req.query.gridCount, 10);
    const exclude = str(req.query && req.query.exclude).trim();
    const pf = await accountPreflight(supabase, {
      userId, keyId: accountCheckKey,
      gridCount: Number.isFinite(gc) ? gc : NaN,
      excludeBotId: (exclude && isUuid(exclude)) ? exclude : null,
    });
    return res.status(200).json(pf);
  }

  // Статистика: /api/bots/list?stats=1 → итоги + боты + сделки
  // Считаем здесь же (без новой serverless-функции). Включаем УДАЛЁННЫХ ботов.
  if (str(req.query && req.query.stats).trim()) {
    const { data: allBots, error: bErr } = await supabase
      .from('bots')
      .select('id, name, strategy, status, status_message, config, deleted_at, created_at')
      .eq('user_id', userId)
      .order('id', { ascending: true });   // стабильный порядок: клиент сравнивает свежий ответ с предыдущим
    if (bErr) {
      console.error('stats bots error:', bErr);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }

    const ids = (allBots || []).map(b => b.id);
    let trades = [];
    if (ids.length) {
      const { data: tr, error: tErr } = await supabase
        .from('bot_trades')
        .select('bot_id, exchange_order_id, side, kind, price, amount, fee, filled_at')
        .in('bot_id', ids)
        .order('filled_at', { ascending: true });
      if (tErr) {
        console.error('stats trades error:', tErr);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }
      trades = tr || [];
    }

    return res.status(200).json(computeStats(allBots || [], trades));
  }

  // Боты пользователя + имя используемого ключа (вложенный select по FK)
  // Удалённых (deleted_at) здесь не показываем — они только в «Статистике».
  const { data: bots, error } = await supabase
    .from('bots')
    .select('id, name, strategy, status, status_message, config, created_at, updated_at, api_key_id, api_keys ( name )')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase select error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  // Разворачиваем вложенный объект api_keys в плоское поле api_key_name
  const result = (bots || []).map(bot => {
    const { api_keys, ...rest } = bot;
    return { ...rest, api_key_name: api_keys?.name || null };
  });

  return res.status(200).json({ bots: result });
};
