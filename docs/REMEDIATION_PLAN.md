# План устранения проблем после аудита

Дата аудита: 2026-07-28  
Репозиторий: `code-agent-43824/pdf-signing-demo`  
Статус документа: реализация начата

## 1. Цель и обязательные инварианты

Цель — перевести работающий демонстрационный контур в состояние, в котором
результат подписи можно проверяемо считать корректным, а публичный сервис не
позволяет неавторизованным пользователям менять конфигурацию, исчерпывать
ресурсы или оставлять документы на неопределённый срок.

При любых изменениях обязательны следующие инварианты:

1. Уже существующие подписи в загруженном PDF не должны становиться
   криптографически недействительными из-за неинкрементальной перезаписи.
2. Новый `/ByteRange` должен точно соответствовать данным, переданным
   криптопровайдеру для подписи.
3. В PDF должна встраиваться только CMS, криптографически соответствующая
   подготовленному документу.
4. Визуальный штамп не является доказательством действительности или
   квалифицированности подписи.
5. Нельзя заявлять об успешной КЭП, пока отдельно не подтверждены:
   целостность CMS, сертификат подписанта и требуемый профиль доверия.
6. Каждая фаза должна иметь автоматические регрессионные проверки и
   обратимый deployment.

## 2. Приоритеты

- **P0** — закрыть возможность компрометации, ложного успешного результата
  или остановки публичного сервиса.
- **P1** — сделать криптографический и PDF-контур проверяемым,
  воспроизводимым и наблюдаемым.
- **P2** — снизить стоимость сопровождения и безопасно разделить монолиты.

Переход к следующей фазе допускается только после выполнения критериев
готовности текущей фазы.

## 3. Фаза 0 — зафиксировать эталон до изменений (P0)

### Работы

- Создать каталог тестовых PDF:
  - простой одностраничный PDF;
  - многостраничный PDF;
  - PDF с AcroForm;
  - PDF с одной, двумя и тремя действующими подписями;
  - PDF с пустыми signature fields;
  - PDF с нестандартными `MediaBox`/`CropBox` и поворотом страниц;
  - намеренно повреждённые PDF и CMS.
- Зафиксировать обезличенные CMS-фикстуры для поддерживаемых алгоритмов
  CryptoPro и Рутокен.
- Для каждого эталона хранить:
  - SHA-256 исходного PDF;
  - ожидаемый `/ByteRange`;
  - ожидаемое количество signature fields;
  - ожидаемый статус старых и новой подписей;
  - ожидаемое размещение штампа.
- Добавить интеграционный тест полного цикла `prepare -> sign fixture ->
  complete -> validate`.
- Выбрать не менее двух независимых валидаторов результата:
  один программный и один применяемый в целевой среде. Проверка должна
  включать предыдущие подписи после добавления новой.
- Снять baseline текущего production-поведения и сохранить только
  обезличенные результаты.

### Критерии готовности

- Тестовый набор воспроизводится локально и в CI.
- Зафиксирован текущий корректный результат для 1–4 последовательных
  подписей.
- Любое изменение PDF-конвейера можно сравнить с baseline.

### Ход выполнения — 2026-07-28/29

Статус: **завершено с явно принятым исключением для персональных реальных
GOST-файлов**.

Выполнено:

- добавлен детерминированный committed-корпус из семи файлов:
  одностраничный, многостраничный, AcroForm, пустое signature field,
  нестандартная геометрия, повреждённый PDF и повреждённая CMS;
- для каждого committed-файла зафиксированы SHA-256, размер и структурные
  ожидания в `test/fixtures/manifest.json`;
- добавлен динамический сценарий 1–4 инкрементальных подписей без
  сохранения закрытого ключа в репозитории;
- каждый инкремент проверяет, что прежний PDF сохранён как неизменённый
  префикс;
- каждая из всех ранее добавленных и новой подписей проверяется двумя
  независимыми средствами: OpenSSL CMS и pyHanko PDF validation;
- добавлены malformed PDF/CMS negative cases;
- добавлен read-only production baseline с удалением абсолютных путей
  перед хешированием JSON;
- добавлены воспроизводимые команды запуска и GitHub Actions workflow;
- локальный прогон: 4 теста успешно, 0 ошибок, 1 ожидаемый TODO для
  серверного отклонения malformed CMS (относится к фазе 2).
- GitHub Actions run
  [`30395001009`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30395001009)
  завершился успешно за 29 секунд: корпус воспроизведён без diff, golden
  tests и dependency gate прошли;
- commit `9d9fca6` развёрнут в
  `/home/openclaw/services/pdf-signing-demo/current`; перед копированием
  rsync сохранил заменяемые файлы в
  `/home/openclaw/services/pdf-signing-demo/backups/20260728T201200Z-golden-baseline`;
- golden-прогон на production-хосте прошёл на Node `22.22.2`,
  Python `3.14.4`, pyHanko `0.35.1` и OpenSSL `3.5.5`:
  4 теста успешно, 0 ошибок, 1 ожидаемый TODO;
- после рестарта `pdf-signing-demo.service` активен, `NRestarts=0`;
  read-only сравнение подтвердило неизменность всех пяти endpoint
  production baseline, а существующие файлы `public/generated` сохранены.

Исключение, принятое владельцем проекта 2026-07-29:

- реальные файлы Рутокен и CryptoPro содержат персональный сертификат и
  не добавляются ни в публичный golden-корпус, ни в репозиторий;
- оба файла проверены разово и без сохранения персональных реквизитов:
  точный `/ByteRange`, Streebog-256 document digest и подпись
  ГОСТ Р 34.10-2012/256 криптографически корректны; signer certificate и
  signed attributes совпадают, а CryptoPro дополнительно включает
  сертификат издателя;
- исходные PDF различаются, поэтому результат подтверждает корректность
  обоих provider flows независимо, но не является same-input A/B-тестом;
- динамический committed-контур продолжает использовать временный RSA
  test certificate для воспроизводимой проверки PDF/CMS mechanics.

Таким образом, критерии фазы закрыты воспроизводимым обезличенным корпусом,
а GOST-совместимость подтверждена отдельной transient-проверкой без
нарушения конфиденциальности.

## 4. Фаза 1 — немедленное ограничение публичной поверхности (P0)

### 4.1. Конфигурация штампа

- Удалить публичный `POST /api/stamp-config` либо вынести его в отдельный
  административный контур с аутентификацией, авторизацией и CSRF-защитой.
- Оставить пользовательские настройки только в браузере, если серверное
  редактирование не является обязательным требованием.
- Не возвращать клиенту `configPath` и абсолютные пути шрифтов.
- Серверные изменения конфигурации выполнять атомарно: временный файл,
  `fsync`, rename, резервная копия последней валидной версии.

### 4.2. Схемы и лимиты

- Ввести общую строгую JSON Schema для `stampConfig`, `signer`, `prepare`
  и `complete`.
- Запрещать неизвестные поля там, где расширяемость не требуется.
- Ограничить:
  - размер PDF до документированного значения;
  - decoded-размер base64, а не только размер JSON;
  - размеры и число страниц PDF;
  - `width`, `height`, `imageScale`, размеры шрифтов и число строк;
  - `bytesReserved`;
  - координаты, число подписей и число страниц для штампа;
  - длину строк метаданных и DN.
