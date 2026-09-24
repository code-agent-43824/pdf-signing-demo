# pdf-signing-demo

Демо-проект для веб-сценария подписи PDF-документа через CryptoPro
Browser Plugin или Рутокен Плагин.

Текущее состояние, известные дефекты и релиз в production — в
[`docs/STATUS.md`](docs/STATUS.md), план текущего этапа — в
[`docs/PLAN.md`](docs/PLAN.md). План отдельного режима подписи произвольных
файлов CAdES-BES в attached и detached упаковке — в
[`docs/CADES_BES_PLAN.md`](docs/CADES_BES_PLAN.md).

## Состав

- Node.js-сервер на Express;
- страница в стиле выдачи формуляров;
- серверный PDF-формуляр, видимый в браузере;
- двухфазный PAdES-контур `prepare`/`complete` с обязательной серверной
  проверкой CMS до встраивания.

## Архитектура

- `public/` — статический UI и локально закреплённые браузерные адаптеры
  (`public/vendor/`);
- `public/modules/` — тестируемые browser-модули: API-клиент, помощники по
  сертификатам, адаптеры CryptoPro и Рутокен вместе с жизненным циклом их
  окружения, машина состояний и оркестратор подписи, хранилище конфигурации
  штампа, диалоги, размещение штампа и предпросмотр результата;
- `src/server.js` — чтение конфигурации сервиса из окружения, сборка
  зависимостей и запуск;
- `src/application.js` — фабрика Express-приложения, общие middleware,
  заголовки безопасности и порядок подключения маршрутов;
- `src/bootstrap.js` — listener на loopback, HTTP-таймауты и фоновая очистка;
- `src/routes/` — health, публичная конфигурация и формуляр, результаты и
  подпись;
- `src/http/` — валидация запросов, rate limiting и единое безопасное
  отображение внутренних ошибок в публичный HTTP-контракт;
- `src/stamp/` — чтение конфигурации штампа и двусторонняя граница между
  серверными путями шрифтов и непрозрачными ID для браузера;
- `src/signing/` — подготовка инкрементального PDF и проверка CMS;
- `src/runtime/` — ограниченная очередь операций и изолированный запуск
  Python-воркеров;
- `src/storage/` — TTL, capability-ссылки и приватные результаты;
- `src/observability/` — локальные Prometheus-метрики;
- `scripts/prepare-pyhanko.py` — единственный runtime-воркер подготовки PDF;
  `normalize-cms.py` и `verify-cms.py` обслуживают границу CMS; остальные
  скрипты в `scripts/` — деплой, мониторинг, SBOM и служебные проверки;
- `test/` — golden-корпус PDF/CMS и регрессионные тесты API, ограничений
  ресурсов, UI и хранилища.

Браузер выбирает сертификат и создаёт detached CAdES, но не определяет
доверенные данные штампа. Сервер сам разбирает сертификат в `prepare`, выдаёт
точные байты `/ByteRange`, а в `complete` проверяет CMS и все подписи
итогового PDF до сохранения результата.

## Окружение и bootstrap

Поддерживаемые версии Node.js, npm и Python и правила работы с lock-файлами
описаны в `docs/SUPPLY_CHAIN.md`.

Из чистого checkout установка и все проверки выполняются одной командой:

```bash
./scripts/bootstrap-and-test.sh
```

Скрипт создаёт `.venv` интерпретатором `python3` (его версия должна входить в
поддерживаемый диапазон), устанавливает Python-пакеты с `--require-hashes`,
выполняет `npm ci`, воспроизводит фикстуры, запускает полный набор тестов,
`npm audit` production-зависимостей и проверяет закоммиченный SBOM.

Локальный запуск после bootstrap:

```bash
PATH="$PWD/.venv/bin:$PATH" node src/server.js
```

Node — системный бинарник, `.venv` нужен только Python-воркерам: сервер и
тесты запускают `python3` из `PATH`.

Переменные окружения. Значения по умолчанию и допустимые границы заданы в
`src/server.js`, `src/bootstrap.js` и `src/runtime/process-runner.js`,
production-значения — в `deploy/pdf-signing-demo.service`.

