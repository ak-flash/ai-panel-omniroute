'use strict';

// ============================================================
// Multi-Account Credentials (RFC-0003).
//
// Хранилище: таблица `credentials` в той же SQLite-базе, что и `kv`.
// Каждое значение зашифровано тем же master-ключом, что и поля в `kv`.
//
// Контракт:
//   - account_name — пользовательский псевдоним (например, "work", "personal").
//     Допустимы только [a-z0-9_-], длина 1..32. Регистр сохраняется, но
//     сравнение в lookup делается case-insensitive.
//   - provider_id — фиксированный список (xkiro, agentrouter, omniroute, antigravity).
//   - credential_type — внутренний тег (api_key, oauth_refresh, url_key_pair,
//     user_id) для будущего расширения.
//   - encrypted_value — то же представление v1:<iv>:<tag>:<data>, что и kv.
//
// Методы возвращают только булевы has* / counts наружу — секреты не читаются.
// ============================================================

const { StoreError, encryptValue, decryptValue } = require('./crypto');

const ACCOUNT_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

const PROVIDER_IDS = ['xkiro', 'agentrouter', 'omniroute', 'antigravity'];

// Сколько может быть разных провайдеров на один (account_name, provider_id):
//  - xkiro: api_key
//  - agentrouter: api_key + user_id
//  - omniroute: url_key_pair (один блок с двумя полями) — сейчас как api_key,
//    url — отдельным полем
//  - antigravity: oauth_refresh (основной), project, email — пока один
const ALLOWED_CREDENTIAL_TYPES = new Set([
  'api_key',
  'user_id',
  'oauth_refresh',
  'project_id',
  'email',
  'url',
  'key',
]);

const MAX_ACCOUNTS = 10;

function assertAccountName(name) {
  if (typeof name !== 'string' || !ACCOUNT_NAME_PATTERN.test(name)) {
    throw new StoreError(
      'invalid_account_name',
      'Имя аккаунта должно быть 1–32 символа из [a-z0-9_-]',
    );
  }
}

function assertProviderId(id) {
  if (!PROVIDER_IDS.includes(id)) {
    throw new StoreError(
      'invalid_provider',
      'Неизвестный провайдер: «' + id + '». Допустимо: ' + PROVIDER_IDS.join(', '),
    );
  }
}

function assertCredentialType(t) {
  if (!ALLOWED_CREDENTIAL_TYPES.has(t)) {
    throw new StoreError('invalid_credential_type', 'Неизвестный тип credential: «' + t + '»');
  }
}

/**
 * Проверяет структуру credentials, которую прислал клиент.
 * Возвращает плоский список { provider_id, credential_type, value } для записи.
 * Кодировщик сам разберётся, какие поля валидны для каждого провайдера.
 */
function normalizeCredentials(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StoreError('bad_credentials', 'Ожидается объект credentials');
  }
  const out = [];
  for (const providerId of Object.keys(raw)) {
    assertProviderId(providerId);
    const block = raw[providerId];
    if (block == null) continue;
    if (typeof block === 'string') {
      // Сокращённая форма: { xkiro: "sk-..." }
      if (block === '') continue;
      out.push({ providerId, credentialType: 'api_key', value: block });
      continue;
    }
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new StoreError('bad_credentials', 'Поле «' + providerId + '» должно быть строкой или объектом');
    }
    for (const field of Object.keys(block)) {
      const value = block[field];
      if (value == null || value === '') continue;
      // Маппинг полей провайдеров на credential_type
      let credType;
      if (providerId === 'agentrouter' && field === 'userId') credType = 'user_id';
      else if (providerId === 'agentrouter' && field === 'key') credType = 'api_key';
      else if (providerId === 'antigravity' && field === 'refreshToken') credType = 'oauth_refresh';
      else if (providerId === 'antigravity' && field === 'project') credType = 'project_id';
      else if (providerId === 'antigravity' && field === 'email') credType = 'email';
      else if (providerId === 'omniroute' && field === 'url') credType = 'url';
      else if (providerId === 'omniroute' && field === 'key') credType = 'key';
      else credType = field; // api_key, secret, ...
      assertCredentialType(credType);
      out.push({ providerId, credentialType: credType, value: String(value) });
    }
  }
  return out;
}

function selectRowsForAccount(rows, accountName) {
  const out = {};
  for (const [name, providerId, credentialType, encryptedValue, , updatedAt] of rows) {
    if (name !== accountName) continue;
    if (!out[providerId]) out[providerId] = { hasAny: false, fields: {}, updatedAt };
    out[providerId].hasAny = true;
    out[providerId].fields[credentialType] = encryptedValue; // шифрованное; наружу не отдаём
    if (Number(updatedAt) > Number(out[providerId].updatedAt)) {
      out[providerId].updatedAt = updatedAt;
    }
  }
  return out;
}

