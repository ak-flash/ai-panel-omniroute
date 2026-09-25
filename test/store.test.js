'use strict';

// Юнит-тесты encrypted store (src/store/): allowlist ключей, батч,
// проверка master key при открытии (wrong_key / corrupted различаются),
// переоткрытие файловой базы, конкурентные записи, flush/close, ротация.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, StoreError, STORE_KEYS } = require('../src/store');
const { rotateKey } = require('../src/store/rotate-key');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

/** Каталог во временной директории с путём до файловой базы. */
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-store-'));
  return { dir, dbPath: path.join(dir, 'store.db') };
}

/** Правит файл базы напрямую через sql.js (повреждение, легаси-миграция). */
async function editDbFile(dbPath, fn) {
  const SQL = await require('sql.js')();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    fn(db);
    const bytes = Buffer.from(db.export());
    fs.writeFileSync(dbPath, bytes);
  } finally {
    db.close();
  }
}

test('get отсутствующего ключа → null; set/get roundtrip; set(\'\') удаляет', async () => {
  const store = await createStore({ memory: true });
  assert.equal(await store.get('omniUrl'), null);
  await store.set('omniUrl', 'http://upstream');
  assert.equal(await store.get('omniUrl'), 'http://upstream');
  await store.set('omniUrl', '');
  assert.equal(await store.get('omniUrl'), null);
});

test('проверочная запись скрыта от get и snapshot', async () => {
  const store = await createStore({ memory: true });
  assert.equal(await store.get('__verify'), null);
  assert.equal('__verify' in (await store.snapshot()), false);
});

test('произвольный ключ записать нельзя (allowlist)', async () => {
  const store = await createStore({ memory: true });
  await assert.rejects(
    () => store.set('hacker', 'x'),
    (err) => err instanceof StoreError && err.code === 'unknown_key',
  );
  await assert.rejects(
    () => store.setMany([['omniUrl', 'http://x'], ['hacker', 'x']]),
    (err) => err.code === 'unknown_key',
  );
  // Батч атомарен: до валидации ничего не записалось
  assert.equal(await store.get('omniUrl'), null);
});

test('setMany записывает все ключи одной транзакцией', async () => {
  const store = await createStore({ memory: true });
  await store.setMany([['omniUrl', 'http://x'], ['omniKey', 'k']]);
  const s = await store.snapshot();
  assert.equal(s.omniUrl, 'http://x');
  assert.equal(s.omniKey, 'k');
});

test('переоткрытие файловой базы: данные читаются, ключ верифицируется', async () => {
  const { dbPath } = tmpDb();
  const first = await createStore({ dbPath, masterKey: KEY_A });
  await first.set('xkiroKey', 'secret-1');
  await first.set('omniUrl', 'http://upstream');
  await first.close();

  const second = await createStore({ dbPath, masterKey: KEY_A });
  assert.equal(await second.get('xkiroKey'), 'secret-1');
  assert.equal(await second.get('omniUrl'), 'http://upstream');
  await second.close();
});

test('чужой master key → wrong_key при открытии', async () => {
  const { dbPath } = tmpDb();
  const first = await createStore({ dbPath, masterKey: KEY_A });
  await first.set('xkiroKey', 'secret-1');
  await first.close();

  await assert.rejects(
    () => createStore({ dbPath, masterKey: KEY_B }),
    (err) => err instanceof StoreError && err.code === 'wrong_key',
  );
});

test('повреждённая запись данных → corrupted при открытии', async () => {
  const { dbPath } = tmpDb();
  const first = await createStore({ dbPath, masterKey: KEY_A });
  await first.set('xkiroKey', 'secret-1');
  await first.close();

  // Портим строку данных; проверочная запись остаётся валидной
  await editDbFile(dbPath, (db) => {
    db.run("UPDATE kv SET value = 'v1:AAAA:AAAA:AAAA' WHERE key = 'xkiroKey'");
  });

  await assert.rejects(
    () => createStore({ dbPath, masterKey: KEY_A }),
    (err) => err.code === 'corrupted',
  );
});

