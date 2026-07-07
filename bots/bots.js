// СТРАНИЦА «МОИ БОТЫ»
// Список ботов пользователя. Загрузка — stale-while-revalidate:
// мгновенно из localStorage-кэша, затем сверка с сервером.
// Тот же паттерн, что на странице API-ключей.

// Стратегия → человекочитаемое название
const STRATEGY_LABEL = {
  spot_grid: 'Spot Grid',
};

// Иконки монет (COIN_ICON) — общий объект из common.js.

// <img> монеты
function coinIc(t) {
  return `<img class="mybot-coin" src="${COIN_ICON[t]}" alt="${t}" />`;
}

// Торговая пара с иконками (пока единственная — CITRO/USDT)
function pairHtml() {
  return `${coinIc('CITRO')}${coinIc('USDT')} CITRO / USDT`;
}

// Депозит с иконками монет
function depositHtml(dep) {
  if (!dep || typeof dep !== 'object') return '—';
  if (dep.mode === 'BOTH') {
    return `${coinIc('USDT')}${escapeHtml(String(dep.usdt))} USDT&nbsp;&nbsp;+&nbsp;&nbsp;`
         + `${coinIc('CITRO')}${escapeHtml(String(dep.citro))} CITRO`;
  }
  if (dep.amount != null) {
    const t = dep.mode === 'CITRO' ? 'CITRO' : 'USDT';
    return `${coinIc(t)}${escapeHtml(String(dep.amount))} ${t}`;
  }
  return '—';
}

// Статус бота → подпись и CSS-класс бейджа.
//   active                       → «Активен» (зелёный);
//   не активен и есть причина    → «Ошибка»  (янтарный) — бот упал, причина в status_message;
//   не активен и причины нет     → «Неактивен» (красный) — штатно остановлен.
// Воркер очищает status_message при успешном запуске и заполняет только при сбое,
// поэтому «не активен + сообщение» = ошибка.
function statusInfo(status, statusMessage) {
  if (status === 'active') return { label: 'Активен',   cls: 'active'   };
  if (statusMessage)       return { label: 'Ошибка',    cls: 'error'    };
  return { label: 'Неактивен', cls: 'inactive' };
}

// Порядок карточек: сначала активные, затем остановленные с ошибкой, затем
// неактивные. Внутри одной группы сохраняем исходный порядок (Array.sort
// стабильна) — не перетасовываем ботов с одинаковым статусом.
const STATUS_ORDER = { active: 0, error: 1, inactive: 2 };
function statusRank(bot) {
  return STATUS_ORDER[statusInfo(bot.status, bot.status_message).cls] ?? 9;
}
function sortBots(bots) {
  return bots.slice().sort((a, b) => statusRank(a) - statusRank(b));
}


document.addEventListener('DOMContentLoaded', () => {
  fillProfile();
  document.querySelector('.logout-btn')?.addEventListener('click', logout);
  setupCardActions();  // делегирование кликов по кнопкам карточек
  setupModals();       // закрытие окон «Информация» и «Удаление»
  loadBots();
});


// КЭШ СПИСКА БОТОВ В localStorage
// Ключ привязан к userId (как apiKeys_<userId>) — чужой пользователь
// на том же устройстве не увидит данные.
const botsCache = makeCache('bots');           // фабрика кэша — из common.js
function readCache()      { return botsCache.read(); }
function writeCache(bots) { botsCache.write(bots); }


