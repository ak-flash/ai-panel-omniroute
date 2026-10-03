'use strict';

// Счётчики /api/metrics (src/metrics.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getMetrics,
  recordCache,
  recordProvider,
  recordRequest,
  resetMetrics,
} = require('../../src/metrics');

test('метрики считают запросы, ошибки и среднее время', t => {
  resetMetrics();
  t.after(resetMetrics);

  assert.deepEqual(getMetrics(), {
    requests: 0,
    errors: 0,
    avgDurationMs: 0,
    statuses: {},
    latencyBuckets: { le100: 0, le500: 0, le1000: 0, le5000: 0, gt5000: 0 },
    routes: {},
    providers: {},
    cache: { hit: 0, miss: 0 },
  });

  recordRequest(200, 10, { route: '/api/x' });
  recordRequest(404, 30);
  recordRequest(500, 50);

  const metrics = getMetrics();
  assert.equal(metrics.requests, 3);
  assert.equal(metrics.errors, 1, 'ошибкой считается только 5xx');
  assert.equal(metrics.avgDurationMs, 30);
  assert.deepEqual(metrics.statuses, { 200: 1, 404: 1, 500: 1 });
  assert.equal(metrics.latencyBuckets.le100, 3);
  assert.deepEqual(metrics.routes, { '/api/x': 1 });
});

test('метрики учитывают провайдеров, кеш и маршрут', () => {
  resetMetrics();
  try {
    recordRequest(200, 5, { route: '/api/providers/xkiro/usage' });
    recordRequest(200, 5, { route: '/api/providers/xkiro/usage' });
    recordRequest(404, 5);
    recordProvider('xkiro');
    recordProvider('agentrouter');
    recordCache('hit');
    recordCache('hit');
    recordCache('miss');
    recordCache('неизвестное');

    const metrics = getMetrics();
    assert.deepEqual(metrics.routes, { '/api/providers/xkiro/usage': 2 });
    assert.deepEqual(metrics.providers, { xkiro: 1, agentrouter: 1 });
    assert.deepEqual(metrics.cache, { hit: 2, miss: 1 });
  } finally {
    resetMetrics();
  }
});

test('resetMetrics обнуляет счётчики', () => {
  resetMetrics();
  recordRequest(500, 100);
  recordProvider('xkiro');
  recordCache('hit');
  resetMetrics();
  assert.deepEqual(getMetrics(), {
    requests: 0,
    errors: 0,
    avgDurationMs: 0,
    statuses: {},
    latencyBuckets: { le100: 0, le500: 0, le1000: 0, le5000: 0, gt5000: 0 },
    routes: {},
    providers: {},
    cache: { hit: 0, miss: 0 },
  });
});
