# AI Панель

Дашборд для управления AI-разработкой: статистика потребления и остатков **xKiro** и баланса **AgentRouter** одной строкой, каталог моделей, combo OmniRoute и управление — отдельными страницами с общей навигацией.

## Возможности

**Управление Combo (OmniRoute)** — в IDE достаточно указать одну модель с именем Combo из OmniRoute, а панель удалённо управляет порядком моделей внутри него. Выбираете нужный combo из списка, видите все targets и их веса, ставите приоритетную модель на первое место — и OmniRoute сразу начинает маршрутизировать запросы на неё. Переключение модели в IDE не требуется. Ниже — таблица «Последние combo-запросы»: какая модель реально ответила на каждый запрос через combo.

**Статистика провайдеров** — мониторинг потребления и лимитов: баланс кошелька, зарезервированные средства, окна расхода (короткое ~5 ч и длинное ~7 д) с обратным отсчётом до сброса, бесплатные токены (xKiro), квоты по моделям Google AI Pro (Antigravity), баланс кошелька AgentRouter.

**Каталог моделей** — просмотр доступных моделей провайдера с ценами ($/1M токенов), тирами доступа (free / paid / premium) и контекстным окном. Поиск по имени, переключение между провайдерами.

- **Навигация** — четыре страницы с общей шапкой: **Статистика** (главная), **Combo**, **Модели** и **Управление**
- **Настройки** — диалог в шапке: ввод API-ключа xKiro, токен Antigravity (OAuth), URL и ключ OmniRoute, алиасы имён провайдеров. Секреты хранятся в зашифрованном серверном хранилище.
<br><br>

| | |
|---|---|
| [![Статистика](public/assets/imgs/AI%20Панель%20—%20Статистика.png)](public/assets/imgs/AI%20Панель%20—%20Статистика.png) | [![Combo](public/assets/imgs/Combo%20·%20AI%20Панель.png)](public/assets/imgs/Combo%20·%20AI%20Панель.png) |
| [![Настройки](public/assets/imgs/AI%20Панель%20—%20Настройки.png)](public/assets/imgs/AI%20Панель%20—%20Настройки.png) | [![Модели](public/assets/imgs/Модели%20·%20AI%20Панель.png)](public/assets/imgs/Модели%20·%20AI%20Панель.png) |

## Запуск

### Вариант А — через локальный сервер (рекомендуется)

Официальная версия для разработки — Node.js 22 LTS (`.nvmrc`); поддерживаются Node.js 22 и 24 (CI проверяет обе).

```
node server.js
# или
npm start
```

Откройте http://localhost:8765 — сервер отдаёт статику и проксирует запросы к API (обход CORS).

Порт можно поменять: `PORT=9000 node server.js`.

Прямой запуск через `file://` не поддерживается: интерфейс зависит от серверного API и encrypted vault.