// ЗАГРУЗКА (stale-while-revalidate)
async function loadBots() {
  const cached = readCache();

  // Мгновенный показ из кэша, если он есть
  if (cached !== null) renderBots(cached);

  // Фоновое обновление с сервера (источник истины)
  const token = localStorage.getItem('token');
  try {
    const res = await fetch('/api/bots/list', {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (!res.ok) {
      if (cached === null) renderBots([]); // кэша не было и сервер не ответил
      return;
    }

    const { bots } = await res.json();
    const fresh = bots || [];

    // Перерисовываем только при реальных изменениях — без лишнего мерцания
    if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
      writeCache(fresh);
      renderBots(fresh);
    }
  } catch {
    if (cached === null) renderBots([]); // сеть недоступна и кэша не было
  }
}


// РЕНДЕР: пустое состояние или список карточек
function renderBots(bots) {
  const emptyEl = document.getElementById('bots-empty');
  const listEl  = document.getElementById('bots-list');
  const cardsEl = document.getElementById('bot-list-cards');
  const countEl = document.getElementById('bots-count');

  if (!bots || bots.length === 0) {
    emptyEl.style.display = '';
    listEl.style.display  = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.style.display  = '';
  countEl.textContent   = 'Мои боты (' + bots.length + ')';

  cardsEl.innerHTML = sortBots(bots).map(botCardHtml).join('');
}


// HTML одной карточки бота
function botCardHtml(bot) {
  const strategy = STRATEGY_LABEL[bot.strategy] || bot.strategy || 'Бот';
  const status   = statusInfo(bot.status, bot.status_message);
  const isActive = bot.status === 'active';

  const cfg      = bot.config || {};
  // Активного бота нельзя редактировать и удалять — гасим кнопки
  const lockAttr = isActive ? 'disabled' : '';

  // Причина показывается только при статусе «Ошибка»
  const errHtml = (status.cls === 'error' && bot.status_message)
    ? `<p class="mybot-error">⚠ ${escapeHtml(bot.status_message)}</p>` : '';

  return `
    <div class="mybot-card" data-bot-id="${escapeHtml(bot.id)}">
      <div class="mybot-card-top">
        <h3 class="mybot-name">${escapeHtml(bot.name)}</h3>
        <span class="mybot-status mybot-status--${status.cls}">${escapeHtml(status.label)}</span>
      </div>

      ${errHtml}

      <div class="mybot-card-grid">
        <div class="mybot-field">
          <span class="mybot-label">Тип</span>
          <span class="mybot-value">${escapeHtml(strategy)}</span>
        </div>
        <div class="mybot-field">
          <span class="mybot-label">Торговая пара</span>
          <span class="mybot-value mybot-value--icons">${pairHtml()}</span>
        </div>
        <div class="mybot-field">
          <span class="mybot-label">Депозит</span>
          <span class="mybot-value mybot-value--icons">${depositHtml(cfg.deposit)}</span>
        </div>
      </div>

      <div class="mybot-card-foot">
        <div class="mybot-actions">
          <button class="mybot-btn mybot-btn--info" data-action="info" type="button">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="11" x2="12" y2="16"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            Информация
          </button>

          <button class="mybot-btn mybot-btn--delete" data-action="delete" type="button" ${lockAttr}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            Удалить
          </button>

          <!-- Запуск идёт через страницу настройки (перепроверка по текущей цене),
               остановка — через окно подтверждения. См. setupCardActions. -->
          <button class="mybot-btn mybot-btn--toggle ${isActive ? 'is-stop' : 'is-start'}"
                  data-action="run" type="button">
            ${isActive ? toggleIcon('stop') + 'Остановить' : toggleIcon('start') + 'Перейти к настройке и запуску'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// Иконка для кнопки запуска/остановки
function toggleIcon(kind) {
  if (kind === 'stop') {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>`;
  }
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 5v14l11-7z"/></svg>`;
}


// ДЕЙСТВИЯ С КАРТОЧКАМИ (информация / правка / удаление / запуск-остановка)
// Клик ловим делегированием на контейнере — кнопки рисуются через innerHTML,
// поэтому вешать обработчики на каждую отдельно не получится.
function setupCardActions() {
  const container = document.getElementById('bot-list-cards');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const card = e.target.closest('.mybot-card');
    if (!card) return;

    const botId  = card.dataset.botId;
    const action = btn.dataset.action;

    if (action === 'info') openBotInfo(botId);
    else if (action === 'delete') openBotDelete(botId);
    else if (action === 'run') {
      const bot = findBot(botId);
      if (bot && bot.status === 'active') {
        openBotStop(botId); // активный → окно подтверждения остановки
      } else {
        // неактивный → страница настройки (там перепроверка по текущей цене и запуск)
        window.location.href = '/bots/spot-grid/?edit=' + encodeURIComponent(botId);
      }
    }
  });
}

// Находит бота в кэше по id
function findBot(botId) {
  return (readCache() || []).find(b => b.id === botId) || null;
}

// Обновляет поля бота в кэше и возвращает обновлённый список
function updateBotInCache(botId, patch) {
  const cached = readCache() || [];
  const i = cached.findIndex(b => b.id === botId);
  if (i !== -1) { cached[i] = { ...cached[i], ...patch }; writeCache(cached); }
  return cached;
}

// Удаляет бота из кэша и возвращает обновлённый список
function removeBotFromCache(botId) {
  const cached = (readCache() || []).filter(b => b.id !== botId);
  writeCache(cached);
  return cached;
}


// Окна: открытие/закрытие
function setupModals() {
  document.getElementById('info-close-btn')?.addEventListener('click', () => closeOverlay('info-overlay'));
  document.getElementById('info-ok-btn')?.addEventListener('click',   () => closeOverlay('info-overlay'));
  document.getElementById('delete-close-btn')?.addEventListener('click',  () => closeOverlay('delete-overlay'));
  document.getElementById('delete-cancel-btn')?.addEventListener('click', () => closeOverlay('delete-overlay'));
  document.getElementById('stop-close-btn')?.addEventListener('click',  () => closeOverlay('stop-overlay'));
  document.getElementById('stop-cancel-btn')?.addEventListener('click', () => closeOverlay('stop-overlay'));
}

