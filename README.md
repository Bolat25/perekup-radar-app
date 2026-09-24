# Perekup Radar — приложение

Страница Telegram Mini App для бота Perekup Radar (объявления OLX и Kaspi).
Раздаётся через GitHub Pages, своего сервера нет.

Настройки подписчика бот передаёт в адресе после `#` — эта часть адреса на сервер
не отправляется. Изменения уходят боту через `Telegram.WebApp.sendData`, бот их проверяет.

- `index.html`, `app.js`, `style.css` — страница;
- `i18n.json` — тексты (ru, kk);
- `data/` — справочники городов OLX и Kaspi, категорий Kaspi (выгружает `tools/export_webapp.py` бота).
