const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PATTERNS, str, tooLong } = require('./_validation');
const { applyCors } = require('./_cors');
const { clientIp, isLocked, recordFailure, clearFailures, LOCK_MESSAGE } = require('./_ratelimit');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  // CORS — ограничено доменом приложения (см. api/_cors.js)
  applyCors(res, 'POST');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Защита от перебора: 5 неудачных попыток с этого IP за 2 мин → отказ
  const ip = clientIp(req);
  if (await isLocked(supabase, ip, 'register')) {
    return res.status(429).json({ code: 'too_many_attempts', field: 'password', error: LOCK_MESSAGE });
  }

  // DoS-потолок до любых проверок (огромные строки отсекаем сразу)
  if (tooLong(req.body?.login) || tooLong(req.body?.password)) {
    return res.status(400).json({ error: 'Слишком длинное значение', field: 'login' });
  }

  // Защита типов: гарантируем строки, не объекты/массивы
  const login    = str(req.body?.login).trim();
  const password = str(req.body?.password);

  // Валидация формата (единый источник — api/_validation.js)
  if (!login || !password) {
    return res.status(400).json({ error: 'Заполните все поля', field: 'login' });
  }
  if (!PATTERNS.login.test(login)) {
    return res.status(400).json({
      error: 'Логин: только латинские буквы и цифры, 4–30 символов',
      field: 'login'
    });
  }
  if (!PATTERNS.password.test(password)) {
    return res.status(400).json({
      error: 'Пароль: латинские буквы, цифры и спецсимволы, 8–32 символа',
      field: 'password'
    });
  }

  // Проверяем, не занят ли логин
  const { data: existing, error: existingErr } = await supabase
    .from('users')
    .select('id')
    .eq('username', login)
    .maybeSingle();

  if (existingErr) {
    console.error('Supabase select error:', existingErr);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  if (existing) {
    // Корректный по формату ввод, не приведший к регистрации (логин занят) —
    // считаем неудачной попыткой. На 5-й показываем лимит под полем пароля.
    if (await recordFailure(supabase, ip, 'register')) {
      return res.status(429).json({ code: 'too_many_attempts', field: 'password', error: LOCK_MESSAGE });
    }
    return res.status(409).json({ error: 'Этот логин уже занят', field: 'login' });
  }

  // Хэшируем пароль и сохраняем пользователя
  const password_hash = await bcrypt.hash(password, 10);

  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ username: login, password_hash })
    .select('id, username, user_number')
    .single();

  if (error) {
    // 23505 = нарушение UNIQUE: логин заняли в гонке между SELECT и INSERT.
    // Уникальный индекс на users.username — последний и достоверный барьер.
    if (error.code === '23505') {
      if (await recordFailure(supabase, ip, 'register')) {
        return res.status(429).json({ code: 'too_many_attempts', field: 'password', error: LOCK_MESSAGE });
      }
      return res.status(409).json({ error: 'Этот логин уже занят', field: 'login' });
    }
    console.error('Supabase insert error:', error);
    return res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }

  // Успешная регистрация — снимаем счётчик неудачных попыток этого IP.
  await clearFailures(supabase, ip, 'register');

  // Выдаём JWT (свежая регистрация без «запомнить меня» → 1 день)
  const token = jwt.sign(
    { userId: newUser.id, username: newUser.username, userNumber: newUser.user_number },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  return res.status(201).json({ token, username: newUser.username });
};
