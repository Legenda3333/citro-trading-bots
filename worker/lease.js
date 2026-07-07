//  «КЛЮЧ» ЕДИНСТВЕННОГО ВОРКЕРА (leader lease).
//  Торгует только тот процесс, который держит ключ. Реализовано через таблицу
//  worker_lease + атомарные функции в БД (см. db/schema.sql). Нужно, чтобы при
//  пересечении двух воркеров (напр. в момент деплоя) не выставились ДВОЙНЫЕ
//  ордера на реальные деньги: один UPDATE в БД физически не даст двум процессам
//  взять ключ одновременно.
const { sb } = require('./db');

// Взять или продлить ключ. true — ключ теперь у нас (можно торговать).
// Бросает при сбое БД (после повторов) — вызывающий трактует это как «ключа нет».
async function acquire(supabase, holder, ttlSeconds, log) {
  const data = await sb(() => supabase.rpc('acquire_worker_lease',
    { p_holder: holder, p_ttl_seconds: ttlSeconds }),
    { label: 'взять ключ воркера', log, attempts: 2 });
  return data === true;
}

// Отдать ключ (сработает, только если он наш) — для аккуратной остановки.
// Best-effort: любые ошибки гасим, выключение не должно зависнуть из-за БД.
async function release(supabase, holder, log) {
  try {
    await sb(() => supabase.rpc('release_worker_lease', { p_holder: holder }),
      { label: 'отдать ключ воркера', log, attempts: 2 });
  } catch (e) {
    if (log) log('не удалось отдать ключ (не критично):', e && e.message);
  }
}

module.exports = { acquire, release };
