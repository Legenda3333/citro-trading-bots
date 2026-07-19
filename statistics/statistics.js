// СТРАНИЦА «СТАТИСТИКА»
// Итоги + таблицы «Боты»/«Сделки» по данным /api/bots/list?stats=1.
// Прибыль считает сервер (api/_stats.js, модель «шаг сетки на продажу»);
// клиент только фильтрует, пагинирует и рисует. Загрузка — fetch-first:
// показываем загрузку и рисуем СВЕЖИЕ данные; кэш — лишь офлайн-резерв.

const PAGE_SIZE = 10;

// Иконки монет (COIN_ICON) — общий объект из common.js.

// Метки статуса бота (классы бейджей — в statistics.css)
const STATUS_LABEL = {
  active:   { label: 'Активен',   cls: 'active'   },
  inactive: { label: 'Неактивен', cls: 'inactive' },
  error:    { label: 'Ошибка',    cls: 'error'    },
  deleted:  { label: 'Удалён',    cls: 'deleted'  },
};

// Порядок сортировки по статусу: активные → неактивные → с ошибкой → удалённые
const STATUS_RANK = { active: 0, inactive: 1, error: 2, deleted: 3 };

// Состояние страницы
let data       = null;                      // { summary, bots, trades }
let filters    = { bot: '', type: '', pair: '' };
let currentTab = 'bots';
let page       = 1;

// Короткие ссылки на DOM
const $ = (id) => document.getElementById(id);
let elThead, elTbody, elTableWrap, elPager;


document.addEventListener('DOMContentLoaded', () => {
  elThead     = $('stat-thead');
  elTbody     = $('stat-tbody');
  elTableWrap = $('stat-table-wrap');
  elPager     = $('stat-pager');

  fillProfile();
  document.querySelector('.logout-btn')?.addEventListener('click', logout);
  setupTabs();
  setupFilters();
  $('stat-retry')?.addEventListener('click', () => { showLoading(); live.refreshNow(); });

  showLoading();
  live.start();
});


// ЗАГРУЗКА (fetch-first)
const statsCache = makeCache('stats');         // фабрика кэша — из common.js
function readCache()  { return statsCache.read(); }
function writeCache(d) { statsCache.write(d); }

// Свежие данные: запрос → рисуем. Старый кэш как актуальный НЕ рисуем — он только
// офлайн-резерв, когда показать ещё нечего. БРОСАЕТ при неудаче: живой обновлятель
// (common.js) повторит, поэтому страница не замирает на старых данных.
//
// lastRaw — строковый снимок ПОСЛЕДНЕГО ответа сервера. Свежий ответ сравниваем именно
// с ним, а не с data: afterData() сортирует data.bots на месте, поэтому сравнение с data
// почти всегда давало «не равно» и приводило к лишней перерисовке на каждом опросе.
let lastRaw = null;
async function fetchFresh() {
  try {
    const fresh = await apiGet('/api/bots/list?stats=1');
    const raw = JSON.stringify(fresh);
    if (raw !== lastRaw) {          // на сервере действительно что-то изменилось
      lastRaw = raw;
      data = fresh;
      writeCache(fresh);
      afterData();
    }
  } catch (e) {
    // Сервер/сеть недоступны. Если показать ещё нечего — тихо берём офлайн-резерв
    // из кэша; нет и его — состояние ошибки. Если данные уже показаны (напр. упал
    // фоновый опрос) — оставляем текущее, не мигаем ошибкой.
    if (!data) {
      const cached = readCache();
      if (cached) { lastRaw = JSON.stringify(cached); data = cached; afterData(); }
      else        showError();
    }
    throw e;   // обновлятелю: не получилось — повтори
  }
}

// Живое обновление: сразу при заходе и при каждом возвращении (вкладка снова видима,
// фокус окна, «назад» из bfcache, вернулась сеть), далее раз в 30 секунд, пока страница
// видима; после сбоя — быстрый повтор; после сна ПК — обновление сразу. См. common.js.
const live = makeLiveRefresher(fetchFresh);

// Данные получены/обновлены: сортируем ботов, пересобираем фильтры и таблицу.
// Сделки сервер уже отдаёт новыми сверху (по времени) — порядок не трогаем.
function afterData() {
  sortBotsInPlace(data.bots);
  populateFilters();
  render();
}