- Строго проверять base64 и magic bytes `%PDF-`.
- Разрешать шрифты только из заранее сформированного allowlist по
  стабильному ID; не принимать файловые пути от клиента.
- Возвращать клиенту безопасные коды ошибок, а технические подробности
  писать только в серверный лог с correlation ID.

### 4.3. Сетевой и HTTP-контур

- Явно слушать `127.0.0.1`, а не все интерфейсы.
- Перенести health route внутрь base-path router и разделить:
  - liveness — процесс отвечает;
  - readiness — доступны Python runtime, конфигурация и writable storage.
- Отключить `x-powered-by`.
- Добавить rate limiting отдельно для `prepare` и `complete`.
- Ограничить request timeout, body timeout и число одновременных операций
  на один IP/сессию.

### Критерии готовности

- Неавторизованный пользователь не может изменить серверную конфигурацию.
- Запросы с экстремальными параметрами отклоняются до запуска Python.
- `/pdf-signing/health/live` и `/pdf-signing/health/ready` возвращают
  ожидаемый статус через production reverse proxy.
- Node-порт недоступен извне напрямую.

### Ход выполнения PR-2 — 2026-07-30

Статус фазы: **PR-2 завершён и развёрнут; схемы, лимиты, safe errors,
loopback bind, rate limits и timeouts остаются в PR-3/PR-6**.

Выполнено:

- удалён публичный `POST /api/stamp-config`; персональные настройки
  штампа сохраняются только в браузере;
- `GET /api/stamp-config` больше не возвращает `configPath`;
- абсолютные пути шрифтов заменены клиентскими opaque IDs, которые
  сервер сопоставляет с собственным allowlist перед подготовкой PDF;
- `GET /api/fonts` возвращает только `id` и отображаемое имя шрифта;
- прежние браузерные настройки с серверным или project-relative путём
  продолжают работать только тогда, когда путь совпадает с разрешённым
  шрифтом сервера;
- health перенесён внутрь base-path router и разделён на
  `/health/live` и `/health/ready`; readiness проверяет Python runtime,
  валидность конфигурации и writable storage;
- добавлены production-like API-регрессии: config write отклоняется без
  изменения файла, пути не раскрываются, opaque font IDs разрешаются в
  реальный `prepare`, оба health endpoint работают под `BASE_PATH`.

Проверка и rollout:

- локально: 8 тестов успешно, 0 ошибок, 1 ожидаемый TODO фазы 2;
- commit `7303d18` запушен; GitHub Actions run
  [`30518905385`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30518905385)
  завершился успешно;
- production backup:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T061420Z-pr2`;
- полный тестовый набор на production runtime: 8 pass, 0 fail,
  1 ожидаемый TODO;
- после рестарта сервис active, `NRestarts=0`, существующие 12 generated
  PDF сохранены;
- через публичный Caddy route оба health endpoint возвращают `200`,
  старый `/pdf-signing/health` и запрещённый config POST возвращают `404`;
- SHA-256 серверного config до и после запрещённого POST совпадает;
- публичный `prepare` с opaque font IDs успешно вернул корректный
  четырёхэлементный `ByteRange`;
- browser smoke подтвердил корректную загрузку UI, отсутствие абсолютных
  путей в диалоге и выбор шрифтов по opaque IDs. Ошибок приложения в
  console нет; есть только ожидаемые ошибки отсутствующих crypto
  extensions в изолированном браузере.

### Ход выполнения PR-3 — 2026-07-30

Статус фазы: **PR-3 завершён и развёрнут; rate limiting, request/worker
timeouts и concurrency control остаются в PR-6**.

Выполнено:

- добавлены общие strict JSON Schema на Ajv для `prepare`, `complete`,
  `signer` и полного `stampConfig`; неизвестные поля запрещены на каждом
  уровне;
- до запуска Python проверяются типы, обязательные поля и границы строк,
  DN, строк штампа, шрифтов, размеров, координат, страниц,
  `bytesReserved`, правил размещения и `maxSignatures`;
- JSON body ограничен 15 MiB; требуется `Content-Type:
  application/json`;
- PDF ограничен 10 MiB после строгого base64 decode, должен начинаться с
  `%PDF-`, содержать 1–200 страниц и не превышать 14 400 pt по каждой
  стороне страницы;
- настройки штампа не могут ссылаться на отсутствующие страницы PDF;
- rendered stamp ограничен 4096 px по каждой стороне и 16 777 216 px
  суммарно, что блокирует опасные сочетания `width × height ×
  imageScale`;
- CMS ограничена 128 KiB после строгого base64 decode, а её размер
  дополнительно сверяется с резервом `/Contents`;
- клиент больше не может отправить файловый путь шрифта: сервер принимает
  только opaque ID из собственного каталога; frontend однократно
  мигрирует старый сохранённый путь по точному имени разрешённого шрифта
  либо сбрасывает его к серверному значению;
- внешние ошибки имеют фиксированные `code`/`message`, не содержат
  exception/path details и включают `requestId`; тот же ID возвращается
  в `X-Request-Id`, а технические сведения пишутся структурированно в
  server log без request body;
- отключён `x-powered-by`; Node явно слушает только `127.0.0.1`;
- Ajv зафиксирован на `8.20.0`; транзитивные `body-parser` и `qs`
  обновлены до исправленных версий, итоговый production dependency audit
  содержит 0 уязвимостей.

Проверка и rollout:

- локально после чистого `npm ci`: 15 тестов успешно, 0 ошибок,
  1 ожидаемый TODO фазы 2; committed fixtures воспроизведены без diff,
  syntax checks и dependency audit прошли;
- commit `f2c95d7` запушен; GitHub Actions run
  [`30521004680`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30521004680)
  завершился успешно;
- production backup:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T065358Z-pr3`;
- полный тестовый набор на production runtime: 15 pass, 0 fail,
  1 ожидаемый TODO;
- после рестарта сервис active, `NRestarts=0`, socket виден только как
  `127.0.0.1:3010`, существующие 12 generated PDF сохранены;
- публичный HTTPS smoke успешно выполнил реальный `prepare`, а unknown
  field, файловый путь шрифта, PDF размером 10 MiB + 1 byte и
  отсутствующая session получили ожидаемые безопасные `400/413/404`
  ответы с correlation IDs;
- browser smoke подтвердил миграцию сохранённого legacy font path в
  opaque ID, работу диалога и отсутствие filesystem paths. Ошибок
  приложения в console нет; присутствуют только ожидаемые ошибки
  отсутствующих crypto extensions в изолированном браузере;
- production journal подтвердил структурированные validation records без
  содержимого PDF, CMS и request body.

## 5. Фаза 2 — проверка CMS и честная семантика результата (P0)

### 5.1. Разделить уровни проверки

Ввести три независимых статуса:

1. **CMS integrity valid** — CMS корректна и подписывает точное содержимое
   текущего `/ByteRange`.
2. **Certificate trusted** — построена допустимая цепочка, проверены срок,
   отзыв и назначение ключа согласно выбранной политике.
3. **Qualified status confirmed** — сертификат и подпись отвечают явно
   заданной политике квалифицированной подписи.

UI не должен заменять эти статусы одним безусловным сообщением «КЭП
успешна».

### 5.2. Серверная проверка до встраивания

