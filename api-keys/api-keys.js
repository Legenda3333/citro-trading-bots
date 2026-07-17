// Ключ, который редактируется в данный момент (null = режим добавления)
let editingKey = null;

// Активна ли серверная ошибка по паре «ключ + секрет» (например «ключ неверен»
// или «такой ключ уже добавлен»). Снимается при правке любого из ключевых полей.
// Отдельный флаг нужен, потому что элемент api-secret-error используется и для
// серверной, и для charset-ошибки — без флага одна затирала бы другую.
let keyServerError = false;

// ТОЧКА ВХОДА
document.addEventListener('DOMContentLoaded', () => {
  setupModal();
  setupValidation();
  setupSecretToggle();
  setupDeleteModal();
  setupSmartTooltips();
  setupCardActions();   // делегирование кликов по кнопкам «Редактировать»/«Удалить»
  live.start();
  fillProfile();        // профиль (ник + ID) — общий хелпер из common.js
  document.querySelector('.logout-btn')?.addEventListener('click', logout);
  setupFieldA11y();     // авто-aria-invalid по aria-describedby
});


// ДЕЛЕГИРОВАНИЕ КЛИКОВ ПО КНОПКАМ КЛЮЧЕЙ
// Кнопки рисуются через innerHTML, поэтому ловим клик на контейнере
// (вместо inline onclick — чтобы работал строгий CSP без 'unsafe-inline').
function setupCardActions() {
  const container = document.getElementById('keys-cards');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const keyId = btn.dataset.keyId;
    if (btn.dataset.action === 'edit')   openEditModal(keyId);
    if (btn.dataset.action === 'delete') openDeleteModal(keyId);
  });
}


// Профиль в шапке (fillProfile) и выход (logout) — общие хелперы из common.js.


// МОДАЛЬНОЕ ОКНО
// Открывается по кнопке, закрывается по:
//   - кнопке X внутри модала
//   - кнопке "Отмена"
function setupModal() {
  const overlay   = document.getElementById('modal-overlay');
  const openBtn   = document.getElementById('open-modal-btn');
  const openBtn2  = document.getElementById('open-modal-btn-2'); // кнопка в шапке списка
  const closeBtn  = document.getElementById('modal-close-btn');
  const cancelBtn = document.getElementById('modal-cancel-btn');
  const saveBtn   = document.querySelector('.btn-save');

  // Открыть (обе кнопки)
  openBtn.addEventListener('click', () => openAddModal());
  if (openBtn2) openBtn2.addEventListener('click', () => openAddModal());

  // Закрыть по X
  closeBtn.addEventListener('click', () => closeModal());

  // Закрыть по "Отмена"
  cancelBtn.addEventListener('click', () => closeModal());

  // Сохранить
  saveBtn.addEventListener('click', () => saveKey());
}

// Открытие окна в режиме ДОБАВЛЕНИЯ: чистые поля + заголовок «Добавить».
function openAddModal() {
  resetForm();
  document.getElementById('modal-title').textContent    = 'Добавить новый API ключ';
  document.getElementById('modal-save-btn').textContent = 'Сохранить';
  openModal();
}

function openModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');

  // Ставим фокус на первое поле для ввода (UX)
  setTimeout(() => {
    document.getElementById('key-name').focus();
  }, 80);
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');

  // Сбрасываем поля и ошибки при закрытии
  resetForm();
}