// Боты по умолчанию: активные → неактивные → с ошибкой → удалённые, внутри группы —
// от новых к старым (по дате создания). При равных датах — по имени, чтобы порядок был
// стабильным.
function sortBotsInPlace(arr) {
  arr.sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9, rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    const da = Date.parse(a.createdAt) || 0, db = Date.parse(b.createdAt) || 0;
    if (db !== da) return db - da;                 // новее — выше
    return a.name.localeCompare(b.name, 'ru');
  });
}


// РЕНДЕР: карточки-итоги + таблица активной вкладки
function render() {
  if (!data) return;
  renderSummary();

  const bots   = filteredBots();
  const trades = filteredTrades();
  $('tab-count-bots').textContent   = bots.length;
  $('tab-count-trades').textContent = trades.length;

  renderTable(currentTab === 'bots' ? bots : trades);
}

// Итоги считаем по ОТФИЛЬТРОВАННЫМ ботам — карточки следуют за фильтрами
function renderSummary() {
  let pnl = 0, fees = 0, net = 0, vol = 0;
  for (const b of filteredBots()) { pnl += b.pnl; fees += b.fees; net += b.net; vol += b.volume; }

  paintMoney($('sum-pnl'), pnl, true);
  paintMoney($('sum-fees'), fees, false);
  paintMoney($('sum-net'), net, true);
  paintMoney($('sum-vol'), vol, false);
}

// Колонки и сборщик строки для каждой вкладки
const TABS = {
  bots: {
    columns: [
      { label: 'ID' },
      { label: 'Название' },
      { label: 'Тип' },
      { label: 'Торговая пара' },
      { label: 'PnL, USDT',            cls: 'col-num' },
      { label: 'Комиссии, USDT',       cls: 'col-num' },
      { label: 'Чистая прибыль, USDT', cls: 'col-num' },
      { label: 'Объём, USDT',          cls: 'col-num' },
      { label: 'Кол-во сделок',        cls: 'col-num' },
      { label: 'Статус',               cls: 'col-center' },
    ],
    row: (b) => [
      { html: idCell(b.id),            cls: 'col-id' },
      { html: escapeHtml(b.name),      cls: 'col-name' },
      { html: escapeHtml(b.type) },
      { html: pairHtml(b.pair) },
      { html: moneyCell(b.pnl),        cls: 'col-num' },
      { html: feeCell(b.fees),         cls: 'col-num' },
      { html: moneyCell(b.net),        cls: 'col-num' },
      { html: fmtNum(b.volume, 2, 2),  cls: 'col-num' },
      { html: String(b.trades),        cls: 'col-num' },
      { html: statusBadge(b.status),   cls: 'col-center' },
    ],
  },
  trades: {
    columns: [
      { label: 'ID' },
      { label: 'Название бота' },
      { label: 'Тип бота' },
      { label: 'Торговая пара' },
      { label: 'Тип сделки',           cls: 'col-center' },
      { label: 'PnL, USDT',            cls: 'col-num' },
      { label: 'Комиссии, USDT',       cls: 'col-num' },
      { label: 'Чистая прибыль, USDT', cls: 'col-num' },
      { label: 'Объём, USDT',          cls: 'col-num' },
      { label: 'Дата исполнения' },
    ],
    row: (t) => [
      { html: idCell(t.id),            cls: 'col-id' },
      { html: escapeHtml(t.botName),   cls: 'col-name' },
      { html: escapeHtml(t.type) },
      { html: pairHtml(t.pair) },
      { html: sideTag(t.side),         cls: 'col-center' },
      { html: moneyCell(t.pnl),        cls: 'col-num' },
      { html: feeCell(t.fee),          cls: 'col-num' },
      { html: moneyCell(t.net),        cls: 'col-num' },
      { html: fmtNum(t.volume, 2, 2),  cls: 'col-num' },
      { html: escapeHtml(fmtDate(t.executedAt)) },
    ],
  },
};

