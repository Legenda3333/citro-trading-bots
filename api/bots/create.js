const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { PATTERNS, str, tooLong, isUuid, validateSpotGridConfig } = require('../_validation');
const { applyCors } = require('../_cors');
const { accountPreflight, ORDER_LIMIT_MESSAGE, fetchLastPrice } = require('../_exchange');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Пока поддерживаем единственную стратегию (DCA и др. — позже)
const ALLOWED_STRATEGIES = ['spot_grid'];

// Последняя цена CITRO/USDT (публичный метод, с таймаутом) — из общего модуля
// api/_exchange.js, чтобы «зависшая» биржа не держала функцию.

module.exports = async function handler(req, res) {
  applyCors(res, 'POST');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  // Грубый потолок длины ДО разбора
  if (tooLong(req.body?.name)) {
    return res.status(400).json({ error: 'Слишком длинное значение' });
  }

  // Имя бота
  const name = str(req.body?.name).trim();
  if (!name) {
    return res.status(400).json({ error: 'Введите название бота' });
  }
  if (!PATTERNS.name.test(name)) {
    return res.status(400).json({ code: 'invalid_format', field: 'name',
      error: 'Название: до 32 символов, без управляющих символов' });
  }

  // Стратегия
  const strategy = str(req.body?.strategy) || 'spot_grid';
  if (!ALLOWED_STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: 'Неизвестная стратегия' });
  }

  // Запускать сразу? («Создать и запустить» → active, иначе inactive)
  // Статус active подхватывает воркер и раскладывает сетку (реальная торговля).
  const autostart = req.body?.autostart === true;

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

  // Конфигурация сетки: проверяем по текущей цене с биржи
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

  // Уникальность имени среди НЕ удалённых ботов пользователя
  // (имя удалённого бота можно переиспользовать; индекс в БД тоже частичный).
  const { data: sameName, error: sameNameErr } = await supabase
    .from('bots')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
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

  // Лимит биржи (100 ордеров на аккаунт)
  // Создание/запуск бота невозможны, если сетка не помещается в свободный лимит
  // (свободно = 100 − открытые ордера аккаунта). Не удалось проверить (биржа
  // недоступна) → НЕ блокируем: подстрахует воркер при размещении.
  try {
    const pf = await accountPreflight(supabase, {
      userId, keyId: apiKeyId, gridCount: check.config.gridCount, excludeBotId: null });
    if (pf.verified && pf.overLimit) {
      return res.status(409).json({ code: 'order_limit', error: ORDER_LIMIT_MESSAGE });
    }
  } catch (e) {
    console.error('order-limit preflight error (allow create):', e && e.message);
  }

  // Сохраняем бота: active («…и запустить») либо inactive
  const { data: newBot, error } = await supabase
    .from('bots')
    .insert({
      user_id:    userId,
      api_key_id: apiKeyId,
      name,
      strategy,
      status:     autostart ? 'active' : 'inactive',
      config:     check.config
    })
    .select('id, name, strategy, status, status_message, config, created_at, updated_at')
    .single();

  if (error) {
    // 23505 — гонка по уникальному индексу (user_id, name)
    if (error.code === '23505') {
      return res.status(409).json({ code: 'duplicate_name',
        error: 'Названия ботов не должны повторяться' });
    }
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  // Имя ключа кладём в ответ — клиенту для карточки «Мои боты»
  return res.status(201).json({
    bot: { ...newBot, api_key_id: apiKeyId, api_key_name: keyRow.name }
  });
};
