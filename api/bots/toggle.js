const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { str, isUuid } = require('../_validation');
const { applyCors } = require('../_cors');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Переключение статуса бота: active ⇄ inactive.
// Это смена флага в БД; фактическую торговлю ведёт воркер: на active он
// раскладывает сетку, на inactive — снимает все ордера (см. worker/runner.js).
module.exports = async function handler(req, res) {
  applyCors(res, 'POST');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  // Валидируем вход: botId + желаемое действие
  const botId  = str(req.body?.botId).trim();
  const action = str(req.body?.action);
  if (!isUuid(botId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор бота' });
  }
  if (action !== 'start' && action !== 'stop') {
    return res.status(400).json({ error: 'Некорректное действие' });
  }

  const newStatus = action === 'start' ? 'active' : 'inactive';

  // Меняем статус только у бота этого пользователя
  // Условие user_id = userId гарантирует, что нельзя тронуть чужого бота.
  const { data: updated, error } = await supabase
    .from('bots')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', botId)
    .eq('user_id', userId)
    .select('id, status, updated_at')
    .maybeSingle();

  if (error) {
    console.error('Supabase update error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (!updated) {
    return res.status(404).json({ error: 'Бот не найден' });
  }

  return res.status(200).json({ status: updated.status, updated_at: updated.updated_at });
};
