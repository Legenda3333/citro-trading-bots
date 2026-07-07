//  ЗАЩИТА СТРАНИЦ ДЛЯ ВОШЕДШИХ. Без токена или с просроченным — на вход.
//  Отдельный файл (а не инлайн-скрипт), чтобы CSP мог обойтись без 'unsafe-inline'
//  (защита от внедрения чужих скриптов).
//  Грузится в <head> синхронно — редирект срабатывает ДО отрисовки страницы.
(function () {
  try {
    const token = localStorage.getItem('token');
    if (!token) {
      window.location.replace('/');
    } else {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 <= Date.now()) {
        localStorage.removeItem('token');
        localStorage.removeItem('username');
        window.location.replace('/');
      }
    }
  } catch (e) {
    window.location.replace('/');
  }
})();