function openOverlay(id) {
  const o = document.getElementById(id);
  if (o) { o.classList.add('is-open'); o.setAttribute('aria-hidden', 'false'); }
}

function closeOverlay(id) {
  const o = document.getElementById(id);
  if (o) { o.classList.remove('is-open'); o.setAttribute('aria-hidden', 'true'); }
}


// Окно «Информация о боте» (только сохранённые настройки)
function openBotInfo(botId) {
  const bot = findBot(botId);
  if (!bot) return;

  // Заголовок — само название бота (синим, без кавычек); textContent защищает от XSS
  document.getElementById('info-title').textContent = bot.name;

  const cfg = bot.config || {};
  const st  = statusInfo(bot.status, bot.status_message);
  const range = (cfg.priceLow != null && cfg.priceHigh != null)
    ? `${cfg.priceLow} — ${cfg.priceHigh}` : '—';

  // Шаг сетки = (Верх − Низ) / Кол-во. Сетка арифметическая → шаг в цене точный.
  const stepNum = (cfg.priceLow != null && cfg.priceHigh != null && cfg.gridCount)
    ? (parseFloat(cfg.priceHigh) - parseFloat(cfg.priceLow)) / parseInt(cfg.gridCount, 10) : NaN;
  const step = (isFinite(stepNum) && stepNum > 0) ? parseFloat(stepNum.toFixed(8)).toString() : '—';

  // [метка, готовый HTML значения]. Метки и текстовые значения экранируем;
  // статус, пара и депозит — наш контролируемый HTML (цвет/иконки).
  // «Причина» показывается только при статусе «Ошибка».
  const rows = [
    ['Статус',            `<span class="info-status info-status--${st.cls}">${st.label}</span>`],
    ...(st.cls === 'error' ? [['Причина', `<span class="info-reason">${escapeHtml(bot.status_message)}</span>`]] : []),
    ['API ключ',          escapeHtml(bot.api_key_name || '—')],
    ['Торговая пара',     pairHtml()],
    ['Депозит',           depositHtml(cfg.deposit)],
    ['Диапазон цен',      escapeHtml(range)],
    ['Количество сеток',  escapeHtml(cfg.gridCount != null ? String(cfg.gridCount) : '—')],
    ['Шаг сетки',         escapeHtml(step)],
  ];

  document.getElementById('info-rows').innerHTML = rows.map(([label, valueHtml]) => `
    <div class="info-row">
      <span class="info-label">${escapeHtml(label)}</span>
      <span class="info-value">${valueHtml}</span>
    </div>
  `).join('');

  openOverlay('info-overlay');
}


// Окно «Удаление бота»
function openBotDelete(botId) {
  const bot = findBot(botId);
  if (!bot) return;
  if (bot.status === 'active') return; // подстраховка: активного не удаляем

  document.getElementById('delete-bot-text').innerHTML =
    `Вы действительно хотите удалить бота <strong>${escapeHtml(bot.name)}</strong>?<br>
     Обратите внимание, что эта операция необратима.`;

  // Перевешиваем обработчик заменой кнопки (сбрасываем старый) — resetButton из common.js
  const newBtn = resetButton('delete-confirm-btn');
  newBtn.disabled    = false;
  newBtn.textContent = 'Удалить бота';
  newBtn.addEventListener('click', () => confirmBotDelete(botId));

  openOverlay('delete-overlay');
}

async function confirmBotDelete(botId) {
  const btn   = document.getElementById('delete-confirm-btn');
  const token = localStorage.getItem('token');

  btn.disabled    = true;
  btn.textContent = 'Удаление...';

  try {
    const res = await fetch('/api/bots/delete', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ botId })
    });

    if (!res.ok) {
      btn.textContent = 'Удалить бота';
      // Бота успели запустить в другом месте (409) — синхронизируем и закрываем
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.status === 409 && data.code === 'bot_active') {
        const cached = updateBotInCache(botId, { status: 'active' });
        closeOverlay('delete-overlay');
        renderBots(cached);
        return;
      }
      btn.disabled = false;
      return;
    }

    const cached = removeBotFromCache(botId);
    closeOverlay('delete-overlay');
    renderBots(cached);

  } catch {
    btn.disabled    = false;
    btn.textContent = 'Удалить бота';
  }
}


