//  ПРАВИЛА ВАЛИДАЦИИ
//  Логин:  [a-zA-Z0-9], 4–30 символов
//  Пароль: печатаемые ASCII без пробела (\x21–\x7E), 8–32 символа
const LOGIN_RE    = /^[a-zA-Z0-9]+$/;
const PASSWORD_RE = /^[\x21-\x7E]+$/;

// Флаг активной отправки — защита от двойного сабмита (в т.ч. по Enter)
let isSubmitting = false;


// ОШИБКИ ПОД КОНКРЕТНЫМ ПОЛЕМ
// field = 'login' | 'password' | 'confirm'

function showFieldError(formId, field, message) {
  const form  = document.getElementById(formId);
  const group = form.querySelector(`[data-field="${field}"]`);
  if (!group) return;
  const span  = group.querySelector('.field-error');
  const input = group.querySelector('.field-input');
  if (!span)  return;
  span.textContent = message;
  if (input) input.classList.add('is-invalid');
}

function clearFieldError(formId, field) {
  const form  = document.getElementById(formId);
  const group = form.querySelector(`[data-field="${field}"]`);
  if (!group) return;
  const span  = group.querySelector('.field-error');
  const input = group.querySelector('.field-input');
  if (!span)  return;
  span.textContent   = '';
  if (input) input.classList.remove('is-invalid');
}

function clearAllErrors(formId) {
  const form = document.getElementById(formId);
  // Сбрасываем признак «парной» ошибки (неверная пара логин/пароль,
  // несовпадение паролей), чтобы он не пережил очистку формы
  delete form.dataset.pairError;
  form.querySelectorAll('.field-error')
    .forEach(el => { el.textContent = ''; });
  form.querySelectorAll('.field-input')
    .forEach(el => el.classList.remove('is-invalid'));
}

// Подсвечивает поле красным без отображения текста ошибки.
// Используется когда ошибка относится к нескольким полям сразу.
function markFieldInvalid(formId, field) {
  const form  = document.getElementById(formId);
  const group = form.querySelector(`[data-field="${field}"]`);
  const input = group?.querySelector('.field-input');
  if (input) input.classList.add('is-invalid');
}


// ЖИВОЕ СНЯТИЕ ОШИБОК ПРИ ВВОДЕ
// Как только пользователь начал править поле, ошибка этого поля исчезает.
// Если активна «парная» ошибка (неверная пара логин/пароль или несовпадение
// паролей) — снимаем подсветку и текст со всех полей формы, т.к. ошибка
// относилась сразу к двум полям.
function setupLiveValidation() {
  attachLiveClear('loginForm',    ['login', 'password']);
  attachLiveClear('registerForm', ['login', 'password', 'confirm']);
}

function attachLiveClear(formId, fields) {
  const form = document.getElementById(formId);
  if (!form) return;
  fields.forEach(field => {
    const input = form.querySelector(`[data-field="${field}"] input`);
    if (!input) return;
    input.addEventListener('input', () => {
      if (form.dataset.pairError) {
        // Парная ошибка охватывает оба поля — снимаем со всей формы
        // (clearAllErrors заодно удаляет сам признак pairError)
        clearAllErrors(formId);
      } else {
        clearFieldError(formId, field);
      }
    });
  });
}


// СБРОС ФОРМЫ
function resetForm(formId) {
  const form = document.getElementById(formId);

  form.querySelectorAll('input').forEach(input => {
    input.value = '';
    if (input.closest('.input-wrapper')) input.type = 'password';
  });

  form.querySelectorAll('.toggle-pw').forEach(btn => {
    btn.querySelector('.eye-open').style.display  = 'none';
    btn.querySelector('.eye-closed').style.display = 'block';
    btn.setAttribute('aria-label', 'Показать пароль');
  });

  clearAllErrors(formId);
}


// ПЕРЕКЛЮЧЕНИЕ ФОРМ
function showRegister() {
  resetForm('loginForm');
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('registerForm').classList.remove('hidden');
}

