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

Переменные окружения:

- `PORT` — порт сервера (по умолчанию `3010`)
- `BASE_PATH` — базовый путь за reverse proxy (по умолчанию `/`)

## Deploy contour

Current VPS URL:

- `https://watsonopenclaw.duckdns.org/pdf-signing/`

Repo includes reference deployment files:

- `deploy/pdf-signing-demo.service`
- `deploy/Caddyfile.snippet`
