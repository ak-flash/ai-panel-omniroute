// ============================================================
// Хранилище панели: ключи и настройки на сервере, а не в localStorage.
//
// База — SQLite (библиотека sql.js, WASM, без нативной сборки), файл
// data/store.db. Каждое значение зашифровано AES-256-GCM и кладётся
// как { key, value } в таблицу kv — на диск секреты не попадают
// в открытом виде.
//
// Мастер-ключ берётся (по приоритету):
//   1. Из переменной окружения AIPANEL_MASTER_KEY (32 байта, hex) —
//      позволяет перенести базу на другой сервер.
//   2. Из файла data/store.db.key (создаётся автоматически при первом
//      запуске с правами 0o600) — если ничего не задано в env.
//
// API — асинхронный и единый для всех полей, поэтому createApp может
// создавать хранилище лениво и использовать в обработчиках:
//   createStore(opts) -> { get(key), set(key, value), snapshot(), ready }
//   set(key, '')        — удаляет ключ (пустое значение = удаление)
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');

let sqlJsInit = null;
function loadSqlJs() {
  if (!sqlJsInit) sqlJsInit = require('sql.js')().then((m) => m);
  return sqlJsInit;
}

// Версия формата шифрования
const V = 'v1';

/** Генерация случайного master-ключа (32 байта) в hex. */
function generateMasterKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Загружает master-ключ: env → файл → генерация + запись файла.
 * Для :memory: хранилища возвращает случайный ключ без записи.
 */
function resolveMasterKey({ keyPath, inMemory }) {
  if (!inMemory && process.env.AIPANEL_MASTER_KEY) {
    return process.env.AIPANEL_MASTER_KEY;
  }
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8').trim();
  }
  const key = generateMasterKey();
  if (keyPath) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
  }
  return key;
}

/**
 * Создаёт готовое хранилище (async — sql.js инициализируется асинхронно).
 * opts:
 *   dbPath   — путь к файлу SQLite (по умолчанию data/store.db)
 *   memory   — true для in-memory базы (тесты): данные не пишутся на диск
 */
async function createStore({ dbPath, keyPath, memory = false } = {}) {
  const sql = await loadSqlJs();
  const fileDb = !memory;

  const resolvedDbPath = fileDb
    ? dbPath || path.join(DATA_DIR, 'store.db')
    : null;
  const resolvedKeyPath =
    fileDb && !process.env.AIPANEL_MASTER_KEY
      ? keyPath || (resolvedDbPath + '.key')
      : null;

  const masterKey = resolveMasterKey({
    keyPath: resolvedKeyPath,
    inMemory: !fileDb,
  });

  let db;
  if (fileDb && fs.existsSync(resolvedDbPath)) {
    db = new sql.Database(fs.readFileSync(resolvedDbPath));
  } else {
    db = new sql.Database();
  }
  db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  // Очередь записи на диск, чтобы не писать параллельно
  let writeChain = Promise.resolve();

  function persist() {
    if (!fileDb) return;
    const bytes = db.export();
    writeChain = writeChain.then(() => {
      fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
      // Атомарная замена: во временный файл, затем rename
      const tmp = resolvedDbPath + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, resolvedDbPath);
    });
    return writeChain;
  }

  function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(masterKey, 'hex'), iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return (
      V + ':' +
      iv.toString('base64') + ':' +
      tag.toString('base64') + ':' +
      enc.toString('base64')
    );
  }

  function decrypt(payload) {
    const parts = String(payload).split(':');
    if (parts.length !== 4 || parts[0] !== V) return null;
    const [, ivB64, tagB64, dataB64] = parts;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(masterKey, 'hex'),
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const dec = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]);
      return dec.toString('utf8');
    } catch {
      return null; // подпись не сошлась / неверный ключ
    }
  }

  async function get(key) {
    const res = db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!res.length || !res[0].values.length) return null;
    return decrypt(res[0].values[0][0]);
  }

  async function set(key, value) {
    const v = value == null ? '' : String(value);
    if (v === '') {
      db.run('DELETE FROM kv WHERE key = ?', [key]);
    } else {
      db.run(
        'INSERT INTO kv (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, encrypt(v)],
      );
    }
    await persist();
  }

  async function snapshot() {
    const res = db.exec('SELECT key, value FROM kv');
    if (!res.length) return {};
    const out = {};
    for (const [k, v] of res[0].values) {
      const dec = decrypt(String(v));
      if (dec !== null) out[k] = dec;
    }
    return out;
  }

  await persist(); // гарантируем, что файл существует после создания таблицы

  return {
    ready: Promise.resolve(),
    get,
    set,
    snapshot,
    _masterKey: masterKey,
  };
}

module.exports = { createStore, DATA_DIR };
