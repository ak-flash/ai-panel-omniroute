'use strict';

// Счётчики /api/metrics (src/metrics.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { getMetrics, recordRequest, resetMetrics } = require('../../src/metrics');

test('метрики считают запросы, ошибки и среднее время', t => {
  resetMetrics();
  t.after(resetMetrics);

  assert.deepEqual(getMetrics(), { requests: 0, errors: 0, avgDurationMs: 0 });

  recordRequest(200, 10);
  recordRequest(404, 30);
  recordRequest(500, 50);

  const metrics = getMetrics();
  assert.equal(metrics.requests, 3);
  assert.equal(metrics.errors, 1, 'ошибкой считается только 5xx');
  assert.equal(metrics.avgDurationMs, 30);
});

test('resetMetrics обнуляет счётчики', () => {
  resetMetrics();
  recordRequest(500, 100);
  resetMetrics();
  assert.deepEqual(getMetrics(), { requests: 0, errors: 0, avgDurationMs: 0 });
});
