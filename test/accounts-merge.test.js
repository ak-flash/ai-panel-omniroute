'use strict';

// Юнит-тесты маппинга полей провайдеров в credential_type (RFC-0003).
// Это чистые unit-тесты — без БД.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDER_IDS } = require('../src/store/accounts');

test('PROVIDER_IDS содержит 6 ожидаемых провайдеров', () => {
  assert.deepEqual(
    PROVIDER_IDS.sort(),
    ['agentrouter', 'antigravity', 'experiential', 'omniroute', 'openrouter', 'selora', 'xkiro'],
  );
});
