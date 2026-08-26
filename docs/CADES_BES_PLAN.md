# План поддержки CAdES-BES attached/detached

Статус: **запланировано, реализация не начата**.

Этот документ фиксирует отдельный пользовательский сценарий создания
CAdES-BES подписи произвольного файла через CryptoPro Browser Plugin или
Рутокен Плагин. Существующий PAdES-контур не заменяется и не расширяется
attached-семантикой.

## 1. Граница продукта

В интерфейсе появятся два независимых режима:

| Режим | Что подписывается | Результат |
| --- | --- | --- |
| PAdES | подготовленные сервером `/ByteRange` байты PDF | PDF со встроенной detached CMS |
| CAdES-BES detached | точные исходные байты произвольного файла | отделённая подпись `<имя>.p7s`; исходный файл остаётся отдельным |
| CAdES-BES attached | точные исходные байты произвольного файла | совмещённое CMS-сообщение `<имя>.p7m`, содержащее исходный файл |

Для PDF, выбранного в CAdES-режиме, результатом также будет `.p7s` или
`.p7m`, а не визуально подписанный PDF. Штамп, размещение и PDF signature
field относятся только к PAdES.

Первая версия ограничивается:

- одним файлом и одним подписантом за операцию;
- CAdES-BES без timestamp, co-sign, countersign и upgrade до CAdES-T/A;
- точным сохранением исходных байтов без перекодирования текста и нормализации
  переводов строк;
- прежней честной семантикой: проверяется целостность подписи и соответствие
  сертификата, но не trust chain, revocation и qualified status;
- максимальным исходным файлом 10 MiB и тем же TTL результата 15 минут;
- download-only выдачей CMS без inline preview.

Расширение этих границ не входит в первый срез.

## 2. Подтверждённые provider API

CryptoPro должен подписывать исходные данные через
`CAdESCOM.CadesSignedData.SignCades` с `CADESCOM_CADES_BES`: параметр
`bDetached=true` создаёт отделённую подпись, `false` — совмещённую. До вызова
задаются `ContentEncoding=CADESCOM_BASE64_TO_BINARY` и точные исходные данные
в `Content`. Существующий PAdES-вызов `SignHash` остаётся отдельным и не
используется для attached CAdES.

Рутокен должен вызывать `plugin.sign` над исходными base64-данными с явным
`options.detached=true|false`. Перед реализацией нужно на реально
установленной поддерживаемой версии подтвердить используемые имена опций
включения сертификата и ESSCertIDv2 (`addUserCertificate`/`addEssCert`) и
зафиксировать их mock-контрактом.

Основные источники:

