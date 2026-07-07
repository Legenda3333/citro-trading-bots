const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { isUuid } = require('../_validation');
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

  const keyId = typeof req.body?.keyId === 'string' ? req.body.keyId.trim() : '';
  if (!isUuid(keyId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор ключа' });
  }

  // Нельзя удалить ключ, который использует НЕ удалённый бот
  // Удалённые (deleted_at) ключ уже не держат (api_key_id обнулён при удалении),
  // поэтому их не учитываем. limit(1) — на ключе может быть несколько ботов.
  const { data: usingBots, error: usingErr } = await supabase
    .from('bots')
    .select('id')
    .eq('user_id', userId)
    .eq('api_key_id', keyId)
    .is('deleted_at', null)
    .limit(1);

  if (usingErr) {
    console.error('Supabase select error:', usingErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (usingBots && usingBots.length) {
    return res.status(409).json({ code: 'key_in_use',
      error: 'Вы не можете удалить этот ключ, так как он используется одним из ваших ботов' });
  }

  // Удаляем только ключ, принадлежащий этому пользователю
  // Условие user_id = userId гарантирует, что нельзя удалить чужой ключ
  const { error } = await supabase
    .from('api_keys')
    .delete()
    .eq('id', keyId)
    .eq('user_id', userId);

  if (error) {
    // 23503 — FK: ключ всё же занят ботом (страховка от гонки)
    if (error.code === '23503') {
      return res.status(409).json({ code: 'key_in_use',
        error: 'Вы не можете удалить этот ключ, так как он используется одним из ваших ботов' });
    }
    console.error('Supabase delete error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  return res.status(200).json({ success: true });
};
