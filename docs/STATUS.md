# Состояние

Проверено 2026-09-24.

- **Production.** `https://mescheryakov.pro/pdf-signing/` работает на релизе
  `4b279d2` (CI-прогон 57). Публичный `health/ready` — 200, все проверки
  `true`; внешний `health/metrics` — 404; UI и соседний сайт
  `https://mescheryakov.pro/` — 200.
- **Ствол `main`.** Зелёный: начиная с `4b279d2` проходят все гейты CI, включая
  `npm audit` и `pip-audit`.
- **Известные дефекты.** В облачной песочнице Claude Code тест
  `isolated worker is asynchronous and timeout kills its process group`
  иногда падает с `condition timed out`; причина — в `docs/JOURNAL.md`,
  исправление — в `docs/PLAN.md`.
- **CAdES-BES (`docs/CADES_BES_PLAN.md`).** Этап 0 не закрыт: вердикт spike —
  `PARTIAL`, прогона с реальными провайдерами на компьютере владельца в
  репозитории нет.
- **Где остановилась работа.** Подключение свода правил: осталась карта кода в
  `CLAUDE.md`.
