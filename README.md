# pdf-signing-demo

Демо-проект для веб-сценария подписи PDF-документа через CryptoPro
Browser Plugin или Рутокен Плагин.

## Что уже есть

- Node.js сервер на Express
- страница в стиле выдачи формуляров
- серверный PDF-формуляр, видимый в браузере
- двухфазный `prepare`/`complete` PAdES-контур с обязательной серверной
  проверкой CMS до встраивания

## Архитектура

- `public/` — статический UI и локально закреплённые browser adapters;
- `src/server.js` — HTTP API, health endpoints и orchestration;
- `src/signing/` — подготовка incremental PDF и CMS verification;
- `src/runtime/` — bounded queue и изолированный запуск Python workers;
- `src/storage/` — TTL, capability-ссылки и приватные результаты;
- `scripts/prepare-pyhanko.py` — единственный runtime PDF preparation
  worker; `normalize-cms.py` и `verify-cms.py` обслуживают CMS boundary;
- `test/` — golden PDF/CMS corpus, API, resource-control, UI и storage
  regression tests.

Браузер выбирает сертификат и создаёт detached CAdES, но не определяет
доверенные данные штампа. Сервер сам разбирает сертификат в `prepare`,
выдаёт точные байты `/ByteRange`, а в `complete` проверяет CMS и все
подписи итогового PDF до сохранения результата.

## Поддерживаемое окружение и точный bootstrap

Поддерживается Node.js `22.22.2` (зафиксирован в `.node-version`,
`engines` допускает только Node 22) и Python `3.12–3.14`. Node
dependencies полностью фиксирует `package-lock.json`. Python lock
`requirements.txt` содержит полный transitive closure и hashes;
`requirements.in` перечисляет прямые зависимости, а
`requirements.constraints.txt` сохраняет проверенные production-версии
транзитивных пакетов.

Из чистого checkout установка и все проверки выполняются одной командой:

```bash
./scripts/bootstrap-and-test.sh
```

Скрипт создаёт `.venv`, устанавливает Python packages с
`--require-hashes`, выполняет `npm ci`, воспроизводит fixtures, запускает
полный набор тестов, production `npm audit` и проверяет committed SBOM.

Для обычного локального запуска после bootstrap:

```bash
PATH="$PWD/.venv/bin:$PATH" node src/server.js
```

Node остаётся системным/runtime binary; `.venv` используется только для
Python workers.

Переменные окружения:

- `PORT` — порт сервера (по умолчанию `3010`)
- `BASE_PATH` — базовый путь за reverse proxy (по умолчанию `/`)
- `STAMP_CONFIG_PATH` — необязательный путь к JSON-конфигу штампа/размещения подписи
- `RESULTS_DIR` — приватный каталог результатов вне web-root (по умолчанию
  `var/results`; production использует отдельный каталог сервиса)
- `SIGNING_CONCURRENCY` — число одновременно выполняемых signing
  operations (по умолчанию `1`);
- `SIGNING_MAX_QUEUE` — максимальная очередь ожидающих операций
  (по умолчанию `8`);
- `SIGNING_QUEUE_TIMEOUT_MS` / `SIGNING_OPERATION_TIMEOUT_MS` — лимиты
  ожидания очереди и полного выполнения (`5000` / `60000` мс);
- `PREPARE_RATE_LIMIT` / `COMPLETE_RATE_LIMIT` — отдельные лимиты запросов
  на IP за окно `SIGNING_RATE_WINDOW_MS` (`12` / `30` за 60 секунд);
- `PDF_WORKER_MEMORY_BYTES` / `PDF_WORKER_CPU_SECONDS` — лимиты отдельного
  Python worker через `prlimit` (512 MiB / 60 CPU seconds).
- `SIGNING_SESSION_TTL_MS` — TTL подготовленной signing session
  (10 минут);
- `SIGNING_MAX_SESSIONS` / `SIGNING_MAX_SESSIONS_PER_IP` — общий и
  per-IP лимиты активных сессий (16 / 3);
- `SIGNING_SESSION_MEMORY_BYTES` — общий лимит RAM для подготовленных
  сессий (64 MiB);
- `SIGNING_RESULT_TTL_MS` — TTL готового PDF и capability-ссылок
  (10 минут);
- `SIGNING_MAX_RESULTS` / `SIGNING_RESULT_DISK_BYTES` — общий лимит
  результатов и диска (32 / 128 MiB).
- `STORAGE_CLEANUP_INTERVAL_MS` — период фоновой очистки истёкших
  sessions/results (30 секунд).

Health endpoints при `BASE_PATH=/pdf-signing/`:

- `GET /pdf-signing/health/live` — процесс отвечает
- `GET /pdf-signing/health/ready` — доступны Python, конфигурация и writable storage

HTTP-сервер слушает только `127.0.0.1`; внешний доступ предполагается
исключительно через reverse proxy.

## Изоляция тяжёлых операций

Подготовка PDF, разбор сертификата, нормализация и проверка CMS больше не
используют синхронный `execFileSync`. Python-команды запускаются
асинхронно в отдельных process groups с минимальным окружением,
приватными временными каталогами, лимитами address space/CPU/open files и
ограниченным stdout/stderr.