function resetForm() {
  // Сбрасываем режим редактирования
  editingKey = null;
  keyServerError = false;

  // Очищаем все редактируемые поля
  ['key-name', 'api-key-val', 'api-secret'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Скрываем все сообщения об ошибках и снимаем красную подсветку
  ['key-name-error', 'api-key-error', 'api-secret-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });

  ['key-name', 'api-key-val', 'api-secret'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('is-invalid');
  });

  // Скрываем поле пароля (если было открыто)
  const secret = document.getElementById('api-secret');
  if (secret) secret.type = 'password';

  // Возвращаем иконку в исходное состояние: глаз закрыт (пароль скрыт)
  const eyeOpen = document.querySelector('.eye-open');
  const eyeOff  = document.querySelector('.eye-off');
  if (eyeOpen) eyeOpen.style.display = 'none';
  if (eyeOff)  eyeOff.style.display  = '';

  // Обновляем состояние кнопки "Сохранить"
  updateSaveBtn();
}


// ПОКАЗАТЬ / СКРЫТЬ СЕКРЕТНЫЙ КЛЮЧ
function setupSecretToggle() {
  const toggleBtn = document.getElementById('toggle-secret');
  const input     = document.getElementById('api-secret');
  const eyeOpen   = toggleBtn.querySelector('.eye-open');
  const eyeOff    = toggleBtn.querySelector('.eye-off');

  toggleBtn.addEventListener('click', () => {
    const isHidden = input.type === 'password';

    // Переключаем тип поля
    input.type = isHidden ? 'text' : 'password';

    // Если было скрыто → показываем открытый глаз (контент виден)
    // Если было открыто → показываем закрытый глаз (контент скрыт)
    eyeOpen.style.display = isHidden ? ''     : 'none';
    eyeOff.style.display  = isHidden ? 'none' : '';
  });
}


// ВАЛИДАЦИЯ ПОЛЕЙ
function setupValidation() {
  // Название ключа — любые символы, только проверяем непустоту
  setupNameField('key-name', 'key-name-error');

  // Публичный ключ — латиница, цифры и знак «-»
  setupApiField('api-key-val', 'api-key-error', { allowDash: true });
  // Секретная часть — только латиница и цифры (без «-»)
  setupApiField('api-secret',  'api-secret-error', { allowDash: false });

  // Серверную ошибку пары «ключ + секрет» при правке любого из полей снимает
  // сам setupApiField через clearKeyServerError(). Отдельного слушателя нет
  // намеренно: он затирал бы charset-ошибку (оба сообщения живут в api-secret-error).
}

// Валидация поля названия: любые символы, только проверяем что не пусто
function setupNameField(inputId, errorId) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (!input || !error) return;

  input.addEventListener('input', () => {
    // Любая ошибка имени (дубликат, формат с сервера) снимается при правке
    input.classList.remove('is-invalid');
    error.textContent = '';
    updateSaveBtn();
  });

  input.addEventListener('blur', () => {
    if (!input.value.trim() && error.textContent === '') {
      error.textContent = ERR.required;
      input.classList.add('is-invalid');
    }
    updateSaveBtn();
  });

  input.addEventListener('focus', () => {
    if (error.textContent === ERR.required) {
      error.textContent = '';
      input.classList.remove('is-invalid');
    }
  });
}

// Валидация поля ключа. Недопустимые символы НЕ вырезаются — вместо этого
// показывается ошибка (единая модель «показать ошибку, не исправлять»).
// allowDash: true  → публичный ключ (латиница, цифры и знак «-»)
// allowDash: false → секретная часть (только латиница и цифры)
function setupApiField(inputId, errorId, { allowDash = false } = {}) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (!input || !error) return;

  const validRe = allowDash ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z0-9]+$/;
  const charMsg = allowDash ? ERR.latinDigitsDash : ERR.latinDigits;

  input.addEventListener('input', () => {
    // Правка ключевого поля снимает серверную ошибку пары ключ/секрет
    clearKeyServerError();

    if (input.value && !validRe.test(input.value)) {
      // В поле есть недопустимый символ — показываем ошибку, ввод не трогаем
      error.textContent = charMsg;
      input.classList.add('is-invalid');
    } else if (error.textContent === charMsg) {
      // Поле снова валидно — снимаем именно charset-ошибку
      error.textContent = '';
      input.classList.remove('is-invalid');
    }

    updateSaveBtn();
  });

  input.addEventListener('blur', () => {
    if (!input.value && error.textContent === '') {
      error.textContent = ERR.required;
      input.classList.add('is-invalid');
    }
    updateSaveBtn();
  });

  input.addEventListener('focus', () => {
    if (error.textContent === ERR.required) {
      error.textContent = '';
      input.classList.remove('is-invalid');
    }
  });
}

// Снимает серверную ошибку пары «ключ + секрет» (если она активна):
// очищает сообщение под секретом и красную рамку с обоих ключевых полей.
function clearKeyServerError() {
  if (!keyServerError) return;
  keyServerError = false;
  document.getElementById('api-key-val').classList.remove('is-invalid');
  document.getElementById('api-secret').classList.remove('is-invalid');
  document.getElementById('api-secret-error').textContent = '';
}