- [CryptoPro: `ICPSignedData2::SignCades`](https://docs.cryptopro.ru/cades/reference/cadescom/cadescom_interface/icpsigneddata2signcades);
- [CryptoPro: пример отделённой CAdES-BES подписи](https://docs.cryptopro.ru/cades/plugin/plugin-samples/plugin-samples-sign-detached);
- [Рутокен: встраивание Рутокен ЭЦП через Плагин](https://dev.rutoken.ru/pages/viewpage.action?pageId=15269905);
- [Рутокен: `sign(deviceId, certId, data, isBase64, options)`](https://dev.rutoken.ru/pages/viewpage.action?pageId=17432716).

## 3. Целевой пользовательский сценарий

1. Пользователь выбирает режим `CAdES-BES`, файл, attached/detached и
   криптопровайдер.
2. Приложение читает файл как `ArrayBuffer`, вычисляет SHA-256 и показывает
   подтверждение: имя, размер, digest, режим, провайдер и сертификат.
3. `POST /api/cades/prepare` принимает исходный base64, выбранный режим и DER
   сертификата. Сервер повторно вычисляет SHA-256, проверяет сертификат и
   создаёт короткоживущую сессию, привязанную к точным байтам, режиму,
   сертификату и владельцу запроса.
4. Клиент сравнивает server digest с локальным и прекращает операцию при
   несовпадении.
5. Provider adapter создаёт CAdES-BES над исходными байтами. Для Рутокен PIN
   проходит через существующий диалог и очищается в `finally`.
6. `POST /api/cades/complete` принимает только session ID и CMS. Сервер
   проверяет режим упаковки, точное содержимое, signed attributes,
   криптографическую подпись и binding сертификата.
7. Проверенная CMS сохраняется как приватный TTL-artifact; API возвращает
   download capability, безопасное имя и независимые verification statuses.
8. Сессия становится terminal, повторный `complete` отклоняется, CMS и
   metadata удаляются после TTL.

Двухфазный API нужен, чтобы attached `complete` не передавал второй раз и
исходный файл, и содержащую его CMS, а также чтобы исключить подмену режима,
контента или сертификата между подтверждением и проверкой.

## 4. Архитектурные изменения

### 4.1 Frontend

- Добавить явный верхнеуровневый выбор `PAdES PDF` / `CAdES-BES` и внутри
  CAdES — `detached` / `attached`.
- Не перегружать существующий `signing-orchestrator.js` PDF-условиями:
  выделить отдельный небольшой `cades-orchestrator.js`, но переиспользовать
  certificate dialog, provider lifecycle, PIN lifecycle, API client и
  signing state machine.
- В adapter API развести намерения:
  - текущая PAdES-операция над серверными `/ByteRange` байтами;
  - новая CAdES-операция над исходными байтами с явным `detached`.
- CryptoPro CAdES-метод использует `SignCades`, Рутокен — `plugin.sign` с
  mode option; ни один provider-specific вызов не возвращается в `app.js`.
- В подтверждении и результате явно писать, что attached не означает PAdES,
  а detached требует исходный файл для последующей проверки.

### 4.2 HTTP API и validation

Добавить отдельные endpoints, не меняя контракт `/api/sign/prepare|complete`:

- `POST /api/cades/prepare`:
  `{ fileName, contentBase64, packaging, signer: { certificateBase64 } }`;
- `POST /api/cades/complete`:
  `{ sessionId, cmsSignatureBase64 }`.

Требования:

- strict JSON Schema, запрет неизвестных полей;
- `packaging` только `attached|detached`;
- strict base64, исходный файл до 10 MiB, сертификат в текущем лимите;
- динамический CMS limit: небольшой bounded overhead для detached и
  `source size + bounded overhead` для attached;
- имя файла очищается от path/control characters, ограничивается по длине и
  используется только для безопасного download name;
- session payload получает явный `kind=cades`, чтобы CAdES session ID нельзя
  было передать в PAdES `complete` и наоборот;
- существующие queue, abort, timeout, per-owner session limits и rate limits
  переиспользуются; observability получает только bounded labels
  `cades_prepare|cades_complete` и `attached|detached` без имён и содержимого.

### 4.3 CMS verification

Обобщить verifier с явным ожидаемым packaging mode:

- detached: `encapContentInfo.eContent` обязан отсутствовать, digest считается
  по сохранённым session bytes;
- attached: `eContent` обязан присутствовать и побайтово совпадать с session
  bytes; digest считается по извлечённому содержимому;
- в обоих режимах обязательны canonical DER, `signedData`, content type
  `data`, ровно один signer, declared digest, signed attributes
  `contentType`, `messageDigest`, `signingCertificateV2`, cryptographic
  validity и exact signer certificate binding;
- normalization не должна менять вложенные байты; если это нельзя доказать
  отдельным тестом, provider CMS должна приниматься только в canonical DER;
- ответ сохраняет независимые `integrity=valid`, `trust=not_checked`,
  `qualified=not_checked`; для attached дополнительно фиксируется
  `embeddedContentMatched=true`.

PAdES verifier продолжает требовать только detached CMS. Его текущий
fail-closed контракт и проверка всех PDF signatures не ослабляются.

### 4.4 Result storage

Расширить существующий result store до типизированного artifact store без
создания второго хранилища:

- PAdES сохраняет прежний `.pdf`, preview и download capabilities;
- detached CAdES сохраняет `.p7s`, attached — `.p7m`, только download;
- metadata хранит allowlisted media type, extension и безопасное имя;
- `Content-Disposition: attachment`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`; CMS никогда не отдаётся inline;
- TTL, restart recovery, aggregate disk reservation, cleanup и capability
  hashing остаются общими;
- migration существующих PDF metadata должна быть backward-compatible и
  покрыта restart-тестом.

## 5. Порядок реализации

Работу выполнять отдельными последовательными срезами.

### Этап 0 — provider capability spike

- На реальных CryptoPro и Рутокен создать четыре обезличенных результата:
  provider × attached/detached на одинаковом небольшом бинарном fixture.
- Проверить DER structure, наличие/отсутствие embedded content,
  `signingCertificateV2`, certificate inclusion и OpenSSL/текущий GOST
  verifier.
- Зафиксировать только безопасные технические свойства и adapter contracts;
  персональные CMS/сертификаты в repository не добавлять.
- Если любой provider не создаёт требуемый CAdES-BES или меняет исходные
  байты, остановить реализацию и пересмотреть scope.

### Этап 1 — verifier и API contracts

- Сначала добавить deterministic RSA attached/detached fixtures и negative
  corpus.
- Реализовать packaging-aware verifier, schemas, typed sessions и два CAdES
  endpoints.
- На этом этапе CMS можно вернуть только из тестового in-memory boundary;
  UI и production не менять.

### Этап 2 — typed artifact storage

- Обобщить result metadata/routes для PDF, `.p7s` и `.p7m`.
- Сохранить прежние PDF capability URL, preview semantics и restart recovery.
- Добавить disk reservation и cleanup tests для крупной attached CMS.

### Этап 3 — provider adapters

- Добавить CryptoPro `SignCades` и Rutoken packaging option только внутри
  соответствующих adapters.
- Покрыть mocks: exact input base64, CAdES-BES constant, attached flag,
  certificate/ESS options, PIN login/logout и ошибки provider-а.
- Убедиться, что существующий PAdES adapter path и его snapshots не изменились.

### Этап 4 — UI и orchestration

- Добавить отдельный CAdES workflow, confirmation и download-only result.
- Проверить переключение provider-а и product mode, повторный запуск,
  cancellation, expiry и отсутствие stale certificate/file state.
- Не добавлять preview или распаковку attached CMS в браузере.

### Этап 5 — integration и rollout

- Прогнать полный прежний PAdES corpus и новый CAdES corpus локально, в CI и
  server staging.
- Выполнить real-provider smoke для четырёх комбинаций без сохранения
  персональных artifacts.
- Перед rollout создать обычный backup; canary обязан отдельно пройти
  существующий PAdES full cycle и CAdES attached/detached verification.
- После deploy проверить readiness, observability, result cleanup, rollback,
  disk headroom и неизменность 12 legacy PDF.

## 6. Обязательные тесты

- Adapter mocks для CryptoPro/Rutoken × attached/detached.
- Deterministic attached/detached CMS с одинаковым binary fixture.
- OpenSSL verify: detached только с внешним content, attached без него.
- Побайтовое совпадение embedded content, включая `0x00`, non-UTF-8 и CR/LF.
- Tampered content, tampered signature, wrong packaging, unexpected
  certificate, multiple signers, missing/duplicate attributes,
  non-canonical DER и oversized CMS.
- Cross-contour session misuse, expiry, replay, concurrent complete, abort,
  queue overflow, rate limit и cleanup race.
- Result headers, safe filename, download-only capability, TTL/restart и disk
  capacity.
- Browser flow для обоих providers и обоих packaging modes поверх mocks.
- Полный regression существующих 73 тестов, 1–4 PAdES signatures, malformed
  corpus, fixtures, SBOM и audits.

## 7. Definition of Done

Функция считается готовой только если:

- оба реальных provider-а создают attached и detached CAdES-BES над теми же
  исходными байтами;
- сервер fail-closed проверяет packaging, embedded/external content,
  cryptographic integrity и exact certificate binding;
- detached результат проверяется только вместе с исходным файлом, attached
  самостоятельно содержит побайтово совпадающий файл;
- PAdES API, `/ByteRange`, PDF result URLs и golden corpus не изменились;
- UI не смешивает CAdES с PAdES и не заявляет проверку доверия/КЭП;
- CMS/PIN/file content/capability tokens не попадают в logs или metrics;
- TTL, storage limits, cleanup, restart recovery, CI/CD rollback и disk
  retention подтверждены тестами;
- production smoke пройден на CryptoPro и Рутокен для обоих packaging modes.

До выполнения этапа 0 оценки остальных этапов считаются предварительными.