Все `prepare`/`complete` проходят через bounded queue. На текущем
одноядерном production-хосте одновременно работает одна операция,
очередь принимает до восьми; один IP не
может параллельно выполнять несколько `prepare`, а один session ID —
несколько `complete`. При timeout или разрыве HTTP-запроса завершается
вся process group, затем удаляются временные файлы. Переполнение очереди
возвращает безопасный `503 SERVER_BUSY`, превышение времени —
`504 OPERATION_TIMEOUT`, rate limit — `429 RATE_LIMITED` с
`Retry-After`.

Liveness не запускает Python и остаётся доступным под нагрузкой.
Readiness коалесцирует и кэширует проверку Python на пять секунд, но
возвращает актуальные `workers.active/queued` при каждом запросе.

## Жизненный цикл документов

Подготовленная signing session живёт не более 10 минут и имеет конечные
состояния `prepared`, `completed`, `failed`, `expired`. После terminal
transition PDF-буферы немедленно освобождаются; одновременно допускается
не более 16 сессий, не более трёх с одного IP и не более 64 MiB их
суммарных буферов.

Готовые PDF никогда не публикуются через static middleware. Они
записываются с правами `0600` в приватный `RESULTS_DIR`; API возвращает
отдельную короткоживущую ссылку preview и одноразовую ссылку download.
Обе истекают через 10 минут, download отдаётся с
`Content-Disposition: attachment` и `Cache-Control: no-store`. После TTL
файл удаляется автоматически. При рестарте все файлы результата
удаляются на старте, поскольку capability-токены хранятся только в
памяти процесса.

Сервис не пишет в логи содержимое PDF, CMS, PIN или capability-токены.
Для пути результата логируется только шаблон `/api/results/:capability`.

## Защита браузерного криптоконтура

Все ответы приложения получают enforcing CSP с `frame-ancestors 'none'`,
`script-src 'self' chrome-extension:`, запретом inline-script/event
handlers, а также `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, ограниченным `Permissions-Policy` и
`Cache-Control: no-store`. Узкие разрешения `chrome-extension:`,
`object-src 'self'` и `cpnp-js-call:` необходимы официальным browser
adapter-ам CryptoPro и Рутокен; произвольные Internet script origins не
разрешены.

CryptoPro loader и `@aktivco/rutoken-plugin@1.0.9` загружаются только из
локального `public/vendor`. Их SHA-256, SHA-384 SRI, происхождение и
процедура обновления описаны в `docs/VENDOR_ASSETS.md`.

До показа сертификата как пригодного клиент проверяет `notBefore`,
`notAfter`, наличие связанного private key и назначение key usage.
Непосредственно перед `prepare` пользователь подтверждает имя документа,
его SHA-256 и fingerprint выбранного сертификата. PIN Рутокен не
попадает в `state` или логи; поле очищается до закрытия диалога, а
локальная ссылка на строку — в `finally` сразу после попытки `login`.

## Настройка штампа подписи

Весь текущий конфиг штампа лежит в одном месте:

- `config/stamp-config.json`

Через него можно настраивать:

- содержимое штампа (`content.title`, `content.rows`)
- внешний вид (`appearance`)
- метаданные PDF-подписи (`signatureObject`)
- правила размещения для 1-й, 2-й и последующих подписей (`placements.rules`)
- выбор страниц для штампа:
  - одна страница: `"mode": "single"`
  - все страницы: `"mode": "all"`
  - диапазон: `"mode": "range"`
  - список страниц: `"mode": "list"`

Публичный API отдаёт только конфигурацию по умолчанию для чтения.
Персональные изменения сохраняются в браузере. Серверные пути конфигурации
и шрифтов клиенту не раскрываются; шрифты выбираются по непрозрачным ID.

## Входные схемы и лимиты

`prepare`, `complete`, `signer` и конфигурация штампа проверяются строгими
JSON Schema: неизвестные поля и значения вне диапазонов отклоняются до
запуска Python.

Основные лимиты:

- JSON body: не более 15 MiB;
- PDF: не более 10 MiB после base64 decode, от 1 до 200 страниц,
  максимальная сторона страницы 14 400 pt;
- PDF base64 проверяется строго, документ должен начинаться с `%PDF-`;
- CMS: не более 128 KiB после base64 decode;
- rendered stamp: не более 4096 px по каждой стороне и 16 777 216 px
  суммарно;
- строки, число строк штампа, шрифты, координаты, страницы,
  `bytesReserved` и `maxSignatures` имеют отдельные верхние границы.

Ошибки API не включают пути и внутренние исключения. Ответ содержит
стабильный `code`, безопасный `message` и `requestId`; тот же request ID
возвращается в заголовке `X-Request-Id` и используется в серверном логе.

## Проверка CMS

`prepare` принимает DER выбранного сертификата в
`signer.certificateBase64`. Сервер сам извлекает из сертификата данные
подписанта для визуального штампа и сохраняет SHA-256 сертификата в
краткоживущей signing session.

`complete` принимает только detached CMS в строгом DER и до встраивания
проверяет:

- единственный `SignerInfo` и точное разрешение его сертификата по SID;
- поддерживаемые digest/signature algorithms;
- обязательные `contentType`, `messageDigest` и `signingCertificateV2`;
- `messageDigest` по точным байтам подготовленного `/ByteRange`;
- криптографическую подпись DER-кодированных signed attributes;
- точное совпадение сертификата CMS с сертификатом из `prepare`.

Поддерживаются RSA/ECDSA с SHA-256/384/512 и ГОСТ Р 34.10-2012
256/512 со Стрибог-256/512 для перечисленных в валидаторе наборов
параметров. После встраивания сервер повторно извлекает и
криптографически проверяет новую и все предыдущие подписи PDF. Невалидная
CMS не уничтожает сессию, успешный `complete` делает её недоступной для
replay.

Ответ `complete` возвращает независимый объект `verification` версии 1:

- `integrity.status = valid` — CMS и все встроенные подписи
  криптографически проверены, сертификат подписанта совпал с выбранным;
- `trust.status = not_checked` — цепочка, срок, отзыв и назначение ключа
  не проверялись;
- `qualified.status = not_checked` — проверка по явно заданной политике
  квалифицированной электронной подписи не выполнялась.

UI показывает эти статусы раздельно и не называет подпись
квалифицированной без соответствующей проверки. Таким образом,
текущий контур подтверждает целостность, но не заявляет доверие
сертификату или квалифицированный статус.

Если правило выбирает несколько страниц, реальный signature widget ставится на одну страницу (`widgetPageMode`: `first` или `last`), а на остальных выбранных страницах рисуются такие же визуальные штампы.

## API

Все JSON endpoints требуют `Content-Type: application/json`. При
`BASE_PATH=/pdf-signing/` основной контракт:

- `GET /pdf-signing/api/stamp-config` — публичные defaults без путей;
- `GET /pdf-signing/api/fonts` — opaque font IDs и display names;
- `GET /pdf-signing/api/form` — исходный серверный PDF;
- `POST /pdf-signing/api/sign/prepare` — PDF, certificate DER,
  stamp config и placement; ответ содержит session ID, exact
  `contentToSignBase64`, `/ByteRange` и размер placeholder;
- `POST /pdf-signing/api/sign/complete` — session ID и detached CMS;
  ответ содержит `verification`, отдельные preview/download capability и
  их expiry;
- `GET|HEAD /pdf-signing/api/results/:capability` — short-lived preview
  или одноразовый attachment download;
- `GET /pdf-signing/health/live|ready` — liveness/readiness.

Неизвестные поля отклоняются. Ошибки имеют стабильные `code`, безопасный
`message` и `requestId`; внутренние пути, PDF/CMS и персональные данные в
ответы не попадают.

## Deployment contour

Current production URL:

- `https://mescheryakov.pro/pdf-signing/`