function renderTable(rows) {
  const def = TABS[currentTab];

  if (!rows.length) { showEmpty(); return; }
  hideStates();

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const start = (page - 1) * PAGE_SIZE;
  const slice = rows.slice(start, start + PAGE_SIZE);

  elThead.innerHTML = '<tr>' + def.columns
    .map(c => `<th class="${c.cls || ''}">${escapeHtml(c.label)}</th>`).join('') + '</tr>';

  elTbody.innerHTML = slice.map(r =>
    '<tr>' + def.row(r).map(c => `<td class="${c.cls || ''}">${c.html}</td>`).join('') + '</tr>'
  ).join('');

  elTableWrap.hidden = false;
  renderPager(rows.length, pages, start, slice.length);
}


// ПАГИНАЦИЯ
function renderPager(total, pages, start, shown) {
  if (pages <= 1) { elPager.hidden = true; return; }

  const info = `Показано ${start + 1}–${start + shown} из ${total}`;
  elPager.innerHTML =
    `<span class="stat-pager-info">${info}</span>` +
    `<div class="stat-pager-controls">${pageButtons(pages)}</div>`;
  elPager.hidden = false;

  elPager.querySelectorAll('button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (p >= 1 && p <= pages && p !== page) { page = p; render(); }
    });
  });
}

function pageButtons(pages) {
  const parts = [];
  parts.push(`<button class="stat-page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Предыдущая страница">‹</button>`);
  for (const n of pageList(page, pages)) {
    if (n === '…') parts.push('<span class="stat-page-gap">…</span>');
    else parts.push(`<button class="stat-page-btn ${n === page ? 'is-current' : ''}" data-page="${n}">${n}</button>`);
  }
  parts.push(`<button class="stat-page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Следующая страница">›</button>`);
  return parts.join('');
}

// Список номеров страниц с многоточиями: 1 … 4 5 6 … 12
function pageList(cur, pages) {
  const keep = new Set([1, pages, cur, cur - 1, cur + 1]);
  const nums = [...keep].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
}


// ФИЛЬТРЫ — кастомные выпадающие списки (нужны иконки монет в опциях)
function setupFilters() {
  document.querySelectorAll('.stat-dd').forEach(initDropdown);

  // Закрытие меню по клику вне и по Escape
  document.addEventListener('click', (e) => { if (!e.target.closest('.stat-dd')) closeAllDropdowns(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllDropdowns(); });

  $('filter-reset').addEventListener('click', onReset);
}

function ddByFilter(name) {
  return document.querySelector(`.stat-dd[data-filter="${name}"]`);
}

function initDropdown(dd) {
  const btn = dd.querySelector('.stat-dd-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !dd.classList.contains('is-open');
    closeAllDropdowns();
    if (willOpen) {
      dd.classList.add('is-open');                 // меню проявляется через CSS-переход
      btn.setAttribute('aria-expanded', 'true');
    }
  });
}

function closeAllDropdowns() {
  document.querySelectorAll('.stat-dd.is-open').forEach(dd => {
    dd.classList.remove('is-open');
    dd.querySelector('.stat-dd-btn').setAttribute('aria-expanded', 'false');
  });
}

// Заполняет меню опциями [{value, label}] и выставляет текущее значение
function fillDropdown(dd, options, value) {
  const menu = dd.querySelector('.stat-dd-menu');
  menu.innerHTML = options.map(o =>
    `<li class="stat-dd-opt" role="option" data-value="${escapeHtml(o.value)}">${o.label}</li>`
  ).join('');
  menu.querySelectorAll('.stat-dd-opt').forEach(li =>
    li.addEventListener('click', (e) => { e.stopPropagation(); selectOption(dd, li.dataset.value); })
  );
  setDropdownValue(dd, value);   // подсветка опции + надпись на кнопке (без перерисовки)
}

// Меняет значение дропдауна и подпись на кнопке (без перерисовки таблицы)
function setDropdownValue(dd, value) {
  const menu = dd.querySelector('.stat-dd-menu');
  let labelHtml = '';
  menu.querySelectorAll('.stat-dd-opt').forEach(li => {
    const on = li.dataset.value === value;
    li.classList.toggle('is-selected', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) labelHtml = li.innerHTML;
  });
  if (!labelHtml) {                                   // значение пропало → первая опция
    const first = menu.querySelector('.stat-dd-opt');
    if (first) { value = first.dataset.value; first.classList.add('is-selected'); labelHtml = first.innerHTML; }
  }
  dd.dataset.value = value;
  dd.querySelector('.stat-dd-value').innerHTML = labelHtml;
}