function showLogin() {
  resetForm('registerForm');
  document.getElementById('registerForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
}


// НАЖАТИЕ ENTER: запускает активную форму
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (isSubmitting) return; // запрос уже идёт — не дублируем
  const loginShown    = !document.getElementById('loginForm').classList.contains('hidden');
  const registerShown = !document.getElementById('registerForm').classList.contains('hidden');
  if (loginShown)    handleLogin();
  if (registerShown) handleRegister();
});


// ДОСТУПНОСТЬ + ЛИМИТ ДЛИНЫ
// Разметка обеих форм одинакова (одинаковые data-field), поэтому id блокам
// ошибок, связь aria-describedby и абсолютный maxlength проставляем из JS,
// чтобы не плодить одинаковые id в HTML.
function setupAuthA11y() {
  ['loginForm', 'registerForm'].forEach(formId => {
    const form = document.getElementById(formId);
    if (!form) return;
    form.querySelectorAll('.field-group[data-field]').forEach(group => {
      const field = group.dataset.field;
      const input = group.querySelector('.field-input');
      const span  = group.querySelector('.field-error');
      if (input) input.setAttribute('maxlength', '128');
      if (input && span) {
        const id = `${formId}-${field}-error`;
        span.id = id;
        span.setAttribute('role', 'alert');
        input.setAttribute('aria-describedby', id);
      }
    });
  });
  setupFieldA11y(); // включаем авто-aria-invalid
}


// Навешиваем обработчики кнопок вместо inline onclick (нужно для строгого CSP)
function wireAuthButtons() {
  document.querySelectorAll('.toggle-pw').forEach(btn =>
    btn.addEventListener('click', () => togglePassword(btn)));

  const lf = document.getElementById('loginForm');
  if (lf) {
    lf.querySelector('.btn-primary')?.addEventListener('click', handleLogin);
    lf.querySelector('.btn-secondary')?.addEventListener('click', showRegister);
  }
  const rf = document.getElementById('registerForm');
  if (rf) {
    rf.querySelector('.btn-primary')?.addEventListener('click', handleRegister);
    rf.querySelector('.btn-secondary')?.addEventListener('click', showLogin);
  }
}

// Подключаем живое снятие ошибок, доступность и обработчики кнопок
setupLiveValidation();
setupAuthA11y();
wireAuthButtons();


// ПЕРЕХОД НА ГЛАВНЫЙ ЭКРАН
function goToMain() {
  window.location.href = 'main/index.html';
}


