# План

Этап: сопровождение — вернуть зелёный ствол и перейти на свод правил агентов.

- [x] Обновить `fast-uri` и `qs` в `package-lock.json` и SBOM до версий без
  advisories `npm audit`.
- [ ] Обновить `pypdf` до версии без advisories `pip-audit`.
- [ ] Задеплоить исправления через CI и проверить production.
- [ ] Подключить свод правил из `code-agent-43824/coding-rules`: `AGENTS.md` как
  есть, импорт в `CLAUDE.md`, карта кода.

## Замечено попутно

- [ ] Тест `isolated worker is asynchronous and timeout kills its process group`
  (`test/runtime-controls.test.js`) нестабилен в облачной песочнице Claude Code:
  проверка завершения процесса должна считать зомби завершённым.
- [ ] `docs/SUPPLY_CHAIN.md`, `docs/VENDOR_ASSETS.md`, `test/fixtures/README.md` и
  README spike написаны по-английски, а свод требует документацию проекта на
  русском.
- [ ] `README.md` и `docs/CADES_BES_PLAN.md` содержат утверждения о состоянии
  реализации; по своду состояние живёт только в `docs/STATUS.md`.
