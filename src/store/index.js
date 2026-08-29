'use strict';

// ============================================================
// Encrypted store панели — фасад над компонентами:
//   crypto.js       — AES-256-GCM шифрование значений (формат v1);
//   master-key.js   — источник master-ключа (env → файл → генерация);
//   persistence.js  — sql.js и атомарная запись на диск.
//
// Гарантии (этап 4 плана рефакторинга):
//   - master-ключ проверяется при открытии: проверочная запись
//     __verify содержит известную строку под текущим ключом; для
//     legacy-баз без неё ключ подтверждается самими данными.
//     Неверный ключ (wrong_key) и повреждение (corrupted) не
//     маскируются под «нет данных»;
//   - запись ограничена allowlist (STORE_KEYS) — произвольное имя
//     ключа через публичный API записать нельзя;
//   - setMany() — батч-транзакция: либо все ключи, либо ни один;
//   - flush() дожидается записи на диск, close() освобождает базу.
// ============================================================

const path = require('path');
const { StoreError, encryptValue, decryptValue } = require('./crypto');
const { resolveMasterKey } = require('./master-key');
const { openDatabase, createPersistQueue } = require('./persistence');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Внутренняя проверочная запись: известная строка, зашифрованная
// master-ключом. Не расшифровывается → ключ неверный.
const VERIFY_KEY = '__verify';
const VERIFY_MAGIC = 'ai-panel-store-ok';

// Allowlist ключей панели (схема хранилища). Писать можно только их;
// чтение (snapshot) остаётся терпимым к унаследованным записям.
const STORE_KEYS = [
  'xkiroKey', 'agentrouterKey', 'agentrouterUserId',
  'omniUrl', 'omniKey',
  'agRefreshToken', 'agProject', 'agEmail',
  'aliases', 'comboActive', 'dlgProvider', 'modelsProvider', 'statsProvider',
  'agentrouterDayBalance',
];

const UPSERT_SQL =
  'INSERT INTO kv (key, value) VALUES (?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value';

function readRows(db, sql, params) {
  const res = db.exec(sql, params);
  return res.length ? res[0].values : [];
}

/**
 * Создаёт готовое хранилище (async — sql.js инициализируется асинхронно).
 * opts:
 *   dbPath    — путь к файлу SQLite (по умолчанию data/store.db)
 *   keyPath   — путь к файлу master-ключа (по умолчанию <dbPath>.key)
 *   memory    — true для in-memory базы (тесты): диск не используется
 *   masterKey — явный master-ключ (тесты/ротация); иначе env/файл/генерация
 */