//  ПРЕДЗАГРУЗКА API-КЛЮЧЕЙ
//  Вызывается сразу после успешного входа/регистрации.
//  Кладёт список ключей в localStorage — тот же кэш,
//  который читает страница создания бота.
//  Если запрос не удался — молча продолжаем (ключи можно
//  добавить позже, редирект не блокируем).
async function prefetchApiKeys(token) {
  try {
    const res = await fetch('/api/keys/list', {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (!res.ok) return;

    const { keys } = await res.json();

    // Сохраняем в тот же кэш, что читает страница API-ключей (makeCache — из common.js)
    makeCache('apiKeys').write(keys || []);
  } catch {
    // Ошибка сети или парсинга — не блокируем вход
  }
}


// ПЕРЕКЛЮЧЕНИЕ ВИДИМОСТИ ПАРОЛЯ
function togglePassword(btn) {
  const input  = btn.parentElement.querySelector('input');
  const hidden = input.type === 'password';

  input.type = hidden ? 'text' : 'password';
  btn.querySelector('.eye-open').style.display  = hidden ? 'block' : 'none';
  btn.querySelector('.eye-closed').style.display = hidden ? 'none'  : 'block';
  btn.setAttribute('aria-label', hidden ? 'Скрыть пароль' : 'Показать пароль');
}


// Проверяет формат логина и пароля (общая логика входа и регистрации).
// При ошибке показывает её под нужным полем и возвращает false.
function validateCredentials(formId, login, password) {
  if (!login) {
    showFieldError(formId, 'login', ERR.required);
    return false;
  }
  if (login.length < 4 || login.length > 30) {
    showFieldError(formId, 'login', 'Длина логина должна быть от 4 до 30 символов');
    return false;
  }
  if (!LOGIN_RE.test(login)) {
    showFieldError(formId, 'login', ERR.latinDigits);
    return false;
  }
  if (!password) {
    showFieldError(formId, 'password', ERR.required);
    return false;
  }
  if (password.length < 8 || password.length > 32) {
    showFieldError(formId, 'password', 'Длина пароля должна быть от 8 до 32 символов');
    return false;
  }
  if (!PASSWORD_RE.test(password)) {
    showFieldError(formId, 'password', ERR.latinDigitsSpecial);
    return false;
  }
  return true;
}


//  ВХОД
async function handleLogin() {
  if (isSubmitting) return; // защита от повторной отправки
  const form     = document.getElementById('loginForm');
  const login    = form.querySelector('[data-field="login"] input').value.trim();
  const password = form.querySelector('[data-field="password"] input').value;

  clearAllErrors('loginForm');

  // Валидация логина и пароля (общий помощник)
  if (!validateCredentials('loginForm', login, password)) return;

  const rememberMe = document.getElementById('rememberMe')?.checked ?? false;

  const btn = form.querySelector('.btn-primary');
  isSubmitting    = true;
  btn.disabled    = true;
  btn.textContent = 'Вход...';

  try {
    const res  = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ login, password, rememberMe })
    });
    const data = await res.json();

    if (!res.ok) {
      // Превышен лимит попыток — сообщение под полем пароля, без «парной» подсветки
      if (data.code === 'too_many_attempts') {
        showFieldError('loginForm', 'password', data.error || 'Превышено количество попыток входа в аккаунт, попробуйте позже');
        return;
      }
      // "Неверный логин или пароль" — показываем под полем пароля, красним оба поля
      showFieldError('loginForm', 'password', data.error || 'Ошибка входа');
      markFieldInvalid('loginForm', 'login');
      form.dataset.pairError = 'credentials'; // ошибка относится к обоим полям
      return;
    }

    localStorage.setItem('token',    data.token);
    localStorage.setItem('username', data.username);

    // Загружаем ключи в фоне до перехода, чтобы выпадашка на странице
    // создания бота была заполнена даже без посещения страницы API-ключей
    await prefetchApiKeys(data.token);

    goToMain();

  } catch (e) {
    showFieldError('loginForm', 'password', 'Нет соединения с сервером');
  } finally {
    isSubmitting    = false;
    btn.disabled    = false;
    btn.textContent = 'Войти';
  }
}


//  РЕГИСТРАЦИЯ
async function handleRegister() {
  if (isSubmitting) return; // защита от повторной отправки
  const form     = document.getElementById('registerForm');
  const login    = form.querySelector('[data-field="login"] input').value.trim();
  const password = form.querySelector('[data-field="password"] input').value;
  const confirm  = form.querySelector('[data-field="confirm"] input').value;

  clearAllErrors('registerForm');

  // Валидация логина и пароля (общий помощник)
  if (!validateCredentials('registerForm', login, password)) return;

  // Подтверждение пароля
  if (!confirm) {
    showFieldError('registerForm', 'confirm', ERR.required);
    return;
  }
  if (password !== confirm) {
    showFieldError('registerForm', 'confirm', ERR.passwordsMismatch);
    markFieldInvalid('registerForm', 'password');
    form.dataset.pairError = 'mismatch'; // ошибка относится к обоим полям пароля
    return;
  }

  const btn = form.querySelector('.btn-primary');
  isSubmitting    = true;
  btn.disabled    = true;
  btn.textContent = 'Регистрация...';

  try {
    const res  = await fetch('/api/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ login, password })
    });
    const data = await res.json();

    if (!res.ok) {
      // Сервер возвращает field: 'login' | 'password' — показываем под нужным полем
      showFieldError('registerForm',
        data.field || 'password',
        data.error  || 'Ошибка регистрации'
      );
      return;
    }

    localStorage.setItem('token',    data.token);
    localStorage.setItem('username', data.username);

    // Аналогично входу — предзагружаем ключи сразу после регистрации
    await prefetchApiKeys(data.token);

    goToMain();

  } catch (e) {
    showFieldError('registerForm', 'password', 'Нет соединения с сервером');
  } finally {
    isSubmitting    = false;
    btn.disabled    = false;
    btn.textContent = 'Зарегистрироваться';
  }
}