// СОСТОЯНИЕ КНОПКИ "СОХРАНИТЬ"
// Активна только когда все три поля заполнены и без ошибок
function updateSaveBtn() {
  const saveBtn = document.querySelector('.btn-save');
  if (!saveBtn) return;

  const nameVal   = document.getElementById('key-name').value.trim();
  const apiKeyVal = document.getElementById('api-key-val').value.trim();
  const secretVal = document.getElementById('api-secret').value.trim();

  const allFilled = nameVal && apiKeyVal && secretVal;

  const hasErrors = ['key-name-error', 'api-key-error', 'api-secret-error'].some(id => {
    const el = document.getElementById(id);
    return el && el.textContent.trim().length > 0;
  });

  let shouldEnable = allFilled && !hasErrors;

  // В режиме редактирования кнопка активна только если данные изменились
  if (editingKey) {
    const changed = nameVal !== editingKey.name
      || apiKeyVal !== editingKey.api_key
      || secretVal.length > 0;
    shouldEnable = shouldEnable && changed;
  }

  saveBtn.disabled = !shouldEnable;
}


// КЭШ КЛЮЧЕЙ В localStorage
// Ключ кэша привязан к userId — если зайдёт
// другой пользователь, он не увидит чужие данные
const keysCache = makeCache('apiKeys');        // фабрика кэша — из common.js
function readCache()      { return keysCache.read(); }
function writeCache(keys) { keysCache.write(keys); }


// ЗАГРУЗКА КЛЮЧЕЙ (fetch-first)
// При заходе грузим СВЕЖИЙ список и рисуем его — старый кэш как актуальный НЕ рисуем.
// Кэш остаётся офлайн-резервом. БРОСАЕТ при неудаче: живой обновлятель (common.js)
// повторит, поэтому страница не замирает на старых данных.
async function loadKeys() {
  try {
    const { keys } = await apiGet('/api/keys/list');
    const fresh = keys || [];
    writeCache(fresh);      // кэш обновляем всегда: он офлайн-резерв и его читают другие страницы
    showKeys(fresh);
  } catch (e) {
    if (!rendered) showKeys(readCache() || []);   // показать ещё нечего → офлайн-резерв
    throw e;   // обновлятелю: не получилось — повтори
  }
}

// Рисует список, только если он отличается от УЖЕ НАРИСОВАННОГО в ЭТОЙ вкладке.
// ВАЖНО: сравнивать со свежими данными нужно именно нарисованное, а НЕ кэш. Кэш общий
// на все вкладки: удалив ключ в соседней вкладке, мы бы поправили общий кэш, и эта
// вкладка решила бы «ничего не изменилось» — оставив на экране удалённый ключ.
let rendered = null;   // копия того, что реально нарисовано в этой вкладке
function showKeys(keys) {
  if (rendered && JSON.stringify(keys) === JSON.stringify(rendered)) return;
  rendered = keys;
  renderKeys(keys);
}

// Ответы add/update отдают сырую строку БД (+ подсказку): в ней есть лишние user_id и
// api_secret_encrypted и НЕТ in_use. Приводим к той же форме (и тому же порядку полей),
// что отдаёт список, — чтобы в localStorage не лежало лишнее, чтобы не терялся in_use
// и чтобы записи везде сравнивались одинаково.
function toListShape(key, inUse) {
  return {
    id:          key.id,
    name:        key.name,
    api_key:     key.api_key,
    exchange:    key.exchange,
    created_at:  key.created_at,
    secret_hint: key.secret_hint,
    in_use:      !!inUse,
  };
}

// Живое обновление: сразу при заходе и при каждом возвращении (вкладка снова видима,
// фокус окна, «назад» из bfcache, вернулась сеть), далее раз в минуту, пока страница
// видима; после сбоя — быстрый повтор. См. common.js.
// Опрос здесь по большей части подстраховка: флаг in_use меняется только от действий
// пользователя на других страницах (создание/удаление бота), а туда-обратно ходят через
// события выше. Но он закрывает случай двух окон рядом, когда фокус не менялся, —
// поэтому поведение у всех страниц одинаковое.
const live = makeLiveRefresher(loadKeys);