Панель работает и без OmniRoute, но странице **Combo** нужен отдельно установленный OmniRoute — см. раздел [«Combo (OmniRoute)»](#combo-omniroute).

### Вариант Б — за reverse proxy (удалённый доступ)

Если reverse proxy работает в другом контейнере или сетевом namespace, задайте публичный origin и токен входа:

```env
PUBLIC_ORIGIN=https://ai-panel.home.ak-vps.ru
AIPANEL_AUTH_TOKEN=<openssl rand -hex 24>
TRUST_PROXY=true
```

**Вход обязателен.** В remote-режиме (задан `PUBLIC_ORIGIN` или `HOST` вне loopback) сервер не стартует без `AIPANEL_AUTH_TOKEN`: без него любой, кто достучится до порта, получил бы доступ к ключам провайдеров. Первый запрос страницы уводит на `/login.html`, где вводится токен; сессия — подписанная cookie `HttpOnly; SameSite=Strict; Secure` (при https) на 7 дней, пароля и логинов нет. Выход — кнопка **Выйти** в шапке. Неудачные попытки входа ограничены (10 на IP и 100 глобально за 15 минут), сравнение токена — за постоянное время. Смена `AIPANEL_AUTH_TOKEN` завершает все сессии.

**Проверка `Host`.** Сервер принимает запросы только с loopback-адресов, хоста из `PUBLIC_ORIGIN` и имён из `ALLOWED_HOSTS`; остальные получают `421` — это защита от DNS rebinding. Заголовки `X-Forwarded-Host` и `X-Forwarded-Proto` учитываются только при `TRUST_PROXY=true`, иначе их может подставить любой клиент. Для одного origin `ALLOWED_ORIGINS` не требуется — он считается same-origin.

По возможности слушайте панель на `127.0.0.1` за proxy и закрывайте порт firewall'ом: `PUBLIC_ORIGIN` включает bind на `0.0.0.0`, и тогда порт `PORT` (по умолчанию 8765) доступен напрямую, минуя proxy и его TLS.

Пример Nginx/OpenResty:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_pass http://ai-panel:8765;
```

Проверьте, что порт панели закрыт снаружи: `ss -ltnp | grep 8765` и правила firewall. Если панель опубликована в интернет без TLS, токен и cookie уходят открытым текстом — используйте только `https`.

### Вариант В — через PM2 (фоновый демон)

Установите PM2 глобально: `npm install -g pm2`.

```
# Запуск
pm2 start server.js --name ai-panel

# Полезные команды
pm2 status              # статус процессов
pm2 logs ai-panel       # логи в реальном времени
pm2 restart ai-panel    # перезапуск
pm2 stop ai-panel       # остановка
pm2 delete ai-panel     # удаление из списка
pm2 save                # сохранить список процессов
pm2 startup              # автозапуск при перезагрузке системы (по инструкции PM2)
```

Порт задаётся через `.env` или переменную окружения: `PORT=9000 pm2 start server.js --name ai-panel`.

## Деплой на Ubuntu-сервер

Сценарий: `git pull` на сервере → установка прод-зависимостей → перезапуск PM2.

**Первый раз (один раз на сервере)**

```bash
# Установить Node.js через nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22

# PM2 глобально
npm install -g pm2

# Клонировать репозиторий
git clone https://github.com/ak-flash/ai-panel-omniroute.git /home/user/ai-panel
cd /home/user/ai-panel

# Создать .env с секретами (шаблон ниже в разделе «Настройка»)
nano .env

# Установить только production-зависимости
npm ci --omit=dev

# Запустить и сохранить в автозапуск
pm2 start server.js --name ai-panel
pm2 save
pm2 startup   # выполнить команду, которую выведет PM2
```

**Обновление до новой версии**

```bash
ssh user@your-server
cd /home/user/ai-panel

git pull
npm ci --omit=dev
pm2 restart ai-panel --update-env
pm2 logs ai-panel --lines 30   # убедиться, что стартовало без ошибок
```

**Откат** (если что-то пошло не так):

```bash
git log --oneline -5            # найти нужный коммит
git checkout <commit>           # откатиться
npm ci --omit=dev
pm2 restart ai-panel --update-env
```

## Настройка (.env)

Скопируйте `.env.example` в `.env` и заполните:

| Переменная | По умолчанию | Описание |
|---|---|---|
| `AIPANEL_ENV_FILE` | `.env` в корне проекта | Путь к env-файлу; задаётся только в окружении, `none` — не читать файл |
| `HOST` | `127.0.0.1` или `0.0.0.0` при `PUBLIC_ORIGIN` | Адрес прослушивания |
| `PORT` | `8765` | Порт сервера (0–65535) |
| `PUBLIC_ORIGIN` | _(пусто)_ | Внешний `https://` origin reverse proxy; явно включает remote deployment |
| `ALLOWED_ORIGINS` | _(пусто)_ | Явный CORS allowlist браузерных origins через запятую |
| `AIPANEL_AUTH_TOKEN` | _(пусто)_ | Токен входа в панель; **обязателен в remote-режиме** (задан `PUBLIC_ORIGIN` или `HOST` вне loopback), минимум 16 символов (`openssl rand -hex 24`) |
| `ALLOWED_HOSTS` | _(пусто)_ | Доп. hostname'ы «своего» сервера через запятую (проверка `Host` против DNS rebinding). Loopback и хост `PUBLIC_ORIGIN` разрешены всегда |
| `TRUST_PROXY` | `false` | `true`, если панель за reverse proxy и `X-Forwarded-Host`/`X-Forwarded-Proto` можно доверять |
| `AIPANEL_MASTER_KEY` | генерируется локально | Необязательный переносимый master key: ровно 64 hex-символа (`openssl rand -hex 32`); пусто — ключ создаётся в `<AIPANEL_DATA_DIR>/store.db.key` |
| `AIPANEL_DATA_DIR` | `data/` | Каталог хранилища (`store.db`, `store.db.key`) и кэша рейтинга; относительный путь считается от корня проекта |
| `AIPANEL_LOG_DIR` | `logs/` | Каталог лога `ai-panel.log` |
| `AIPANEL_PROVIDER_DEBUG` | `false` | Подробный лог запросов к провайдерам (`true`/`false`); ключи маскируются |
| `AIPANEL_CODING_CACHE_PATH` | `<AIPANEL_DATA_DIR>/coding-ratings.json` | Файл кэша рейтинга для кодинга |
| `GOOGLE_CLIENT_ID` | _(пусто)_ | ID клиента OAuth для кнопки «Войти через Google» (Antigravity) |
| `GOOGLE_CLIENT_SECRET` | _(пусто)_ | Секрет клиента OAuth (для типа «Настольное приложение» обычно не нужен) |
| `AGENTROUTER_RELEASE_HOURS_UTC` | `2,11` | Часы высвобождения пула AgentRouter (Claude/GPT) в UTC через запятую. По графику провайдера: Пекин 10:00/19:00 = UTC 02:00/11:00; якорь — `Asia/Shanghai`. Переопределяется также в настройках провайдера (поле «Окна сброса») |

Реальные переменные окружения (`PORT=9000 node server.js`) имеют приоритет над `.env`. Все переменные читает один модуль `src/config.js`; некорректное значение (например, `PORT=abc` или master key не из 64 hex-символов) останавливает старт с понятной ошибкой в логе.

Бэкап, восстановление и диагностика — в разделе [«Эксплуатация»](#эксплуатация).

**Откуда брать `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`** (Google Cloud Console):

1. Откройте <https://console.cloud.google.com/> и выберите или создайте проект.
2. **APIs и сервисы → Экран согласия OAuth** (OAuth consent screen): тип **Внешний** (External), заполните обязательные поля, добавьте себя в тест-пользователи.
3. **APIs и сервисы → Учётные данные** (Credentials) → **Создать учётные данные → ID клиента OAuth**:
   - Тип приложения — **Настольное приложение** (Desktop app). Под локальный сервер подходит именно он, и секрет клиента в этом случае не создаётся (оставьте `GOOGLE_CLIENT_SECRET` пустым).
   - Если выбрали другой тип (Web/Другое), скопируйте также **Секрет клиента** в `GOOGLE_CLIENT_SECRET`.
4. Скопируйте **ID клиента** в `GOOGLE_CLIENT_ID`.
5. В том же клиенте добавьте **URI перенаправления** (Authorized redirect URIs):
   `http://127.0.0.1:<PORT>/api/antigravity-auth/callback` (порт = `PORT`, по умолчанию `8765`).

После правки `.env` перезапустите сервер.

Нажмите **⚙ Настройки** в панели, вставьте ключ, «Проверить и сохранить». Он сохранится в encrypted store сервера и не возвращается клиенту через API.

**OmniRoute** настраивается через диалог **⚙ Настройки** в панели (URL и ключ хранятся на сервере). Можно указать несколько адресов — по одному в строке (например, домашний LAN и удалённый): панель автоматически выбирает доступный.

## Провайдеры

Поддерживаемые провайдеры и что панель умеет для каждого:

| Провайдер | Что показывает панель | Ключ / авторизация | Заводится в |
|---|---|---|---|
| **xKiro** | План, окна расхода (5 ч / 7 д), бесплатные токены, баланс кошелька; каталог моделей с ценами | API-ключ (`sk-xt-…`) | `FACTORIES` (реестр) |
| **AgentRouter** | Баланс кошелька, расход за сутки, группа аккаунта; обратный отсчёт до высвобождения пула Claude/GPT (2 раза в сутки — Пекин 10:00/19:00 = UTC 02:00/11:00, в локальном времени) | Access-токен + User ID (`New-Api-User`) | `FACTORIES` (реестр) |
| **OpenRouter** | Баланс кошелька, расход за сегодня, каталог моделей с ценами и контекстом; рейтинг для кодинга | API-ключ (`sk-or-…`), `Authorization: Bearer` | `FACTORIES` (реестр) |
| **Selora** | План, баланс кошелька, окна расхода (4-часовая сессия / неделя); каталог моделей с ценами за 1M токенов | API-ключ (`sk-gw-…`), `x-api-key` | `FACTORIES` (реестр) |
| **Experiential Labs** | Баланс кредитов, расход и число запросов за сегодня (UTC); каталог моделей с ценами | API-ключ, `Authorization: Bearer` | `FACTORIES` (реестр) |
| **Antigravity** | Квоты Google AI Pro по моделям + групповые окна (5 ч / неделя) | Google OAuth (refresh-token) | Отдельный сервис `src/antigravity-service.js` |
| **OmniRoute** | Combo: список, targets, порядок; последние combo-запросы и реальная модель | Management-ключ (Bearer) | Прокси `src/routes/omniroute.js` |

xKiro, AgentRouter, OpenRouter, Selora и Experiential Labs — вшитые провайдеры реестра (селектор в шапке, `/proxy/{id}/…`); Antigravity и OmniRoute подключаются отдельно через ⚙ Настройки.

Логика работы с API конкретного провайдера — фабрика адаптера в каталоге `providers/`:

### Архитектура

```mermaid
flowchart TD
    B[Браузер: статические страницы] -->|/api, /proxy, /omniroute| S[server.js]
    S --> R[Реестр провайдеров]
    R --> X[xKiro]
    R --> A[AgentRouter]
    R --> OR[OpenRouter]
    R --> SEL[Selora]
    R --> EXP[Experiential Labs]
    S --> G[Antigravity и Google OAuth]
    S --> OM[OmniRoute]
    S --> V[src/store]
    V --> D[(SQLite-файл)]
```

- `providers/xkiro.js` — `createXKiroProvider(config)` возвращает адаптер с функциями `getUsage(key)`, `getModels(key)` и авторизацией `x-api-key`
- `providers/agentrouter.js` — `createAgentRouterProvider(config)`: `getUsage(key, userId)` читает профиль `GET /api/user/self` (баланс кошелька), `getModels(key, userId)` — список моделей `GET /api/user/models`; авторизация `Authorization: Bearer <access-токен>` + `New-Api-User`
- `providers/openrouter.js` — `createOpenRouterProvider(config)`: `getUsage(key)` читает кредиты `GET /auth/key`, `getModels(key)` — каталог `GET /models` (нормализуется в формат панели); авторизация `Authorization: Bearer <ключ>`
- `providers/selora.js` — `createSeloraProvider(config)`: `getUsage(key)` собирает профиль `GET /v1/me` и окна расхода `GET /v1/me/windows` (сессия 4 ч / неделя, фолбэк на окна из профиля), `getModels(key)` — каталог `GET /v1/models` без авторизации; авторизация `x-api-key <ключ>`
- `providers/experiential.js` — `createExperientialProvider(config)`: `getUsage(key)` — кредиты `GET /api/v1/credits` и дневной расход `GET /api/gateway/usage/daily`, `getModels(key)` — каталог `GET /api/models`; авторизация `Authorization: Bearer <ключ>`
- `providers/antigravity.js` — `createAntigravityProvider(config)`: `getQuota({token, project})` и `getQuotaSummary({token, project})` для квот Google AI Pro; токен берётся из OAuth-flow, а не из ключа. В `FACTORIES` не входит — адаптер использует `src/antigravity-service.js`
- `providers/google-oauth.js` — `createGoogleOauth(config)`: `exchangeCode(…)` (обмен одноразового кода после входа) и `refresh(…)` (автообновление access-token по refresh-token)
- `providers/index.js` — реестр: `FACTORIES` (id → фабрика) и `loadProviders()`, возвращает список вшитых адаптеров

Набор провайдеров вшит в код: активен каждый из `FACTORIES`, первый — активный по умолчанию. Настройки провайдеров в окружении не задаются: адрес API вшит в фабрику, ключи хранятся в encrypted store сервера.

Панель получает данные через эндпоинты сервера:

| Эндпоинт | Назначение |
|---|---|
| `GET /api/config` | Публичная DTO настроек и признаки `hasKey` — без секретов |
| `PUT /api/config` | Write-only сохранение настроек и секретов |
| `GET /api/providers/{id}/usage` | Статистика через адаптер провайдера |
| `GET /api/providers/{id}/models` | Каталог моделей через адаптер провайдера |
| `GET/POST/DELETE /api/settings/google-token` | Статус, приём и сброс учётных данных Antigravity (access token — в памяти процесса) |
| `GET /api/antigravity-auth/start` | Ссылка входа Google (OAuth, одноразовый `state` с TTL) |
| `GET /api/antigravity-auth/callback` | Страница-подсказка после входа Google (код остаётся в адресной строке) |
| `POST /api/antigravity-auth/paste` | Обмен кода из вставленной ссылки на токены |
| `GET /api/antigravity-quota` | Квоты Antigravity по моделям (кеш 60 с) |
| `/proxy/{id}/v1/…` | Сырой прокси к API провайдера (или `/proxy/v1/…` — активный) |
| `/omniroute/…` | Прокси к сохранённому на сервере OmniRoute URL |
| `GET /api/coding-ratings` | Онлайн-рейтинг для кодинга (кэш Artificial Analysis Coding Index) |
| `POST /api/coding-ratings/refresh` | Обновить рейтинг (берёт ключ OpenRouter из хранилища) |
| `GET /api/accounts`, `POST /api/accounts` | Мультиаккаунты: список (только признаки `has*`) и создание |
| `GET/PUT /api/accounts/active` | Активный аккаунт |
| `PUT/DELETE /api/accounts/{name}` | Обновление и удаление аккаунта |
| `GET /api/health` | Liveness: процесс отвечает |
| `GET /api/ready` | Readiness: хранилище открыто и последние изменения записаны на диск, трекер AgentRouter запущен; иначе 503 |
| `GET /api/metrics` | Число запросов, ошибок 5xx и среднее время ответа с момента старта |
| `GET /api/auth/status` | Вход включён? Есть ли активная сессия (только булевы флаги) |
| `POST /api/auth/login` | Вход по `AIPANEL_AUTH_TOKEN`, выдаёт сессионную cookie |
| `POST /api/auth/logout` | Отменяет сессию (очищает cookie) |

Ключ провайдера берётся из encrypted store; временный `x-api-key` поддерживается для совместимости. Ответ upstream нормализуется адаптером провайдера.

**Добавить нового провайдера:** файл `providers/<id>.js` с фабрикой по образцу `xkiro.js` (функции `getUsage`/`getModels`, `upstream`) и строка в `FACTORIES` в `providers/index.js`; поле ключа — в `src/provider-store-fields.js`, `STORE_KEYS` и `WRITABLE_KEYS`, форма и карточка — во фронтенде. Настройки в `.env` не нужны.

## AgentRouter (баланс кошелька)

Провайдер [agentrouter.org](https://agentrouter.org) (платформа new-api) — **баланс кошелька**, расход за сутки и список доступных моделей; окон расхода у new-api нет. На главной есть отдельная карточка **AgentRouter** (баланс и расход за сутки, группа аккаунта); она показывается, когда токен задан, и прячется, если в полосе статистики уже выбран этот провайдер. В самой полосе провайдер выбирается селектором рядом с балансом (выбор запоминается).

**Настройка:** ⚙ Настройки → провайдер **AgentRouter** → вставьте **access-токен** и **User ID** аккаунта (в одной строке):

1. Войдите на agentrouter.org → аватар → **Security Settings** → раздел **System Access Token** → сгенерируйте и скопируйте токен.
2. Вставьте токен в поле «Access-токен», а в поле «User ID» — числовой ID из профиля сайта → **Проверить и сохранить**. Панель покажет баланс. Учтите: повторная генерация отзывает старый токен.
3. Поле **«Окна сброса»** задаёт часы высвобождения пула — именно оно управляет блоком «Высвобождение пула» и уведомлением о сбросе. Формат — часы 0–23 через запятую (напр. «2,11»); дефолт провайдера — Пекин 10:00/19:00 = UTC 02:00/11:00. **Пусто — блок и уведомления скрыты** (не показывается даже дефолт). Переопределяет `AGENTROUTER_RELEASE_HOURS_UTC` из `.env`.

Токен уходит в заголовке `Authorization: Bearer <token>` на `GET /api/user/self`, а рядом — `New-Api-User: <User ID>` (новые версии new-api требуют ID пользователя вместе с токеном — защита от кражи токенов; без него сайт отвечает 401 «未提供 New-Api-User»). Баланс считается как `data.quota / 500000` (в `/api/status` сайта это поле `quota_per_unit`), до двух знаков; там же берётся `used_quota` → «Израсходовано». Группа аккаунта показывается badge-ем. Для «расхода за сутки» сервер раз в сутки (граница — 00:00 UTC, как у OpenRouter и Experiential) снимает стартовый баланс дня и хранит его в БД (только последний день) — карточка вычитает из него текущий баланс. Перезапуск сервера днём снимок не переснимает. API-ключ (sk-…) **не подходит** — он авторизует только запросы к моделям `/v1/*`.

Токен и User ID хранятся на сервере в зашифрованном виде (поля `agentrouterKey` и `agentrouterUserId` хранилища) и не возвращаются клиенту — как и ключ xKiro.

## OpenRouter (баланс кошелька)

Провайдер [openrouter.ai](https://openrouter.ai) — единый API к сотням LLM. Панель показывает **баланс кошелька** и **расход за сегодня**, каталог моделей с ценами и контекстом — на странице «Модели», а также онлайн-рейтинг для кодинга (Artificial Analysis) для колонки «Код».

**Настройка:** ⚙ Настройки → провайдер **OpenRouter** → вставьте API-ключ (`sk-or-v1-…`) → **Проверить и сохранить**. Панель запросит `GET /auth/key` и покажет баланс.

1. Создайте ключ на сайте (`openrouter.ai` → **Keys** → **Create Key**) — достаточно обычного ключа, management не требуется.
2. Вставьте ключ в поле «API-ключ» → **Проверить и сохранить**.

Ключ уходит в заголовке `Authorization: Bearer <ключ>`. **Баланс:** эндпоинт `/auth/key` отдаёт лимит ключа (`limit`/`limit_remaining`) — это граница расхода, заданная для ключа, а не кошелёк. Если у ключа лимита нет (оба поля `null`), панель дополнительно опрашивает `GET /credits` (`total_credits − total_usage` — реальный баланс; запрос проходит с обычным ключом). Расход за сегодня берётся из `usage_daily`.

Ключ хранится в зашифрованном хранилище сервера (поле `openrouterKey`) и не возвращается клиенту. Тот же ключ используется кнопкой **«Обновить рейтинг»** на странице «Модели». На главной баланс показывается в карточке **OpenRouter** рядом с карточкой AgentRouter — обе стоят в один ряд; карточка скрыта, если OpenRouter выбран активным провайдером в полосе статистики.

## Antigravity (Google AI Pro)

Секция квот на главной странице: процент использованных лимитов по моделям Claude (данные Google `fetchAvailableModels`, референс — [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager)).

**Настройка:** откройте **⚙ Настройки** → провайдер **Antigravity** в карточке «Провайдер»:

1. Нажмите **«Войти через Google»** и войдите в аккаунт (OAuth-клиент Antigravity вшит в сервер).
2. После входа браузер перейдёт на loopback-адрес `http://127.0.0.1:<порт>/callback?code=…` — страница может не открыться (это нормально, Google разрешает только такие redirect). **Скопируйте адрес целиком из адресной строки.**
3. Вставьте ссылку в поле **«Ссылка после входа»** и нажмите **«Применить»**: сервер обменяет код на токены (код одноразовый, живёт ~10 минут) и сохранит их.

Access token хранится в памяти, refresh token — в encrypted store сервера; клиенту возвращается лишь статус «задан/не задан» и время истечения. Пока действует refresh token, сервер обновляет access token сам.

Необязательно заполните **Project ID** (обходит ошибку `project_required` для аккаунтов без активного GCP-проекта) — он хранится в encrypted store сервера.

**Риски:** токен даёт доступ к вашему аккаунту Google. Передавайте его только своему локальному серверу панели; не публикуйте и не вставляйте его в сторонние сервисы.

Ошибки мапятся в понятные коды: `no_token` (ничего не задано), `token_expired` (401 от Google или отозванный refresh-token), `project_required` (403 после fallback без project), `rate_limited` (429), `provider_error` (сеть/таймаут). Ответы Google кешируются на 60 секунд.

Помимо per-model квот панель показывает **групповые окна** из `retrieveUserQuotaSummary`: «Окно 5 ч» и «Недельное окно» (худший остаток среди моделей). Ошибка этого эндпоинта не ломает основной ответ.

## Используемые API

| Эндпоинт | Назначение | Стоимость вызова |
|---|---|---|
| `GET https://api.xkiro.com/v1/usage` | План, окна расхода, бесплатные токены, кошелёк | Бесплатно |
| `GET https://api.xkiro.com/v1/models` | Каталог моделей с ценами | Бесплатно |
| `GET https://agentrouter.org/api/user/self` | Баланс кошелька AgentRouter (нужен access-токен в `Authorization: Bearer`) | Бесплатно |
| `GET https://openrouter.ai/api/v1/auth/key` | Информация о ключе OpenRouter: лимит, остаток, расход (нужен `Authorization: Bearer <ключ>`) | Бесплатно |
| `GET https://openrouter.ai/api/v1/credits` | Баланс кошелька OpenRouter (`total_credits − total_usage`), если у ключа нет лимита | Бесплатно |
| `GET https://openrouter.ai/api/v1/models` | Каталог моделей OpenRouter с ценами и контекстом | Бесплатно |
| `GET {omniUrl}/api/combos` | Список всех combo OmniRoute | — |
| `GET {omniUrl}/api/combos/{id}` | Детали combo (targets, strategy) | — |
| `PUT {omniUrl}/api/combos/{id}` | Обновить combo (перестановка targets) | — |
| `GET {omniUrl}/api/usage/call-logs?limit=200` | Последние запросы: реальная модель (`model`) за combo-запросами; требует management-ключ | — |
| `POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` | Квоты Antigravity по моделям (нужен заголовок User-Agent `vscode/… (Antigravity/…)`) | Бесплатно |
| `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | Групповые окна Antigravity (weekly / 5h) | Бесплатно |
| `POST https://oauth2.googleapis.com/token` | Обмен кода / обновление access-token | Бесплатно |
| `GET https://accounts.google.com/o/oauth2/v2/auth` | Окно авторизации Google (кнопка «Войти через Google») | — |

Деньги приходят строками (`"683.950000"`), парсятся во float только для отображения.

## Каталог моделей

Страница **Модели** (`/models.html`) — выбор провайдера, поиск по имени, таблица с ценами ($/1M токенов), тирами доступа и контекстным окном.

### Рейтинг для кодинга

Колонка **Код** — онлайн-оценка модели для кодинга (Artificial Analysis Coding Index, 0–100) из OpenRouter Benchmarks API. Кнопка **«Обновить рейтинг»** загружает свежие данные; без них модели помечаются «нет данных».

Ключ тот же, что у провайдера **OpenRouter** в Настройках: маршрут `POST /api/coding-ratings/refresh` берёт его из серверного хранилища (клиентский `x-openrouter-api-key`/`x-api-key` приоритетнее). Кэш — `<AIPANEL_DATA_DIR>/coding-ratings.json` или `AIPANEL_CODING_CACHE_PATH` (24 ч).

## Эксплуатация

**Где что лежит.** Хранилище — `<AIPANEL_DATA_DIR>/store.db` (SQLite, каждое значение зашифровано AES-256-GCM), master key — `<AIPANEL_DATA_DIR>/store.db.key` или `AIPANEL_MASTER_KEY`. Лог — `<AIPANEL_LOG_DIR>/ai-panel.log` (одна строка на событие, при 50 МБ файл переименовывается в `.old`). Файлы создаются с правами `0600`, каталоги — `0700`.

**Бэкап.** Скопируйте `store.db` **вместе** с ключом (`store.db.key` или значение `AIPANEL_MASTER_KEY`): без ключа данные не расшифровать. База записывается атомарно (временный файл → `fsync` → `rename`), поэтому копировать её можно на работающем сервере. Ключ храните отдельно от копии базы.

**Восстановление.** Остановите сервер, положите `store.db` и `store.db.key` в `AIPANEL_DATA_DIR` (или задайте `AIPANEL_MASTER_KEY`), запустите. Сервер проверяет ключ при старте и не запустится, если:

- `wrong_key` — ключ не подходит к базе: верните ключ от этой копии;
- `corrupted` — повреждены отдельные записи: восстановите базу из более ранней копии.

**Мониторинг.** `GET /api/health` — процесс жив; `GET /api/ready` — хранилище открыто, последние изменения на диске, трекер запущен (иначе 503). Если запись на диск не удалась (нет места, права), сервер продолжает работать, повторяет запись с паузой и пишет предупреждение в лог; `/api/ready` отвечает 503, пока запись не пройдёт.

**Остановка.** По `SIGTERM`/`SIGINT` сервер дожидается завершения запросов и записи хранилища; если за 5 с не уложился или данные не сохранились — выходит с кодом 1 и пишет причину в лог.

## Тесты

```
npm test            # unit + интеграционные (node:test)
npm run test:ci     # то же с порогом покрытия src/, providers/, public/
npm run lint:docs   # README и .env.example соответствуют коду
```

Зависимостей нет — используется встроенный раннер Node (`node:test`). Тесты не трогают рабочие данные: конфигурация строится из явного env (`test/helpers.js` → `testEnv`), `data/` и `logs/` создаются во временном каталоге, `.env` не читается.


- `test/providers-registry.test.js` — реестр вшитых провайдеров: список по умолчанию
- `test/openrouter.test.js` — адаптер OpenRouter (usage/models, нормализация, ошибки) и обновление рейтинга: ключ из хранилища, ошибка без ключа, кэш
- `test/xkiro-adapter.test.js` — фабрика адаптера xKiro против mock-upstream: пути, приоритет ключей, ошибки сети и формата ответа
- `test/selora-adapter.test.js` — фабрика адаптера Selora против mock-upstream: профиль и окна (сессия 4 ч / неделя), фолбэк окон из профиля, каталог без авторизации, ошибки сети и формата ответа
- `test/model-match.test.js` — сопоставление модели из combo с каталогом (префикс провайдера, «:free»-варианты, тарифные бейджи)
- `test/call-logs.test.js` — разбор call logs OmniRoute: combo-строки, реальная модель, сортировка, сводка по моделям
- `test/server.test.js` — интеграционные: сервер поднимается через `createApp` с адаптерами на mock-upstream (плюс smoke-тест CLI-запуска), проверяются `/api/config`, `/api/providers/…`, оба формата прокси и статика
- `test/antigravity.test.js` — квоты Antigravity против mock-Google: заголовки (Bearer + User-Agent), fallback `{}` при 403, кеш 60 с, все коды ошибок, refresh-token flow (автообновление, повтор после 401, invalid_grant), групповые окна weekly/5h и тесты «токен/секреты не попадают в ответы/логи»

Реальные API провайдеров не вызываются: адаптеры в тестах смотрят на mock-upstream, передаваемый напрямую в сервер (через `createApp`).

## Combo (OmniRoute)

Страница **Combo** (`/combo.html`) управляет routing combo из вашего OmniRoute-инстанса. Ключ xKiro для неё не нужен — запросы идут через OmniRoute.

**Требуется установленный OmniRoute.** OmniRoute — отдельное приложение (open-source AI-gateway, MIT, [github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)), которое нужно установить и запустить самостоятельно: панель подключается к уже работающему инстансу и сама его не поднимает. Без OmniRoute страница Combo работать не будет.

Установка (нужен Node.js ≥ 22.22.2, поддерживаются также 24–26):

```bash
npm install -g omniroute
omniroute            # дашборд и API появятся на http://localhost:20128
```

Вариант через Docker:

```bash
docker run -d --name omniroute --restart unless-stopped --stop-timeout 40 \
  -p 127.0.0.1:20128:20128 -v omniroute-data:/app/data diegosouzapw/omniroute:latest
```

В примере выше Docker публикует порт только на `127.0.0.1` хоста; если панель работает в другом контейнере/namespace, откройте порт на нужный интерфейс и укажите доступный URL в Настройках.

**Настройка:** откройте **⚙ Настройки** в панели, введите URL OmniRoute (например `http://localhost:20128`) и, если инстанс требует management-авторизацию, ключ с правами management. Можно указать несколько URL — по одному в строке (домашний LAN-адрес и удалённый): перед каждым запросом панель проверяет доступность и использует первый живой адрес. URL и ключ хранятся в encrypted store сервера. Клиент обращается только к `/omniroute/…`; сервер валидирует сохранённые URL и добавляет management key в `Authorization: Bearer …`.

Сохранённые в настройках URL являются единственными разрешёнными OmniRoute upstream. Дополнительная переменная окружения для LAN-адресов не нужна; URL из клиентских заголовков сервер игнорирует.

**Возможности:**

1. Выбор combo из списка — панель загружает все combo через `GET /api/combos`, при выборе — детали через `GET /api/combos/{id}`.
2. Просмотр списка targets (provider/model) с нумерацией и стратегией роутинга.
3. **Переставить первой** — выберите target в списке и нажмите кнопку; порядок обновится через `PUT /api/combos/{id}`.
4. **Последние combo-запросы → реальная модель** — таблица последних 10 запросов через combo (из `GET /api/usage/call-logs?limit=200` OmniRoute): время, имя combo, модель которая реально ответила (`model`), провайдер, токены (`tokens.in/out`, детали с кэшем — в подсказке) и статус; под таблицей — сводка «какая модель сколько раз».
5. **Алиасы провайдеров** — настройте-readable имена для provider ID из OmniRoute (в Настройках).

Combo создаются и удаляются в самом OmniRoute (Dashboard → Combos). Панель только отображает и переставляет targets.

## Файлы

```
ai-panel/
├── server.js          # точка входа (node server.js, PM2): сборка — src/app.js, запуск — src/main.js
├── src/               # серверная часть
│   ├── config.js      # единственное место чтения переменных окружения (ENV_VARS, loadConfig)
│   ├── app.js         # createApp: сборка приложения, security-периметр, error boundary, lifecycle
│   ├── main.js        # CLI-запуск: env-файл, конфигурация, listen, graceful shutdown
│   ├── http.js        # HTTP-инфраструктура: AppError, sendJson, readJson, request ID
│   ├── router.js      # декларативный роутер (params, 400/404/405)
│   ├── security.js    # CORS/same-origin, security headers, валидация upstream URL
│   ├── file-logger.js # файловый лог (logs/ai-panel.log), normalizeLog
│   ├── metrics.js     # счётчики запросов для /api/metrics
│   ├── routes/        # модули маршрутов: providers, proxy, omniroute, antigravity,
│   │                  #   config, accounts, coding-ratings
│   ├── antigravity-service.js # состояние Google-авторизации и кеш квот
│   ├── agentrouter-tracker.js # ежедневный снимок баланса AgentRouter
│   ├── coding-ratings.js # рейтинг для кодинга: Artificial Analysis через OpenRouter, кеш 24 ч
│   ├── fetch-utils.js # fetch с таймаутом и разбором JSON
│   ├── static.js      # раздача public/ (path traversal-защита)
│   ├── proxy.js       # универсальный прозрачный прокси (/proxy, /omniroute)
│   ├── store/         # encrypted store: фасад index.js, crypto, master-key,
│   │                  #   persistence, accounts, CLI rotate-key
│   └── provider-store-fields.js # маппинг провайдер → поля хранилища
├── config/            # конфиги инструментов: eslint.config.js, playwright.config.js
├── providers/         # провайдеры AI-API
│   ├── index.js       # реестр: FACTORIES + loadProviders()
│   ├── xkiro.js       # адаптер xKiro (getUsage, getModels)
│   ├── agentrouter.js # адаптер AgentRouter (баланс кошелька, модели, график пула)
│   ├── openrouter.js  # адаптер OpenRouter (getUsage, getModels)
│   ├── selora.js      # адаптер Selora (профиль, окна расхода, модели)
│   ├── experiential.js# адаптер Experiential Labs (кредиты, расход за сегодня, модели)
│   ├── antigravity.js # адаптер Antigravity (getQuota, getQuotaSummary)
│   └── google-oauth.js# Google OAuth: обмен кода, refresh, userinfo
├── scripts/           # check-docs.js (README ↔ код), check-secrets.js
├── test/              # тесты node:test: helpers.js (mock-upstream, запуск панели,
│                      #   изолированная конфигурация) и *.test.js по модулям
├── tests/playwright/  # браузерные тесты (smoke, вкладки настроек)
├── package.json       # скрипты start/test/lint/stylelint/lint:docs/check:secrets;
│                      #   prod-зависимость одна (sql.js), остальное — dev-инструменты
├── .github/workflows/ # CI: lint, документация, тесты с покрытием, Playwright, audit
├── data/              # хранилище (AIPANEL_DATA_DIR) — не коммитится
├── logs/              # лог (AIPANEL_LOG_DIR) — не коммитится
├── .env               # настройки — не коммитится
├── .env.example       # шаблон настроек
└── public/
    ├── index.html     # страница «Статистика» (главная)
    ├── models.html    # страница «Модели»: каталог моделей
    ├── combo.html     # страница «Combo»: routing combo OmniRoute
    ├── cheatsheet.html# страница «Шпаргалка»: команда обновления opencode
    ├── icons.js       # ES-модуль: heroicons
    ├── partials.js    # ES-модуль: общие HTML-компоненты (шапка, диалог, баннер)
    ├── model-match.js # ES-модуль: сопоставление модели combo с каталогом
    ├── coding-rating.js # ES-модуль: онлайн-рейтинг для кодинга (колонка «Код»)
    ├── js/            # фронтенд-модули
    │   ├── boot.js    # запуск страницы: partials → общий UI → page.init()
    │   ├── session.js # общее состояние: провайдеры, каталог моделей
    │   ├── settings.js# settings client: серверное хранилище, write-only секреты
    │   ├── api.js     # API client: провайдеры, OmniRoute, Antigravity
    │   ├── dialog.js  # диалог настроек: батч-сохранение, проверка ключей
    │   ├── notifications.js # браузерные уведомления о лимитах
    │   ├── topbar.js  # статус, время обновления, мобильное меню
    │   ├── banner.js  # баннер ошибок
    │   ├── dom.js     # $id/on, инлайн-иконки статуса
    │   ├── events.js  # мини-шина событий (диалог ↔ страницы)
    │   ├── aliases.js # сопоставление имён OmniRoute (хранилище + UI)
    │   ├── combos.js  # разбор combo-объектов OmniRoute
    │   ├── call-logs.js # разбор call logs OmniRoute (combo → реальная модель)
    │   ├── formatters.js # чистые форматтеры (unit-тесты)
    │   └── pages/     # entry и логика каждой страницы:
    │                  #   index, models, combo, cheatsheet
    ├── css/           # стили, порядок подключения важен:
    │                  #   themes, base, layout, components,
    │                  #   pages, dialogs, responsive
    ├── favicon.svg
    └── assets/imgs/   # скриншоты интерфейса
```

## Планы развития

- [x] OmniRoute: переключение моделей в combo (auto-coding и др.) по их API
- [x] Провайдеры: фабрики-адаптеры в `providers/` (xKiro, AgentRouter, OpenRouter, Selora, Experiential Labs, Antigravity + refresh-token flow)
- [x] Страница «Управление» с командой обновления opencode
- [x] Алиасы имён провайдеров для OmniRoute
- [x] AgentRouter: список моделей и расход за сутки (окон расхода у new-api нет)
- [x] Уведомления при приближении к лимитам (пороги настраиваются в диалоге настроек)
- [ ] История расходов по провайдерам с графиком за неделю/месяц
- [ ] Внешние каналы уведомлений (Telegram, webhook)
- [ ] Кнопка запуска/остановки dev-процессов — только после аутентификации и по allowlist команд

Текущий план работ — [`IMPROVEMENT_PLAN.md`](IMPROVEMENT_PLAN.md).
