# Lock-файлы зависимостей, аудит и SBOM

## Поддерживаемые версии

- Node.js — версия из `.node-version`; `package.json#engines` допускает только
  Node 22 не ниже неё.
- npm — версия из `package.json#packageManager`. CI ставит её глобально, деплой
  на сервере использует отдельную копию этой версии (`NPM_CLI` в
  `scripts/deploy-production.sh`).
- Python — от 3.12 до 3.14. CI работает на версии из
  `.github/workflows/ci.yml`, production — на 3.14.

## Зависимости Node

Установка идёт только по `package-lock.json`. В runtime:

```bash
npm ci --omit=dev
```

Зависимости обновляются закреплёнными Node и npm: `npm install
--package-lock-only` (для транзитивного пакета — `npm update <пакет>
--package-lock-only`), затем `npm ci` и `npm run verify`. Незакоммиченный
lock-файл в релиз не попадает.

## Зависимости Python

`requirements.in` перечисляет прямые runtime-пакеты.
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

Устанавливать только так:

```bash
python -m pip install \
  --require-hashes \
  --requirement requirements.txt
```

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

1. установка lock-файла Python с проверкой хешей;
2. `npm ci`;
3. воспроизводимость закоммиченных фикстур;
4. полный набор тестов;
5. `npm audit --omit=dev --audit-level=high`;
6. воспроизводимость закоммиченного SBOM;
7. `pip-audit` по полному lock Python.

Браузерные vendor-скрипты не входят в runtime-зависимости npm. Их
происхождение, версии, контрольные суммы и SRI описаны в
`docs/VENDOR_ASSETS.md`.
