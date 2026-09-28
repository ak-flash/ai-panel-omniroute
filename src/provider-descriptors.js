'use strict';

// ============================================================
// Дескрипторы провайдеров (P2-1) — единственный источник правды.
//
// Раньше список провайдеров и их ключи хранилища дублировались в
// шести местах: providers/index.js, src/provider-store-fields.js,
// src/store/index.js (STORE_KEYS), src/store/accounts.js
// (PROVIDER_IDS), src/routes/config.js (WRITABLE_KEYS,
// credentialFields, has*Key) и во фронтенде. Расхождение уже было:
// провайдер появлялся в адаптере, но не в списке восстановления
// диалога или в форме настроек.
//
// Теперь из DESCRIPTORS строятся:
//   PROVIDER_STORE_KEYS    — id → ключ legacy KV;
//   PROVIDER_STORE_USER_FIELDS — id → ключ ID пользователя;
//   PROVIDER_IDS           — список провайдеров с учётными данными;
//   STORE_KEYS             — схема хранилища (часть);
//   WRITABLE_KEYS          — allowlist записи из UI (часть);
//   CREDENTIAL_FIELDS      — ключ KV → [id провайдера, поле];
//   has*Key в /api/config  — по дескрипторам, без ручного списка.
//
// Цель: новый провайдер = providers/<id>.js (адаптер + дескриптор) и
// test/unit/<id>-adapter.test.js.
// ============================================================

/**
 * @typedef {object} ProviderDescriptor
 * @property {string} id            идентификатор (совпадает с ключом в FACTORIES)
 * @property {string} name          отображаемое имя
 * @property {string} [site]        сайт провайдера для карточки
 * @property {string} storeKey      ключ legacy KV (fallback для старых баз)
 * @property {string} [userField]   ключ KV с ID пользователя (AgentRouter)
 * @property {{field: string, storeKey: string}[]} [credentials]
 *   поля учётных данных активного аккаунта: api_key, user_id, url, key…
 * @property {string} [userHeader]  HTTP-заголовок, из которого берётся ID
 * @property {boolean} [apiKeyHeader] принимает ли ключ из x-api-key
 * @property {string} [authScheme]   схема авторизации адаптера
 * @property {boolean} [adapter]     false для служебных провайдеров без адаптера
 * @property {object} [capabilities] возможности (windows, pool…)
 */

/** @type {Record<string, ProviderDescriptor>} */
const DESCRIPTORS = {
  xkiro: {
    id: 'xkiro',
    name: 'xKiro',
    site: 'https://xkiro.com/dashboard',
    storeKey: 'xkiroKey',
    credentials: [{ field: 'api_key', storeKey: 'xkiroKey' }],
    apiKeyHeader: true,
    authScheme: 'x-api-key',
    capabilities: { windows: true, models: true, balance: true },
  },
  agentrouter: {
    id: 'agentrouter',
    name: 'AgentRouter',
    site: 'https://agentrouter.org',
    storeKey: 'agentrouterKey',
    userField: 'agentrouterUserId',
    userHeader: 'x-agentrouter-user-id',
    authScheme: 'authorization',
    credentials: [
      { field: 'api_key', storeKey: 'agentrouterKey' },
      { field: 'user_id', storeKey: 'agentrouterUserId' },
    ],
    capabilities: { windows: false, models: true, balance: true, pool: true },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    site: 'https://openrouter.ai',
    storeKey: 'openrouterKey',
    credentials: [{ field: 'api_key', storeKey: 'openrouterKey' }],
    apiKeyHeader: true,
    authScheme: 'authorization',
    capabilities: { windows: false, models: true, balance: true, codingRatings: true },
  },
  selora: {
    id: 'selora',
    name: 'Selora',
    site: 'https://selora.lol',
    storeKey: 'seloraKey',
    credentials: [{ field: 'api_key', storeKey: 'seloraKey' }],
    apiKeyHeader: true,
    authScheme: 'x-api-key',
    capabilities: { windows: true, models: true, balance: true },
  },
  experiential: {
    id: 'experiential',
    name: 'Experiential Labs',
    site: 'https://platform.experientiallabs.ai/overview',
    storeKey: 'experientialKey',
    credentials: [{ field: 'api_key', storeKey: 'experientialKey' }],
    apiKeyHeader: true,
    authScheme: 'authorization',
    capabilities: { windows: false, models: true, balance: true },
  },

  // Служебные провайдеры: у них нет публичного API-адаптера, но есть
  // учётные данные в том же хранилище.
  omniroute: {
    id: 'omniroute',
    name: 'OmniRoute',
    site: '',
    adapter: false,
    storeKey: 'omniKey',
    credentials: [
      { field: 'url', storeKey: 'omniUrl' },
      { field: 'key', storeKey: 'omniKey' },
    ],
    capabilities: {},
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    site: 'https://aistudio.google.com',
    adapter: false,
    storeKey: 'agRefreshToken',
    credentials: [
      { field: 'oauth_refresh', storeKey: 'agRefreshToken' },
      { field: 'project_id', storeKey: 'agProject' },
      { field: 'email', storeKey: 'agEmail' },
    ],
    capabilities: { quota: true },
  },
};

/** Провайдеры, участвующие в credentials активного аккаунта. */
const PROVIDER_IDS = Object.keys(DESCRIPTORS);

/** Провайдеры с адаптером (есть фабрика в providers/index.js). */
const ADAPTER_PROVIDER_IDS = PROVIDER_IDS.filter(id => DESCRIPTORS[id].adapter !== false);

/** id → ключ legacy KV (только провайдеры с адаптером — как раньше). */
const PROVIDER_STORE_KEYS = Object.fromEntries(
  ADAPTER_PROVIDER_IDS.filter(id => DESCRIPTORS[id].storeKey).map(id => [
    id,
    DESCRIPTORS[id].storeKey,
  ])
);

/** id → ключ KV с числовым ID пользователя. */
const PROVIDER_STORE_USER_FIELDS = Object.fromEntries(
  PROVIDER_IDS.filter(id => DESCRIPTORS[id].userField).map(id => [id, DESCRIPTORS[id].userField])
);

/** Ключ KV → [id провайдера, поле учётных данных]. */
const CREDENTIAL_FIELDS = {};
for (const id of PROVIDER_IDS) {
  for (const { field, storeKey } of DESCRIPTORS[id].credentials || []) {
    CREDENTIAL_FIELDS[storeKey] = [id, field];
  }
}

/** Ключи KV всех провайдеров (секреты и ID) — часть STORE_KEYS. */
const PROVIDER_CREDENTIAL_STORE_KEYS = [...new Set(Object.values(PROVIDER_STORE_KEYS))].concat(
  Object.values(PROVIDER_STORE_USER_FIELDS)
);

/** Секретные поля не должны попадать в PUT-настройки «пустым» (P1-1). */
function isSecretStoreKey(storeKey) {
  return Object.hasOwn(CREDENTIAL_FIELDS, storeKey);
}

function getDescriptor(id) {
  return DESCRIPTORS[id] || null;
}

module.exports = {
  DESCRIPTORS,
  PROVIDER_IDS,
  ADAPTER_PROVIDER_IDS,
  PROVIDER_STORE_KEYS,
  PROVIDER_STORE_USER_FIELDS,
  PROVIDER_CREDENTIAL_STORE_KEYS,
  CREDENTIAL_FIELDS,
  isSecretStoreKey,
  getDescriptor,
};
