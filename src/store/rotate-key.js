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
// Если старый ключ был из окружения, новый печатается в stdout —
// файл <db>.key намеренно не пишется, чтобы не конфликтовать с env.
// ============================================================

const fs = require('fs');
const path = require('path');
const { StoreError, encryptValue, decryptValue, generateMasterKey } = require('./crypto');
const { assertValidMasterKey } = require('./master-key');
const { openDatabase, createPersistQueue } = require('./persistence');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * Перешифровывает все записи базы под новым ключом.
 * oldKey обязателен (64 hex); newKey опционален — генерируется.
 * Ключевые файлы не трогает — только содержимое базы.
 * Возвращает { newKey, rows }.
 */
async function rotateKey({ dbPath, oldKey, newKey } = {}) {
  assertValidMasterKey(oldKey);
  if (newKey === undefined) newKey = generateMasterKey();
  assertValidMasterKey(newKey);
  if (newKey === oldKey) {
    throw new StoreError('bad_master_key', 'Новый master key совпадает со старым');
  }

  const { db } = await openDatabase({ dbPath, inMemory: false });
  const queue = createPersistQueue({ db, dbPath, inMemory: false });
  try {
    const res = db.exec('SELECT key, value FROM kv');
    const rows = res.length ? res[0].values : [];
    const reencrypted = [];
    for (const [key, payload] of rows) {
      const dec = decryptValue(oldKey, payload);
      if (!dec.ok) {
        throw new StoreError('wrong_key', 'Запись «' + key + '» не расшифровывается старым ключом — ротация отменена, база не изменена');
      }
      reencrypted.push([key, encryptValue(newKey, dec.value)]);
    }
    for (const [key, payload] of reencrypted) {
      db.run('UPDATE kv SET value = ? WHERE key = ?', [payload, key]);
    }
    await queue.persist();
    return { newKey, rows: reencrypted.length };
  } finally {
    await queue.close();
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--new') args.newKey = argv[++i];
    else if (argv[i] === '--db') args.dbPath = argv[++i];
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dbPath = args.dbPath || path.join(DATA_DIR, 'store.db');
  const keyPath = dbPath + '.key';

  let oldKey = process.env.AIPANEL_MASTER_KEY || '';
  const fromEnv = Boolean(oldKey);
  if (!oldKey && fs.existsSync(keyPath)) {
    oldKey = fs.readFileSync(keyPath, 'utf8').trim();
  }
  if (!oldKey) {
    console.error('Не найден старый master key: задайте AIPANEL_MASTER_KEY или файл ' + keyPath);
    process.exit(1);
  }

  const result = await rotateKey({ dbPath, oldKey, newKey: args.newKey });
  if (fromEnv) {
    console.log('База перешифрована (' + result.rows + ' записей). Новый master key — добавьте в AIPANEL_MASTER_KEY:');
    console.log(result.newKey);
  } else {
    fs.writeFileSync(keyPath, result.newKey + '\n', { mode: 0o600 });
    console.log('База перешифрована (' + result.rows + ' записей), новый ключ записан в ' + keyPath);
  }
}

module.exports = { rotateKey };
if (require.main === module) main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
