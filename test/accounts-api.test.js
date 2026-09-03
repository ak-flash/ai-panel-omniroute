'use strict';

// Интеграционные тесты /api/accounts (RFC-0003).
// Проверяем: создание, обновление, удаление, активный аккаунт,
// write-only (секреты не возвращаются в GET).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startPanel } = require('./helpers');
const { createStore } = require('../store');

test('GET /api/accounts возвращает пустой список для новой панели', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    const res = await fetch(panel.base + '/api/accounts');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);
    assert.deepEqual(body.accounts, []);
    assert.equal(body.active, 'default');
  } finally {
    await panel.stop();
  }
});

test('POST /api/accounts создаёт аккаунт (write-only)', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    const res = await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_name: 'work',
        credentials: { xkiro: 'sk-secret-12345' },
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'work');

    // GET /api/accounts не возвращает секреты
    const list = await fetch(panel.base + '/api/accounts');
    const listBody = await list.json();
    assert.equal(listBody.accounts.length, 1);
    assert.equal(listBody.accounts[0].name, 'work');
    assert.equal(listBody.accounts[0].hasXkiro, true);
    // Секрета быть не должно
    assert.ok(!JSON.stringify(listBody).includes('sk-secret-12345'));
  } finally {
    await panel.stop();
  }
});

test('POST /api/accounts с дублирующим именем → 409 account_exists', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: 'work', credentials: { xkiro: 'sk-1' } }),
    });
    const res = await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: 'work', credentials: { xkiro: 'sk-2' } }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'account_exists');
  } finally {
    await panel.stop();
  }
});

test('PUT /api/accounts/:name обновляет credentials', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: 'work', credentials: { xkiro: 'old-key' } }),
    });
    const res = await fetch(panel.base + '/api/accounts/work', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { xkiro: 'new-key' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.updated, 1);
  } finally {
    await panel.stop();
  }
});

test('DELETE /api/accounts/:name удаляет аккаунт', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: 'work', credentials: { xkiro: 'sk-1' } }),
    });
    const res = await fetch(panel.base + '/api/accounts/work', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const list = await fetch(panel.base + '/api/accounts');
    const listBody = await list.json();
    assert.equal(listBody.accounts.length, 0);
  } finally {
    await panel.stop();
  }
});

test('PUT /api/accounts/active устанавливает активный аккаунт', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    const createRes = await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: 'work', credentials: { xkiro: 'sk-1' } }),
    });
    assert.equal(createRes.status, 201);
    const res = await fetch(panel.base + '/api/accounts/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: 'work' }),
    });
    const errBody = res.status !== 200 ? await res.json() : null;
    assert.equal(res.status, 200, 'expected 200, got ' + res.status + ' body=' + JSON.stringify(errBody));
    const body = await res.json();
    assert.equal(body.active, 'work');

    const get = await fetch(panel.base + '/api/accounts/active');
    const getBody = await get.json();
    assert.equal(getBody.active, 'work');
  } finally {
    await panel.stop();
  }
});

test('POST /api/accounts с невалидным именем → 400 invalid_account_name', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    const res = await fetch(panel.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_name: 'Invalid Name!', credentials: { xkiro: 'sk-1' } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_account_name');
  } finally {
    await panel.stop();
  }
});

test('DELETE /api/accounts/nonexistent → 404 account_not_found', async () => {
  const store = await createStore({ memory: true });
  const panel = await startPanel({ store });
  try {
    const res = await fetch(panel.base + '/api/accounts/nonexistent', { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'account_not_found');
  } finally {
    await panel.stop();
  }
});
