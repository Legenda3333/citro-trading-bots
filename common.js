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
