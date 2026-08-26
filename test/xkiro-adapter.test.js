'use strict';

// Юнит-тесты фабрики адаптера xKiro (providers/xkiro.js)
// против mock-upstream: пути, ключи, ошибки сети и формата ответа.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXKiroProvider } = require('../providers/xkiro');
const { startMockUpstream, getFreePort } = require('./helpers');

const CONFIG_KEY = 'config-key-123';

test('getUsage: GET /v1/usage, JSON как есть, ключ из config', async () => {
  const mock = await startMockUpstream();
  try {
    const provider = createXKiroProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    assert.equal(data.plan, 'pro');
    assert.equal(data.wallet.balance_usd, '12.34');
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].url, '/v1/usage');
    assert.equal(mock.seen[0].key, CONFIG_KEY);
  } finally {
    await mock.close();
  }
});

test('клиентский ключ приоритетнее ключа из config', async () => {
  const mock = await startMockUpstream();
  try {
    const provider = createXKiroProvider({ url: mock.url, apiKey: CONFIG_KEY });
    await provider.getUsage('client-key-456');
    assert.equal(mock.seen[0].key, 'client-key-456');
  } finally {
    await mock.close();
  }
});

test('getModels: GET /v1/models', async () => {
  const mock = await startMockUpstream();
  try {
    const provider = createXKiroProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getModels();
    assert.equal(status, 200);
    assert.deepEqual(data.models, []);
    assert.equal(mock.seen[0].url, '/v1/models');
  } finally {
    await mock.close();
  }
});

test('ошибка авторизации upstream проксируется (статус и тело)', async () => {
  const mock = await startMockUpstream({ requireKey: true });
  try {
    const provider = createXKiroProvider({ url: mock.url, apiKey: '' });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
  } finally {
    await mock.close();
  }
});

test('ошибка сети → 502 provider_error', async () => {
  // Порт свободен: никто не слушает → connection refused
  const port = await getFreePort();
  const provider = createXKiroProvider({
    url: 'http://127.0.0.1:' + port,
    apiKey: CONFIG_KEY,
  });
  const { status, data } = await provider.getUsage();
  assert.equal(status, 502);
  assert.equal(data.error, 'provider_error');
});

test('не-JSON ответ → 502 bad_response', async () => {
  const mock = await startMockUpstream({ usageRaw: 'not-json{{' });
  try {
    const provider = createXKiroProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
  } finally {
    await mock.close();
  }
});

test('пустое тело ответа → 200 и {}', async () => {
  const mock = await startMockUpstream({ usageRaw: '' });
  try {
    const provider = createXKiroProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    assert.deepEqual(data, {});
  } finally {
    await mock.close();
  }
});

test('конфигурация: имя по умолчанию, слэш в URL, схема авторизации', () => {
  assert.equal(createXKiroProvider({}).name, 'xKiro');
  assert.equal(createXKiroProvider({ name: 'Custom' }).name, 'Custom');
  assert.equal(createXKiroProvider({ url: 'http://x/' }).upstream, 'http://x');
  assert.equal(createXKiroProvider({}).upstream, 'https://api.xkiro.com');
  assert.equal(createXKiroProvider({}).authScheme, 'x-api-key');
  assert.deepEqual(createXKiroProvider({ apiKey: 'k' }).buildHeaders('k'), {
    'x-api-key': 'k',
  });
  assert.deepEqual(createXKiroProvider({}).buildHeaders(''), {});
});
