'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../src/store');
const { backup, restore, verify } = require('../../scripts/store-backup');

const KEY = 'a'.repeat(64);

test('store backup → verify → restore сохраняет encrypted store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-backup-'));
  const dbPath = path.join(dir, 'data', 'store.db');
  const restoredPath = path.join(dir, 'restored', 'store.db');
  const backupDir = path.join(dir, 'backup');

  const store = await createStore({ dbPath, masterKey: KEY });
  await store.set('xkiroKey', 'backup-secret');
  await store.close();

  await backup(dbPath, backupDir);
  assert.equal((await verify(backupDir)).format, 1);
  await restore(restoredPath, backupDir);

  const restored = await createStore({ dbPath: restoredPath, masterKey: KEY });
  assert.equal(await restored.get('xkiroKey'), 'backup-secret');
  await restored.close();
});

test('повреждённый backup отклоняется до восстановления', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-backup-'));
  const dbPath = path.join(dir, 'store.db');
  const backupDir = path.join(dir, 'backup');
  const store = await createStore({ dbPath, masterKey: KEY });
  await store.close();
  await backup(dbPath, backupDir);
  fs.appendFileSync(path.join(backupDir, 'store.db'), 'x');
  await assert.rejects(() => verify(backupDir), /integrity check failed/);
});