test('легаси-база без проверочной записи открывается и мигрирует', async () => {
  const { dbPath } = tmpDb();
  const first = await createStore({ dbPath, masterKey: KEY_A });
  await first.set('xkiroKey', 'legacy-secret');
  await first.close();

  await editDbFile(dbPath, (db) => {
    db.run("DELETE FROM kv WHERE key = '__verify'");
  });

  const second = await createStore({ dbPath, masterKey: KEY_A });
  assert.equal(await second.get('xkiroKey'), 'legacy-secret');
  await second.close();

  // После миграции проверочная запись снова на месте: чужой ключ отсекается
  await assert.rejects(
    () => createStore({ dbPath, masterKey: KEY_B }),
    (err) => err.code === 'wrong_key',
  );
});

test('конкурентные записи не теряются (очередь сериализует диск)', async () => {
  const { dbPath } = tmpDb();
  const store = await createStore({ dbPath, masterKey: KEY_A });
  const keys = STORE_KEYS.slice(0, 8);
  await Promise.all(keys.map((key, i) => store.set(key, 'v' + i)));
  await store.close();

  const reopened = await createStore({ dbPath, masterKey: KEY_A });
  const s = await reopened.snapshot();
  keys.forEach((key, i) => assert.equal(s[key], 'v' + i));
  await reopened.close();
});

test('close(): операции после закрытия отклоняются, повторный close безопасен', async () => {
  const store = await createStore({ memory: true });
  await store.set('omniKey', 'k');
  await store.close();
  await store.close();

  for (const fn of [
    () => store.get('omniKey'),
    () => store.set('omniKey', 'x'),
    () => store.setMany([['omniKey', 'x']]),
    () => store.snapshot(),
    () => store.flush(),
  ]) {
    await assert.rejects(fn, (err) => err.code === 'store_closed');
  }
});

test('rotateKey: данные читаются новым ключом, старый больше не подходит', async () => {
  const { dbPath } = tmpDb();
  const first = await createStore({ dbPath, masterKey: KEY_A });
  await first.set('xkiroKey', 'rot-secret');
  await first.set('omniUrl', 'http://x');
  await first.close();

  const { newKey, rows } = await rotateKey({ dbPath, oldKey: KEY_A, newKey: KEY_B });
  assert.equal(newKey, KEY_B);
  // xkiroKey + omniUrl + __verify
  assert.ok(rows >= 3, 'перешифрованы все записи, получено: ' + rows);

  const reopened = await createStore({ dbPath, masterKey: KEY_B });
  assert.equal(await reopened.get('xkiroKey'), 'rot-secret');
  assert.equal(await reopened.get('omniUrl'), 'http://x');
  await reopened.close();

  await assert.rejects(
    () => createStore({ dbPath, masterKey: KEY_A }),
    (err) => err.code === 'wrong_key',
  );
});

test('rotateKey: нечитаемая запись отменяет ротацию без изменений', async () => {
  const { dbPath } = tmpDb();
  const first = await createStore({ dbPath, masterKey: KEY_A });
  await first.set('xkiroKey', 'keep-me');
  await first.close();

  await editDbFile(dbPath, (db) => {
    db.run("UPDATE kv SET value = 'v1:AAAA:AAAA:AAAA' WHERE key = 'xkiroKey'");
  });
  const before = fs.readFileSync(dbPath);

  await assert.rejects(
    () => rotateKey({ dbPath, oldKey: KEY_A, newKey: KEY_B }),
    (err) => err.code === 'wrong_key',
  );

  // Файл не изменился: ни одна запись не перешифрована новым ключом
  assert.ok(
    Buffer.from(before).equals(fs.readFileSync(dbPath)),
    'ротация не должна менять базу при ошибке расшифровки',
  );
});

test('невалидный master key (не 64 hex) отклоняется', async () => {
  await assert.rejects(
    () => createStore({ memory: true, masterKey: 'nothex' }),
    (err) => err.code === 'bad_master_key',
  );
});

