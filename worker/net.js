//  СЕТЕВАЯ УСТОЙЧИВОСТЬ — повтор запросов с задержкой.
//  На нестабильном соединении один сетевой сбой не должен ломать
//  запуск/остановку бота: повторяем несколько раз, прежде чем сдаться.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Человеческое описание частых сетевых ошибок — чтобы лог не выглядел тревожно.
function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/abort|timeout/i.test(m)) return 'медленное соединение (таймаут)';
  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|EPIPE/i.test(m)) return 'сетевой сбой';
  return m;
}

// Выполняет fn с повторами и возвращает её результат.
//   attempts     — всего попыток (включая первую). 1 = без повторов.
//   baseDelayMs  — пауза перед 2-й попыткой; дальше ×2 (0.5с → 1с → 2с).
//   shouldRetry  — повторять ли при данной ошибке (по умолчанию — да).
//   label, log   — для строки в журнале при повторе.
// Если все попытки провалились — бросает последнюю ошибку.
async function withRetry(fn, opts = {}) {
  const { attempts = 3, baseDelayMs = 500, label = '', log, shouldRetry = () => true } = opts;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i >= attempts || !shouldRetry(e)) break;
      if (log) log(`  ↻ повтор «${label}» (${i}/${attempts - 1}): ${friendly(e)}`);
      await sleep(baseDelayMs * Math.pow(2, i - 1));
    }
  }
  throw lastErr;
}

module.exports = { withRetry, sleep };
