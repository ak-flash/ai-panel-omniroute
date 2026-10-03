'use strict';

// ============================================================
// Ротация master-ключа хранилища.
//
// Читает все записи под старым ключом, перешифровывает под новым и
// атомарно перезаписывает базу. Если хотя бы одна запись не
// расшифровывается старым ключом — выходит без изменений.
//
// CLI (из корня проекта):
//   node src/store/rotate-key.js --new <64 hex>        # ключ из <db>.key
//   AIPANEL_MASTER_KEY=<старый> node src/store/rotate-key.js --new <hex>
//   node src/store/rotate-key.js                       # новый сгенерируется
//
// Путь к базе и AIPANEL_MASTER_KEY берутся так же, как у сервера:
// окружение → env-файл (src/config.js); --db перекрывает путь.
// Если старый ключ был из окружения, новый печатается в stdout —
// файл <db>.key намеренно не пишется, чтобы не конфликтовать с env.
// ============================================================

const fs = require('fs');
const { StoreError, encryptValue, decryptValue, generateMasterKey } = require('./crypto');
const { assertValidMasterKey } = require('./master-key');
const { openDatabase, createPersistQueue } = require('./persistence');
const { loadConfig, loadEnvFile, resolveEnvFile } = require('../config');

/**
 * Перешифровывает все записи базы под новым ключом.
 * oldKey обязателен (64 hex); newKey опционален — генерируется.
 * Ключевые файлы не трогает — только содержимое базы.
 * Возвращает { newKey, rows }.
 *
 * @param {{dbPath?: string, oldKey?: string, newKey?: string}} [opts]
 * @returns {Promise<{newKey: string, rows: number}>}
 */
async function rotateKey({ dbPath, oldKey, newKey } = {}) {
  assertValidMasterKey(oldKey);
  if (!dbPath) throw new StoreError('bad_config', 'Не задан путь к базе для ротации');
  const lockPath = dbPath + '.rotate.lock';
  let lockHandle;
  try {
    lockHandle = await fs.promises.open(lockPath, 'wx');
    await lockHandle.writeFile(String(process.pid) + '\\n');
  } catch (err) {
    if (/** @type {Error & {code?: string}} */ (err).code === 'EEXIST') {
      throw new StoreError('rotation_locked', 'Ротация уже выполняется: ' + lockPath);
    }
    throw err;
  }

  try {
    return await rotateKeyLocked({
      dbPath: /** @type {string} */ (dbPath),
      oldKey: /** @type {string} */ (oldKey),
      newKey,
    });
  } finally {
    await lockHandle.close().catch(() => {});
    await fs.promises.unlink(lockPath).catch(() => {});
  }
}

/**
 * @param {{dbPath: string, oldKey: string, newKey?: string}} options
 */
async function rotateKeyLocked({ dbPath, oldKey, newKey }) {
  assertValidMasterKey(oldKey);
  if (newKey === undefined) newKey = generateMasterKey();
  assertValidMasterKey(newKey);
  if (newKey === oldKey) {
    throw new StoreError('bad_master_key', 'Новый master key совпадает со старым');
  }

  const { db } = await openDatabase({ dbPath, inMemory: false });
  const queue = createPersistQueue({ db, dbPath, inMemory: false });
  try {
    const kvResult = db.exec('SELECT key, value FROM kv');
    const kvRows = kvResult.length ? kvResult[0].values : [];
    const hasCredentialsTable =
      db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credentials'")
        .length > 0;
    const credentialResult = hasCredentialsTable
      ? db.exec(
          'SELECT id, account_name, provider_id, credential_type, encrypted_value FROM credentials'
        )
      : [];
    const credentialRows = credentialResult.length ? credentialResult[0].values : [];
    const reencryptedKv = [];
    const reencryptedCredentials = [];

    // Расшифровать всё до первой записи: ошибка оставляет базу неизменённой.
    for (const [key, payload] of kvRows) {
      const dec = decryptValue(oldKey, payload);
      if (!dec.ok) {
        throw new StoreError(
          'wrong_key',
          'Запись «' +
            key +
            '» не расшифровывается старым ключом — ротация отменена, база не изменена'
        );
      }
      reencryptedKv.push([key, encryptValue(newKey, dec.value)]);
    }
    for (const [id, account, provider, type, payload] of credentialRows) {
      const dec = decryptValue(oldKey, payload);
      if (!dec.ok) {
        throw new StoreError(
          'wrong_key',
          'Credential «' +
            account +
            '/' +
            provider +
            '/' +
            type +
            '» не расшифровывается старым ключом — ротация отменена, база не изменена'
        );
      }
      reencryptedCredentials.push([id, encryptValue(newKey, dec.value)]);
    }
    for (const [key, payload] of reencryptedKv) {
      db.run('UPDATE kv SET value = ? WHERE key = ?', [payload, key]);
    }
    for (const [id, payload] of reencryptedCredentials) {
      db.run('UPDATE credentials SET encrypted_value = ? WHERE id = ?', [payload, id]);
    }
    await queue.persist();
    return { newKey, rows: reencryptedKv.length + reencryptedCredentials.length };
  } finally {
    await queue.close();
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--new') args.newKey = argv[++i];
    else if (argv[i] === '--db') args.dbPath = argv[++i];
  }
  return args;
}

/** Ошибка уровня CLI: печатается как есть и даёт код выхода 1. */
class RotateKeyCliError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RotateKeyCliError';
  }
}

/**
 * @param {string[]} [argv]
 * @param {{env?: NodeJS.ProcessEnv, print?: (msg: string) => void}} [options]
 */
async function main(
  argv = process.argv.slice(2),
  { env = process.env, print = msg => console.log(msg) } = {}
) {
  const args = parseArgs(argv);
  loadEnvFile(/** @type {string} */ (resolveEnvFile(env)), env);
  const config = loadConfig(env);
  const dbPath = /** @type {string} */ (args.dbPath || config.dbPath);
  const keyPath = dbPath + '.key';

  /** @type {string|undefined} */
  let oldKey = /** @type {string|undefined} */ (config.masterKey);
  const fromEnv = Boolean(oldKey);
  if (!oldKey && fs.existsSync(keyPath)) {
    oldKey = fs.readFileSync(keyPath, 'utf8').trim();
  }
  if (!oldKey) {
    const message = 'Не найден старый master key: задайте AIPANEL_MASTER_KEY или файл ' + keyPath;
    print(message);
    throw new RotateKeyCliError(message);
  }

  const result = await rotateKey({ dbPath, oldKey, newKey: args.newKey });
  if (fromEnv) {
    print(
      'База перешифрована (' +
        result.rows +
        ' записей). Новый master key — добавьте в AIPANEL_MASTER_KEY:'
    );
    print(result.newKey);
  } else {
    const temporaryKeyPath = keyPath + '.new';
    const handle = await fs.promises.open(temporaryKeyPath, 'w', 0o600);
    try {
      await handle.writeFile(result.newKey + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporaryKeyPath, keyPath);
    print('База перешифрована (' + result.rows + ' записей), новый ключ записан в ' + keyPath);
  }
  return result;
}

module.exports = { rotateKey, main, parseArgs, RotateKeyCliError };
if (require.main === module)
  main().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