/** Ломает запись: на месте файла базы — непустой каталог, rename упадёт. */
function breakWrites(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.mkdirSync(dbPath);
  fs.writeFileSync(path.join(dbPath, 'blocker'), 'x');
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('условие не выполнилось за ' + timeoutMs + ' мс');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('сбой записи не ломает очередь: следующая запись сохраняет все изменения', async () => {
  const { dbPath } = tmpDb();
  const warnings = [];
  const store = await createStore({
    dbPath,
    masterKey: KEY_A,
    persistRetryDelaysMs: [], // без повторов по таймеру — проверяем саму очередь
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  await store.set('omniUrl', 'https://one.example');
  breakWrites(dbPath);

  await assert.rejects(store.set('omniKey', 'k1'));
  await assert.rejects(store.set('aliases', 'a'));
  assert.equal(store.status().persisted, false);
  assert.equal(store.status().failures, 2);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /не удалось записать базу/);
  await assert.rejects(store.flush());

  fs.rmSync(dbPath, { recursive: true });
  await store.set('comboActive', 'main');
  assert.equal(store.status().persisted, true);
  await store.flush();

  const reopened = await createStore({ dbPath, masterKey: KEY_A });
  assert.equal(await reopened.get('omniUrl'), 'https://one.example');
  assert.equal(await reopened.get('omniKey'), 'k1');
  assert.equal(await reopened.get('aliases'), 'a');
  assert.equal(await reopened.get('comboActive'), 'main');
  await reopened.close();
  await store.close();
});

test('после сбоя запись повторяется по таймеру без новых изменений', async () => {
  const { dbPath } = tmpDb();
  const store = await createStore({
    dbPath,
    masterKey: KEY_A,
    persistRetryDelaysMs: [20],
    logger: { warn() {} },
  });
  breakWrites(dbPath);
  await assert.rejects(store.set('omniKey', 'retry-me'));
  fs.rmSync(dbPath, { recursive: true });
  await waitFor(() => store.status().persisted);

  const reopened = await createStore({ dbPath, masterKey: KEY_A });
  assert.equal(await reopened.get('omniKey'), 'retry-me');
  await reopened.close();
  await store.close();
});

test('close() «грязной» базы закрывает её и сообщает об ошибке', async () => {
  const { dbPath } = tmpDb();
  const store = await createStore({ dbPath, masterKey: KEY_A, persistRetryDelaysMs: [], logger: { warn() {} } });
  breakWrites(dbPath);
  await assert.rejects(store.set('omniKey', 'lost'));
  await assert.rejects(store.close());
  assert.equal(store.status().open, false);
  await store.close(); // повторный вызов безопасен
});

test('файлы базы и ключа создаются с правами 0600, временных файлов не остаётся', async () => {
  const { dir, dbPath } = tmpDb();
  const store = await createStore({ dbPath: path.join(dir, 'nested', 'store.db') });
  await store.set('omniUrl', 'https://perm.example');
  await store.close();
  const nested = path.join(dir, 'nested');
  assert.equal(fs.statSync(path.join(nested, 'store.db')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(nested, 'store.db.key')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(nested).sort(), ['store.db', 'store.db.key']);
  assert.ok(dbPath);
});

test('файловая база без dbPath — понятная ошибка конфигурации', async () => {
  await assert.rejects(createStore({}), (err) => err.code === 'bad_config');
});

test('AES-GCM тег всегда 16 байт (authTagLength)', async () => {
  const { dbPath } = tmpDb();
  const store = await createStore({ dbPath, masterKey: KEY_A });
  await store.set('omniUrl', 'https://tag.example');
  await store.close();
  const raw = fs.readFileSync(dbPath, 'utf8');
  const match = raw.match(/v1:[A-Za-z0-9+/=]+:([A-Za-z0-9+/=]+):/);
  assert.ok(match, 'в базе есть зашифрованная запись v1');
  assert.equal(Buffer.from(match[1], 'base64').length, 16);
});
