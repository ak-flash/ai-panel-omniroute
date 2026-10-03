'use strict';

const LATENCY_BUCKETS = [100, 500, 1000, 5000];

const metrics = {
  requests: 0,
  errors: 0,
  totalDuration: 0,
  /** @type {Record<string, number>} */
  statuses: {},
  latencyBuckets: { le100: 0, le500: 0, le1000: 0, le5000: 0, gt5000: 0 },
  /** @type {Record<string, number>} */
  routes: {},
  /** @type {Record<string, number>} */
  providers: {},
  cache: { hit: 0, miss: 0 },
};

/** @param {Record<string, number>} map @param {string|undefined} key */
function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

/**
 * @param {number} status
 * @param {number} durationMs
 * @param {{ route?: string }} [meta]
 */
function recordRequest(status, durationMs, { route } = {}) {
  metrics.requests++;
  metrics.totalDuration += durationMs;
  const statusKey = String(status);
  metrics.statuses[statusKey] = (metrics.statuses[statusKey] || 0) + 1;
  increment(metrics.routes, route);
  if (status >= 500) metrics.errors++;
  const bucket = LATENCY_BUCKETS.findIndex(limit => durationMs <= limit);
  const key = /** @type {'le100'|'le500'|'le1000'|'le5000'|'gt5000'} */ (
    bucket === -1 ? 'gt5000' : 'le' + LATENCY_BUCKETS[bucket]
  );
  metrics.latencyBuckets[key]++;
}

function getMetrics() {
  const avg = metrics.requests === 0 ? 0 : metrics.totalDuration / metrics.requests;
  return {
    requests: metrics.requests,
    errors: metrics.errors,
    avgDurationMs: Math.round(avg),
    statuses: { ...metrics.statuses },
    latencyBuckets: { ...metrics.latencyBuckets },
    routes: { ...metrics.routes },
    providers: { ...metrics.providers },
    cache: { ...metrics.cache },
  };
}

function resetMetrics() {
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.totalDuration = 0;
  metrics.statuses = {};
  metrics.latencyBuckets = { le100: 0, le500: 0, le1000: 0, le5000: 0, gt5000: 0 };
  metrics.routes = {};
  metrics.providers = {};
  metrics.cache = { hit: 0, miss: 0 };
}

/** @param {string|undefined} provider */
function recordProvider(provider) {
  increment(metrics.providers, provider);
}

/** @param {'hit'|'miss'|string} result */
function recordCache(result) {
  if (result === 'hit') metrics.cache.hit++;
  else if (result === 'miss') metrics.cache.miss++;
}

module.exports = { recordCache, recordProvider, recordRequest, getMetrics, resetMetrics };
