# Release checklist

Короткий воспроизводимый сценарий выпуска и отката AI Panel.

## Перед выпуском

1. Использовать Node.js версии из `.nvmrc` и выполнить `npm ci`.
2. Запустить `npm run lint`, `npm run stylelint`, `npm run check:types`, `npm run lint:docs`, `npm run test` и `npm run test:security`.
3. Создать backup до миграций:
   ```sh
   npm run store:backup -- backup --output ./backup/<timestamp>
   npm run store:backup -- verify --input ./backup/<timestamp>
   ```
4. Master key (`AIPANEL_MASTER_KEY` или файл `<store>.key`) хранить отдельно от backup базы.
5. Проверить совместимость Node.js, lockfile и production-зависимостей.

## Деплой и проверка

1. Остановить текущий процесс штатным `SIGTERM` (PM2/systemd/Docker).
2. Установить зависимости через `npm ci` и запустить production-команду `npm start` либо штатный supervisor.
3. Проверить `GET /api/ready`, затем `GET /api/health` и `/api/metrics`.
4. Проверить логи запуска, миграций схемы и отсутствие ошибок записи store.

Схема encrypted store имеет явную версию в таблице `schema_meta`. Текущая версия экспортируется как `STORE_SCHEMA_VERSION`; неподдерживаемая версия отклоняется до чтения пользовательских данных.

## Откат

1. Остановить процесс и сохранить логи.
2. Установить предыдущую версию приложения из того же lockfile.
3. Восстановить backup во временный каталог и проверить его:
   ```sh
   npm run store:backup -- restore --input ./backup/<timestamp> --output ./data-rollback
   npm run store:backup -- verify --input ./data-rollback
   ```
4. Заменить data-каталог только после успешной проверки; master key вернуть из отдельного защищённого хранилища.
5. Запустить процесс и проверить `/api/ready`.

Не удаляйте рабочий каталог до подтверждения успешного запуска и возможности повторного отката.

Breaking changes в контракте провайдеров и внутреннем DTO фиксируются в `CHANGELOG.md` (раздел «Провайдеры»); перед выпуском проверьте, что запись добавлена.