- Строго разобрать CMS DER и отклонять:
  - невалидный base64/DER;
  - attached CMS вместо ожидаемой detached CMS;
  - пустой или неоднозначный набор signer infos;
  - неподдерживаемые алгоритмы;
  - отсутствие обязательных signed attributes.
- Проверить `messageDigest` на точном содержимом подготовленного
  `/ByteRange`.
- Проверить криптографическую подпись signed attributes.
- Сопоставить сертификат из CMS с сертификатом, выбранным на клиенте:
  fingerprint/serial/issuer должны приходить не как доверенные данные
  штампа, а извлекаться сервером из проверенной CMS.
- Только после успешной проверки встраивать CMS и сохранять PDF.
- При ошибке не уничтожать signing session немедленно: оставить
  ограниченную повторную попытку либо завершать её явным неизменяемым
  статусом. Исключить replay после успешного завершения.
- После встраивания повторно открыть итоговый PDF валидатором и проверить
  новую и все предыдущие подписи.

### 5.3. Выбор GOST-валидатора

Перед реализацией сделать короткий технический spike и выбрать один
поддерживаемый вариант:

- серверный CryptoPro CSP/сертифицированный инструмент;
- библиотека с подтверждённой поддержкой требуемых GOST CMS-алгоритмов;
- отдельный доверенный validation service.

Решение принимается только после проверки на реальных обезличенных
CryptoPro- и Рутокен-фикстурах. ASN.1-разбор без проверки подписи не
считается валидатором.

### 5.4. Нормализация CMS

- Убрать поведение «ошибка нормализации — продолжить как есть».
- Ограничить GOST parameter fix точным сертификатом соответствующего
  `SignerInfo`, а не первым сертификатом CMS.
- Покрыть исходную и нормализованную CMS тестами, подтверждающими, что
  нормализация не меняет подписанные атрибуты и не маскирует невалидную
  подпись.

### Критерии готовности

- Случайная, повреждённая, чужая и повторно отправленная CMS отклоняется.
- Подмена `signer`-метаданных не меняет данные в итоговом штампе.
- Итоговый PDF проходит оба выбранных валидатора.
- UI различает целостность, доверие и квалифицированный статус.

### Ход выполнения PR-4 — 2026-07-30

Статус: **серверная часть фазы 2 завершена; честное разделение статусов в
UI остаётся в PR-5**.

Выполнено:

- frontend передаёт в `prepare` DER выбранного сертификата вместо
  доверенных строк `subject`/`issuer`/`thumbprint`; сервер строго разбирает
  сертификат, сам формирует данные визуального штампа и сохраняет его
  SHA-256 в signing session;
- `complete` до встраивания строго разбирает canonical CMS DER, требует
  detached `SignedData`, ровно один `SignerInfo`, поддерживаемые алгоритмы
  и обязательные `contentType`, `messageDigest`,
  `signingCertificateV2`;
- сертификат подписанта выбирается по SID соответствующего `SignerInfo`,
  а не по позиции в CMS, после чего проверяются ESSCertIDv2 и точное
  совпадение сертификата с `prepare`;
- `messageDigest` пересчитывается по точному prepared `/ByteRange`,
  затем криптографически проверяется подпись DER signed attributes;
- реализована серверная проверка RSA/ECDSA с SHA-256/384/512 и ГОСТ Р
  34.10-2012/256/512 со Стрибог-256/512 на разрешённых наборах параметров;
- после встраивания из итогового PDF повторно извлекаются и проверяются
  новая и все предыдущие CMS-подписи до сохранения результата;
- невалидная CMS оставляет сессию доступной для ограниченной повторной
  попытки, успешный `complete` потребляет её и блокирует replay;
- нормализация CMS стала fail-closed и получает параметры из сертификата
  точного `SignerInfo`, а не первого сертификата контейнера;
- добавлены регрессии для malformed/attached/non-CAdES CMS, подмены
  content, подписи и сертификата, retry после ошибки, replay после успеха
  и полного цикла с повторной проверкой embedded PDF;
- реальные персональные CryptoPro- и Рутокен-PDF повторно проверены
  transient новым контуром: обе ГОСТ-подписи прошли; файлы и сертификаты
  по принятому исключению не добавлялись в репозиторий.

Ограничение семантики результата:

- PR-4 подтверждает только CMS integrity и certificate binding;
- проверка цепочки доверия, отзыва и квалифицированного статуса, а также
  их раздельное отображение пользователю выполняются в PR-5.

Проверка и rollout:

- локально: 18 тестов успешно, 0 ошибок, 0 TODO; `npm audit --omit=dev` —
  0 известных уязвимостей;
- реализация зафиксирована commit `def0b57`, изоляция generated-артефактов
  тестового сервера — follow-up commit `08702a3`;
- GitHub Actions runs
  [`30567173614`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30567173614)
  и
  [`30567755557`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30567755557)
  завершились успешно;
- production backup:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T174436Z-pr4`;
- на production runtime (Node 22, Python 3.14) полный набор прошёл:
  18 pass, 0 fail, 0 TODO; test output направлен во временный каталог,
  существующие 12 generated PDF сохранены без изменений;
- публичный HTTPS smoke подтвердил новый certificate-DER `prepare`,
  точный ByteRange, безопасный отказ `CMS_INTEGRITY_FAILED` для malformed
  CMS и отказ strict schema при попытке передать подменённые signer
  metadata;
- browser smoke подтвердил загрузку production UI и открытие настроек
  штампа без ошибок приложения; присутствуют только ожидаемые ошибки
  отсутствующих crypto extensions в изолированном браузере;
- сервис после рестарта active, `NRestarts=0`, readiness зелёный, порт
  слушает только `127.0.0.1:3010`.

### Ход выполнения PR-5 — 2026-07-30

Статус: **честная семантика результата и её отображение реализованы;
trust и qualified остаются явно непроверенными до появления отдельных
политик и валидаторов**.

Выполнено:

- `complete` возвращает версионированный объект `verification` с тремя
  независимыми ветками `integrity`, `trust` и `qualified`;
- сервер выдаёт `integrity.status = valid` только после успешной
  проверки новой и всех ранее встроенных CMS-подписей и точного
  сопоставления сертификата подписанта;
- для доверия сертификату возвращается `status = not_checked` с
  отдельными непроверенными признаками `chain`, `validity`, `revocation`
  и `keyUsage`;
- квалифицированный статус возвращается как `not_checked`, без
  подразумеваемой политики и без логического shortcut из факта
  криптографической корректности;
- frontend fail-closed проверяет полный контракт ответа до показа
  результата и выводит три отдельные карточки статусов;
- безусловные утверждения о «квалифицированной подписи» удалены из
  заголовка и сообщения об успехе; зелёный подтверждённый статус
  относится только к целостности CMS;
- добавлены API- и UI-регрессии на точную структуру статусов, отсутствие
  прежнего неоднозначного поля `integrity` и запрет ложной формулировки.

Осознанное ограничение:

- PR-5 не строит PKI-цепочку и не проверяет срок, отзыв, назначение ключа
  либо соответствие квалифицированной политике; он делает отсутствие
  этих проверок явным и машинно-читаемым;
- реализация trust/revocation/qualified policy потребует выбранных
  trust anchors, источника статусов отзыва и формальной политики и не
  должна подменяться UI-текстом.

Проверка и rollout:

- локально и на production runtime: 19 тестов успешно, 0 ошибок,
  0 TODO; `npm audit --omit=dev` — 0 известных уязвимостей;
- реализация зафиксирована commit `4c4bbf7`, найденное browser smoke
  мобильное переполнение длинного status badge исправлено follow-up
  commit `38f74bb`;
- GitHub Actions runs
  [`30570139319`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30570139319)
  и
  [`30570856699`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30570856699)
  завершились успешно;
- production backup:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T182413Z-pr5`;
- публичный HTTPS smoke выполнил полный цикл
  `prepare → CAdES → complete → download` и подтвердил точный контракт
  `integrity=valid`, `trust=not_checked`, `qualified=not_checked`;
  синтетический результат убран из публичного каталога в backup;
