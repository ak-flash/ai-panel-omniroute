# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/); версиям присваивается SemVer.
Раздел «Провайдеры» фиксирует breaking changes в контракте адаптеров и внутреннем DTO.

## [Unreleased]

### Провайдеры

- Введена явная версия схемы encrypted store (`schema_meta`, `STORE_SCHEMA_VERSION`); store с неподдерживаемой версией отклоняется до чтения пользовательских данных.
- Внутренний provider DTO нормализован: usage, models, errors и capability flags описаны в дескрипторах адаптеров и проверяются общим contract suite (`test/unit/provider-contract.test.js`).
- Ошибки провайдеров получили стабильные machine-readable коды: `provider_timeout`, `provider_unreachable`, `provider_circuit_open` (с `retry_after_ms`) внутри существующего `error: 'provider_error'`.

При добавлении breaking change в контракт адаптера или DTO добавляйте запись в этот раздел и повышайте соответствующую версию схемы/дескриптора (см. `docs/RELEASE.md`).