// Остановка бота (через окно подтверждения)
// Запуск НЕ здесь: он идёт через страницу настройки (перепроверка по цене).
// Остановка снимает все лимитные ордера; показываем прогресс «Отмена ордеров»
// и закрываем окно только когда воркер реально снимет все ордера.
function openBotStop(botId) {
  const bot = findBot(botId);
  if (!bot || bot.status !== 'active') return;

  resetStopModal(); // на случай, если окно осталось в состоянии прогресса

  // Заголовок «Остановить <название>?» — имя акцентным синим
  document.getElementById('stop-title').innerHTML =
    `Остановить <span class="title-accent">${escapeHtml(bot.name)}</span>?`;

  // Перевешиваем обработчик заменой кнопки (сбрасываем старый) — resetButton из common.js
  const newBtn = resetButton('stop-confirm-btn');
  newBtn.disabled    = false;
  newBtn.textContent = 'Остановить';
  newBtn.addEventListener('click', () => confirmBotStop(botId));

  openOverlay('stop-overlay');
}

// Текст в блоке прогресса остановки
function setStopText(t) {
  const el = document.getElementById('stop-progress-text');
  if (el) el.textContent = t;
}

// Режим «Отмена ордеров»: прячем предупреждение и подвал, показываем спиннер,
// блокируем закрытие (как при запуске на странице настройки).
function enterStopProgress(total) {
  const title = document.getElementById('stop-title');
  if (title) title.textContent = 'Отмена ордеров';
  const warn = document.getElementById('stop-warn-text'); if (warn) warn.hidden = true;
  const prog = document.getElementById('stop-progress'); if (prog) prog.hidden = false;
  const ft = document.querySelector('#stop-overlay .modal-ft'); if (ft) ft.style.display = 'none';
  const closeBtn = document.getElementById('stop-close-btn'); if (closeBtn) closeBtn.disabled = true;
  // Счётчик показываем СРАЗУ (как при запуске), не дожидаясь первого опроса.
  setStopText(total > 0 ? `Отмена ордеров… (0/${total})` : 'Отмена ордеров…');
}

// Возврат окна остановки в исходный вид. Заголовок не трогаем — его задаёт openBotStop.
function resetStopModal() {
  const warn = document.getElementById('stop-warn-text'); if (warn) warn.hidden = false;
  const prog = document.getElementById('stop-progress'); if (prog) prog.hidden = true;
  const ft = document.querySelector('#stop-overlay .modal-ft'); if (ft) ft.style.display = '';
  const closeBtn = document.getElementById('stop-close-btn'); if (closeBtn) closeBtn.disabled = false;
}

// Остановка: переводим бота в inactive, затем ждём, пока воркер реально снимет
// все ордера (опрашиваем тот же эндпоинт статуса, что и при запуске).
async function confirmBotStop(botId) {
  const btn   = document.getElementById('stop-confirm-btn');
  const token = localStorage.getItem('token');

  btn.disabled    = true;
  btn.textContent = 'Остановка...';

  try {
    const res = await fetch('/api/bots/toggle', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ botId, action: 'stop' })
    });

    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = 'Остановить';
      return;
    }

    const data = await res.json();
    updateBotInCache(botId, { status: data.status }); // теперь inactive
    // Всего к снятию ≈ число сеток бота (как expected при запуске) — для счётчика
    const total = parseInt(findBot(botId)?.config?.gridCount, 10) || null;
    enterStopProgress(total);
    pollStopCancel(botId, total);

  } catch {
    btn.disabled = false;
    btn.textContent = 'Остановить';
  }
}

// Опрашивает статус, пока все ордера не снимутся (open + placing === 0).
async function pollStopCancel(botId, total) {
  const token = localStorage.getItem('token');
  const POLL_MS = 600, TIMEOUT_MS = 90000, t0 = Date.now();
  if (!(total > 0)) total = null; // нет оценки — определим по первому замеру

  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let data;
    try {
      const res = await fetch('/api/bots/list?launchStatus=' + encodeURIComponent(botId), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) continue;
      data = await res.json();
    } catch { continue; }

    const remaining = (data.open || 0) + (data.placing || 0);
    if (total === null || remaining > total) total = remaining; // если открытых больше оценки

    if (remaining === 0) { setStopText('Ордера сняты ✓'); await new Promise(r => setTimeout(r, 600)); finishStop(); return; }

    const done = Math.max(0, total - remaining); // снято к этому моменту
    setStopText(`Отмена ордеров… (${done}/${total})`); // формат как при запуске
  }
  finishStop(); // таймаут — закрываем (статус уже inactive, остаток снимет воркер)
}

// Закрывает окно остановки и обновляет список из кэша.
function finishStop() {
  resetStopModal();
  closeOverlay('stop-overlay');
  renderBots(readCache() || []);
}


// Профиль в шапке (fillProfile) и выход (logout) — общие хелперы из common.js.
