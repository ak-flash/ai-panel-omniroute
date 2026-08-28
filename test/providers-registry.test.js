'use strict';

// Юнит-тесты реестра вшитых провайдеров (providers/index.js):
// набор провайдеров задаётся кодом (FACTORIES), окружение не используется.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders } = require('../providers');

test('вшитый список: xKiro', () => {
  const list = loadProviders();
  assert.equal(list.length, 1);
  const xkiro = list[0];
  assert.equal(xkiro.id, 'xkiro');
  assert.equal(xkiro.name, 'xKiro');
  assert.equal(xkiro.upstream, 'https://api.xkiro.com');
  assert.equal(xkiro.apiKey, '');
  assert.equal(xkiro.authScheme, 'x-api-key');
});
