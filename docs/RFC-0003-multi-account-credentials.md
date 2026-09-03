# RFC-0003: Multi-Account Credentials

**Статус:** предлагается (draft).
**Дата:** 2026-09-03.
**Авторы:** AI Panel.
**Связанные документы:** [docs/STORE.md](STORE.md), [docs/BASELINE.md](BASELINE.md),
[docs/RFC-0001-agentrouter-models.md](RFC-0001-agentrouter-models.md),
[docs/IMPROVEMENT_AND_REFACTORING_PLAN.md](../IMPROVEMENT_AND_REFACTORING_PLAN.md) (Этап 11).

## 1. Мотивация

Сейчас у каждого провайдера ровно один слот для ключа/учётных данных
(`xkiroKey`, `agentrouterKey` + `agentrouterUserId`, `omniUrl`/`omniKey`,
`agRefreshToken`/`agProject`/`agEmail`). В роадмапе уже есть
«Несколько аккаунтов через сущности `account` и `credential`» — пользователь
хочет держать 2–3 аккаунта xKiro, разные т