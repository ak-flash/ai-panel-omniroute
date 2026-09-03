# RFC-0002: Пороговые уведомления

## Проблема

Пользователь не получает предупреждений, когда баланс или квота
провайдера опускается до критичного уровня: чтобы узнать состояние,
нужно открыть страницу «Статистика» и прочитать цифры вручную.

## Предпосылки

- Панель локальная, single-user. Уведомления адресуются только тому,
  кто сидит за браузером.
- Уже есть инфраструктура:
  - `public/js/toast.js` — `showToast(message, { type, timeout })`;
  - `vaultGet` / `vaultSet` / `saveSettings` (public/js/settings.js) —
    работа с серверным хранилищем;
  - `STORE_KEYS` (src/store/index.js) + `WRITABLE_KEYS`
    (src/routes/config.js) — allowlist для новых настроек;
  - `getUsage` / `getAntigravityQuota` / `providerRequest` —
    данные, на основе которых вычисляются пороги.
- Существующая «memory» в `index.js` подходит для dedup
  (не повторять одно и то же уведомление за сессию).

## Дизайн

### 1. Хранилище

Новый ключ `notificationThresholds` в `STORE_KEYS` и `WRITABLE_KEYS`.
Значение — JSON-строка:

```json
{
  "xkiro":        { "short_window_pct": 80, "long_window_pct": 80 },
  "agentrouter":  { "balance_below_usd": 10 },
  "antigravity":  { "remaining_below_pct": 20 }
}
```

Поле есть — порог активен, нет или `null` — не активен. `0` валиден
(«уведомлять когда лимит 0» = немедленно при появлении провайдера).

### 2. Чистая логика (`public/js/notifications.js`)

ES-модуль с чистыми функциями, без побочных эффектов. Тестируется
через `node --test`:

- `evaluateXKiro(usage, thresholds) -> [{ id, level, message }]`
- `evaluateAgentRouter(usage, thresholds) -> [...]`
- `evaluateAntigravity(quota, thresholds) -> [...]`

Каждый id уникален в пределах сессии (например,
`xkiro.short_window_pct.80`) — используется для dedup.

### 3. Дедупликация

В `index.js` — `Map<id, boolean>` уже показанных за сессию
уведомлений. Не показываем тост, если id уже в Map.
Дропается по явной кнопке «Сбросить уведомления» в диалоге
(опционально для первой версии) или при перезагрузке страницы
(сессия = текущий запуск).

### 4. UI

В диалоге настроек добавляется секция «Уведомления» с полями:

- xKiro: «Короткое окно ≥ %» / «Длинное окно ≥ %» (число 1–100);
- AgentRouter: «Баланс ниже $» (число);
- Antigravity: «Остаток квоты < %» (число 1–100).

Сохранение через `saveSettings({ notificationThresholds: JSON.stringify({...}) })`.

## Безопасность

- Ключ `notificationThresholds` — обычная настройка (не секрет).
- Чистая логика в `notifications.js` не получает ключей/токенов.
- Данные провайдеров приходят через `/api/providers/...` — тот же
  путь, что и для отображения карточек; дополнительных слоёв не добавляем.

## Тестирование

`test/notifications.test.js`:

- порог сработал → запись в массиве;
- порог не сработал → пустой массив;
- порог не задан (`thresholds = {}` / `null` поля) → пустой массив;
- некорректные данные (`usage.windows` без `short`) → не падает, пустой массив;
- денормализация входа (строка → число, запятая → точка) — терпимо.

## Ограничения

- Уведомления показываются только когда страница открыта.
  Push/email/webhook — за рамками (single-user desktop).
- Дедупликация только в пределах сессии (per-page-load). При
  перезагрузке страницы показывается снова, если порог ещё
  актуален — это ожидаемо и простое поведение.
- Только три провайдера в первой версии (xkiro, agentrouter, antigravity).

## Ссылки

- `public/js/notifications.js` — чистая логика.
- `public/js/pages/index.js` — вызов evaluator, dedup, showToast.
- `public/js/dialog.js` — поля в диалоге.
- `src/store/index.js`, `src/routes/config.js` — allowlist ключа.
- `test/notifications.test.js` — unit-тесты.
