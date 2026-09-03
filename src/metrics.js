'use strict';

const metrics = {
  requests: 0,
  errors: 0,
  totalDuration: 0,
};

function recordRequest(status, durationMs) {
  metrics.requests++;
  metrics.totalDuration += durationMs;
  if (status >= 500) metrics.errors++;
}

function getMetrics() {
  const avg = metrics.requests === 0 ? 0 : metrics.totalDuration / metrics.requests;
  return {
    requests: metrics.requests,
    errors: metrics.errors,
    avgDurationMs: Math.round(avg),
  };
}

function resetMetrics() {
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.totalDuration = 0;
}

module.exports = { recordRequest, getMetrics, resetMetrics };