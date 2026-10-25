'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = globalThis.fetch;

let comboTestModelId;
let testComboModel;
test.before(async () => {
  ({ comboTestModelId, testComboModel } = await import('../../public/js/combo-test.js'));
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('comboTestModelId prefers normalized modelId', () => {
  assert.equal(
    comboTestModelId({ modelId: 'provider/model', display: 'fallback' }),
    'provider/model'
  );
});

test('comboTestModelId reads model fields from raw target', () => {
  assert.equal(
    comboTestModelId({ _raw: { model: 'raw/model' }, display: 'fallback' }),
    'raw/model'
  );
  assert.equal(comboTestModelId({ _raw: { modelId: 'raw/id' }, display: 'fallback' }), 'raw/id');
  assert.equal(comboTestModelId({ _raw: { id: 'raw/id' }, display: 'fallback' }), 'raw/id');
});

test('comboTestModelId falls back to display', () => {
  assert.equal(comboTestModelId({ display: 'shown/model' }), 'shown/model');
});

test('testComboModel sends a non-cached probe with a valid minimum token limit', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{}', {
      headers: { 'X-OmniRoute-Model': 'provider/resolved-model' },
    });
  };

  const result = await testComboModel('provider/model');

  assert.equal(request.url, '/omniroute/v1/chat/completions');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(request.options.headers, {
    'content-type': 'application/json',
    'X-OmniRoute-No-Cache': 'true',
  });
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'provider/model',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
    stream: false,
  });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.model, 'provider/resolved-model');
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
});
