const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { PATTERNS, str, tooLong } = require('./_validation');
const { applyCors } = require('./_cors');
const { clientIp, isLocked, recordFailure, clearFailures, LOCK_MESSAGE } = require('./_ratelimit');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Фиктивный bcrypt-хэш для выравнивания времени ответа. Если логина нет, всё равно
// выполняем сравнение пароля — иначе по времени ответа можно было бы отличить
// существующий логин (идёт медленный bcrypt) от несуществующего (мгновенный отказ).
// Считаем один раз при загрузке модуля.
const DUMMY_HASH = bcrypt.hashSync('citronus-timing-guard', 10);

module.exports = async function handler(req, res) {
  applyCors(res, 'POST');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Защита от перебора: 5 неудачных попыток с этого IP за 2 мин → отказ
  const ip = clientIp(req);
  if (await isLocked(supabase, ip, 'login')) {
    return res.status(429).json({ code: 'too_many_attempts', field: 'password', error: LOCK_MESSAGE });
  }

  // DoS-защита: огромная строка не должна уходить в bcrypt
  // Ответ обобщённый (401), чтобы не раскрывать детали.
  if (tooLong(req.body?.login) || tooLong(req.body?.password)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  // Защита типов: гарантируем строки, не объекты/массивы
  const login      = str(req.body?.login).trim();
  const password   = str(req.body?.password);
  const rememberMe = req.body?.rememberMe === true;

  if (!login || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  // Ищем пользователя
  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, password_hash, user_number')
    .eq('username', login)
    .maybeSingle();

  if (error) {
    console.error('Supabase select error:', error);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }

  // Неудачной попыткой считаем ТОЛЬКО корректный по формату ввод, не подошедший
  // под логин. Кривой формат (длина/символы) — это ещё не попытка подбора.
  const formatOk = PATTERNS.login.test(login) && PATTERNS.password.test(password);

  // Одинаковое сообщение — не раскрываем, что именно неверно. И выполняем
  // «пустое» сравнение пароля, чтобы время ответа не выдавало отсутствие логина.
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    if (formatOk && await recordFailure(supabase, ip, 'login')) {
      return res.status(429).json({ code: 'too_many_attempts', field: 'password', error: LOCK_MESSAGE });
    }
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    if (formatOk && await recordFailure(supabase, ip, 'login')) {
      return res.status(429).json({ code: 'too_many_attempts', field: 'password', error: LOCK_MESSAGE });
    }
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  // Успешный вход — снимаем счётчик неудачных попыток этого IP.
  await clearFailures(supabase, ip, 'login');

  // JWT: 5 дней если "запомнить", 1 день если нет
  const expiresIn = rememberMe ? '5d' : '1d';
  const token = jwt.sign(
    { userId: user.id, username: user.username, userNumber: user.user_number },
    process.env.JWT_SECRET,
    { expiresIn }
  );

  return res.status(200).json({ token, username: user.username });
};
