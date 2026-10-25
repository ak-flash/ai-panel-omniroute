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

function completion(content, options = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: options.finishReason }],
      ...options.payload,
    }),
    {
      status: options.status || 200,
      headers: options.headers,
    }
  );
}

test('testComboModel sends one non-cached probe with reasoning headroom', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return completion('pong', {
      finishReason: 'length',
      headers: { 'X-OmniRoute-Model': 'provider/resolved-model' },
    });
  };

  const result = await testComboModel('provider/model');

  assert.equal(requests.length, 1);
  const [{ url, options }] = requests;
  assert.equal(url, '/omniroute/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, {
    'content-type': 'application/json',
    'X-OmniRoute-No-Cache': 'true',
  });
  assert.deepEqual(JSON.parse(options.body), {
    model: 'provider/model',
    messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }],
    max_tokens: 4096,
    stream: false,
  });
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.model, 'provider/resolved-model');
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
});

test('testComboModel accepts visible text content blocks', async () => {
  for (const content of [
    [
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'pong' },
    ],
    [{ type: 'output_text', text: 'pong' }],
    ['pong'],
  ]) {
    globalThis.fetch = async () => completion(content);
    const result = await testComboModel('provider/model');
    assert.equal(result.model, 'provider/model');
    assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
  }
});

test('testComboModel rejects successful responses without visible output', async () => {
  const cases = [
    '{}',
    'null',
    JSON.stringify({ choices: [] }),
    JSON.stringify({ choices: [{}] }),
    JSON.stringify({ choices: [{ message: {} }] }),
    JSON.stringify({ choices: [{ message: { content: '' } }] }),
    JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
    JSON.stringify({ choices: [{ message: { content: null } }] }),
    JSON.stringify({ choices: [{ message: { content: [] } }] }),
    JSON.stringify({
      choices: [{ message: { content: [{ type: 'thinking', thinking: 'only reasoning' }] } }],
    }),
    JSON.stringify({ error: { message: '200 error envelope' } }),
  ];
  for (const body of cases) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(body);
    };
    await assert.rejects(testComboModel('provider/model'), /пустой ответ/);
    assert.equal(calls, 1);
  }
});

test('testComboModel reports malformed success JSON without retrying', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('not-json');
  };
  await assert.rejects(testComboModel('provider/model'), /некорректный JSON/);
  assert.equal(calls, 1);
});

test('testComboModel surfaces upstream error and does not retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: { message: '[agentrouter/gpt-6.1-sol] upstream returned an empty response' },
      }),
      { status: 502 }
    );
  };
  await assert.rejects(
    testComboModel('agentrouter/gpt-6.1-sol'),
    /\[agentrouter\/gpt-6\.1-sol\] upstream returned an empty response/
  );
  assert.equal(calls, 1);
});

test('testComboModel reports malformed success JSON', async () => {
  globalThis.fetch = async () =>
    new Response('{'.repeat(5), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  await assert.rejects(testComboModel('provider/model'), /некорректный JSON/);
});