// Выбор опции пользователем → меняем фильтр и перерисовываем
function selectOption(dd, value) {
  setDropdownValue(dd, value);
  closeAllDropdowns();
  filters[dd.dataset.filter] = dd.dataset.value;
  page = 1;
  render();
}

// Наполняем все три списка. Боты — в порядке статусов (как в таблице),
// у удалённых добавляем «(удалён)»; у пар — иконки монет.
function populateFilters() {
  const botOpts = [{ value: '', label: 'Все боты' }].concat(
    data.bots.map(b => ({
      value: b.id,
      label: escapeHtml(b.name + (b.status === 'deleted' ? ' (удалён)' : '')),
    }))
  );
  const typeOpts = [{ value: '', label: 'Все типы' }].concat(
    [...new Set(data.bots.map(b => b.type))].map(t => ({ value: t, label: escapeHtml(t) }))
  );
  const pairOpts = [{ value: '', label: 'Все пары' }].concat(
    [...new Set(data.bots.map(b => b.pair))].map(p => ({ value: p, label: pairHtml(p) }))
  );

  // Текущее значение сохраняем, если оно ещё валидно; иначе откат на «Все …»
  fillDropdown(ddByFilter('bot'),  botOpts,  botOpts.some(o => o.value === filters.bot)   ? filters.bot  : '');
  fillDropdown(ddByFilter('type'), typeOpts, typeOpts.some(o => o.value === filters.type) ? filters.type : '');
  fillDropdown(ddByFilter('pair'), pairOpts, pairOpts.some(o => o.value === filters.pair) ? filters.pair : '');

  // Синхронизируем filters с фактически выставленными значениями
  filters.bot  = ddByFilter('bot').dataset.value;
  filters.type = ddByFilter('type').dataset.value;
  filters.pair = ddByFilter('pair').dataset.value;
}

function filteredBots() {
  return data.bots.filter(b =>
    (!filters.bot  || b.id   === filters.bot) &&
    (!filters.type || b.type === filters.type) &&
    (!filters.pair || b.pair === filters.pair));
}

function filteredTrades() {
  return data.trades.filter(t =>
    (!filters.bot  || t.botId === filters.bot) &&
    (!filters.type || t.type  === filters.type) &&
    (!filters.pair || t.pair  === filters.pair));
}

// Сброс фильтров: чистим выбор, прокручиваем иконку и обновляем данные.
// Троттлинг: повторное нажатие игнорируется, пока идёт анимация/запрос (700 мс).
let resetBusy = false;
function onReset() {
  if (resetBusy) return;
  resetBusy = true;

  const btn = $('filter-reset');
  btn.classList.add('is-spinning');
  btn.disabled = true;

  filters = { bot: '', type: '', pair: '' };
  document.querySelectorAll('.stat-dd').forEach(dd => setDropdownValue(dd, ''));
  closeAllDropdowns();
  page = 1;
  render();
  live.refreshNow();                  // заодно подтягиваем свежие данные

  setTimeout(() => {
    btn.classList.remove('is-spinning');
    btn.disabled = false;
    resetBusy = false;
  }, 800);   // 800 мс = один полный оборот иконки (как у «Обновить баланс»)
}