// РЕНДЕР КАРТОЧЕК КЛЮЧЕЙ
// Переключает между пустым состоянием и списком
function renderKeys(keys) {
  const loadingEl = document.getElementById('keys-loading');
  if (loadingEl) loadingEl.style.display = 'none';   // прячем индикатор загрузки
  const emptyEl = document.getElementById('keys-empty');
  const listEl  = document.getElementById('keys-list');
  const cardsEl = document.getElementById('keys-cards');
  const countEl = document.getElementById('keys-count');

  if (!keys || keys.length === 0) {
    emptyEl.style.display = '';
    listEl.style.display  = 'none';
    return;
  }

  // Скрываем пустое состояние, показываем список
  emptyEl.style.display = 'none';
  listEl.style.display  = '';

  // Счётчик ключей
  countEl.textContent = 'Мои ключи (' + keys.length + ')';

  cardsEl.innerHTML = keys.map(key => {
    // Дата создания
    const d     = new Date(key.created_at);
    const day   = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year  = String(d.getFullYear()).slice(-2);
    const date  = `${day}.${month}.${year}`;


    return `
      <div class="key-card">

        <div class="key-card-logo">
          <img src="https://citronus.com/favicon.svg" alt="Citronus" />
        </div>

        <div class="key-card-body">
          <p class="key-card-name">${escapeHtml(key.name)}</p>

          <!-- Уровень 2: метки | Уровень 3: значения — единая сетка -->
          <div class="key-card-grid">
            <span class="key-card-label">Ключ</span>
            <span class="key-card-label">Секрет</span>
            <span class="key-card-public">${escapeHtml(key.api_key)}</span>
            <span class="key-card-secret">${escapeHtml(key.secret_hint || '••••••••••••')}</span>
          </div>

          <p class="key-card-date">Добавлен ${date}</p>
        </div>

        <div class="key-card-actions">
          <button class="key-btn key-btn--edit" data-action="edit" data-key-id="${escapeHtml(key.id)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
            Редактировать
          </button>
          <button class="key-btn key-btn--delete" data-action="delete" data-key-id="${escapeHtml(key.id)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            Удалить
          </button>
        </div>

      </div>
    `;
  }).join('');
}

// Умное позиционирование тултипов (setupSmartTooltips) — общий помощник из common.js.


// ДИСПЕТЧЕР КНОПКИ СОХРАНЕНИЯ
// Решает: добавить новый ключ или обновить существующий
async function saveKey() {
  if (editingKey) {
    await updateKey();
  } else {
    await addKey();
  }
}


// ДОБАВЛЕНИЕ НОВОГО КЛЮЧА — POST /api/keys/add
async function addKey() {
  const saveBtn   = document.getElementById('modal-save-btn');
  const token     = localStorage.getItem('token');
  const name      = document.getElementById('key-name').value.trim();
  const apiKey    = document.getElementById('api-key-val').value.trim();
  const apiSecret = document.getElementById('api-secret').value.trim();

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Сохранение...';

  try {
    const res  = await fetch('/api/keys/add', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ name, apiKey, apiSecret })
    });
    const data = await res.json();

    if (!res.ok) {
      showModalError(data);
      return;
    }

    const cached = readCache() || [];
    cached.unshift(toListShape(data.key, false));   // новый ключ ботами ещё не занят
    writeCache(cached);
    closeModal();
    showKeys(cached);

  } catch {
    document.getElementById('api-secret-error').textContent = 'Нет соединения с сервером';
    keyServerError = true;
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Сохранить';
    updateSaveBtn();
  }
}


// ОБНОВЛЕНИЕ СУЩЕСТВУЮЩЕГО КЛЮЧА — PATCH /api/keys/update
async function updateKey() {
  const saveBtn   = document.getElementById('modal-save-btn');
  const token     = localStorage.getItem('token');
  const name      = document.getElementById('key-name').value.trim();
  const apiKey    = document.getElementById('api-key-val').value.trim();
  const apiSecret = document.getElementById('api-secret').value.trim();

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Сохранение...';

  try {
    const res  = await fetch('/api/keys/update', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ keyId: editingKey.id, name, apiKey, apiSecret })
    });
    const data = await res.json();

    if (!res.ok) {
      showModalError(data);
      return;
    }

    // Заменяем ключ в кэше (in_use правкой не меняется — сохраняем прежний)
    const cached = readCache() || [];
    const idx    = cached.findIndex(k => k.id === editingKey.id);
    if (idx !== -1) cached[idx] = toListShape(data.key, cached[idx].in_use);
    writeCache(cached);
    closeModal();
    showKeys(cached);

  } catch {
    document.getElementById('api-secret-error').textContent = 'Нет соединения с сервером';
    keyServerError = true;
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Внести изменения';
    updateSaveBtn();
  }
}


// Показывает ошибку сервера в нужном поле модала
function showModalError(data) {
  if (data.code === 'duplicate_name' ||
      (data.code === 'invalid_format' && data.field === 'name')) {
    // Ошибка относится к названию ключа
    document.getElementById('key-name').classList.add('is-invalid');
    document.getElementById('key-name-error').textContent = data.error || ERR.invalidValue;
  } else {
    // Дубликат/неверный/невалидный ключ или секрет — относится к паре:
    // показываем под секретом и красим оба ключевых поля
    document.getElementById('api-key-val').classList.add('is-invalid');
    document.getElementById('api-secret').classList.add('is-invalid');
    document.getElementById('api-secret-error').textContent = data.error || 'Ошибка сервера';
    keyServerError = true;
  }
}


