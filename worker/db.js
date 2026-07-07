//  SUPABASE С УСТОЙЧИВОСТЬЮ — таймаут + повторы.
//  Обычные вызовы supabase-js на медленной сети могут «висеть»
//  десятки секунд и возвращать `fetch failed`. Эта обёртка даёт
//  каждому запросу жёсткий таймаут и до 3 попыток.
const { withRetry } = require('./net');

const SB_TIMEOUT_MS = 5000; // не ждём ответ БД дольше — лучше упасть и повторить на свежем соединении

// build — функция, возвращающая запрос Supabase БЕЗ await (напр.
//   () => supabase.from('bots').select('*').eq('status','active') ).
// Таймаут добавляем здесь же. Возвращает data либо бросает ошибку (для повтора).
async function sb(build, opts = {}) {
  const { label = 'supabase', log, attempts = 4 } = opts;
  return withRetry(async () => {
    const res = await build().abortSignal(AbortSignal.timeout(SB_TIMEOUT_MS));
    if (res.error) {
      const e  = new Error(res.error.message || 'Supabase error');
      e.code   = res.error.code;
      e.dbError = res.error;
      throw e;
    }
    return res.data;
  }, { attempts, label, log });
}

module.exports = { sb, SB_TIMEOUT_MS };
