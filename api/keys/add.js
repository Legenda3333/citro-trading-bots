const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { PATTERNS, str, tooLong } = require('../_validation');
const { applyCors } = require('../_cors');
const { encrypt } = require('../_crypto');       // единый модуль шифрования
const { keyIsValid } = require('../_exchange');  // единый клиент биржи (подпись)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  applyCors(res, 'POST');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT из заголовка Authorization
  const userId = authUser(req, res);
  if (!userId) return;

  // Читаем и валидируем поля из тела запроса
  if (tooLong(req.body?.name) || tooLong(req.body?.apiKey) || tooLong(req.body?.apiSecret)) {
    return res.status(400).json({ error: 'Слишком длинное значение' });
  }

  const name      = str(req.body?.name).trim();
  const apiKey    = str(req.body?.apiKey).trim();
  const apiSecret = str(req.body?.apiSecret).trim();

  if (!name || !apiKey || !apiSecret) {
    return res.status(400).json({ error: 'Заполните все поля' });
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

  // Проверяем уникальность имени среди ключей этого пользователя
  const { data: sameName, error: sameNameErr } = await supabase
    .from('api_keys')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
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

  // Проверяем, что ключ реально работает на бирже
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

  // Проверяем, не добавлен ли уже этот API ключ этим пользователем
  const { data: existing, error: existingErr } = await supabase
    .from('api_keys')
    .select('id')
    .eq('user_id', userId)
    .eq('api_key', apiKey)
    .maybeSingle();

  if (existingErr) {
    console.error('Supabase select error:', existingErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (existing) {
    return res.status(409).json({
      code:  'duplicate_key',
      error: 'Такой API ключ уже добавлен'
    });
  }

  // Шифруем секрет, сохраняем и возвращаем созданную запись
  // .select() нужен чтобы получить id и created_at, присвоенные базой данных
  const { data: newKey, error } = await supabase
    .from('api_keys')
    .insert({
      user_id:              userId,
      name,
      api_key:              apiKey,
      api_secret_encrypted: encrypt(apiSecret),
      exchange:             'citronus'
    })
    .select('id, name, api_key, exchange, created_at')
    .single();

  if (error) {
    // 23505 — уникальный индекс api_keys(user_id,name)/(user_id,api_key): имя или
    // ключ заняли в гонке между SELECT и INSERT. БД — последний барьер.
    if (error.code === '23505') {
      const c = `${error.message || ''} ${error.details || ''} ${error.constraint || ''}`;
      if (/user_name/i.test(c)) {
        return res.status(409).json({ code: 'duplicate_name', error: 'Названия ключей не должны повторяться' });
      }
      return res.status(409).json({ code: 'duplicate_key', error: 'Такой API ключ уже добавлен' });
    }
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  // Добавляем secret_hint прямо здесь — apiSecret ещё доступен в памяти
  const secret_hint = apiSecret.slice(0, 6) + '••••••••';
  return res.status(201).json({ key: { ...newKey, secret_hint } });
};
