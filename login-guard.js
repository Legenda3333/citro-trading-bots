//  СТРАНИЦА ВХОДА. Если токен есть и НЕ просрочен — сразу на главную.
//  Отдельный файл (а не инлайн-скрипт), чтобы CSP мог обойтись без 'unsafe-inline'.
//  Грузится в <head> синхронно — редирект срабатывает ДО отрисовки формы.
(function () {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 > Date.now()) {
        window.location.replace('main/index.html');
      } else {
        // Токен просрочен — чистим хранилище
        localStorage.removeItem('token');
        localStorage.removeItem('username');
      }
    }
  } catch (e) {}
})();
