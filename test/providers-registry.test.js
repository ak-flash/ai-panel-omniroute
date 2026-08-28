'use strict';

// Юнит-тесты реестра вшитых провайдеров (providers/index.js):
// набор провайдеров задаётся кодом (FACTORIES), окружение не используется.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders } = require('../providers');

test('вшитый список: xKiro, AgentRouter', () => {
  const list = loadProviders();
  assert.equal(list.length, 2);

  // xKiro — первый, активный по умолчанию
  const [xkiro, agentrouter] = list;
  assert.equal(xkiro.id, 'xkiro');
  assert.equal(xkiro.name, 'xKiro');
  assert.equal(xkiro.upstream, 'https://api.xkiro.com');
  assert.equal(xkiro.apiKey, '');
  assert.equal(xkiro.authScheme, 'x-api-key');

  // AgentRouter — баланс кошелька (пока без каталога моделей)
  assert.equal(agentrouter.id, 'agentrouter');
  assert.equal(agentrouter.name, 'AgentRouter');
  assert.equal(agentrouter.upstream, 'https://agentrouter.org');
  assert.equal(agentrouter.apiKey, '');
  assert.equal(agentrouter.authScheme, 'authorization');
});
