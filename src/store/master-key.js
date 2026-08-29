'use strict';

// ============================================================
// Master-ключ хранилища: откуда берётся и как проверяется.
//
// Приоритет:
//   1. Явно переданный ключ (параметр masterKey — тесты и ротация).
//   2. AIPANEL_MASTER_KEY из окружения — позволяет перенести базу
//      на другой сервер.
//   3. Файл <db>.key (создаётся при первом запуске с правами 0o600).
//   4. Для in-memory базы — случайный ключ, на диск не пишется.
// ============================================================

const fs = require('fs');
const path = require('path');
const { StoreError, generateMasterKey } = require('./crypto');

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

/** Валидирует master-ключ: 32 байта в hex (64 символа). */
function assertValidMasterKey(key) {
  if (!HEX_KEY_RE.test(String(key || ''))) {
    throw new StoreError(
      'bad_master_key',
      'Master key хранилища должен быть 32 байта в hex (64 символа). ' +
      'Проверьте AIPANEL_MASTER_KEY или файл <db>.key',
    );
  }
}

/** Возвращает master-ключ по приоритету выше; формат валидируется. */
function resolveMasterKey({ keyPath, inMemory, masterKey } = {}) {
  if (masterKey) {
    assertValidMasterKey(masterKey);
    return masterKey;
  }
  if (!inMemory && process.env.AIPANEL_MASTER_KEY) {
    const envKey = process.env.AIPANEL_MASTER_KEY;
    assertValidMasterKey(envKey);
    return envKey;
  }
  if (keyPath && fs.existsSync(keyPath)) {
    const fileKey = fs.readFileSync(keyPath, 'utf8').trim();
    assertValidMasterKey(fileKey);
    return fileKey;
  }
  const key = generateMasterKey();
  if (keyPath) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
  }
  return key;
}

module.exports = { resolveMasterKey, assertValidMasterKey };