- `PORT` — порт сервера;
- `BASE_PATH` — базовый путь за reverse proxy;
- `STAMP_CONFIG_PATH` — необязательный путь к JSON-конфигу штампа и
  размещения подписи;
- `RESULTS_DIR` — приватный каталог результатов вне web-root;
- `SIGNING_CONCURRENCY` — число одновременно выполняемых операций подписи;
- `SIGNING_MAX_QUEUE` — максимальная очередь ожидающих операций;
- `SIGNING_QUEUE_TIMEOUT_MS` / `SIGNING_OPERATION_TIMEOUT_MS` — лимиты
  ожидания в очереди и полного выполнения;
- `PREPARE_RATE_LIMIT` / `COMPLETE_RATE_LIMIT` — лимиты запросов с одного IP
  за окно `SIGNING_RATE_WINDOW_MS`;
- `PDF_WORKER_MEMORY_BYTES` / `PDF_WORKER_CPU_SECONDS` — лимиты
  Python-воркера через `prlimit`;
- `SIGNING_SESSION_TTL_MS` — TTL подготовленной сессии подписи;
- `SIGNING_MAX_SESSIONS` / `SIGNING_MAX_SESSIONS_PER_IP` — общий и per-IP
  лимиты активных сессий;
- `SIGNING_SESSION_MEMORY_BYTES` — общий лимит памяти подготовленных сессий;
- `SIGNING_RESULT_TTL_MS` — TTL готового PDF и capability-ссылок;
- `SIGNING_MAX_RESULTS` / `SIGNING_RESULT_DISK_BYTES` — лимиты числа
  результатов и места на диске;
- `STORAGE_CLEANUP_INTERVAL_MS` — период фоновой очистки истёкших сессий и
  результатов;
- `HTTP_HEADERS_TIMEOUT_MS` / `HTTP_REQUEST_TIMEOUT_MS` — HTTP-таймауты
  сервера;
- `NODE_ENV=production` — делает `prlimit` обязательным для запуска воркеров.

Health endpoints (пример для `BASE_PATH=/pdf-signing/`):

- `GET /pdf-signing/health/live` — процесс отвечает;
- `GET /pdf-signing/health/ready` — доступны Python, `prlimit`, конфигурация
  штампа и запись в каталог результатов, очередь воркеров в норме;
- `GET /pdf-signing/health/metrics` — локальные Prometheus-метрики; Caddy
  намеренно возвращает `404` на внешние запросы к этому endpoint.

HTTP-сервер слушает только `127.0.0.1`; внешний доступ — исключительно через
reverse proxy.

## Изоляция тяжёлых операций

Подготовку PDF, разбор сертификата, нормализацию и проверку CMS выполняют
Python-воркеры. Каждый запускается асинхронно в отдельной process group с
минимальным окружением, приватным временным каталогом, лимитами address
space, CPU и открытых файлов и ограниченным stdout/stderr.

Все `prepare`/`complete` проходят через ограниченную очередь. Production-хост
одноядерный, поэтому по умолчанию одновременно выполняется одна операция.
Один IP не может параллельно выполнять несколько `prepare`, а один session
ID — несколько `complete`. При timeout или разрыве HTTP-запроса завершается
вся process group, затем удаляются временные файлы. Переполнение очереди
возвращает `503 SERVER_BUSY`, превышение времени — `504 OPERATION_TIMEOUT`,
rate limit — `429 RATE_LIMITED` с `Retry-After`.

Liveness не запускает Python и остаётся доступным под нагрузкой. Readiness
объединяет одновременные проверки и ненадолго кэширует их результат
(`src/routes/health.js`), но состояние очереди воркеров возвращает актуальным
при каждом запросе.

## Жизненный цикл документов

Подготовленная сессия подписи живёт не дольше `SIGNING_SESSION_TTL_MS` и
имеет конечные состояния `prepared`, `completed`, `failed`, `expired`. После
перехода в конечное состояние PDF-буферы сразу освобождаются. Число сессий,
сессий с одного IP и суммарный объём их буферов ограничены переменными выше.