- desktop/mobile browser smoke подтвердил раздельные карточки,
  отсутствие внутреннего переполнения и ложного утверждения о КЭП;
  ошибок приложения в console нет, кроме ожидаемых обращений к
  отсутствующим crypto extensions;
- исходные 12 generated PDF сохранены побайтово, сервис active,
  `NRestarts=0`, readiness зелёный, порт слушает только
  `127.0.0.1:3010`.

## 6. Фаза 3 — изоляция тяжёлой обработки и жизненный цикл данных (P0/P1)

### 6.1. Worker-модель

- Заменить `execFileSync` на изолированный worker/очередь с:
  - фиксированным concurrency;
  - wall-clock timeout;
  - лимитом памяти и CPU;
  - kill всей process group по timeout;
  - минимальным окружением;
  - отдельным временным каталогом;
  - запретом сети, если она не нужна валидатору.
- Node event loop не должен блокироваться во время обработки PDF.
- Не передавать крупные PDF через JSON/base64 между внутренними
  компонентами; использовать bounded stream или временный файл с
  контролируемыми правами.

### 6.2. Сессии и документы

- Ввести конечный автомат signing session:
  `prepared -> completed|failed|expired`.
- Хранить только необходимый минимум и установить:
  - TTL;
  - общий лимит памяти/диска;
  - лимит на пользователя/IP;
  - гарантированную очистку после завершения и рестарта.
- Не раздавать `public/generated` через общий static middleware.
- Выдавать результат через короткоживущий capability URL,
  с `Content-Disposition: attachment`, `Cache-Control: no-store` и
  авторизацией, если появятся учётные записи.
- Документировать retention policy и не писать содержимое PDF/CMS/PIN в
  логи.

### Критерии готовности

- Параллельные тяжёлые запросы не блокируют health endpoint.
- Timeout и превышение лимитов завершают worker без остаточных процессов
  и файлов.
- Просроченный URL результата не скачивает документ.
- Автотест подтверждает очистку RAM, temp-файлов и готовых PDF.

### Ход выполнения PR-6 — 2026-07-30

Статус: **worker isolation, bounded concurrency, rate limiting и
timeouts реализованы; private result storage/TTL остаются в PR-7**.

Выполнено:

- runtime-вызовы Python переведены с `execFileSync` на асинхронный
  `spawn` без shell, поэтому ожидание PDF/CMS worker не блокирует Node
  event loop;
- каждый worker запускается в отдельной process group через `prlimit` с
  лимитами address space, CPU time и open files, минимальным окружением,
  ограниченным stdout/stderr и приватным временным каталогом;
- wall-clock timeout и abort отключившегося клиента завершают сначала
  `SIGTERM`, затем всю process group через `SIGKILL`; временные файлы
  удаляются в `finally`;
- `prepare` и `complete` проходят через общую bounded queue с
  фиксированным concurrency, максимальной глубиной и timeout ожидания;
  дополнительно сериализованы `prepare` одного IP и `complete` одной
  signing session;
- добавлены отдельные fixed-window rate limits для `prepare` и
  `complete`, безопасные `429 RATE_LIMITED`, `503 SERVER_BUSY` и
  `504 OPERATION_TIMEOUT`, а также `Retry-After`/RateLimit headers;
- настроены Node headers/request/socket timeouts; loopback proxy
  объявлен единственным доверенным источником forwarded IP;
- readiness больше не блокирует event loop: Python probe коалесцируется
  и кэшируется на пять секунд, а live worker counters возвращаются при
  каждом запросе;
- reference systemd unit фиксирует те же лимиты и добавляет cgroup
  `TasksMax`, `MemoryMax`, `CPUQuota`, `KillMode=control-group`,
  `PrivateTmp` и безопасные sandbox-флаги;
- регрессии проверяют глобальный/per-key concurrency, queue overflow,
  operation timeout, rate window, неблокирующий event loop, доступность
  health под двумя параллельными prepare и отсутствие дочернего процесса
  после timeout.

Проверка и rollout:

- локально и на production runtime: 26 тестов успешно, 0 ошибок,
  0 TODO; `npm audit --omit=dev` — 0 известных уязвимостей;
- реализация зафиксирована commit `3b9d985`; несовместимый с данным
  user manager `ProtectKernelModules` удалён follow-up commit `da2be25`
  после отдельной проверки каждого sandbox-флага;
- GitHub Actions runs
  [`30573220712`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30573220712)
  и
  [`30573542220`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30573542220)
  завершились успешно;
- production backup кода, unit и manifest существующих результатов:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T190532Z-pr6`;
- первый restart с несовместимым sandbox-флагом получил
  `218/CAPABILITIES`; автоматический rollback полностью восстановил
  прежний код/unit и green readiness. После точной диагностики compound
  transient unit с оставшимися ограничениями прошёл, повторный rollout
  завершился успешно;
- публичный HTTPS smoke выполнил полный
  `prepare → CAdES → complete → download`; сохранённый в backup
  синтетический результат повторно прошёл серверный CMS-валидатор;
- при 10 одновременных `prepare` один worker обработал 5 запросов, ещё 5
  получили контролируемый `503 SERVER_BUSY` по queue limits; liveness
  ответил за 4,8 ms, остаточных Python-процессов нет;
- публичный reverse-proxy contour пропустил 12 запросов за окно и вернул
  `429 RATE_LIMITED` с `Retry-After` ровно на 13-м;
- после очистительного рестарта сервис active, `NRestarts=0`, readiness
  зелёный, socket только `127.0.0.1:3010`; cgroup фиксирует один CPU,
  `MemoryMax=768 MiB`, `TasksMax=64`, `PrivateTmp`, `NoNewPrivileges` и
  `KillMode=control-group`;
- исходные 12 generated PDF сохранены побайтово; синтетический smoke
  artifact удалён из публичного каталога и оставлен только в backup.

### Ход выполнения PR-7 — 2026-07-30

Статус: **private result storage, конечный lifecycle, TTL и cleanup
реализованы и развёрнуты в production**.

Выполнено:

- signing session переведена в конечный автомат
  `prepared -> completed|failed|expired`; terminal transition немедленно
  освобождает PDF/content buffers, оставляя только короткоживущий
  обезличенный tombstone против replay;
- TTL подготовленной сессии — 10 минут; установлены лимиты 16 активных
  sessions, 3 с одного IP и 64 MiB суммарных буферов;
- готовые PDF вынесены из web-root в приватный `RESULTS_DIR`, создаются
  с mode `0600`, каталог — `0700`; лимиты — 32 результата и 128 MiB;
- API выдаёт раздельные 32-byte random capability: короткоживущий
  preview и одноразовый download. В памяти хранятся только SHA-256
  токенов, а не сами capability;
- обе ссылки и файл истекают через 10 минут; download получает
  `Content-Disposition: attachment`, preview — `inline`, оба —
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` и
  `X-Content-Type-Options: nosniff`;
