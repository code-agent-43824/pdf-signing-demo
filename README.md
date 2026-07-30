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

Для воспроизводимой установки поддерживаемых версий:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --requirement requirements.txt
```

Переменные окружения:

- `PORT` — порт сервера (по умолчанию `3010`)
- `BASE_PATH` — базовый путь за reverse proxy (по умолчанию `/`)
- `STAMP_CONFIG_PATH` — необязательный путь к JSON-конфигу штампа/размещения подписи

Health endpoints при `BASE_PATH=/pdf-signing/`:

- `GET /pdf-signing/health/live` — процесс отвечает
- `GET /pdf-signing/health/ready` — доступны Python, конфигурация и writable storage

HTTP-сервер слушает только `127.0.0.1`; внешний доступ предполагается
исключительно через reverse proxy.

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

Если правило выбирает несколько страниц, реальный signature widget ставится на одну страницу (`widgetPageMode`: `first` или `last`), а на остальных выбранных страницах рисуются такие же визуальные штампы.

## Deploy contour

Current production URL:

- `https://mescheryakov.pro/pdf-signing/`

Repo includes reference deployment files:

- `deploy/pdf-signing-demo.service`
- `deploy/Caddyfile.snippet`

## Проверки golden-корпуса

Golden-корпус фиксирует структурные варианты PDF и автоматически проверяет
полный цикл подготовки и встраивания от одной до четырёх последовательных
подписей. Каждая подпись проверяется двумя независимыми средствами:
OpenSSL CMS и pyHanko PDF validation.

```bash
npm ci
python -m pip install --requirement requirements.txt
npm test
```

Тестовые сертификат и закрытый ключ создаются во временном каталоге на время
прогона и не сохраняются в репозитории. Состав корпуса описан в
`test/fixtures/README.md`.