Готовые PDF никогда не отдаются через static middleware. Они записываются с
правами `0600` в приватный `RESULTS_DIR`, а API возвращает отдельные
capability-ссылки для preview и download. Обе ссылки можно использовать
многократно в течение всего `SIGNING_RESULT_TTL_MS`. Download отдаётся с
`Content-Disposition: attachment`, preview можно встроить только в страницу
того же origin, оба ответа имеют `Cache-Control: no-store`. После TTL файл и
служебные метаданные удаляются автоматически. На диске хранятся только
SHA-256 capability-токенов, поэтому ссылки переживают штатный рестарт сервиса,
но не раскрываются через файловое хранилище.

Сервис не пишет в логи содержимое PDF, CMS, PIN и capability-токены; путь
результата логируется как шаблон `/api/results/:capability`.

## Защита браузерного криптоконтура

Все ответы интерфейса и JSON API получают enforcing CSP
(`CONTENT_SECURITY_POLICY` в `src/application.js`): `frame-ancestors 'none'`,
скрипты только со своего origin и из расширений (`chrome-extension:`), запрет
inline-скриптов и обработчиков событий в атрибутах. К ним добавляются
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, ограниченный `Permissions-Policy` и
`Cache-Control: no-store`. Узкие разрешения `chrome-extension:`,
`object-src 'self'` и `cpnp-js-call:` нужны официальным браузерным адаптерам
CryptoPro и Рутокен; произвольные интернет-источники скриптов запрещены.
Единственное исключение из запрета inline-скриптов — два скрипта, которые
внедряет Firefox-сборка расширения «Адаптер Рутокен Плагин»: они разрешены по
SHA-256 ровно в опубликованном виде (см. `docs/VENDOR_ASSETS.md`).

Ответ preview PDF получает собственную, более строгую CSP с
`frame-ancestors 'self'` и `X-Frame-Options: SAMEORIGIN` (`resultHeaders` в
`src/routes/results.js`), чтобы встроенный просмотр работал без разрешения
стороннего framing.

Загрузчик CryptoPro и адаптер `@aktivco/rutoken-plugin` загружаются только из
локального `public/vendor`; их происхождение, контрольные суммы и процедура
обновления описаны в `docs/VENDOR_ASSETS.md`.

До показа сертификата как пригодного клиент проверяет `notBefore`,
`notAfter`, наличие связанного закрытого ключа и назначение ключа.
Непосредственно перед `prepare` пользователь подтверждает имя документа, его
SHA-256 и отпечаток выбранного сертификата. PIN Рутокена не попадает в
`state` и логи: поле очищается до закрытия диалога, а локальная ссылка на
строку — в `finally` сразу после попытки `login`.

## Настройка штампа подписи

Конфиг штампа по умолчанию — `config/stamp-config.json` (путь
переопределяется `STAMP_CONFIG_PATH`). Через него настраиваются:

- содержимое штампа (`content.title`, `content.rows`);
- внешний вид (`appearance`);
- метаданные PDF-подписи (`signatureObject`);
- правила размещения для 1-й, 2-й и последующих подписей
  (`placements.rules`);
- выбор страниц для штампа:
  - одна страница: `"mode": "single"`;
  - все страницы: `"mode": "all"`;
  - диапазон: `"mode": "range"`;
  - список страниц: `"mode": "list"`.

Если правило выбирает несколько страниц, настоящий виджет подписи ставится на
одну из них (`widgetPageMode`: `first` или `last`), а на остальных выбранных
страницах рисуются такие же визуальные штампы.

Публичный API отдаёт конфигурацию по умолчанию только для чтения, персональные
изменения сохраняются в браузере. Серверные пути конфигурации и шрифтов
клиенту не раскрываются; шрифты выбираются по непрозрачным ID.

## Входные схемы и лимиты

`prepare`, `complete`, `signer` и конфигурация штампа проверяются строгими
JSON Schema (`src/http/validation.js`): неизвестные поля и значения вне
диапазонов отклоняются до запуска Python.

Основные лимиты:

- размер JSON-тела — лимит `express.json` в `src/application.js`;
- PDF — не больше `MAX_PDF_BYTES` после декодирования base64, от 1 до
  `MAX_PDF_PAGES` страниц, сторона страницы — не больше `MAX_PAGE_DIMENSION`;
  base64 проверяется строго, документ должен начинаться с `%PDF-`;
- CMS — не больше `MAX_CMS_BYTES` после декодирования base64;
- отрендеренный штамп — ограничены каждая сторона и общее число пикселей
  (`MAX_STAMP_PIXELS`);
- строки, число строк штампа, шрифты, координаты, страницы, `bytesReserved` и
  `maxSignatures` ограничены схемой конфигурации штампа.

Ошибки API не содержат путей и внутренних исключений. Ответ включает
стабильный `code`, безопасный `message` и `requestId`; тот же request ID
возвращается в заголовке `X-Request-Id` и попадает в серверный лог.

## Проверка CMS

`prepare` принимает DER выбранного сертификата в `signer.certificateBase64`.
Сервер сам извлекает из сертификата данные подписанта для визуального штампа
и сохраняет SHA-256 сертификата в краткоживущей сессии подписи.

`complete` принимает только detached CMS в строгом DER и до встраивания
проверяет:

- единственный `SignerInfo` и точное разрешение его сертификата по SID;
- поддерживаемые алгоритмы хеширования и подписи;
- обязательные `contentType`, `messageDigest` и `signingCertificateV2`;
- `messageDigest` по точным байтам подготовленного `/ByteRange`;
- криптографическую подпись DER-кодированных signed attributes;
- точное совпадение сертификата CMS с сертификатом из `prepare`.

Поддерживаемые алгоритмы перечислены в `scripts/verify-cms.py`: RSA и ECDSA с
SHA-2 и ГОСТ Р 34.10-2012 со Стрибогом для заданных там наборов параметров.
После встраивания сервер заново извлекает и криптографически проверяет новую
и все предыдущие подписи PDF. Невалидная CMS не уничтожает сессию, а успешный
`complete` делает её недоступной для повторного использования.

Ответ `complete` содержит независимый объект `verification` версии 1:

- `integrity.status = valid` — CMS и все встроенные подписи
  криптографически проверены, сертификат подписанта совпал с выбранным;
- `trust.status = not_checked` — цепочка, срок, отзыв и назначение ключа не
  проверялись;
- `qualified.status = not_checked` — проверка по явно заданной политике
  квалифицированной электронной подписи не выполнялась.

UI показывает эти статусы раздельно и не называет подпись квалифицированной
без соответствующей проверки: контур подтверждает целостность, но не
заявляет доверие сертификату или квалифицированный статус.

## API

POST-запросы требуют `Content-Type: application/json`. Основной контракт
(пример для `BASE_PATH=/pdf-signing/`):

- `GET /pdf-signing/api/stamp-config` — публичные значения по умолчанию без
  путей;
- `GET /pdf-signing/api/fonts` — непрозрачные ID шрифтов и их названия;
- `GET /pdf-signing/api/form` — исходный серверный PDF;
- `POST /pdf-signing/api/sign/prepare` — PDF, DER сертификата, конфигурация
  штампа и размещение; ответ содержит session ID, точные
  `contentToSignBase64`, `/ByteRange` и размер placeholder;
- `POST /pdf-signing/api/sign/complete` — session ID и detached CMS; ответ
  содержит `verification`, отдельные capability для preview и download и срок
  их действия;
- `GET /pdf-signing/api/results/:capability` — многократный preview или
  download в пределах `SIGNING_RESULT_TTL_MS`;
- `GET /pdf-signing/health/live|ready` — liveness и readiness.

Неизвестные поля отклоняются. Ошибки имеют стабильный `code`, безопасный
`message` и `requestId`; внутренние пути, PDF, CMS и персональные данные в
ответы не попадают.

## Деплой

Production: `https://mescheryakov.pro/pdf-signing/`, за Caddy
(`deploy/mescheryakov.pro.caddy`).

