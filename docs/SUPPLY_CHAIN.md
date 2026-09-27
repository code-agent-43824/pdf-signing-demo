# Lock-файлы зависимостей, аудит и SBOM

## Поддерживаемые версии

- Node.js — версия из `.node-version`; `package.json#engines` допускает только
  ту же major-версию не ниже неё. `npm ci` о несовпадении `engines` только
  предупреждает, поэтому деплой сам проверяет Node на сервере
  (`scripts/check-node-runtime.js`) до любых изменений и печатает его версию
  в лог.
- npm — версия из `package.json#packageManager`. CI ставит её глобально, деплой
  на сервере использует отдельную копию этой версии (`NPM_CLI` в
  `scripts/deploy-production.sh`).
- Python — от 3.12 до 3.14. CI работает на версии из
  `.github/workflows/ci.yml`, production — на 3.14.

### Обновление Node

Node на сервере ставится вручную (`NODE_BIN` в
`scripts/deploy-production.sh`); это ручная работа на общем хосте, её делает
владелец или Watson (`AGENTS.md`, §5–6). Поэтому версия поднимается в два
шага:

1. На сервер ставится новый Node той же major-версии. Деплой примет его и при
   старом пине.
2. Одним коммитом меняются `.node-version`, `engines` в `package.json`, корень
   `package-lock.json` (`npm install --package-lock-only`) и пин в
   `test/supply-chain.test.js`. CI проверяет релиз на новом Node, деплой —
   что сервер его уже получил.

В обратном порядке деплой остановится на проверке версии, не тронув
production.

## Зависимости Node

Установка идёт только по `package-lock.json`. Единственная dev-зависимость —
Biome (раздел «Lint и форматирование»). В runtime dev-пакеты не ставятся:

```bash
npm ci --omit=dev
```

Зависимости обновляются закреплёнными Node и npm: `npm install
--package-lock-only` (для транзитивного пакета — `npm update <пакет>
--package-lock-only`), затем `npm ci` и `npm run verify`. Незакоммиченный
lock-файл в релиз не попадает.

## Зависимости Python

`requirements.in` перечисляет прямые runtime-пакеты, `requirements-dev.in` —
инструменты разработки и CI (Ruff); на сервер они не попадают.
`requirements.constraints.txt` фиксирует проверенный в production
транзитивный набор. `requirements.txt` — сгенерированный lock с хешами каждого
допустимого дистрибутива.

Lock пересоздаётся на Python 3.12 с `pip==26.1`, `pip-tools==7.6.0` и
`click==8.1.8`: pip-tools 7.6.0 несовместим с pip 26.2, а с click 8.5.0 пишет в
заголовок lock-файла лишний `--no-index`.

```bash
python -m piptools compile \
  --generate-hashes \
  --strip-extras \
  --resolver=backtracking \
  --output-file requirements.txt \
  requirements.in
```

`requirements-dev.txt` собирается так же из `requirements-dev.in`
(`--output-file requirements-dev.txt requirements-dev.in`).

Устанавливать только так:

```bash
python -m pip install \
  --require-hashes \
  --requirement requirements.txt
```

Для разработки и CI к нему добавляется `--requirement requirements-dev.txt`
(так делает `scripts/bootstrap-and-test.sh`).

Намеренное обновление Python-пакета начинается с правки прямого пина или
constraint, затем lock пересоздаётся. Изменение должно пройти весь
golden-набор на Python 3.12 и на production Python 3.14 (его прогоняет
`scripts/verify-release.sh` при деплое) и сохранить все инварианты проверки
подписей PDF.

## SBOM и аудит

`npm run sbom:generate` детерминированно создаёт манифесты CycloneDX 1.5:

- `sbom/node.cdx.json` — из `package-lock.json`, без dev-пакетов;
- `sbom/python.cdx.json` — из полного lock Python с хешами.

Изменчивые временные метки и UUID в CycloneDX необязательны и намеренно
опущены, поэтому `npm run sbom:check` роняет CI на устаревшем манифесте. В
`sbom/node.cdx.json` записывается версия npm, так что генерировать и проверять
SBOM нужно npm из `packageManager`: другая версия даёт ложное расхождение.

Гейты цепочки поставок в CI, в порядке выполнения
(`scripts/bootstrap-and-test.sh` и `.github/workflows/ci.yml`):

1. поиск секретов по всей истории git (раздел ниже);
2. установка обоих lock-файлов Python с проверкой хешей;
3. `npm ci`;
4. lint и проверка форматирования (`npm run lint`, раздел ниже);
5. воспроизводимость закоммиченных фикстур;
6. полный набор тестов;
7. `npm audit --omit=dev --audit-level=high`;
8. воспроизводимость закоммиченного SBOM;
9. `pip-audit` по обоим lock-файлам Python.

Помимо прогонов на push, раз в неделю CI по расписанию прогоняет все гейты
на последнем коммите `main` (`schedule` в `.github/workflows/ci.yml`): аудиты
ловят advisories, опубликованные между push. Прогон по расписанию не деплоит и идёт
в своей группе concurrency — в общей группе он отменял бы ожидающий
push-прогон вместе с его деплоем. Уведомление о прогоне по расписанию GitHub
отправляет пользователю, который последним менял строку cron, а в публичном
репозитории отключает расписание после 60 дней без активности.

Браузерные vendor-скрипты не входят в runtime-зависимости npm. Их
происхождение, версии, контрольные суммы и SRI описаны в
`docs/VENDOR_ASSETS.md`.

## Lint и форматирование

`npm run lint` — первый шаг `npm run verify`. Он запускает Biome
(`biome ci --error-on-warnings`: форматирование и lint JS) и Ruff (`ruff check`
и `ruff format --check`); `npm run format` переписывает код в нужном формате.
Настройки лежат в `biome.jsonc` и `ruff.toml`, их отступления от правил по
умолчанию объяснены там же в комментариях. Vendor-скрипты и Markdown
инструменты не трогают.

- Biome — точный пин в `devDependencies`. `package-lock.json` закрепляет
  по integrity сборки под все платформы, а SBOM и деплой dev-пакеты не
  включают. Обновление: `npm install --save-dev --save-exact
  @biomejs/biome@<версия>` закреплённым npm, затем `npm run lint`.
- Ruff — `requirements-dev.in`, lock с хешами — `requirements-dev.txt`
  (раздел «Зависимости Python»). Обновление: правка пина в
  `requirements-dev.in`, пересборка lock, `npm run lint`.

Если новая версия форматирует иначе, код переформатируется отдельным коммитом
`style:` без других изменений, и его SHA добавляется в
`.git-blame-ignore-revs`.

## Поиск секретов

`scripts/scan-secrets.sh` прогоняет gitleaks по всей истории репозитория с
правилами по умолчанию; значения найденных секретов в выводе скрыты. Версия
gitleaks и SHA-256 релизного архива для linux x86_64 закреплены в самом
скрипте. Архив скачивается с GitHub Releases в `~/.cache/pdf-signing-demo`, и
его хеш сверяется при каждом запуске. Клон с неполной историей (shallow)
скрипт отвергает, поэтому CI забирает историю целиком (`fetch-depth: 0`).

Обновление: скачать новый архив и файл `gitleaks_<версия>_checksums.txt` того
же релиза, сверить хеш архива с файлом, заменить в скрипте версию и хеш,
прогнать скрипт.

Ложное срабатывание не подавляется молча. Его отпечаток (`Fingerprint` в
выводе) добавляется в `.gitleaksignore` вместе с причиной в сообщении
коммита. Настоящий секрет — повод сообщить владельцу (`AGENTS.md`, §7), а не
вносить его в исключения.
