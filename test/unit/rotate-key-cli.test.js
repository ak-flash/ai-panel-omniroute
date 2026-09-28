'use strict';

// CLI ротации master-ключа (src/store/rotate-key.js): разбор аргументов,
// источник старого ключа, запись нового ключа в файл или в stdout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../../src/store');
const { main, parseArgs } = require('../../src/store/rotate-key');
const { makeTmpDir } = require('../helpers');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

/** База с одной записью и файлом ключа на диске. */
async function seededDb(dir, { withKeyFile = true, masterKey = null } = {}) {
  const dataDir = path.join(dir, 'data');
  const dbPath = path.join(dataDir, 'store.db');
  const store = await createStore({ dbPath, masterKey: masterKey || KEY_A });
  await store.set('xkiroKey', 'rotate-me');
  await store.close();
  if (withKeyFile) fs.writeFileSync(dbPath + '.key', KEY_A + '\n', { mode: 0o600 });
  return { dataDir, dbPath };
}

test('parseArgs читает --new и --db, игнорирует прочее', () => {
  assert.deepEqual(parseArgs(['--new', KEY_B, '--db', '/tmp/x.db']), {
    newKey: KEY_B,
    dbPath: '/tmp/x.db',
  });
  assert.deepEqual(parseArgs(['--new']), { newKey: undefined });
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--verbose', '--new', KEY_B]), { newKey: KEY_B });
});

test('CLI: старый ключ из файла, новый записывается в store.db.key', async () => {
  const dir = makeTmpDir('rotate-cli-');
  const { dataDir, dbPath } = await seededDb(dir);
  const printed = [];
  const result = await main(['--new', KEY_B], {
    env: { AIPANEL_ENV_FILE: 'none', AIPANEL_DATA_DIR: dataDir },
    print: line => printed.push(String(line)),
  });

  assert.equal(result.newKey, KEY_B);
  assert.equal(fs.readFileSync(dbPath + '.key', 'utf8').trim(), KEY_B);
  assert.ok(!fs.existsSync(dbPath + '.key.new'), 'временный файл ключа удалён');
  assert.ok(printed.some(line => /База перешифрована/.test(line)));
  assert.ok(printed.some(line => line.includes(dbPath + '.key')));

  const reopened = await createStore({ dbPath, masterKey: KEY_B });
  assert.equal(await reopened.get('xkiroKey'), 'rotate-me');
  await reopened.close();
});

test('CLI: при ключе из окружения новый печатается в stdout, файл не трогается', async () => {
  const dir = makeTmpDir('rotate-cli-env-');
  const { dataDir, dbPath } = await seededDb(dir, { withKeyFile: false });
  const printed = [];
  const result = await main(['--new', KEY_B], {
    env: { AIPANEL_ENV_FILE: 'none', AIPANEL_DATA_DIR: dataDir, AIPANEL_MASTER_KEY: KEY_A },
    print: line => printed.push(String(line)),
  });

  assert.equal(result.newKey, KEY_B);
  assert.equal(fs.existsSync(dbPath + '.key'), false, 'файл ключа не создаётся при ключе из env');
  assert.ok(
    printed.some(line => /добавьте в AIPANEL_MASTER_KEY/.test(line)),
    'подсказка про AIPANEL_MASTER_KEY'
  );
  assert.ok(printed.includes(KEY_B), 'новый ключ напечатан в вывод');
});

test('CLI: без старого ключа — понятная ошибка, база не тронута', async () => {
  const dir = makeTmpDir('rotate-cli-nokey-');
  const { dataDir, dbPath } = await seededDb(dir, { withKeyFile: false });
  const printed = [];
  await assert.rejects(
    () =>
      main(['--new', KEY_B], {
        env: { AIPANEL_ENV_FILE: 'none', AIPANEL_DATA_DIR: dataDir },
        print: line => printed.push(String(line)),
      }),
    err => err.name === 'RotateKeyCliError' && /Не найден старый master key/.test(err.message)
  );
  assert.ok(printed.some(line => /Не найден старый master key/.test(line)));

  const reopened = await createStore({ dbPath, masterKey: KEY_A });
  assert.equal(await reopened.get('xkiroKey'), 'rotate-me', 'данные целы');
  await reopened.close();
});

test('CLI: --db перекрывает путь из конфигурации, новый ключ генерируется', async () => {
  const dir = makeTmpDir('rotate-cli-db-');
  const other = makeTmpDir('rotate-cli-empty-');
  const { dbPath } = await seededDb(dir);
  const result = await main(['--db', dbPath], {
    env: {
      AIPANEL_ENV_FILE: 'none',
      AIPANEL_DATA_DIR: path.join(other, 'data'),
      AIPANEL_LOG_DIR: path.join(other, 'logs'),
    },
    print: () => {},
  });
  assert.match(result.newKey, /^[a-f0-9]{64}$/);
  assert.notEqual(result.newKey, KEY_A);
  assert.equal(fs.readFileSync(dbPath + '.key', 'utf8').trim(), result.newKey);

  const reopened = await createStore({ dbPath, masterKey: result.newKey });
  assert.equal(await reopened.get('xkiroKey'), 'rotate-me');
  await reopened.close();
});

test('CLI: совпадающий ключ отклоняется, база остаётся на старом', async () => {
  const dir = makeTmpDir('rotate-cli-same-');
  const { dataDir, dbPath } = await seededDb(dir);
  assert.ok(dbPath);
  await assert.rejects(
    () =>
      main(['--new', KEY_A], {
        env: { AIPANEL_ENV_FILE: 'none', AIPANEL_DATA_DIR: dataDir },
        print: () => {},
      }),
    err => err.code === 'bad_master_key'
  );
  const reopened = await createStore({ dbPath, masterKey: KEY_A });
  assert.equal(await reopened.get('xkiroKey'), 'rotate-me');
  await reopened.close();
});

test('CLI: битая конфигурация окружения останавливает ротацию', async () => {
  const dir = makeTmpDir('rotate-cli-badenv-');
  assert.ok(dir, 'временный каталог создан');
  await assert.rejects(
    () =>
      main([], {
        env: { AIPANEL_ENV_FILE: 'none', AIPANEL_MASTER_KEY: 'не-hex' },
        print: () => {},
      }),
    err => err.name === 'ConfigError'
  );
});