- `/generated` явно закрыт до общего static middleware; `RESULTS_DIR`
  fail-closed запрещено размещать внутри `public`;
- background cleanup запускается каждые 30 секунд. На старте процесса
  все orphan result/temp files удаляются, поскольку после рестарта
  in-memory capability уже невосстановимы;
- пути capability редактируются в structured errors до
  `/api/results/:capability`; содержимое PDF/CMS/PIN и токены не
  логируются;
- frontend fail-closed проверяет оба capability URL и expiry, использует
  отдельную одноразовую download-ссылку и сообщает пользователю retention.

Проверка и rollout:

- локально и на production runtime: 33 теста успешно, 0 ошибок,
  0 TODO; `npm audit --omit=dev` — 0 известных уязвимостей;
- реализация зафиксирована commit `6a61d43`; GitHub Actions run
  [`30575409334`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30575409334)
  завершился успешно;
- production backup кода, unit, полных копий и SHA-256 manifest всех
  прежних результатов:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T193544Z-pr7`;
- 12 прежних PDF побайтово сверены с backup и перенесены из web-root в
  `/home/openclaw/services/pdf-signing-demo/legacy-results/pre-pr7-20260730T193544Z`
  с правами каталогов `0700` и файлов `0600`; прежний публичный URL
  возвращает `404 RESULT_NOT_FOUND`;
- публичный HTTPS smoke выполнил полный
  `prepare -> CAdES -> complete -> preview x2 -> download -> replay`:
  verification `valid / not_checked / not_checked`, preview повторяем до
  TTL, `HEAD` не расходует download capability, download игнорирует Range
  и отдаёт полный PDF как attachment, повторный GET возвращает 404;
- полученный smoke PDF (44 472 байта) независимо проверен pyHanko:
  подпись intact/valid/trusted, покрытие `ENTIRE_FILE`;
- до рестарта приватный result существовал с mode `0600`, session buffers
  были освобождены (`memoryBytes=0`); после рестарта result storage
  автоматически стал пустым, прежний preview capability вернул 404;
- browser smoke подтвердил загрузку production UI, работу диалога
  настроек, отсутствие filesystem paths и старых `/generated` ссылок.
  Единственные console errors относятся к ожидаемо отсутствующему
  crypto-extension в изолированном браузере, не к приложению;
- Caddy access log для сайта не включён; structured application log
  подтвердил редактирование capability до
  `/api/results/:capability`;
- после финального рестарта сервис active, `NRestarts=0`, readiness
  зелёный, result counters нулевые, socket только `127.0.0.1:3010`.

## 7. Фаза 4 — защита браузерного криптоконтура (P1)

- Добавить CSP с минимальным `script-src`, запретом inline-кода и
  `frame-ancestors 'none'`.
- Добавить `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, подходящий `Permissions-Policy`,
  `Cache-Control: no-store` для API и чувствительных ответов.
- Зафиксировать происхождение и версию CryptoPro/Rutoken scripts:
  предпочтительно проверенный локальный vendor artifact с checksum и
  описанной процедурой обновления. Если внешний script обязателен,
  документировать риск и применить доступный integrity-контроль.
- Не хранить PIN, не логировать его и минимизировать время жизни строки PIN
  в JS. После `login` очищать поле и ссылки на значение в `finally`.
- Добавить явное подтверждение перед криптооперацией: имя документа,
  fingerprint сертификата и digest документа.
- Проверять `notBefore`, `notAfter`, наличие private key и key usage до
  показа сертификата как пригодного для подписи.

### Критерии готовности

- Страница не открывается во внешнем iframe.
- CSP проходит в enforcing mode без нарушений рабочего потока обоих
  криптопровайдеров.
- PIN отсутствует в DOM, памяти состояния и логах после операции настолько,
  насколько это контролируется приложением.

### Ход выполнения PR-8 — 2026-07-30

Статус: **browser crypto boundary, CSP, vendor provenance и
anti-clickjacking реализованы и развёрнуты в production**.

Выполнено:

- все ответы приложения получают enforcing CSP:
  `default-src 'self'`, `script-src 'self' chrome-extension:`,
  `script-src-attr 'none'`, `frame-ancestors 'none'`,
  `form-action 'none'`; Internet script origins, inline scripts и event
  handlers не разрешены;
- для совместимости с реальными browser adapter-ами оставлены только
  необходимые узкие исключения: `chrome-extension:` для CryptoPro,
  `object-src 'self'` для plugin objects и `cpnp-js-call:` для Safari
  bridge; произвольные внешние script/frame/object origins запрещены;
