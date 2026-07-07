const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { str, isUuid } = require('../_validation');
const { applyCors } = require('../_cors');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  applyCors(res, 'DELETE');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  const botId = str(req.body?.botId).trim();
  if (!isUuid(botId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор бота' });
  }

  // Нельзя удалить активного бота — сначала остановить
  // Проверяем статус по своему боту (заодно убеждаемся, что он существует).
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
      error: 'Сначала остановите бота, затем удалите его' });
  }

  // Мягкое удаление: помечаем deleted_at, строку и сделки СОХРАНЯЕМ
  // Нужно для раздела «Статистика» — там показываем и удалённых ботов.
  // api_key_id ОБНУЛЯЕМ: иначе FK (on delete restrict) не даст удалить ключ,
  // пока его держит удалённый бот. Для статистики ключ не нужен.
  // «Мои боты» и лимит ботов удалённых не учитывают (см. list.js / create.js).
  const { error } = await supabase
    .from('bots')
    .update({ deleted_at: new Date().toISOString(), api_key_id: null })
    .eq('id', botId)
    .eq('user_id', userId);

  if (error) {
    console.error('Supabase soft-delete error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  return res.status(200).json({ success: true });
};
