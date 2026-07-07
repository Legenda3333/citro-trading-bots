//  ЕДИНЫЙ СЛОВАРЬ ТЕКСТОВ ОШИБОК ВАЛИДАЦИИ
//  Подключается на всех страницах ДО их скриптов.
//  Источник истины для текстов ошибок — здесь, чтобы одни и те же
//  ошибки выводились одинаково на всех страницах.
//
//  НЕ здесь (осознанно):
//   • тексты длины (для каждого поля свои: логин 4–30, пароль 8–32);
//   • динамический минимум депозита (зависит от валюты и числа сеток);
//   • «Названия ключей не должны повторяться» (завязано на текст сервера);
//   • серверные и сетевые сообщения.
window.ERR = {
  required:           'Поле обязательно для заполнения',
  latinDigits:        'Допускаются только латинские буквы и цифры',
  latinDigitsDash:    'Допускаются только латинские буквы, цифры и знак «-»',
  latinDigitsSpecial: 'Допускаются только латинские буквы, цифры и специальные символы',
  onlyNumbers:        'Поле принимает только числовые значения',
  onlyIntegers:       'Поле принимает только целые числа',
  invalidValue:       'Недопустимое значение',
  positive:           'Значение должно быть больше нуля',
  passwordsMismatch:  'Пароли не совпадают',
  upperGreaterLower:  'Верхняя граница должна быть больше нижней',
  exceedsBalance:     'Введённое значение превышает доступный баланс',
  tooSmallStep:       'Слишком маленький шаг сетки: увеличьте диапазон или сократите количество сеток',
  keyInUse:           'Вы не можете удалить этот ключ, так как он используется одним из ваших ботов',
  botNameDuplicate:   'Названия ботов не должны повторяться',

  // Динамические — диапазон целого числа
  range: (min, max) => `Введите число от ${min} до ${max}`,
};


//  ДОСТУПНОСТЬ: синхронизация aria-invalid с текстом ошибки
//  Для каждого поля с aria-describedby следим за связанными блоками
//  ошибок и проставляем на поле aria-invalid="true|false".
//  role="alert" на самих блоках задаётся в разметке (или в auth — в JS),
//  чтобы скринридер озвучивал сообщение при появлении.
//  Можно вызывать повторно — на уже обработанных полях стоит data-a11y.
window.setupFieldA11y = function setupFieldA11y() {
  document.querySelectorAll('[aria-describedby]').forEach(input => {
    if (input.dataset.a11y) return;          // уже подключено
    const errEls = input.getAttribute('aria-describedby')
      .split(/\s+/)
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (!errEls.length) return;

    const sync = () => {
      const hasError = errEls.some(el => el.textContent.trim());
      input.setAttribute('aria-invalid', hasError ? 'true' : 'false');
    };

    sync();
    errEls.forEach(el =>
      new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true })
    );
    input.dataset.a11y = '1';
  });
};
