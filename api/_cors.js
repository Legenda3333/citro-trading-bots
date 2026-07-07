//  ЕДИНЫЕ CORS-ЗАГОЛОВКИ
//  Фронтенд и API на одном origin, поэтому обычные запросы приложения
//  CORS не затрагивает. Ограничение нужно, чтобы чужие сайты не могли
//  обращаться к нашему API из браузера.
//
//  Если появятся доп. домены (кастомный домен, превью) — добавить сюда.
const APP_ORIGIN = 'https://citro-trading-bots.vercel.app';

function applyCors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', methods + ', OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { APP_ORIGIN, applyCors };
