//  ПРОВЕРКА JWT ДЛЯ ПРИВАТНЫХ ЭНДПОИНТОВ — единый источник истины.
//  Одно место вместо копии в каждом эндпоинте api/: расхождение копий (напр.
//  забытый algorithms:['HS256']) стало бы дырой в безопасности. Префикс «_» →
//  Vercel НЕ считает файл за отдельную функцию.
const jwt = require('jsonwebtoken');

// Возвращает userId из валидного Bearer-JWT. Если токена нет или он битый — САМ
// пишет ответ 401 и возвращает null; вызывающий делает `if (!userId) return;`.
// Наши токены всегда несут userId (UUID), поэтому для валидного токена результат
// всегда истинный — ложь означает «авторизация не пройдена, ответ уже отправлен».
function authUser(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return null;
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return payload.userId;
  } catch {
    res.status(401).json({ error: 'Токен недействителен' });
    return null;
  }
}

module.exports = { authUser };