Push в `main` после зелёного CI деплоит в production (job `deploy-production`
в `.github/workflows/ci.yml`), если в сообщении head-коммита нет
`[skip deploy]`. GitHub Actions передаёт ровно проверенный commit выделенным
production SSH-ключом. На сервере `scripts/deploy-production.sh` под
эксклюзивной блокировкой создаёт immutable release, устанавливает только
зафиксированные зависимости, повторяет полный набор проверок
(`scripts/verify-release.sh`) и запускает canary на отдельном loopback-порту.
Canary (`scripts/smoke-signing.js`) выполняет полный цикл
`prepare → CAdES → complete → preview×2 → download×2` и независимую проверку
pyHanko. Затем `current` атомарно переключается symlink-ом, сервис
перезапускается и проверяются local и public readiness, внешний `404` для
метрик и HTTPS UI. При любой ошибке после переключения предыдущий release и
unit сервиса восстанавливаются автоматически. Перед переключением
сохраняется backup с меткой времени; `RESULTS_DIR` и legacy-архив в дерево
релиза не входят.

`deploy/pdf-signing-demo.service` деплой устанавливает сам. Caddy-файлы в
`deploy/` — эталонные копии: CI их не применяет, изменение конфигурации Caddy
делается на сервере вручную.

Хранилищем деплоя управляет `scripts/manage-deploy-storage.sh`. Перед сборкой
он удаляет только устаревшие staging-каталоги с корректным именем релиза и
устаревшие incoming-архивы, затем требует свободное место на два размера
текущего релиза плюс резерв. После полностью успешного rollout остаются
текущий и предыдущий immutable release, несколько последних обычных
CI/CD-backup и все evidence-backup с `.retain` или `rollback-drill.log`;
ручные backup не затрагиваются. Пороги задаются `DEPLOY_DISK_RESERVE_BYTES`,
`STALE_DEPLOY_ARTIFACT_AGE_SECONDS` и `DEPLOY_BACKUP_RETENTION_COUNT`
(значения по умолчанию — в скрипте); `RETENTION_DRY_RUN=1` показывает
удаления без их выполнения.

Workflow использует GitHub Environment `production`: host и user хранятся в
переменных `PRODUCTION_HOST`/`PRODUCTION_USER`, приватный ключ и точная строка
host key — в секретах `PRODUCTION_SSH_KEY` и `PRODUCTION_KNOWN_HOSTS`. Ключ на
сервере отдельный и имеет SSH-ограничение `restrict`; административные ключи
в CI не передаются. Деплой на сервере использует отдельную копию npm
закреплённой версии (`NPM_CLI` в `scripts/deploy-production.sh`); npm не
входит в runtime-зависимости приложения.

`scripts/check-observability.js` проверяет local и public readiness,
состояние и рестарты systemd, свободное место на хосте, очередь воркеров,
заполнение памяти сессий и хранилища результатов, ошибки подписи, rate limit
и очистки. В приватном файле состояния он хранит только счётчики и активные
состояния; PDF, CMS, PIN, capability-токены, DN и отпечатки в метрики и
состояние монитора не попадают.

## Проверки golden-корпуса

Golden-корпус фиксирует структурные варианты PDF и проверяет полный цикл
подготовки и встраивания нескольких последовательных подписей (сценарии — в
`test/fixtures/manifest.json`). Каждая подпись проверяется серверным
CMS-валидатором и двумя независимыми средствами: OpenSSL CMS и проверкой PDF в
pyHanko. После bootstrap:

```bash
PATH="$PWD/.venv/bin:$PATH" npm run test:golden
```

Тестовые сертификат и закрытый ключ создаются во временном каталоге на время
прогона и не сохраняются в репозитории. Состав корпуса описан в
`test/fixtures/README.md`.

## Зависимости и SBOM

Допустимый набор runtime-зависимостей Node проверяет
`test/supply-chain.test.js`. Детерминированные манифесты CycloneDX лежат в
`sbom/`; `npm run sbom:check` пересоздаёт их из lock-файлов и запрещает
устаревший diff. Процедура обновления lock-файлов и SBOM и аудит зависимостей
описаны в `docs/SUPPLY_CHAIN.md`.
