//  ГЛАВНАЯ: профиль (ник + ID), выход и переходы по карточкам.
//  Отдельный файл (а не инлайн-скрипт), чтобы CSP мог обойтись без 'unsafe-inline'.
//  Профиль/выход — общие хелперы из common.js (fillProfile / logout).

// Заполняем профиль в шапке (ник + ID)
fillProfile();

// Обработчики вместо inline onclick (нужно для строгого CSP)
(function () {
  document.querySelector('.logout-btn')?.addEventListener('click', logout);
  document.querySelectorAll('[data-nav="spot-grid"]').forEach(el =>
    el.addEventListener('click', () => { window.location.href = '/bots/spot-grid/'; }));
})();
