const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { PATTERNS, str, tooLong, isUuid, validateSpotGridConfig } = require('../_validation');
const { applyCors } = require('../_cors');
const { accountPreflight, ORDER_LIMIT_MESSAGE, fetchLastPrice } = require('../_exchange');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Последняя цена CITRO/USDT (публичный метод, с таймаутом) — из общего модуля
// api/_exchange.js, чтобы «зависшая» биржа не держала функцию.

module.exports = async function handler(req, res) {
  applyCors(res, 'PATCH');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH')  return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  // Идентификатор бота + потолок длины имени
  const botId = str(req.body?.botId).trim();
  if (!isUuid(botId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор бота' });
  }
  if (tooLong(req.body?.name)) {
    return res.status(400).json({ error: 'Слишком длинное значение' });
  }

  // Бот должен существовать, принадлежать пользователю и быть НЕактивным
  const { data: bot, error: findErr } = await supabase
    .from('bots')
    .select('id, status')
    .eq('id', botId)
    .eq('user_id', userId)
    .maybeSingle();

  if (findErr) {
    console.error('Supabase select error:', findErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (!bot) {
    return res.status(404).json({ error: 'Бот не найден' });
  }
  if (bot.status === 'active') {
    return res.status(409).json({ code: 'bot_active',
      error: 'Сначала остановите бота, затем редактируйте его' });
  }

  // Имя
  const name = str(req.body?.name).trim();
  if (!name) {
    return res.status(400).json({ error: 'Введите название бота' });
  }
  if (!PATTERNS.name.test(name)) {
    return res.status(400).json({ code: 'invalid_format', field: 'name',
      error: 'Название: до 32 символов, без управляющих символов' });
  }

  // API ключ: формат + владение
  const apiKeyId = str(req.body?.apiKeyId).trim();
  if (!isUuid(apiKeyId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор ключа' });
  }

  const { data: keyRow, error: keyErr } = await supabase
    .from('api_keys')
    .select('id, name')
    .eq('id', apiKeyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (keyErr) {
    console.error('Supabase select error:', keyErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (!keyRow) {
    return res.status(400).json({ error: 'Выбранный API ключ не найден' });
  }

  // Конфигурация сетки: проверяем по текущей цене
  let price;
  try {
    price = await fetchLastPrice();
  } catch {
    price = null;
  }
  if (price === null) {
    return res.status(502).json({ error: 'Не удалось связаться с биржей. Попробуйте позже.' });
  }

  const check = validateSpotGridConfig(req.body?.config, price);
  if (!check.ok) {
    return res.status(400).json({ error: check.error });
  }

  // Уникальность имени среди ДРУГИХ НЕ удалённых ботов пользователя
  // deleted_at IS NULL обязателен: имена удалённых ботов можно переиспользовать,
  // а без фильтра несколько удалённых тёзок ломают .maybeSingle() (PGRST116).
  const { data: sameName, error: sameNameErr } = await supabase
    .from('bots')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
    .neq('id', botId)
    .is('deleted_at', null)
    .maybeSingle();

  if (sameNameErr) {
    console.error('Supabase select error:', sameNameErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (sameName) {
    return res.status(409).json({ code: 'duplicate_name',
      error: 'Названия ботов не должны повторяться' });
  }

  // Запускать сразу после сохранения? («Сохранить и запустить»)
  const autostart = req.body?.autostart === true;

  // Лимит биржи (100 ордеров на аккаунт)
  // Редактирование/запуск невозможны, если сетка не помещается в свободный лимит.
  // Себя исключаем (бот неактивен — его ордера сняты). Не удалось проверить
  // (биржа недоступна) → не блокируем, подстрахует воркер.
  try {
    const pf = await accountPreflight(supabase, {
      userId, keyId: apiKeyId, gridCount: check.config.gridCount, excludeBotId: botId });
    if (pf.verified && pf.overLimit) {
      return res.status(409).json({ code: 'order_limit', error: ORDER_LIMIT_MESSAGE });
    }
  } catch (e) {
    console.error('order-limit preflight error (allow update):', e && e.message);
  }

  // Сохраняем изменения
  const { data: updated, error } = await supabase
    .from('bots')
    .update({
      name,
      api_key_id: apiKeyId,
      config:     check.config,
      status:     autostart ? 'active' : 'inactive',
      updated_at: new Date().toISOString()
    })
    .eq('id', botId)
    .eq('user_id', userId)
    .select('id, name, strategy, status, status_message, config, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ code: 'duplicate_name',
        error: 'Названия ботов не должны повторяться' });
    }
    console.error('Supabase update error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  return res.status(200).json({
    bot: { ...updated, api_key_id: apiKeyId, api_key_name: keyRow.name }
  });
};
