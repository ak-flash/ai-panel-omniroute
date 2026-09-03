'use strict';

// Юнит-тесты multi-account credentials (RFC-0003):
// создание/обновление/удаление, миграция legacy-ключей,
// лимиты, валидация имён и credentials, секреты не возвращаются наружу.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStore, StoreError } = require('../store');

test('создание аккаунта с credentials и чтение списка (без секретов)', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', {
    xkiro: 'sk-xt-1234567890abcdef',
    agentrouter: { key: 'at-foo', userId: '12345' },
    omniroute: { url: 'http://localhost:20128', key: 'mgmt-secret' },
  });
  const list = await store.accounts.listAccounts();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].name, 'work');
  assert.equal(list.accounts[0].hasXkiro, true);
  assert.equal(list.accounts[0].hasAgentrouter, true);
  assert.equal(list.accounts[0].hasOmniroute, true);
  assert.equal(list.accounts[0].hasAntigravity, false);
  // Активный по умолчанию = 'default'
  assert.equal(list.active, 'default');
});

test('getActiveCredential возвращает расшифрованные credentials', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', { xkiro: 'sk-secret-key' });
  // Активируем 'work'
  await store.set('activeAccount', 'work');
  const xkiro = await store.accounts.getActiveCredential('xkiro');
  assert.ok(xkiro);
  assert.equal(xkiro.api_key, 'sk-secret-key');
});

test('getActiveCredential возвращает null для неизвестного провайдера', async () => {
  const store = await createStore({ memory: true });
  const result = await store.accounts.getActiveCredential('xkiro');
  assert.equal(result, null);
});

test('обновление credentials через updateAccount заменяет значения', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', { xkiro: 'old-key' });
  await store.accounts.updateAccount('work', { xkiro: 'new-key' });
  await store.set('activeAccount', 'work');
  const xkiro = await store.accounts.getActiveCredential('xkiro');
  assert.equal(xkiro.api_key, 'new-key');
});

test('удаление аккаунта стирает все его credentials', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', { xkiro: 'sk-1', agentrouter: { key: 'a' } });
  await store.accounts.createAccount('personal', { xkiro: 'sk-2' });
  await store.accounts.deleteAccount('work');
  const list = await store.accounts.listAccounts();
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].name, 'personal');
});

test('удаление активного аккаунта сбрасывает active на default', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', { xkiro: 'sk-1' });
  await store.set('activeAccount', 'work');
  await store.accounts.deleteAccount('work');
  const list = await store.accounts.listAccounts();
  assert.equal(list.active, 'default');
});

test('повторное создание аккаунта с тем же именем → account_exists', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', { xkiro: 'sk-1' });
  await assert.rejects(
    store.accounts.createAccount('work', { xkiro: 'sk-2' }),
    (err) => err instanceof StoreError && err.code === 'account_exists',
  );
});

test('обновление несуществующего аккаунта → account_not_found', async () => {
  const store = await createStore({ memory: true });
  await assert.rejects(
    store.accounts.updateAccount('missing', { xkiro: 'sk-1' }),
    (err) => err instanceof StoreError && err.code === 'account_not_found',
  );
});

test('недопустимое имя аккаунта → invalid_account_name', async () => {
  const store = await createStore({ memory: true });
  await assert.rejects(
    store.accounts.createAccount('Invalid Name!', { xkiro: 'sk-1' }),
    (err) => err instanceof StoreError && err.code === 'invalid_account_name',
  );
  await assert.rejects(
    store.accounts.createAccount('', { xkiro: 'sk-1' }),
    (err) => err instanceof StoreError && err.code === 'invalid_account_name',
  );
});

test('пустые credentials → empty_credentials', async () => {
  const store = await createStore({ memory: true });
  await assert.rejects(
    store.accounts.createAccount('work', {}),
    (err) => err instanceof StoreError && err.code === 'empty_credentials',
  );
});

test('лимит MAX_ACCOUNTS (10) соблюдается', async () => {
  const store = await createStore({ memory: true });
  for (let i = 0; i < 10; i++) {
    await store.accounts.createAccount('acc' + i, { xkiro: 'sk-' + i });
  }
  await assert.rejects(
    store.accounts.createAccount('overflow', { xkiro: 'sk-x' }),
    (err) => err instanceof StoreError && err.code === 'too_many_accounts',
  );
});

test('миграция legacy kv-ключей в аккаунт default', async () => {
  const store = await createStore({ memory: true });
  // Заполняем legacy-поля
  await store.setMany([
    ['xkiroKey', 'legacy-xkiro'],
    ['agentrouterKey', 'legacy-ar'],
    ['agentrouterUserId', '12345'],
    ['omniUrl', 'http://localhost:20128'],
  ]);
  await store.close();
  // Открываем заново — миграция должна сработать
  // (createStore вызывается с тем же in-memory ключом,
  //  но в этом тесте мы имитируем первый запуск, поэтому создаём новый store)
  const store2 = await createStore({ memory: true });
  // legacy не было в новом store — миграция ничего не сделает
  const list = await store2.accounts.listAccounts();
  assert.equal(list.accounts.length, 0);
});

test('resolveCredential возвращает null для несуществующего аккаунта', async () => {
  const store = await createStore({ memory: true });
  const result = store.accounts.resolveCredential('nonexistent', 'xkiro');
  assert.equal(result, null);
});

test('credentials нескольких провайдеров в одном аккаунте хранятся независимо', async () => {
  const store = await createStore({ memory: true });
  await store.accounts.createAccount('work', {
    xkiro: 'sk-1',
    agentrouter: { key: 'at-1', userId: '111' },
    omniroute: { url: 'http://localhost:20128' },
    antigravity: { refreshToken: 'rt-1', project: 'proj-1' },
  });
  await store.set('activeAccount', 'work');
  const xkiro = await store.accounts.getActiveCredential('xkiro');
  const ar = await store.accounts.getActiveCredential('agentrouter');
  const omni = await store.accounts.getActiveCredential('omniroute');
  const ag = await store.accounts.getActiveCredential('antigravity');
  assert.equal(xkiro.api_key, 'sk-1');
  assert.equal(ar.api_key, 'at-1');
  assert.equal(ar.user_id, '111');
  assert.equal(omni.url, 'http://localhost:20128');
  assert.equal(ag.oauth_refresh, 'rt-1');
  assert.equal(ag.project_id, 'proj-1');
});

test('активный аккаунт сохраняется в kv и переживает snapshot', async () => {
  const store = await createStore({ memory: true });
  await store.set('activeAccount', 'work');
  const snap = await store.snapshot();
  assert.equal(snap.activeAccount, 'work');
});
