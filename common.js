//  ОБЩИЕ УТИЛИТЫ ФРОНТЕНДА
//  Подключается на всех страницах ДО их скриптов (как errors.js).
//  Общие для всех страниц функции — одна точка изменения вместо копий в каждой.
//  Определяет глобальные функции (window.*), доступные скриптам страниц.

// Payload JWT из localStorage (или null при отсутствии/битом токене).
// Единая точка разбора токена для всех страниц.
function getPayload() {
  try { return JSON.parse(atob(localStorage.getItem('token').split('.')[1])); }
  catch { return null; }
}
window.getPayload = getPayload;

// Экранирование для безопасной вставки данных в innerHTML (защита от XSS).
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');   // и одинарная кавычка — чтобы не зависеть от того, какими кавычками обёрнут атрибут
}
window.escapeHtml = escapeHtml;

// Иконки монет — единый источник URL для всех страниц (боты, статистика,
// настройка бота).
const COIN_ICON = {
  CITRO: 'https://s3.eu-central-2.wasabisys.com/citronus/icons/coins/CITRO.svg',
  USDT:  'https://s3.eu-central-2.wasabisys.com/citronus/icons/coins/USDT.svg',
};
window.COIN_ICON = COIN_ICON;

// Умное позиционирование тултипов «i»: по умолчанию над иконкой, но если сверху
// мало места (навбар/край экрана) — добавляем .tooltip-below и показываем снизу.
function setupSmartTooltips() {
  const navbar = document.querySelector('.navbar');
  document.querySelectorAll('.info-wrapper').forEach(wrapper => {
    const btn = wrapper.querySelector('.info-btn');
    if (!btn) return;
    btn.addEventListener('mouseenter', () => {
      const navbarBottom = navbar ? navbar.getBoundingClientRect().bottom : 0;
      const btnTop       = wrapper.getBoundingClientRect().top;
      const estimatedTooltipHeight = 120; // запас достаточен для любого текста
      const gap = 10;
      if (btnTop - gap - estimatedTooltipHeight < navbarBottom) {
        wrapper.classList.add('tooltip-below');
      } else {
        wrapper.classList.remove('tooltip-below');
      }
    });
  });
}
window.setupSmartTooltips = setupSmartTooltips;

// Фабрика кэша в localStorage, привязанного к userId (чужой пользователь на
// том же устройстве не увидит данные). Возвращает { key, read, write }.
// read() → распарсенное значение или null; write(v) — сериализует и кладёт.
function makeCache(prefix) {
  const key = () => { const p = getPayload(); return p ? prefix + '_' + p.userId : prefix; };
  return {
    key,
    read()   { try { return JSON.parse(localStorage.getItem(key())); } catch { return null; } },
    write(v) { try { localStorage.setItem(key(), JSON.stringify(v)); } catch {} },
  };
}
window.makeCache = makeCache;

// GET к нашему API с токеном. Три момента, важные для СВЕЖЕСТИ данных:
//   • cache:'no-store' — ответ никогда не берётся из HTTP-кэша браузера/прокси,
//     поэтому «свежий» запрос не может вернуть вчерашние цифры;
//   • короткие повторы — разовый сетевой сбой или холодный старт функции не должен
//     оборачиваться показом устаревших данных;
//   • 401 (токен недействителен) — выходим и не повторяем, это не сбой связи.
// Возвращает разобранный JSON; БРОСАЕТ, если получить данные не удалось.
async function apiGet(url, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') },
        cache: 'no-store',
      });
      if (res.status === 401) { logout(); const e = new Error('unauthorized'); e.fatal = true; throw e; }
      if (!res.ok) throw new Error('http ' + res.status);
      return await res.json();
    } catch (e) {
      if (e.fatal) throw e;                                   // повторять бессмысленно
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 300 * i));   // 300 мс, затем 600 мс
    }
  }
  throw lastErr;
}
window.apiGet = apiGet;

// ЖИВОЕ ОБНОВЛЕНИЕ ДАННЫХ СТРАНИЦЫ
// Задача — чтобы на экране НИКОГДА не висели устаревшие данные. Обновляем:
//   • при старте и при каждом возвращении к странице: вкладка снова видима, окно
//     получило фокус, страница восстановлена кнопкой «назад» (bfcache), вернулась сеть;
//   • раз в refreshMs, пока страница видима (в фоне запросов не делаем);
//   • после неудачи — повтор с нарастающей паузой (5 c, 10 c, … до refreshMs), чтобы
//     страница вылечилась сама, а не замерла на старых данных.
// Тикер лёгкий (сам по себе в сеть не ходит) и заодно ловит СОН компьютера: обычный
// setInterval во сне не тикает и мог бы отстать на час; после пробуждения тикер видит,
// что срок обновления давно прошёл, и обновляет немедленно.
// refreshFn — async-функция страницы: получает и рисует данные, БРОСАЕТ при неудаче.
function makeLiveRefresher(refreshFn, { refreshMs = 60000, retryMs = 5000, tickMs = 2000 } = {}) {
  let nextAt = 0, fails = 0, inFlight = false, timer = null;

  async function run() {
    if (inFlight || document.hidden || Date.now() < nextAt) return;
    inFlight = true;
    try {
      await refreshFn();
      fails  = 0;
      nextAt = Date.now() + refreshMs;
    } catch {
      fails++;
      nextAt = Date.now() + Math.min(retryMs * fails, refreshMs);
    } finally {
      inFlight = false;
    }
  }

  // Обновить как можно скорее (снимаем задержку; в фоне run() всё равно промолчит).
  function refreshNow() { nextAt = 0; run(); }

  function start() {
    if (timer) return;
    timer = setInterval(run, tickMs);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });
    window.addEventListener('focus',  refreshNow);
    window.addEventListener('online', refreshNow);
    window.addEventListener('pageshow', (e) => { if (e.persisted) refreshNow(); }); // возврат «назад»
    refreshNow();
  }

  return { start, refreshNow };
}
window.makeLiveRefresher = makeLiveRefresher;

// Профиль в шапке (ник + ID) — одинаков на всех внутренних страницах.
function fillProfile() {
  const nameEl = document.getElementById('dropdownUsername');
  const idEl   = document.getElementById('dropdownId');
  if (nameEl) nameEl.textContent = localStorage.getItem('username') || '—';
  if (idEl) {
    const p = getPayload();
    idEl.textContent = (p && p.userNumber != null) ? 'ID: ' + p.userNumber : '—';
  }
}
window.fillProfile = fillProfile;

// Заменяет кнопку её клоном (сбрасывает ВСЕ прежние обработчики) и возвращает
// свежий узел — чтобы навесить новый onclick, не накапливая старые. Используется
// в модалах подтверждения (удаление ключа/бота, остановка бота).
function resetButton(id) {
  const btn = document.getElementById(id);
  if (!btn) return null;
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  return fresh;
}
window.resetButton = resetButton;

// Выход: сперва чистим ВСЕ per-user кэши (пока по токену известен userId),
// затем токен и ник, и уходим на страницу входа.
function logout() {
  const p = getPayload();
  if (p) ['apiKeys', 'bots', 'stats'].forEach(pre => localStorage.removeItem(pre + '_' + p.userId));
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  window.location.replace('/');
}
window.logout = logout;
