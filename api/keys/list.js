const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { applyCors } = require('../_cors');
const { decrypt } = require('../_crypto');  // единый модуль шифрования (первые 6 символов секрета для подсказки)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  applyCors(res, 'GET');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  // Достаём ключи вместе с зашифрованным секретом
  const { data: keys, error } = await supabase
    .from('api_keys')
    .select('id, name, api_key, api_secret_encrypted, exchange, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase select error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  // Какие ключи заняты ботами — для блокировки удаления в UI
  // Собираем id ключей, на которые ссылается хотя бы один бот пользователя.
  const usedKeyIds = new Set();
  const { data: bots, error: botsErr } = await supabase
    .from('bots')
    .select('api_key_id')
    .eq('user_id', userId);

  if (botsErr) {
    // Не валим список ключей из-за этого: настоящую защиту даёт delete.js.
    // Просто оставим in_use=false (кнопка удаления останется активной).
    console.error('Supabase select error (bots):', botsErr);
  } else {
    (bots || []).forEach(b => usedKeyIds.add(b.api_key_id));
  }

  // Расшифровываем и оставляем только первые 6 символов секрета + маска.
  // Сам секрет в ответ не включаем.
  const safeKeys = keys.map(key => {
    let secret_hint = '••••••••••••';
    try {
      const plain = decrypt(key.api_secret_encrypted);
      secret_hint = plain.slice(0, 6) + '••••••••';
    } catch {}

    return {
      id:         key.id,
      name:       key.name,
      api_key:    key.api_key,
      exchange:   key.exchange,
      created_at: key.created_at,
      secret_hint,
      in_use:     usedKeyIds.has(key.id)
    };
  });

  return res.status(200).json({ keys: safeKeys });
};
