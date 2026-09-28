'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchJson, fetchWithRetry } = require('../../src/fetch-utils');

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('fetchJson применяет таймаут к чтению медленного тела', async () => {
  globalThis.fetch = async (_url, options) => ({
    headers: new Headers({ 'content-type': 'application/json' }),
    status: 200,
    text: () =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      }),
  });

  await assert.rejects(
    fetchJson('http://upstream.test/data', {}, 10),
    error => error.code === 'upstream_timeout' && error.status === 504
  );
});

test('fetchWithRetry повторяет GET после 429 и соблюдает Retry-After', async () => {
  let calls = 0;
  const started = Date.now();
  globalThis.fetch = async () => {
    calls += 1;
    return {
      status: calls === 1 ? 429 : 200,
      headers: new Headers(calls === 1 ? { 'retry-after': '0.01' } : {}),
      text: async () => '{}',
    };
  };

  const result = await fetchWithRetry('http://upstream.test/data', {}, 1, 1, 100);
  assert.equal(result.response.status, 200);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 8);
});

test('fetchWithRetry не повторяет POST', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 503, headers: new Headers(), text: async () => '{}' };
  };

  const result = await fetchWithRetry('http://upstream.test/data', { method: 'POST' }, 2, 0, 100);
  assert.equal(result.response.status, 503);
  assert.equal(calls, 1);
});