function accountToPublicView(name, byProvider, createdAt, updatedAt) {
  const view = {
    name,
    createdAt: Number(createdAt),
    updatedAt: Number(updatedAt),
    hasXkiro: Boolean(byProvider.xkiro),
    hasAgentrouter: Boolean(byProvider.agentrouter),
    hasOmniroute: Boolean(byProvider.omniroute),
    hasAntigravity: Boolean(byProvider.antigravity),
  };
  return view;
}

function readRows(db, sql, params) {
  const res = db.exec(sql, params);
  return res.length ? res[0].values : [];
}

function decryptField(masterKey, encrypted) {
  const res = decryptValue(masterKey, encrypted);
  if (!res.ok) {
    throw new StoreError('corrupted', 'Credential повреждён: ' + res.reason);
  }
  return res.value;
}

/**
 * Создаёт набор методов для работы с accounts поверх уже открытого store.
 * Принимает { db, queue, masterKey, hasKvLegacyFields, deleteLegacyFields }.
 *
 * hasKvLegacyFields / deleteLegacyFields — колбэки для миграции со
 * старых плоских ключей (xkiroKey, agentrouterKey, ...). Передаются
 * из store/index.js, чтобы не зависеть от STORE_KEYS напрямую.
 */
function createAccountStore({
  db,
  queue,
  masterKey,
  ensureSchema,
  hasLegacyCredential,
  migrateFromLegacy,
  getActiveAccountName,
  setActiveAccountName,
}) {
  function exec(sql, params) {
    db.run(sql, params || []);
  }
  function select(sql, params) {
    return readRows(db, sql, params);
  }

  function ensureAccountsSchema() {
    if (typeof ensureSchema === 'function') return ensureSchema();
    exec(
      'CREATE TABLE IF NOT EXISTS credentials (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'account_name TEXT NOT NULL, ' +
        'provider_id TEXT NOT NULL, ' +
        'credential_type TEXT NOT NULL, ' +
        'encrypted_value TEXT NOT NULL, ' +
        'created_at INTEGER NOT NULL, ' +
        'updated_at INTEGER NOT NULL, ' +
        'UNIQUE(account_name, provider_id, credential_type)' +
        ')',
    );
    exec('CREATE INDEX IF NOT EXISTS idx_credentials_account ON credentials(account_name)');
  }

  function getAccountRow(name) {
    assertAccountName(name);
    const rows = select(
      'SELECT created_at, updated_at FROM credentials WHERE account_name = ? ' +
        'ORDER BY updated_at DESC LIMIT 1',
      [name],
    );
    return rows[0] || null;
  }

  function getCredentialsForAccount(name) {
    assertAccountName(name);
    const rows = select(
      'SELECT account_name, provider_id, credential_type, encrypted_value, created_at, updated_at ' +
        'FROM credentials WHERE account_name = ?',
      [name],
    );
    return selectRowsForAccount(rows, name);
  }

  async function listAccounts() {
    ensureAccountsSchema();
    // Получаем уникальные имена с временем последнего обновления
    const nameRows = select(
      'SELECT account_name, MIN(created_at) as created_at, MAX(updated_at) as updated_at ' +
        'FROM credentials GROUP BY account_name ORDER BY MIN(created_at) ASC',
    );
    const result = [];
    for (const [name, createdAt, updatedAt] of nameRows) {
      const byProvider = getCredentialsForAccount(name);
      result.push(accountToPublicView(name, byProvider, createdAt, updatedAt));
    }
    const active = (await getActiveAccountName()) || 'default';
    return { accounts: result, active };
  }

  async function createAccount(name, rawCredentials) {
    ensureAccountsSchema();
    assertAccountName(name);
    const normalized = normalizeCredentials(rawCredentials);
    if (!normalized.length) {
      throw new StoreError('empty_credentials', 'Переданы пустые credentials');
    }
    const existing = getAccountRow(name);
    if (existing) {
      throw new StoreError('account_exists', 'Аккаунт «' + name + '» уже существует');
    }
    const countRows = select('SELECT COUNT(DISTINCT account_name) FROM credentials');
    const current = Number(countRows[0] ? countRows[0][0] : 0);
    if (current >= MAX_ACCOUNTS) {
      throw new StoreError(
        'too_many_accounts',
        'Превышен лимит аккаунтов (' + MAX_ACCOUNTS + '). Удалите неиспользуемые.',
      );
    }
    const now = Date.now();
    for (const { providerId, credentialType, value } of normalized) {
      exec(
        'INSERT INTO credentials (account_name, provider_id, credential_type, encrypted_value, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        [name, providerId, credentialType, encryptValue(masterKey, value), now, now],
      );
    }
    await queue.persist();
    return { name, created: normalized.length };
  }

  async function updateAccount(name, rawCredentials) {
    ensureAccountsSchema();
    assertAccountName(name);
    const normalized = normalizeCredentials(rawCredentials);
    if (!normalized.length) {
      throw new StoreError('empty_credentials', 'Нечего обновлять');
    }
    const existing = getAccountRow(name);
    if (!existing) {
      throw new StoreError('account_not_found', 'Аккаунт «' + name + '» не найден');
    }
    const now = Date.now();
    for (const { providerId, credentialType, value } of normalized) {
      exec(
        'INSERT INTO credentials (account_name, provider_id, credential_type, encrypted_value, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(account_name, provider_id, credential_type) DO UPDATE SET ' +
          'encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at',
        [name, providerId, credentialType, encryptValue(masterKey, value), now, now],
      );
    }
    await queue.persist();
    return { name, updated: normalized.length };
  }

  async function deleteAccount(name) {
    ensureAccountsSchema();
    assertAccountName(name);
    const existing = getAccountRow(name);
    if (!existing) {
      throw new StoreError('account_not_found', 'Аккаунт «' + name + '» не найден');
    }
    exec('DELETE FROM credentials WHERE account_name = ?', [name]);
    // Если удалили активный — сбрасываем на 'default'
    const active = (await getActiveAccountName()) || 'default';
    if (active === name) {
      await setActiveAccountName('default');
    }
    await queue.persist();
    return { name, deleted: true };
  }

  /**
   * Возвращает decrypted credentials для конкретного (accountName, providerId).
   * Используется сервером при проксировании запросов. Секреты не покидают
   * процесс — наружу не отдаются.
   */
  function resolveCredential(accountName, providerId) {
    assertAccountName(accountName);
    assertProviderId(providerId);
    const rows = select(
      'SELECT credential_type, encrypted_value FROM credentials ' +
        'WHERE account_name = ? AND provider_id = ?',
      [accountName, providerId],
    );
    if (!rows.length) return null;
    const fields = {};
    for (const [credType, enc] of rows) {
      fields[credType] = decryptField(masterKey, enc);
    }
    return fields;
  }

  /**
   * Возвращает credentials для активного аккаунта и заданного провайдера.
   * Если активного аккаунта нет, но есть credentials у 'default' — отдаёт их.
   * Иначе возвращает null.
   */
  async function getActiveCredential(providerId) {
    const activeName = (await getActiveAccountName()) || 'default';
    return resolveCredential(activeName, providerId);
  }

  /**
   * Миграция со старых плоских ключей (xkiroKey и т.д.) в аккаунт 'default'.
   * Вызывается один раз из store/index.js при открытии базы.
   * Возвращает true, если миграция выполнена.
   */
  async function migrateFromLegacyIfNeeded() {
    ensureAccountsSchema();
    const existingNames = select('SELECT DISTINCT account_name FROM credentials');
    if (existingNames.length > 0) return false; // уже мигрировано

    if (typeof hasLegacyCredential !== 'function' || !hasLegacyCredential()) {
      return false; // нечего мигрировать
    }
    if (typeof migrateFromLegacy !== 'function') return false;
    const legacy = migrateFromLegacy(); // { xkiro: 'sk-...', agentrouterKey: '...', ... }
    const normalized = {
      xkiro: legacy.xkiroKey || legacy.xkiro,
      agentrouter: legacy.agentrouterKey
        ? { key: legacy.agentrouterKey, userId: legacy.agentrouterUserId }
        : null,
      omniroute: legacy.omniUrl ? { url: legacy.omniUrl, key: legacy.omniKey } : null,
      antigravity: legacy.agRefreshToken
        ? { refreshToken: legacy.agRefreshToken, project: legacy.agProject, email: legacy.agEmail }
        : null,
    };
    const cleaned = Object.fromEntries(Object.entries(normalized).filter(([, v]) => v));
    if (!Object.keys(cleaned).length) return false;
    await createAccount('default', cleaned);
    return true;
  }

  return {
    ensureAccountsSchema,
    listAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    resolveCredential,
    getActiveCredential,
    migrateFromLegacyIfNeeded,
  };
}

module.exports = {
  createAccountStore,
  PROVIDER_IDS,
  MAX_ACCOUNTS,
  assertAccountName,
  assertProviderId,
};
