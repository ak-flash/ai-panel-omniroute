'use strict';

// ============================================================
// Схема «провайдер → ключи хранилища» — тонкая обёртка над
// дескрипторами (src/provider-descriptors.js, P2-1).
//
// Где используются эти таблицы:
//   - /api/providers/<id>/usage и /models — ключ и ID из хранилища;
//   - /api/config — флаги has*Key;
//   - дневной снимок AgentRouter (src/agentrouter-tracker.js).
//
// Список провайдеров и их ключи описаны в одном месте — в
// DESCRIPTORS; здесь они собираются в таблицы для маршрутов.
// ============================================================

const {
  DESCRIPTORS,
  PROVIDER_IDS,
  ADAPTER_PROVIDER_IDS,
  PROVIDER_STORE_KEYS,
  PROVIDER_STORE_USER_FIELDS,
  PROVIDER_CREDENTIAL_STORE_KEYS,
  CREDENTIAL_FIELDS,
  isSecretStoreKey,
  getDescriptor,
} = require('./provider-descriptors');

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
