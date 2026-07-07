const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { PATTERNS, str, tooLong, isUuid } = require('../_validation');
const { applyCors } = require('../_cors');
const { encrypt } = require('../_crypto');       // единый модуль шифрования
const { keyIsValid } = require('../_exchange');  // единый клиент биржи (подпись)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  applyCors(res, 'PATCH');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH')  return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  // Читаем поля
  if (tooLong(req.body?.name) || tooLong(req.body?.apiKey) || tooLong(req.body?.apiSecret)) {
    return res.status(400).json({ error: 'Слишком длинное значение' });
  }

  const keyId     = str(req.body?.keyId).trim();
  const name      = str(req.body?.name).trim();
  const apiKey    = str(req.body?.apiKey).trim();
  const apiSecret = str(req.body?.apiSecret).trim();

  if (!keyId || !name || !apiKey || !apiSecret) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!isUuid(keyId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор ключа' });
  }
  if (!PATTERNS.name.test(name)) {
    return res.status(400).json({ code: 'invalid_format', field: 'name',
      error: 'Название: до 32 символов, без управляющих символов' });
  }
  if (!PATTERNS.apiKey.test(apiKey)) {
    return res.status(400).json({ code: 'invalid_format', field: 'apiKey',
      error: 'API ключ: латинские буквы, цифры и «-», до 128 символов' });
  }
  if (!PATTERNS.apiSecret.test(apiSecret)) {
    return res.status(400).json({ code: 'invalid_format', field: 'apiSecret',
      error: 'Секрет: латинские буквы и цифры, до 128 символов' });
  }

  // Убеждаемся, что этот ключ принадлежит текущему пользователю
  const { data: existing, error: existingErr } = await supabase
    .from('api_keys')
    .select('id')
    .eq('id', keyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existingErr) {
    console.error('Supabase select error:', existingErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (!existing) {
    return res.status(404).json({ error: 'Ключ не найден' });
  }

  // Проверяем уникальность имени (исключая редактируемый ключ)
  const { data: sameName, error: sameNameErr } = await supabase
    .from('api_keys')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
    .neq('id', keyId)
    .maybeSingle();

  if (sameNameErr) {
    console.error('Supabase select error:', sameNameErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (sameName) {
    return res.status(409).json({
      code:  'duplicate_name',
      error: 'Названия ключей не должны повторяться'
    });
  }

  // Проверяем уникальность публичного ключа (исключая редактируемый)
  const { data: sameKey, error: sameKeyErr } = await supabase
    .from('api_keys')
    .select('id')
    .eq('user_id', userId)
    .eq('api_key', apiKey)
    .neq('id', keyId)
    .maybeSingle();

  if (sameKeyErr) {
    console.error('Supabase select error:', sameKeyErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (sameKey) {
    return res.status(409).json({
      code:  'duplicate_key',
      error: 'Такой API ключ уже добавлен'
    });
  }

  // Проверяем работоспособность ключа на бирже
  let valid;
  try {
    valid = await keyIsValid(apiKey, apiSecret);
  } catch {
    return res.status(502).json({ error: 'Не удалось связаться с биржей. Попробуйте позже.' });
  }

  if (!valid) {
    return res.status(400).json({
      code:  'invalid_key',
      error: 'Произошла ошибка при добавлении ключа. Проверьте правильность введённых вами данных.'
    });
  }

  // Обновляем запись в базе данных
  const { data: updated, error } = await supabase
    .from('api_keys')
    .update({
      name,
      api_key:              apiKey,
      api_secret_encrypted: encrypt(apiSecret)
    })
    .eq('id', keyId)
    .select('id, name, api_key, exchange, created_at')
    .single();

  if (error) {
    // 23505 — уникальный индекс api_keys(user_id,name)/(user_id,api_key): имя или
    // ключ заняли в гонке (страховка на случай, если SELECT-проверка устарела).
    if (error.code === '23505') {
      const c = `${error.message || ''} ${error.details || ''} ${error.constraint || ''}`;
      if (/user_name/i.test(c)) {
        return res.status(409).json({ code: 'duplicate_name', error: 'Названия ключей не должны повторяться' });
      }
      return res.status(409).json({ code: 'duplicate_key', error: 'Такой API ключ уже добавлен' });
    }
    console.error('Supabase update error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  // Формируем подсказку для секрета
  const secret_hint = apiSecret.slice(0, 6) + '••••••••';

  return res.status(200).json({ key: { ...updated, secret_hint } });
};