- добавлены `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  ограниченный `Permissions-Policy` и
  `Cache-Control: no-store, private, max-age=0` с legacy no-cache
  заголовками;
- production Caddy перестал добавлять к `/pdf-signing/*` общий
  `Referrer-Policy: strict-origin-when-cross-origin`: путь исключён из
  site-wide header matcher. Browser security headers принадлежат
  приложению, Caddy отдельно сохраняет HSTS; публичный ответ содержит
  ровно по одному значению каждого security header;
- CryptoPro `cadesplugin_api.js` перенесён с runtime URL в локальный
  vendor: 42 363 байта, SHA-256
  `d54cfe9186c4b6dbe9ed73d83f289d31da7b50000b48ba3e7c278e820578086b`;
- локальный Rutoken adapter точно сопоставлен с
  `@aktivco/rutoken-plugin@1.0.9`: 2 897 байт, SHA-256
  `612514f867c0b54db498edf470908696e1eec3389914db5740e0c2252b339ce2`;
  BSD-2-Clause license сохранена рядом;
- оба runtime vendor asset имеют SHA-384 SRI; SHA-256 manifest
  проверяется тестами. Источники, дата получения, checksum и процедура
  ручного обновления зафиксированы в `docs/VENDOR_ASSETS.md`;
- неиспользуемый публичный `@qiwitech/cryptopro` bundle удалён из
  web-root;
- CryptoPro до показа сертификата fail-closed проверяет `notBefore`,
  `notAfter`, `HasPrivateKey`, `KeyUsage.IsPresent`,
  `IsDigitalSignatureEnabled` и `IsNonRepudiationEnabled`;
- Rutoken показывает только `CERT_CATEGORY_USER`, которая связана с
  закрытым ключом, и дополнительно проверяет обе границы срока и
  `keyUsage` из parsed certificate;
- перед `prepare` появился обязательный confirm с именем PDF, SHA-256
  исходного документа, именем сертификата и fingerprint; данные
  вставляются через `textContent`;
- PIN не хранится в global state, очищается в input до удаления диалога,
  а локальная ссылка обнуляется в `finally` непосредственно после
  `login`; browser smoke подтвердил пустые live DOM и template после
  cancel. Логи после smoke не содержат тестового PIN.

Проверка и rollout:

- локально и на production runtime: 38 тестов успешно, 0 ошибок,
  0 TODO; `npm audit --omit=dev` — 0 известных уязвимостей;
- реализация зафиксирована commit `efd707a`; GitHub Actions run
  [`30578509794`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30578509794)
  завершился успешно;
- production backup кода, systemd unit, исходного Caddy config и
  manifest 12 прежних PDF:
  `/home/openclaw/services/pdf-signing-demo/backups/20260730T201945Z-pr8`;
- Caddy candidate и итоговый `/etc/caddy/Caddyfile` прошли
  `caddy validate`; reload выполнен без restart, Caddy остаётся active,
  `NRestarts=0`;
- публичные CryptoPro/Rutoken vendor bytes совпали с pinned SHA-256;
  `app.js` не содержит runtime third-party URL;
- публичный full-cycle
  `prepare -> CAdES -> complete -> preview x2 -> download -> replay`
  вернул `valid / not_checked / not_checked`, одноразовый replay —
  `404`; итоговый PDF 44 460 байт независимо проверен pyHanko как
  intact/valid/trusted с покрытием `ENTIRE_FILE`;
- production browser smoke загрузил оба локальных adapter-а с ожидаемым
  SRI, открыл настройки и confirm, подтвердил очистку PIN и блокировку
  iframe. CSP violations отсутствовали; console errors относятся только
  к намеренно отсутствующим crypto extensions в изолированном браузере
  и к тестовой блокировке frame;
- все 12 прежних персональных PDF повторно сверены по SHA-256; файлы и
  сертификаты не возвращались в web-root или репозиторий.

## 8. Фаза 5 — воспроизводимость и зависимости (P1)

- Добавить `requirements.txt`/lock или `pyproject.toml` с точными версиями
  Python-зависимостей и поддерживаемой версией Python.
- Зафиксировать поддерживаемую версию Node.js через `engines` и
  `.nvmrc`/`.node-version`.
- В CI использовать `npm ci`, а не `npm install`.
- Обновить lockfile так, чтобы устранить advisory для `qs` и
  `body-parser`.
- Добавить отсутствующий `@pdf-lib/fontkit`, если генератор sample PDF
  остаётся, либо удалить неиспользуемый генератор.
- Удалить неиспользуемые runtime-зависимости:
  `@qiwitech/cryptopro`, `@signpdf/placeholder-pdf-lib`,
  `@signpdf/signpdf`, `@signpdf/utils`, если тесты не докажут их
  необходимость.
- Удалить или перенести в архив неиспользуемый `prepare-multisign.py`.
- Добавить SBOM и автоматический dependency audit в CI.
- Обновить README: архитектура, точный bootstrap, лимиты, API, validation
  semantics, retention и deployment.

### Критерии готовности

- Чистый checkout собирается и тестируется одной документированной
  командой.
- `npm audit` не содержит известных применимых production-уязвимостей.
- Python-окружение воспроизводимо из lock-файла.
- В runtime-дереве нет неиспользуемых зависимостей.

### Ход выполнения PR-9 — 2026-07-31

Статус: **фаза 5 завершена и развёрнута в production**.

Выполнено:

- поддерживаемый Node зафиксирован как `22.22.2` в `.node-version` и
  диапазоном `>=22.22.2 <23` в `engines`; npm зафиксирован как `10.9.8`,
  а CI устанавливает именно эту версию;
- прямые Python runtime dependencies вынесены в `requirements.in`,
  проверенный production transitive closure — в
  `requirements.constraints.txt`; полный `requirements.txt` создан
  `pip-compile` и требует SHA-256 hashes для каждого разрешённого
  distribution;
- clean checkout устанавливается и полностью проверяется одной командой
  `./scripts/bootstrap-and-test.sh`: создаются `.venv`, hashed Python
  environment и `node_modules` через `npm ci`, затем воспроизводятся
  fixtures, запускаются все tests, audits и SBOM consistency gate;
- Node runtime tree сокращён до трёх прямых packages: `ajv`, `express`,
  `pdf-lib`; удалены неиспользуемые `@qiwitech/cryptopro`,
  `@signpdf/placeholder-pdf-lib`, `@signpdf/signpdf` и
  `@signpdf/utils`;
- удалены неиспользуемые legacy `prepare-multisign.py` и broken sample
  generator, поэтому добавлять неиспользуемый `@pdf-lib/fontkit` не
  потребовалось;
- добавлены детерминированные CycloneDX 1.5 SBOM для полного production
  Node tree и полного Python lock. CI пересоздаёт manifests и отклоняет
  stale diff;
- добавлены regression tests минимальности runtime tree, hashes и
  соответствия обоих SBOM lockfiles; полный набор вырос до 40 tests;
- CI дополнительно выполняет `npm audit --omit=dev` и `pip-audit`
  полного Python lock. Первый audit выявил уже опубликованные advisory в
  `cryptography 48.0.0`, `Pillow 12.2.0` и `pypdf 6.10.2`; версии
  подняты до исправленных `48.0.1`, `12.3.0` и `6.14.2`, после чего оба
  audit дают 0 известных уязвимостей;
- README дополнен фактической архитектурой, exact bootstrap, API,
  validation semantics, limits, retention и production deployment;
  отдельный `docs/SUPPLY_CHAIN.md` фиксирует процедуру обновления locks,
  audit и SBOM.

Проверка и rollout:

- локальный полный прогон в заново созданном окружении из hashed lock:
  40 успешно, 0 ошибок, 0 TODO; fixtures и оба SBOM воспроизведены без
  diff, `npm audit` и `pip-audit` — 0;
- code commit `da7b8bf` запушен; GitHub Actions run
  [`30619305434`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30619305434)
  завершился успешно;
- production staging на Python `3.14.4` установился только из hashed
  lock, `pip check` прошёл; полный production-runtime suite:
  40 успешно, 0 ошибок, 0 TODO;
- rollout выполнен атомарной заменой подготовленного каталога; полный
  предыдущий runtime, service unit, environment manifests и контрольные
  данные сохранены в
  `/home/openclaw/services/pdf-signing-demo/backups/20260731T091835Z-pr9`;
- публичный full cycle `prepare -> CAdES -> complete -> preview x2 ->
  one-time download -> replay` прошёл; новая подпись независимо проверена
  pyHanko как `intact`, `valid`, `trusted`, `ENTIRE_FILE`, а API вернул
  честные `valid / not_checked / not_checked`;
- production headers/vendor hashes, закрытый `/generated`, public
  health и loopback socket проверены; все 12 прежних персональных PDF
  повторно совпали по SHA-256 и остались только в private legacy archive;
- после финального restart service active, `NRestarts=0`, readiness
  зелёный, session/result counters нулевые, socket только
  `127.0.0.1:3010`, warning/error journal пуст.

### Follow-up lifecycle/UX — 2026-07-31

- по решению владельца preview и download capability стали многократными;
  обе ссылки и приватный PDF действуют ровно 15 минут, после чего API
  отказывает, а файл и metadata удаляются;
- SHA-256 capability-токенов и expiry сохраняются рядом с PDF с правами
  `0600`, поэтому штатный restart не сокращает обещанный пользователю TTL;
- preview получает узкое исключение `frame-ancestors 'self'` и
  `X-Frame-Options: SAMEORIGIN`; общий UI/API по-прежнему защищён от
  framing через `frame-ancestors 'none'` / `DENY`;
- подробные статусы integrity/trust/qualified скрыты по умолчанию и
  раскрываются только кнопкой «Информация о подписанном файле».
- реализация `7e80d53` прошла локальный и production-runtime suite 41/41,
  `npm audit`, `pip check`, deterministic SBOM и GitHub Actions
  [`30633783838`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/30633783838);
- rollout выполнен только после штатного истечения последнего результата
  старой версии, чтобы restart не оборвал ещё действующую capability;
  backup и полный прежний runtime сохранены в
  `/home/openclaw/services/pdf-signing-demo/backups/20260731T131958Z-reusable-results`;
- публичный synthetic CAdES cycle вернул точный TTL `900000` мс,
  preview `200` дважды и download `200` дважды с идентичным SHA-256;
  pyHanko подтвердил `intact/valid/trusted/ENTIRE_FILE`;
- production browser проверен при 390 px: preview отображается, детали
  изначально скрыты и раскрываются кнопкой, horizontal overflow отсутствует;
  deploy hashes совпадают с repo, service active, `NRestarts=0`, readiness
  зелёный, socket только `127.0.0.1:3010`, warning journal пуст.

## 9. Фаза 6 — безопасная декомпозиция (P2)

Рефакторинг начинать только после появления golden tests из фазы 0.

### Backend

- Разделить `server.js` на:
  - application/bootstrap;
  - routes;
  - request schemas;
  - signing session service;
  - PDF preparation adapter;
  - CMS verification adapter;
  - result storage;
  - error mapping и observability.
- Изолировать чистые функции разбора `/ByteRange` и встраивания CMS и
  покрыть property-based/fuzz tests.

#### PR-10a — первый безопасный backend-срез (2026-08-09)

Статус: **реализован и развёрнут в production**.

- конфигурация штампа и каталог шрифтов вынесены из `src/server.js` в
  `src/stamp/configuration.js`; модуль сохраняет прежнее детерминированное
  построение opaque font ID и выполняет обратное разрешение пути только на
  сервере;
- единое отображение storage/queue/worker/CMS/certificate ошибок и
  безопасная сериализация HTTP-ответов вынесены в `src/http/errors.js`;
- `src/server.js` сокращён с 970 до 768 строк без изменения signing routes,
  PDF preparation, CMS normalization/verification или embedding;
- добавлены отдельные unit-контракты для font boundary, неизвестных font ID,
  JSON object boundary, стабильных status/code, abort semantics и редактирования
  capability path; полный suite содержит 48 тестов;
- при обязательном production audit обнаружена новая advisory
  `GHSA-7p8r-x3mc-p8w7`; транзитивный `fast-uri` обновлён lockfile-only с
  `3.1.4` до исправленного `3.1.5`; CI дополнительно обнаружил свежие
  `PYSEC-2026-3552..3554`, `CVE-2026-71852` и `CVE-2026-71870`, поэтому
  Python pins подняты до исправленных `cryptography 50.0.0` и
  `pypdf 6.15.0`;
- криптографические функции и golden fixtures в этом срезе не изменялись.

Rollout evidence:

- implementation commits: `39ce684`, dependency-lock follow-up `52b4df2`;
  финальный GitHub Actions run
  [`31310431292`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/31310431292)
  прошёл clean bootstrap, 48/48 tests и оба dependency audit;
- production staging на Python `3.14.4` установился только по hashes;
  48/48 tests, `npm audit` и `pip check` прошли, SBOM и ключевые runtime
  files побайтово совпали с repository commit;
- перед переключением active sessions/results были нулевыми; прежний runtime
  сохранён в backup
  `/home/openclaw/services/pdf-signing-demo/backups/20260809T111939Z-pr10a`;
- public UI/API/health вернули ожидаемые `200`, `/generated` остался `404`,
  opaque font IDs и enforcing security headers сохранились;
- отдельный production-runtime contour прошёл полный synthetic cycle
  `prepare -> CAdES -> complete -> preview x2 -> download x2`; API вернул
  `valid / not_checked / not_checked`, а pyHanko подтвердил
  `intact/valid/trusted/ENTIRE_FILE`; contour и synthetic result удалены;
- финально service active, `NRestarts=0`, readiness зелёный, session/result
  counters нулевые, socket только `127.0.0.1:3010`, warning journal пуст;
  12 прежних private legacy PDF остались на месте.

#### PR-10b — signing routes и orchestration (2026-08-20)

Статус: **реализован и развёрнут в production**.

- оба signing endpoint, rate-limit adapters и orchestration полного цикла
  `prepare`/`complete` вынесены из `src/server.js` в
  `src/routes/signing.js` через узкий router factory;
- в том же модуле локализованы CMS normalization и fail-closed построение
  публичного verification contract; PDF preparation, CMS verification,
  embedding, session/result storage и frontend не изменялись;
- публичные URL, safe error stages/codes, queue keys, retry semantics и
  reusable 15-minute result capabilities сохранены без изменения;
- `src/server.js` сокращён с 768 до 500 строк; добавлены два unit-контракта
  для независимой семантики integrity/trust/qualified и запрета успешного
  ответа при неполной embedded verification; полный suite содержит 50 тестов.

Rollout evidence:

- implementation commit `d6c8605`; GitHub Actions run
  [`32342136303`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/32342136303)
  прошёл clean bootstrap, 50/50 tests, SBOM gate и оба dependency audit;
- production staging на Python `3.14.4` установился только по hashes;
  50/50 tests и `pip check` прошли, Node/Python locks и SBOM совпали с
  проверенным release;
- перед переключением active sessions/results были нулевыми; прежний runtime
  и service unit сохранены в backup
  `/home/openclaw/services/pdf-signing-demo/backups/20260820T070349Z-pr10b`;
- public HTTPS contour прошёл полный synthetic cycle
  `prepare -> CAdES -> complete -> preview x2 -> download x2`; все четыре
  результата имели один SHA-256, API вернул
  `valid / not_checked / not_checked`, а pyHanko подтвердил
  `intact/valid/trusted/ENTIRE_FILE`; synthetic result удалён;
- финально deploy hashes совпадают с commit, service active, `NRestarts=0`,
  readiness зелёный, session/result counters нулевые, socket только
  `127.0.0.1:3010`, warning journal пуст; 12 private legacy PDF сохранены.

#### PR-10c — health/result routes и bootstrap (2026-08-22)

Статус: **реализован и развёрнут в production**.

- liveness/readiness и их прежний coalesced five-second cache вынесены в
  `src/routes/health.js`; worker/storage counters по-прежнему вычисляются
  непосредственно для каждого readiness-ответа;
- выдача reusable preview/download capabilities и их разные security headers
  вынесены в `src/routes/results.js` без изменения URL, TTL или HTTP-семантики;
- loopback listener, HTTP timeouts и periodic storage/rate-limit cleanup
  вынесены в `src/bootstrap.js`;
- `src/server.js` сокращён с 500 до 340 строк; signing/PDF/CMS/storage и
  frontend в этом срезе не менялись;
- nested result router потребовал укрепить центральное редактирование логов:
  capability теперь fail-closed распознаётся по полному `originalUrl`, даже
  когда Express обрезал mount prefix из `req.path`;
- добавлены два unit-контракта для preview/download headers и loopback/timeout
  bootstrap, а существующий log-redaction контракт переведён на реальную
  nested-router форму; полный suite содержит 52 теста.

Rollout evidence:

- implementation commit `0baae13`; GitHub Actions run
  [`32572880936`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/32572880936)
  прошёл clean bootstrap, 52/52 tests, SBOM gate и оба dependency audit;
- production staging на Node `22.22.2` / Python `3.14.4` прошёл 52/52 tests
  и `pip check`; content checksums staging/repository совпали;
- перед переключением active sessions/results были нулевыми; прежний runtime
  и service unit сохранены в backup
  `/home/openclaw/services/pdf-signing-demo/backups/20260822T122848Z-pr10c`;
- public HTTPS contour прошёл полный synthetic cycle
  `prepare -> CAdES -> complete -> preview x2 -> download x2`; все четыре
  результата имели один SHA-256, API вернул
  `valid / not_checked / not_checked`, а pyHanko подтвердил
  `intact/valid/trusted/ENTIRE_FILE`;
- synthetic result перенесён в rollout backup, transient sessions очищены
  штатным restart; финально service active, `NRestarts=0`, readiness зелёный,
  session/result counters нулевые, socket только `127.0.0.1:3010`, warning
  journal пуст; 12 private legacy PDF сохранены.

#### PR-10d — application factory и public routes (2026-08-24)

Статус: **реализован и развёрнут в production**.

- Express application factory, общие security/request middleware, порядок
  подключения маршрутов и safe JSON error boundary вынесены в
  `src/application.js`; factory не открывает listener и остаётся независимо
  тестируемым;
- read-only stamp/font/form endpoints и явный запрет legacy `/generated`
  вынесены в `src/routes/public.js` без изменения публичных URL, ответов или
  порядка относительно static middleware;
- `src/server.js` теперь только собирает runtime dependencies, проверяет
  приватность `RESULTS_DIR` и передаёт приложение в bootstrap; файл сокращён
  с 340 до 160 строк;
- signing/PDF/CMS/storage/frontend не менялись; добавлены два контракта для
  listener-free application factory, Express hardening, base-path boundary,
  form metadata и закрытого legacy storage; полный suite содержит 54 теста.

Rollout evidence:

- implementation commit `cd6ce7b`; GitHub Actions run
  [`32708392451`](https://github.com/code-agent-43824/pdf-signing-demo/actions/runs/32708392451)
  прошёл clean bootstrap, 54/54 tests, SBOM gate и оба dependency audit;
- production staging на Node `22.22.2` / Python `3.14.4` прошёл 54/54 tests,
  `pip check` и побайтовую проверку fixture/SBOM artifacts; ключевые
  signing/PDF/CMS/frontend файлы production побайтово совпадают с repository;
- перед переключением workers, sessions и results были нулевыми; прежний
  runtime и service unit сохранены в backup
  `/home/openclaw/services/pdf-signing-demo/backups/20260824T085451Z-pr10d`;
- public HTTPS contour проверил UI/security headers, health, stamp/fonts/form,
  закрытый `/generated` и полный synthetic cycle
  `prepare -> CAdES -> complete -> preview x2 -> download x2`; все четыре
  результата имели SHA-256
  `531228216e472dabfdb27ec4090503cccd5e3d92a70ceaccde66cb1395e5c2f1`, API
  вернул `valid / not_checked / not_checked`, а pyHanko подтвердил
  `intact/valid/trusted/ENTIRE_FILE`;
- synthetic result перенесён в rollout backup, transient runtime очищен
  штатным restart; финально service active, `NRestarts=0`, readiness зелёный,
  session/result counters нулевые, socket только `127.0.0.1:3010`, warning
  journal пуст; все 12 private legacy PDF сохранены побайтово.

### Frontend

- Разделить `public/app.js` на:
  - CryptoPro adapter;
  - Rutoken adapter;
  - certificate model;
  - signing workflow;
  - stamp configuration;
  - dialogs/components;
  - API client.
- Ввести явную state machine вместо связанных boolean-полей.
- Для динамического UI предпочитать DOM APIs шаблонным `innerHTML`.

### Критерии готовности

- Модули криптопровайдеров тестируются с mock adapters независимо от DOM.
- Workflow не допускает невозможных переходов и двойного `complete`.
- Размер и связность основных модулей существенно уменьшены без изменения
  golden PDF-результатов.

## 10. CI/CD quality gates

Каждый pull request должен проходить:

1. lint и форматирование JS/Python;
2. unit tests;
3. API schema/negative tests;
4. интеграционный PAdES-тест;
5. проверку 1–4 последовательных подписей;
6. проверку сохранности всех предыдущих подписей;
7. dependency и secret scan;
8. malformed PDF/CMS corpus;
9. лимиты памяти, времени и конкурентности;
10. production-like smoke test под реальным `BASE_PATH`.

Deployment:

- immutable release directory;
- health/readiness до переключения Caddy;
- canary smoke test;
- атомарное переключение symlink;
- сохранение предыдущего release для rollback;
- автоматический rollback при неуспешной PAdES-проверке.

## 11. Наблюдаемость

- Структурированные логи с request/session correlation ID.
- Метрики:
  - длительность prepare/complete/validate;
  - размер и число страниц PDF;
  - активные/ожидающие workers;
  - timeout/OOM/validation failures;
  - число sessions и объём result storage;
  - cleanup failures.
- Не включать в метрики и логи содержимое документа, CMS, PIN,
  персональные DN целиком или полный fingerprint без необходимости.
- Alerts на рост очереди, validation failures, нехватку диска и
  недоступность readiness.

## 12. Рекомендуемая последовательность pull requests

1. **PR-1: Golden corpus и CI baseline.**
2. **PR-2: Закрытие config write, удаление path leaks, корректный health.**
3. **PR-3: Строгие схемы, лимиты, safe errors, loopback bind.**
4. **PR-4: CMS integrity verification и сопоставление сертификата.**
5. **PR-5: Trust/qualified policy и честные статусы UI.**
6. **PR-6: Worker isolation, rate limiting и timeouts.**
7. **PR-7: Private result storage, TTL и cleanup.**
8. **PR-8: CSP, anti-clickjacking и vendor pinning.**
9. **PR-9: Dependency locks, cleanup и документация.**
10. **PR-10+: Декомпозиция backend/frontend малыми шагами.**

PR-2 и PR-3 можно готовить параллельно после PR-1. PR-4 должен
предшествовать изменению текста успешного результата. Рефакторинг PR-10
не должен смешиваться с криптографическими изменениями.

## 13. Definition of Done проекта

Работы по плану считаются завершёнными, когда:

- публичный пользователь не может менять серверную конфигурацию;
- произвольная или чужая CMS не может привести к ответу `ok`;
- данные штампа извлекаются из проверенной CMS, а не доверяются клиенту;
- все предыдущие и новая подписи проходят независимую валидацию;
- статус КЭП показывается только после выполнения заданной trust policy;
- сервис устойчив к ограниченному набору параллельных вредоносных
  PDF/config-запросов;
- документы и signing sessions гарантированно удаляются по TTL;
- browser security headers включены в enforcing mode;
- сборка и зависимости полностью воспроизводимы;
- все quality gates обязательны перед deployment;
- rollback проверен практически.
