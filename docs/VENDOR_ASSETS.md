# Браузерные vendor-компоненты криптографии

Браузер загружает криптоадаптеры только из `public/vendor`; загрузку стороннего
JavaScript из сети запрещает CSP приложения. Точные байты адаптеров закреплены
в `public/vendor/SHA256SUMS` (его сверяет `test/vendor-assets.test.js`), а
каждый динамически вставляемый скрипт дополнительно закреплён SHA-384 SRI в
`CRYPTO_SCRIPTS` (`public/app.js`).

## Закреплённые файлы

### CryptoPro `cadesplugin_api.js`

- Источник:
  `https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js`.
- Получен 2026-07-30; `Last-Modified` в ответе источника — 2025-11-23
  08:05:01 UTC.

Это загрузчик CryptoPro. В поддерживаемых браузерах он общается с
установленным расширением CryptoPro или загружает из него код
(`chrome-extension://…/nmcades_plugin_api.js`). Поэтому CSP разрешает схему
`chrome-extension:`, но не интернет-хосты.

### Адаптер Рутокен Плагина `rutoken-plugin.min.js`

- Пакет: `@aktivco/rutoken-plugin@1.0.9`.
- Реестр:
  `https://registry.npmjs.org/@aktivco/rutoken-plugin/-/rutoken-plugin-1.0.9.tgz`.
- Исходники: `https://github.com/AktivCo/rutoken-plugin-js`.
- Лицензия: BSD-2-Clause, копия — `public/vendor/LICENSE.rutoken-plugin.txt`.

При загрузке адаптер ищет объект, который внедряет в страницу расширение
«Адаптер Рутокен Плагин» (раздел ниже). Если объекта нет, адаптер считает, что
расширение не установлено.

## Процедура обновления

1. Скачать кандидата во временный каталог. До проверки не перезаписывать
   закоммиченный файл.
2. Сверить URL источника или владельца пакета, просмотреть diff, release notes
   и совместимость с расширениями браузеров.
3. Скопировать проверенные байты в `public/vendor`.
4. Пересчитать SHA-256 в `public/vendor/SHA256SUMS` и SHA-384 SRI в
   `CRYPTO_SCRIPTS` (`public/app.js`).
5. Запустить `npm test` и проверить подпись в браузере обоими реальными
   провайдерами.
6. Закоммитить файл, контрольную сумму, запись о происхождении и SRI вместе.

Изменение источника по тому же URL не принимается автоматически: локальная
копия меняется только через эту процедуру.

## Расширение «Адаптер Рутокен Плагин»

Расширение внедряет в страницу свой API — объект
`window["C3B7563B-BF85-45B7-88FC-7CFF1BD3C2DB"]` и, после `initialize()`,
страничный код `webpage.js`. Сборки для разных браузеров делают это по-разному.

- Chrome-сборка (MV3) регистрирует `inject.js` как content-скрипт в
  `world: "MAIN"`, а `webpage.js` подключает по адресу `chrome-extension://`.
  CSP страницы на первое не действует, второе разрешено схемой
  `chrome-extension:`.
- Firefox-сборка (MV2) вставляет и объект, и `webpage.js` inline-скриптами.
  CSP приложения запрещает inline-скрипты, а Firefox применяет CSP страницы и к
  скриптам расширений (Mozilla bug 1446231). Поэтому ровно эти два текста
  разрешены по SHA-256 — константа `RUTOKEN_FIREFOX_EXTENSION_SCRIPT_HASHES` в
  `src/application.js`. Любой другой inline-скрипт по-прежнему запрещён.

Происхождение Firefox-сборки, для которой посчитаны хеши:

- Источник:
  `https://addons.mozilla.org/firefox/downloads/latest/adapter-rutoken-plugin/latest.xpi`,
  расширение `rutokenplugin@rutoken.ru` версии 1.0.5.0, получено 2026-09-24.
- XPI: 44 700 байт, SHA-256
  `00d7e9965f2039b1d69e8e235afc2df8089c3fd7171823dc62f3906078fb0df4`.
- Хеши считает `scripts/rutoken-firefox-csp-hashes.js`: он выполняет
  `content.js` расширения на заглушках DOM и хеширует ровно вставленный текст.

Процедура обновления, когда на AMO выходит новая версия Firefox-сборки:

1. Скачать XPI во временный каталог и распаковать его:
   `unzip latest.xpi -d rutoken-xpi`.
2. Запустить `node scripts/rutoken-firefox-csp-hashes.js rutoken-xpi`. Скрипт
   печатает хеши и помечает отсутствующие в CSP (тогда код выхода 1).
3. Заменить значения в `RUTOKEN_FIREFOX_EXTENSION_SCRIPT_HASHES` и в проверке
   CSP в `test/server-surface.test.js`, обновить здесь версию и SHA-256 XPI.
4. Проверить в Firefox с установленным расширением: объект
   `window["C3B7563B-BF85-45B7-88FC-7CFF1BD3C2DB"]` появляется, в консоли нет
   нарушений CSP, а с реальным токеном проходит подпись.
