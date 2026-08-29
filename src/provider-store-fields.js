'use strict';

// ============================================================
// Маппинг «провайдер → поля серверного хранилища».
//
// Ключи провайдеров клиент больше не хранит: секреты лежат в
// зашифрованном SQLite (store.js). Константы нужны трём местам:
//   - /api/providers/<id>/usage — фолбэк ключа, если клиент не
//     прислал свой (x-api-key / x-agentrouter-user-id);
//   - /api/config — hasKey в списке провайдеров;
//   - ежедневный снимок AgentRouter (src/agentrouter-tracker.js).
// ============================================================

/** Поле хранилища с ключом провайдера. */
const PROVIDER_STORE_KEYS = { xkiro: 'xkiroKey', agentrouter: 'agentrouterKey' };

/** Дополнительные поля авторизации (у AgentRouter — числовой ID
 * пользователя для заголовка New-Api-User). */
const PROVIDER_STORE_USER_FIELDS = { agentrouter: 'agentrouterUserId' };

module.exports = { PROVIDER_STORE_KEYS, PROVIDER_STORE_USER_FIELDS };