// ВКЛАДКИ
function setupTabs() {
  document.querySelectorAll('.stat-tab').forEach(tab =>
    tab.addEventListener('click', () => {
      if (tab.classList.contains('is-active')) return;
      document.querySelectorAll('.stat-tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      currentTab = tab.dataset.tab;
      page = 1;
      render();
    })
  );
}


// СОСТОЯНИЯ ПАНЕЛИ
function showLoading() {
  $('stat-loading').hidden = false;
  $('stat-error').hidden   = true;
  $('stat-empty').hidden   = true;
  elTableWrap.hidden = true;
  elPager.hidden     = true;
}
function showError() {
  $('stat-loading').hidden = true;
  $('stat-error').hidden   = false;
  $('stat-empty').hidden   = true;
  elTableWrap.hidden = true;
  elPager.hidden     = true;
}
function showEmpty() {
  elTableWrap.hidden = true;
  elPager.hidden     = true;
  $('stat-loading').hidden = true;
  $('stat-error').hidden   = true;

  const anyData  = data.bots.length > 0 || data.trades.length > 0;
  const filtered = filters.bot || filters.type || filters.pair;
  $('stat-empty-text').textContent = !anyData
    ? 'Здесь появится статистика после первых сделок ваших ботов.'
    : filtered
      ? 'Нет данных по выбранным фильтрам.'
      : (currentTab === 'bots' ? 'У вас пока нет ботов.' : 'Пока нет ни одной сделки.');
  $('stat-empty').hidden = false;
}
function hideStates() {
  $('stat-loading').hidden = true;
  $('stat-error').hidden   = true;
  $('stat-empty').hidden   = true;
}


// ФОРМАТИРОВАНИЕ И ЯЧЕЙКИ

// Число с разделителем тысяч (тонкий пробел) и минусом «−». Хвостовые нули
// обрезаются, но не меньше minDec знаков после запятой.
function fmtNum(x, minDec = 2, maxDec = 6) {
  const n = Number.isFinite(+x) ? +x : 0;
  const neg = n < 0;
  let [int, dec = ''] = Math.abs(n).toFixed(maxDec).split('.');
  dec = dec.replace(/0+$/, '');
  if (dec.length < minDec) dec = dec.padEnd(minDec, '0');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '−' : '') + int + (dec ? '.' + dec : '');
}

// Денежная ячейка со знаком и цветом (PnL / чистая прибыль)
function moneyCell(x) {
  const n = +x || 0;
  const cls = n > 1e-9 ? 'money-pos' : n < -1e-9 ? 'money-neg' : 'money-zero';
  const sign = n > 1e-9 ? '+' : '';                      // минус добавит fmtNum
  return `<span class="${cls}">${sign}${fmtNum(n)}</span>`;
}

// Комиссия — всегда издержка: янтарным, без знака
function feeCell(x) {
  const n = +x || 0;
  return n > 1e-9
    ? `<span class="money-fee">${fmtNum(n)}</span>`
    : `<span class="money-zero">${fmtNum(0)}</span>`;
}

// Значение в карточке-итоге: signed → знак и цвет, иначе нейтрально
function paintMoney(el, x, signed) {
  const n = +x || 0;
  el.classList.remove('val-pos', 'val-neg', 'val-zero');
  if (signed) {
    el.classList.add(n > 1e-9 ? 'val-pos' : n < -1e-9 ? 'val-neg' : 'val-zero');
    el.textContent = (n > 1e-9 ? '+' : '') + fmtNum(n) + ' USDT';
  } else {
    el.textContent = fmtNum(n) + ' USDT';
  }
}

// Идентификатор: моноширинно, выводим первые 8 символов; полное значение — в title
function idCell(id) {
  if (!id) return '<span class="money-zero">—</span>';
  const s = String(id);
  return `<span title="${escapeHtml(s)}">${escapeHtml(s.slice(0, 8))}</span>`;
}

// Торговая пара: иконки монет + код в одну строку (компактно). Используется
// и в таблице, и в опциях фильтра «Торговая пара».
function pairHtml(pair) {
  if (pair === 'CITRO/USDT') {
    return `<span class="stat-pair">`
         + `<img class="stat-coin" src="${COIN_ICON.CITRO}" alt="" />`
         + `<img class="stat-coin" src="${COIN_ICON.USDT}" alt="" />CITRO/USDT</span>`;
  }
  return `<span class="stat-pair">${escapeHtml(pair || '—')}</span>`;
}

function statusBadge(status) {
  const s = STATUS_LABEL[status] || STATUS_LABEL.inactive;
  return `<span class="status-badge status-badge--${s.cls}">${s.label}</span>`;
}

function sideTag(side) {
  return side === 'sell'
    ? '<span class="stat-side stat-side--sell">Продажа</span>'
    : '<span class="stat-side stat-side--buy">Покупка</span>';
}

// Дата исполнения: ДД.ММ.ГГГГ ЧЧ:ММ:СС по Московскому времени (Europe/Moscow,
// UTC+3, без перехода на летнее время). Часовой пояс фиксируем всегда — не зависит
// от настроек устройства пользователя; отдельной подписи «МСК» не показываем.
const MSK_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',   // 00–23 (не «24:00» в полночь)
});
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = {};
  for (const part of MSK_FMT.formatToParts(d)) p[part.type] = part.value;
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

// Профиль в шапке (fillProfile) и выход (logout) — общие хелперы из common.js.
