# Baseline проекта

Дата фиксации: 2026-08-29.

Этот документ фиксирует поведение до рефакторинга. Он не объявляет все
перечисленные свойства желательными: известные риски меняются отдельными
этапами плана и должны сопровождаться обновлением этого документа и тестов.

## Среда выполнения

- официальная версия для разработки и CI: Node.js 22 LTS;
- минимально допустимая версия пакета: Node.js 18 (нужен встроенный `fetch`);
- рекомендуемый способ выбора версии: `.nvmrc`;
- установка: `npm ci`;
- запуск: `npm start`;
- полный baseline: `npm test`.

## Тестовый baseline

На момент фиксации `npm test` проходит: 64 теста, 0 ошибок (31 unit и 33 integration).

- `npm run test:unit` — адаптеры провайдеров, registry и клиентский подбор
  моделей; внешние API заменены локальными mock-серверами;
- `npm run test:integration` — HTTP-сервер, encrypted store, OAuth/quota flow и
  smoke-тест CLI entry point;
- `npm test` — unit и integration последовательно.

Реальные API провайдеров тестами не вызываются.

## Официальный режим развёртывания

Приложение является local-first инструментом одного пользователя.

- По умолчанию сервер слушает `127.0.0.1`; другой адрес задаётся явно через `HOST`.
- `PUBLIC_ORIGIN` явно включает reverse-proxy deployment и bind на `0.0.0.0`,
  если `HOST` не задан. Same-origin учитывает `X-Forwarded-Host` и
  `X-Forwarded-Proto`.
- Удалённый доступ не является режимом по умолчанию. Для него нужны TLS на
  reverse proxy и внешняя аутентификация; дополнительные origins задаются
  через `ALLOWED_ORIGINS`.

## Решение по `file://`

`file://` не поддерживается как официальный режим. После переноса секретов в
server-side vault интерфейс зависит от HTTP API, а браузерный запуск статических
файлов напрямую создаёт другое происхождение и не даёт гарантированного доступа
к серверу. Поддерживается только открытие UI через запущенный HTTP-сервер.

## HTTP-контракт до этапа безопасности

Общие свойства текущего API:

- ошибки API имеют форму `{ "error": "code", "message": "text", "requestId": "uuid" }`;
- статические 403/404 остаются text-ответами;
- cross-origin запрещён по умолчанию; разрешённые origins задаются через
  `ALLOWED_ORIGINS`;
- большинство специальных API-маршрутов не ограничивают HTTP-метод, если в
  таблице не указано обратное;
- неизвестный путь обрабатывается как запрос статического файла;
- proxy возвращает статус, content type и тело upstream без нормализации;
- каждый HTTP-ответ содержит `X-Request-Id`, запросы ограничены таймаутом 30 секунд.

### Маршруты

| Маршрут | Текущие методы | Успех | Ошибки приложения |
| --- | --- | --- | --- |
| `/proxy[/<provider>][/*]` | любые, `OPTIONS` → 204 | прозрачный ответ выбранного upstream | 503 `no_provider`; 413 `payload_too_large`; 502 `proxy_error` |
| `/omniroute[/...]` | любые | proxy к сохранённому server-side URL | 400 `no_omniroute_url`; 400 `invalid_omniroute_url`; ошибки proxy как выше |
| `/api/providers/<id>/usage` | любые, `OPTIONS` → 204 | 200, provider-specific JSON | 404 `unknown_provider`; provider-specific error payload/status |
| `/api/providers/<id>/models` | любые, `OPTIONS` → 204 | 200, provider-specific JSON | 404 `unknown_provider`; provider-specific error payload/status |
| `/api/antigravity-auth/start` | любые, `OPTIONS` → 204 | 200 `{ url }` | 500 с OAuth error code и message |
| `/api/antigravity-auth/exchange` | `POST`, `OPTIONS` → 204 | 200 `{ ok, email }` | 405 `method_not_allowed`; 400 `bad_request`; 400 `bad_callback_url`; 502 с OAuth error code |
| `/api/antigravity-quota` | любые, `OPTIONS` → 204 | provider result/status, cache 60 секунд | 400 `no_token`; 401 `refresh_failed`; provider-specific error payload/status |
| `/api/config` | `GET`, `PUT`, `OPTIONS` → 204 | GET: публичная DTO без секретов; PUT: write-only обновление | 405 `method_not_allowed`; 400 `bad_json`; 400 `invalid_omniroute_url` |
| `/api/health` | любые, `OPTIONS` → 204 | 200 `{ ok: true }` | — |
| `/*` | любые | static file, `/` → `index.html` | text 403 `403 Forbidden`; text 404 `404 Not Found` |

### Конфигурация процесса

| Переменная | Назначение | Текущее значение по умолчанию |
| --- | --- | --- |
| `HOST` | адрес HTTP-сервера | `127.0.0.1`, либо `0.0.0.0` с `PUBLIC_ORIGIN` |
| `PUBLIC_ORIGIN` | внешний origin reverse proxy | пусто |
| `PORT` | порт HTTP-сервера | `8765` |
| `ALLOWED_ORIGINS` | браузерный CORS allowlist | пусто |
| `AIPANEL_MASTER_KEY` | master key encrypted store | локальная генерация; заданное значение валидируется |
| `GOOGLE_CLIENT_ID` | OAuth client ID Antigravity | пусто |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret Antigravity | пусто |

При CLI-запуске загружаются `.env.local`, затем `.env`; уже заданные переменные
окружения имеют приоритет.

## Правило изменения baseline

Изменение метода, статуса, error code, JSON-схемы или режима запуска считается
изменением контракта. Оно должно иметь тест и быть отражено здесь. Исправления
уязвимостей могут намеренно ломать небезопасный контракт, но это должно быть
отмечено в плане и release notes.
