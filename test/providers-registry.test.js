'use strict';

// Юнит-тесты реестра вшитых провайдеров (providers/index.js):
// набор провайдеров задаётся кодом (FACTORIES), окружение не используется.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders } = require('../providers');

test('вшитый список: по умолчанию только xKiro', () => {
  const list = loadProviders();
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.id, 'xkiro');
  assert.equal(p.name, 'xKiro');
  assert.equal(p.upstream, 'https://api.xkiro.com');
  assert.equal(p.apiKey, '');
  assert.equal(p.authScheme, 'x-api-key');
});
