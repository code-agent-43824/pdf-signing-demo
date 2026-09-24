# Browser crypto vendor assets

The browser loads crypto adapters only from `public/vendor`. Runtime network
loading of third-party JavaScript is prohibited by the application CSP.
`public/vendor/SHA256SUMS` is checked by the test suite, while `public/app.js`
also pins each dynamically inserted script with SHA-384 Subresource Integrity.

## Pinned artifacts

### CryptoPro `cadesplugin_api.js`

- Source:
  `https://www.cryptopro.ru/sites/default/files/products/cades/cadesplugin_api.js`
- Retrieved: 2026-07-30.
- Source response `Last-Modified`: 2025-11-23 08:05:01 UTC.
- Size: 42,363 bytes.
- SHA-256:
  `d54cfe9186c4b6dbe9ed73d83f289d31da7b50000b48ba3e7c278e820578086b`.
- SHA-384 SRI:
  `sha384-5w5a3gj2rEglmho8SnY3toHnjMQcHhMaXB5mtbfOLeQlxELCBi7zLlvwgG5pvUwT`.

This is CryptoPro's loader. On supported browsers it communicates with, or
loads code from, the installed CryptoPro browser extension. The CSP therefore
permits the `chrome-extension:` script scheme but no Internet script hosts.

### Rutoken adapter

- Package: `@aktivco/rutoken-plugin@1.0.9`.
- Registry:
  `https://registry.npmjs.org/@aktivco/rutoken-plugin/-/rutoken-plugin-1.0.9.tgz`.
- Upstream: `https://github.com/AktivCo/rutoken-plugin-js`.
- License: BSD-2-Clause; local copy:
  `public/vendor/LICENSE.rutoken-plugin.txt`.
- Size: 2,897 bytes.
- SHA-256:
  `612514f867c0b54db498edf470908696e1eec3389914db5740e0c2252b339ce2`.
- SHA-384 SRI:
  `sha384-Lu5PgN+MfVF7y+8cpsOnSbHd03PcEWEAJPQYmsRlhDX3u1NuI/eR3N4r9z16f8YQ`.

## Update procedure

1. Download the candidate artifact into a temporary directory. Never overwrite
   the checked-in file before review.
2. Confirm the source URL/package owner and review the diff, upstream release
   notes, and browser-extension compatibility.
3. Copy the exact reviewed bytes into `public/vendor`.
4. Recalculate SHA-256 in `public/vendor/SHA256SUMS` and SHA-384 SRI in
   `public/app.js`.
5. Run `npm test` and browser smoke tests with both real providers.
6. Commit the artifact, checksum, provenance note, and SRI update together.

An upstream change with the same URL is not accepted automatically: the local
copy changes only through this review procedure.

## Firefox-расширение «Адаптер Рутокен Плагин»

Firefox-сборка расширения (MV2) внедряет свой API в страницу двумя
inline-скриптами. При загрузке страницы первый скрипт создаёт объект
`window["C3B7563B-BF85-45B7-88FC-7CFF1BD3C2DB"]`, а при `initialize()` второй
скрипт вставляет `webpage.js`. CSP приложения запрещает inline-скрипты, а
Firefox применяет CSP страницы и к скриптам расширений (Mozilla bug 1446231).
Поэтому ровно эти два текста разрешены по SHA-256 — константа
`RUTOKEN_FIREFOX_EXTENSION_SCRIPT_HASHES` в `src/application.js`. Chrome-сборка
(MV3) внедряет API вне CSP страницы, и хеши ей не нужны. Любой другой
inline-скрипт по-прежнему запрещён.

- Источник: `https://addons.mozilla.org/firefox/downloads/latest/adapter-rutoken-plugin/latest.xpi`,
  расширение `rutokenplugin@rutoken.ru` версии 1.0.5.0, получено 2026-09-24.
- XPI: 44 700 байт, SHA-256
  `00d7e9965f2039b1d69e8e235afc2df8089c3fd7171823dc62f3906078fb0df4`.
- Хеши считает `scripts/rutoken-firefox-csp-hashes.js`: он выполняет
  `content.js` расширения на заглушках DOM и хеширует ровно вставленный текст.

Процедура обновления, когда на AMO выходит новая версия расширения:

1. Скачать XPI во временный каталог и распаковать его:
   `unzip latest.xpi -d rutoken-xpi`.
2. Запустить `node scripts/rutoken-firefox-csp-hashes.js rutoken-xpi`. Скрипт
   печатает хеши и помечает отсутствующие в CSP (тогда код выхода 1).
3. Заменить значения в `RUTOKEN_FIREFOX_EXTENSION_SCRIPT_HASHES` и в проверке
   CSP в `test/server-surface.test.js`, обновить здесь версию и SHA-256 XPI.
4. Проверить в Firefox с установленным расширением: объект
   `window["C3B7563B-BF85-45B7-88FC-7CFF1BD3C2DB"]` появляется, в консоли нет
   нарушений CSP, а с реальным токеном проходит подпись.
