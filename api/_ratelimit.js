//  ЗАЩИТА ОТ ПЕРЕБОРА ПАРОЛЕЙ (login / register).
//  Считаем НЕУДАЧНЫЕ попытки по IP за окно; при превышении — временный отказ.
//  Состояние храним в таблице auth_attempts (у serverless нет общей памяти,
//  поэтому «в уме» счётчик не удержать). Ключ — IP, а не логин: так нельзя
//  заблокировать чужой аккаунт, зная его логин.
//
//  Файл с префиксом «_» Vercel НЕ считает за отдельную функцию.
//  БЕЗОПАСНО деплоить даже до создания таблицы: любая ошибка/сбой БД трактуется
//  как «попыток нет» (fail-open) — вход не блокируется, лимит просто не работает,
//  пока таблицу не создадут.

const MAX_ATTEMPTS = 5;                 // столько неудачных попыток — и блок
const WINDOW_MS    = 2 * 60 * 1000;     // окно/срок сброса — 2 минуты
const LOCK_MESSAGE = 'Превышено количество попыток входа в аккаунт, попробуйте позже';

// IP клиента из заголовков Vercel. x-forwarded-for бывает списком — берём первый.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length) return real.trim();
  return 'unknown';
}

// Сколько неудачных попыток у этого IP за окно. Любой сбой (ошибка запроса ИЛИ
// брошенное исключение сети) → возвращаем 0 (fail-open): проблема с БД не должна
// закрыть вход всем пользователям.
async function failureCount(supabase, ip, kind) {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { count, error } = await supabase
      .from('auth_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip).eq('kind', kind).gte('created_at', since);
    if (error) { console.error('rate-limit count error:', error.message); return 0; }
    return count || 0;
  } catch (e) { console.error('rate-limit count threw:', e && e.message); return 0; }
}

// Достигнут ли лимит для этого IP (проверка до обработки запроса).
async function isLocked(supabase, ip, kind) {
  return (await failureCount(supabase, ip, kind)) >= MAX_ATTEMPTS;
}

// Записать неудачную попытку и вернуть true, если лимит достигнут ИМЕННО сейчас
// (тогда вызывающий сразу показывает сообщение о блокировке). При сбое БД —
// false (не блокируем).
async function recordFailure(supabase, ip, kind) {
  try {
    const { error } = await supabase.from('auth_attempts').insert({ ip, kind });
    if (error) { console.error('rate-limit insert error:', error.message); return false; }
  } catch (e) { console.error('rate-limit insert threw:', e && e.message); return false; }
  return (await failureCount(supabase, ip, kind)) >= MAX_ATTEMPTS;
}

// Успех — снимаем счётчик этого IP (удаляем его записи данного вида).
async function clearFailures(supabase, ip, kind) {
  try {
    const { error } = await supabase.from('auth_attempts').delete().eq('ip', ip).eq('kind', kind);
    if (error) console.error('rate-limit clear error:', error.message);
  } catch (e) { console.error('rate-limit clear threw:', e && e.message); }
}

module.exports = {
  MAX_ATTEMPTS, WINDOW_MS, LOCK_MESSAGE,
  clientIp, isLocked, recordFailure, clearFailures,
};