async function createStore({ dbPath, keyPath, memory = false, masterKey: explicitKey } = {}) {
  const inMemory = Boolean(memory);
  const fileDb = !inMemory;

  const resolvedDbPath = fileDb ? dbPath || path.join(DATA_DIR, 'store.db') : null;
  const resolvedKeyPath =
    fileDb && !explicitKey && !process.env.AIPANEL_MASTER_KEY
      ? keyPath || (resolvedDbPath + '.key')
      : null;

  const masterKey = resolveMasterKey({
    keyPath: resolvedKeyPath,
    inMemory,
    masterKey: explicitKey,
  });

  const { db } = await openDatabase({ dbPath: resolvedDbPath, inMemory });
  db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const queue = createPersistQueue({ db, dbPath: resolvedDbPath, inMemory });

  // ---------- Проверка целостности и master-ключа при открытии ----------
  // Неверный ключ не расшифровывает ни одну запись разом; повреждение
  // бьёт по части записей — по этому и различаем wrong_key / corrupted.
  const rows = readRows(db, 'SELECT key, value FROM kv');
  const failures = [];
  for (const [key, payload] of rows) {
    const res = decryptValue(masterKey, payload);
    if (!res.ok) failures.push({ key, reason: res.reason });
  }

  if (rows.length === 0) {
    // Свежая база — создаём проверочную запись
    db.run('INSERT INTO kv (key, value) VALUES (?, ?)', [
      VERIFY_KEY,
      encryptValue(masterKey, VERIFY_MAGIC),
    ]);
    await queue.persist();
  } else {
    const verifyFailure = failures.find((f) => f.key === VERIFY_KEY);
    if (verifyFailure) {
      if (verifyFailure.reason === 'format') {
        throw new StoreError('corrupted', 'Проверочная запись хранилища повреждена — восстановите базу из бэкапа (см. docs/STORE.md)');
      }
      if (failures.length === rows.length) {
        throw new StoreError('wrong_key', 'Master key не подходит к базе: ни одна запись не расшифровывается. Проверьте AIPANEL_MASTER_KEY / файл <db>.key (см. docs/STORE.md)');
      }
      throw new StoreError('corrupted', 'Проверочная запись не расшифровывается, хотя данные читаются — база повреждена, восстановите из бэкапа (см. docs/STORE.md)');
    }

    if (failures.length > 0) {
      const names = failures.map((f) => '«' + f.key + '»').join(', ');
      throw new StoreError('corrupted', failures.length + ' записей базы повреждены (' + names + ') — восстановите из бэкапа (см. docs/STORE.md)');
    }

    const verifyRow = rows.find(([key]) => key === VERIFY_KEY);
    if (!verifyRow) {
      // Legacy-база до введения проверочной записи: ключ подтверждён
      // тем, что все данные расшифровались — добавляем запись (миграция)
      db.run('INSERT INTO kv (key, value) VALUES (?, ?)', [
        VERIFY_KEY,
        encryptValue(masterKey, VERIFY_MAGIC),
      ]);
      await queue.persist();
    } else {
      const magic = decryptValue(masterKey, verifyRow[1]);
      if (magic.value !== VERIFY_MAGIC) {
        throw new StoreError('corrupted', 'Проверочная запись не совпадает с ожидаемой — база повреждена (см. docs/STORE.md)');
      }
    }
  }

  // ---------- API ----------
  let closed = false;
  function assertOpen() {
    if (closed) throw new StoreError('store_closed', 'Хранилище закрыто — операция невозможна');
  }

  function assertKnownKey(key) {
    if (!STORE_KEYS.includes(key)) {
      throw new StoreError('unknown_key', 'Неизвестный ключ хранилища: «' + key + '». Разрешены только ключи панели (STORE_KEYS)');
    }
  }

  function applyRow(key, value) {
    if (value === '') {
      db.run('DELETE FROM kv WHERE key = ?', [key]);
    } else {
      db.run(UPSERT_SQL, [key, encryptValue(masterKey, value)]);
    }
  }

  async function get(key) {
    assertOpen();
    if (key === VERIFY_KEY) return null; // внутренняя запись наружу не отдаётся
    const found = readRows(db, 'SELECT value FROM kv WHERE key = ?', [key]);
    if (!found.length) return null;
    const res = decryptValue(masterKey, found[0][0]);
    if (!res.ok) throw new StoreError('corrupted', 'Запись «' + key + '» повреждена (см. docs/STORE.md)');
    return res.value;
  }

  async function set(key, value) {
    assertOpen();
    assertKnownKey(key);
    applyRow(key, value == null ? '' : String(value));
    await queue.persist();
  }

  /** Батч-запись: все ключи валидируются до применения, пишутся разом
   * одним экспортом — частичного набора настроек не бывает. */
  async function setMany(entries) {
    assertOpen();
    const list = [];
    for (const [key, value] of entries) {
      assertKnownKey(key);
      list.push([key, value == null ? '' : String(value)]);
    }
    if (!list.length) return;
    for (const [key, value] of list) applyRow(key, value);
    await queue.persist();
  }

  async function snapshot() {
    assertOpen();
    const out = {};
    for (const [key, payload] of readRows(db, 'SELECT key, value FROM kv')) {
      if (key === VERIFY_KEY) continue;
      const res = decryptValue(masterKey, payload);
      if (!res.ok) throw new StoreError('corrupted', 'Запись «' + key + '» повреждена (см. docs/STORE.md)');
      out[key] = res.value;
    }
    return out;
  }

  /** Дожидается, что все изменения попали на диск. */
  async function flush() {
    assertOpen();
    await queue.flush();
  }

  /** Сбрасывает изменения и закрывает базу. Идемпотентен. */
  async function close() {
    if (closed) return;
    await queue.close();
    closed = true;
  }

  return {
    ready: Promise.resolve(),
    get,
    set,
    setMany,
    snapshot,
    flush,
    close,
    _masterKey: masterKey,
  };
}

module.exports = { createStore, DATA_DIR, STORE_KEYS, StoreError };