Repo includes reference deployment files:

- `deploy/pdf-signing-demo.service`
- `deploy/mescheryakov.pro.caddy`
- `deploy/Caddyfile.snippet`

Production разворачивается из зафиксированного commit в
`/home/openclaw/services/pdf-signing-demo/current`. Перед заменой
создаётся timestamped backup кода, venv и service unit. В staging-копии
выполняются `npm ci --omit=dev`, установка `requirements.txt
--require-hashes` в venv и полный test suite; только после этого файлы
переносятся в `current`, service перезапускается и проверяются readiness,
public HTTPS, полный CAdES cycle и независимая PDF validation. При любой
неуспешной проверке восстанавливается backup. `RESULTS_DIR` и legacy
archive не входят в release tree.

## Проверки golden-корпуса

Golden-корпус фиксирует структурные варианты PDF и автоматически проверяет
полный цикл подготовки и встраивания от одной до четырёх последовательных
подписей. Каждая подпись проверяется серверным CMS-валидатором и двумя
независимыми средствами: OpenSSL CMS и pyHanko PDF validation.

```bash
npm ci
python -m pip install --require-hashes --requirement requirements.txt
npm run verify
```

Тестовые сертификат и закрытый ключ создаются во временном каталоге на время
прогона и не сохраняются в репозитории. Состав корпуса описан в
`test/fixtures/README.md`.

## Зависимости и SBOM

Runtime Node tree содержит только `express`, `ajv` и `pdf-lib`; прежние
неиспользуемые `@qiwitech/cryptopro` и `@signpdf/*` удалены.
Неиспользуемые legacy preparation script и sample generator также
удалены, поэтому `@pdf-lib/fontkit` не требуется.

Детерминированные CycloneDX 1.5 manifests лежат в
`sbom/node.cdx.json` и `sbom/python.cdx.json`. Команда
`npm run sbom:check` пересоздаёт их из lockfiles и запрещает stale diff.
CI дополнительно запускает `npm audit --omit=dev` и `pip-audit` для
полного Python lock.

Процедура обновления lockfiles и supply-chain artifacts описана в
`docs/SUPPLY_CHAIN.md`.
