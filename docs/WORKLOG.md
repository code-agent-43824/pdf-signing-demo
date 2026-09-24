# Журнал работ

Что собирались сделать, что сделано и что дальше. Новые записи сверху.

## 2026-09-24 — починка `npm audit` и переход на свод правил

**План.** Полный гейт `npm run verify` на `main` (`2b36d06`) падает на
`npm audit --omit=dev --audit-level=high`. После последнего зелёного CI (28.08)
опубликованы advisories для `fast-uri` 3.1.5 (high, приходит через `ajv`) и `qs`
6.15.3 (moderate, приходит через `express`). Любой новый CI-прогон `main` будет
красным, деплой заблокирован. Владелец решил сначала починить ствол, затем
подключить свод правил из `code-agent-43824/coding-rules`: работа только в `main`,
без веток. Ветку `claude/vibrant-curie-u8l0q9` с первой версией `CLAUDE.md`
владелец решил оставить.

1. Обновить в `package-lock.json` только `fast-uri` и `qs`, пересоздать SBOM
   закреплённым npm, прогнать `npm run verify`.
2. Запушить в `main`, проверить CI, деплой и production.
3. Положить `AGENTS.md` как есть, импорт в `CLAUDE.md` и карту кода на английском.

**Сделано.**

- Шаг 1: `npm update fast-uri qs --package-lock-only` под npm 10.9.8 поднял
  `fast-uri` до 3.1.8 и `qs` до 6.16.0 в пределах диапазонов `ajv` и `express`;
  новых пакетов нет. SBOM пересоздан, `npm run verify` зелёный: 73/73 тестов,
  `npm audit` — 0 уязвимостей.
- Попутно: CI-шаг `pip-audit` на том же `main` тоже красный — у `pypdf` 6.15.0
  три advisories (исправлены в 6.16.0 и 6.16.1). `pypdf` используют только
  `test/fixtures/generate.py` и `test/validate_corpus.py`, рантайм его не
  импортирует. Обновление — отдельным шагом по `docs/SUPPLY_CHAIN.md`.
- `pypdf`: пин в `requirements.in` поднят до 6.16.2 (последний патч ветки 6.16,
  закрывает все три advisories), `requirements.txt` пересоздан pip-tools на
  Python 3.12; в lock-файле изменилась только запись `pypdf`. Фикстуры
  воспроизводятся побайтно, `npm run verify` зелёный (73/73), `pip-audit` и
  `pip check` чистые. Прогон на production Python 3.14 выполнит
  `scripts/verify-release.sh` при деплое до переключения релиза.

**Дальше.** Шаг 2: запушить, проверить CI, лог деплоя и production.
