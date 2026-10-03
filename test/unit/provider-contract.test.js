'use strict';

// Контракт адаптеров и дескрипторов (P2-1): реестр провайдеров и
// src/provider-descriptors.js не должны расходиться, а каждый адаптер
// обязан отдавать одинаковый набор функций и полей.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FACTORIES, loadProviders } = require('../../providers');
const {
  DESCRIPTORS,
  ADAPTER_PROVIDER_IDS,
  PROVIDER_STORE_KEYS,
  PROVIDER_STORE_USER_FIELDS,
  CREDENTIAL_FIELDS,
} = require('../../src/provider-descriptors');
const { STORE_KEYS } = require('../../src/store');
const { WRITABLE_KEYS } = require('../../src/routes/config');

test('реестр адаптеров совпадает с провайдерами-дескрипторами', () => {
  assert.deepEqual(Object.keys(FACTORIES).sort(), [...ADAPTER_PROVIDER_IDS].sort());
});

test('дескриптор каждого адаптера описывает его поля', () => {
  for (const id of ADAPTER_PROVIDER_IDS) {
    const descriptor = DESCRIPTORS[id];
    assert.equal(descriptor.id, id, id);
    assert.ok(descriptor.name, id + ': нет имени');
    assert.ok(descriptor.storeKey, id + ': нет ключа хранилища');
    assert.ok(
      Array.isArray(descriptor.credentials) && descriptor.credentials.length,
      id + ': нет полей credentials'
    );
    // Ключ секрета обязан быть в схеме хранилища и в allowlist записи
    assert.ok(STORE_KEYS.includes(descriptor.storeKey), id + ': ключ не в STORE_KEYS');
    assert.ok(WRITABLE_KEYS.includes(descriptor.storeKey), id + ': ключ не в WRITABLE_KEYS');
    // userField, если есть, тоже должен быть записью и полем credentials
    if (descriptor.userField) {
      assert.equal(PROVIDER_STORE_USER_FIELDS[id], descriptor.userField, id);
      assert.ok(CREDENTIAL_FIELDS[descriptor.userField], id + ': userField не в CREDENTIAL_FIELDS');
    }
  }
});

test('все адаптеры отдают единый контракт', () => {
  for (const provider of loadProviders()) {
    const descriptor = DESCRIPTORS[provider.id];
    assert.ok(descriptor, provider.id + ': нет дескриптора');
    assert.equal(typeof provider.getUsage, 'function', provider.id + ': нет getUsage');
    assert.equal(typeof provider.getModels, 'function', provider.id + ': нет getModels');
    assert.equal(typeof provider.buildHeaders, 'function', provider.id + ': нет buildHeaders');
    assert.equal(provider.name, descriptor.name, provider.id + ': имя не из дескриптора');
    assert.equal(provider.site, descriptor.site || '', provider.id + ': site не из дескриптора');
    assert.equal(provider.authScheme, descriptor.authScheme || provider.authScheme);
    // Пустой ключ не даёт заголовков авторизации (секрет не утекает «пустым»)
    assert.deepEqual(provider.buildHeaders(''), {}, provider.id);
  }
});

test('все адаптеры сохраняют единый контракт rate limit upstream', async () => {
  const fetchImpl = async () => ({ response: { status: 429 }, data: { error: 'rate_limited' } });
  for (const provider of loadProviders({ fetchImpl })) {
    const usage = await provider.getUsage('test-key');
    assert.equal(usage.status, 429, provider.id + ': getUsage status');
    assert.equal(usage.data.error, 'rate_limited', provider.id + ': getUsage error');

    const models = await provider.getModels('test-key');
    assert.equal(models.status, 429, provider.id + ': getModels status');
    assert.equal(models.data.error, 'rate_limited', provider.id + ': getModels error');
  }
});

test('все адаптеры скрывают malformed JSON общего клиента', async () => {
  const fetchImpl = async () => {
    throw Object.assign(new Error('invalid upstream JSON'), {
      code: 'upstream_invalid_json',
      details: { status: 502, contentType: 'text/html', snippet: '<secret-upstream-body>' },
    });
  };
  for (const provider of loadProviders({
    fetchImpl,
    log: () => {},
    retryNonJson: { count: 0, delayMs: 0 },
  })) {
    const result = await provider.getModels('test-key');
    assert.equal(result.status, 502, provider.id + ': status');
    assert.equal(result.data.error, 'bad_response', provider.id + ': error code');
    assert.doesNotMatch(JSON.stringify(result.data), /secret-upstream-body/, provider.id);
  }
});

test('PROVIDER_STORE_KEYS покрывает всех провайдеров-адаптеров', () => {
  for (const id of ADAPTER_PROVIDER_IDS) {
    assert.equal(PROVIDER_STORE_KEYS[id], DESCRIPTORS[id].storeKey, id);
  }
});

test('ключи дескрипторов не попадают в список дважды', () => {
  const keys = ADAPTER_PROVIDER_IDS.map(id => DESCRIPTORS[id].storeKey);
  assert.equal(new Set(keys).size, keys.length);
});
