# pdf-signing-demo

Демо-проект для веб-сценария подписи PDF-документа через CryptoPro Browser Plugin.

## Что уже есть

- Node.js сервер на Express
- страница в стиле выдачи формуляров
- серверный PDF-формуляр, видимый в браузере
- базовые API-заглушки под prepare/complete этапы подписи

## Запуск

```bash
npm install
node src/server.js
```

Дополнительно для server-side подготовки PDF нужны Python-зависимости:

- `pyHanko`
- `pypdf`
- `reportlab`
- `Pillow`

Переменные окружения:

- `PORT` — порт сервера (по умолчанию `3010`)
- `BASE_PATH` — базовый путь за reverse proxy (по умолчанию `/`)
- `STAMP_CONFIG_PATH` — необязательный путь к JSON-конфигу штампа/размещения подписи

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

Если правило выбирает несколько страниц, реальный signature widget ставится на одну страницу (`widgetPageMode`: `first` или `last`), а на остальных выбранных страницах рисуются такие же визуальные штампы.

## Deploy contour

Current VPS URL:

- `https://watsonopenclaw.duckdns.org/pdf-signing/`

Repo includes reference deployment files:

- `deploy/pdf-signing-demo.service`
- `deploy/Caddyfile.snippet`