// ОТКРЫТИЕ МОДАЛА В РЕЖИМЕ РЕДАКТИРОВАНИЯ
function openEditModal(keyId) {
  const cached = readCache() || [];
  const key    = cached.find(k => k.id === keyId);
  if (!key) return;

  // Запоминаем редактируемый ключ
  editingKey = key;

  // Меняем заголовок и кнопку
  document.getElementById('modal-title').textContent    = 'Редактирование API ключа';
  document.getElementById('modal-save-btn').textContent = 'Внести изменения';

  // Заполняем поля (секрет всегда пустой — пользователь вводит заново)
  document.getElementById('key-name').value    = key.name;
  document.getElementById('api-key-val').value = key.api_key;
  document.getElementById('api-secret').value  = '';

  openModal();
  updateSaveBtn();
}


// МОДАЛ УДАЛЕНИЯ
function setupDeleteModal() {
  const overlay   = document.getElementById('delete-modal-overlay');
  const closeBtn  = document.getElementById('delete-modal-close-btn');
  const cancelBtn = document.getElementById('delete-modal-cancel-btn');

  closeBtn.addEventListener('click',  () => closeDeleteModal());
  cancelBtn.addEventListener('click', () => closeDeleteModal());
}

function openDeleteModal(keyId) {
  const cached = readCache() || [];
  const key    = cached.find(k => k.id === keyId);
  if (!key) return;

  // Вставляем название ключа в текст подтверждения
  document.getElementById('delete-confirm-text').innerHTML =
    `Вы действительно хотите удалить ключ <strong>${escapeHtml(key.name)}</strong>?<br>
     Обратите внимание, что эта операция необратима.`;

  // Вешаем обработчик на кнопку подтверждения (сброс старого через замену) — resetButton из common.js
  const newBtn = resetButton('delete-modal-confirm-btn');
  newBtn.addEventListener('click', () => confirmDelete(keyId));

  // Ключ занят ботом — предупреждаем и блокируем удаление.
  // Источник истины — сервер (delete.js вернёт 409); здесь сразу гасим кнопку
  // по флагу in_use из кэша, чтобы не отправлять заведомо отклоняемый запрос.
  setKeyInUseState(!!key.in_use);

  const overlay = document.getElementById('delete-modal-overlay');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
}

// Показывает/прячет предупреждение «ключ занят ботом» и блокирует кнопку удаления
function setKeyInUseState(inUse) {
  const warning    = document.getElementById('delete-key-warning');
  const confirmBtn = document.getElementById('delete-modal-confirm-btn');
  if (warning) {
    warning.textContent = inUse ? ERR.keyInUse : '';
    warning.hidden      = !inUse;
  }
  if (confirmBtn) confirmBtn.disabled = inUse;
}

function closeDeleteModal() {
  const overlay = document.getElementById('delete-modal-overlay');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
}

async function confirmDelete(keyId) {
  const confirmBtn = document.getElementById('delete-modal-confirm-btn');
  const token      = localStorage.getItem('token');

  confirmBtn.disabled    = true;
  confirmBtn.textContent = 'Удаление...';

  try {
    const res = await fetch('/api/keys/delete', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ keyId })
    });

    if (!res.ok) {
      confirmBtn.textContent = 'Удалить ключ';

      // Кэш мог устареть: ключ заняли ботом уже после его загрузки.
      // Сервер вернул 409 — показываем предупреждение, блокируем кнопку
      // и обновляем флаг в кэше, чтобы дальше состояние было согласованным.
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.status === 409 && data.code === 'key_in_use') {
        setKeyInUseState(true);
        const cached = readCache() || [];
        const k = cached.find(x => x.id === keyId);
        if (k) { k.in_use = true; writeCache(cached); }
        return;
      }

      confirmBtn.disabled = false;
      return;
    }

    // Удаляем из кэша и перерисовываем
    const cached = (readCache() || []).filter(k => k.id !== keyId);
    writeCache(cached);
    closeDeleteModal();
    showKeys(cached);

  } catch {
    confirmBtn.disabled    = false;
    confirmBtn.textContent = 'Удалить ключ';
  }
}
