'use strict';

// Общий клиент провайдера (P2-1): стандартные коды ошибок, таймаут,
// маскирование секретов в debug-логе и повторы не-JSON ответов.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderClient, apiKeyAuth, bearerAuth } = require('../../src/provider-client');

/** Подмена fetchJson: отдаёт заранее заданные ответы/ошибки. */
function stubFetch(script) {
  const calls = [];
  const impl = async (url, options, timeoutMs) => {
    calls.push({ url, options, timeoutMs });
    const step = script.length > 1 ? script.shift() : script[0];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, options, timeoutMs);
    return step;
  };
  return { impl, calls };
}

const ok = (status, data) => ({ response: { status }, data });

test('успешный ответ возвращается как есть, таймаут адаптера доходит до fetch', async () => {
  const fetch = stubFetch([ok(200, { balance: 1 })]);
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test/',
    auth: apiKeyAuth(),
    timeoutMs: 1234,
    fetchImpl: fetch.impl,
  });
  const result = await client.get('/v1/usage', { credential: { key: 'k' } });
  assert.deepEqual(result, { status: 200, data: { balance: 1 } });
  assert.equal(fetch.calls[0].url, 'https://example.test/v1/usage', 'хвостовой слэш срезан');
  assert.equal(fetch.calls[0].timeoutMs, 1234);
  assert.equal(fetch.calls[0].options.headers['x-api-key'], 'k');
});

test('query-параметры кодируются, null пропускаются', async () => {
  const fetch = stubFetch([ok(200, {})]);
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    fetchImpl: fetch.impl,
  });
  await client.get('/daily', { query: { org_id: 'a b', scope: null, group_by: 'day' } });
  assert.equal(fetch.calls[0].url, 'https://example.test/daily?org_id=a%20b&group_by=day');
});

test('не-JSON ответ даёт 502 bad_response, а не сырое тело', async () => {
  const err = Object.assign(new Error('upstream вернул не-JSON'), {
    code: 'upstream_invalid_json',
    details: { status: 403, contentType: 'text/html', snippet: '<html>заглушка</html>' },
  });
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    fetchImpl: stubFetch([err]).impl,
  });
  const result = await client.get('/x');
  assert.equal(result.status, 502);
  assert.equal(result.data.error, 'bad_response');
  assert.match(result.data.message, /не-JSON/);
  assert.doesNotMatch(JSON.stringify(result.data), /заглушка/);
});

test('сеть и таймаут дают 502 provider_error с причиной', async () => {
  const err = new Error('таймаут');
  err.cause = new Error('socket hang up');
  const lines = [];
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    log: (...a) => lines.push(a.join(' ')),
    fetchImpl: stubFetch([err]).impl,
  });
  const result = await client.get('/x');
  assert.equal(result.status, 502);
  assert.equal(result.data.error, 'provider_error');
  assert.equal(result.data.message, 'таймаут');
  assert.ok(
    lines.some(line => line.includes('socket hang up')),
    'причина в логе'
  );
});

test('повторы не-JSON с HTTP 200: столько попыток, сколько разрешено', async () => {
  const err = () =>
    Object.assign(new Error('не-JSON'), {
      code: 'upstream_invalid_json',
      details: { status: 200, contentType: 'text/html', snippet: 'waf' },
    });
  const fetch = stubFetch([err(), err(), ok(200, { ok: 1 })]);
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    fetchImpl: fetch.impl,
    retryNonJson: { count: 2, delayMs: 0 },
  });
  const result = await client.get('/x');
  assert.equal(result.status, 200);
  assert.equal(fetch.calls.length, 3, 'две неудачи и один успех');
});

test('повторы не-JSON не тратятся, если ответ не 200', async () => {
  const err = Object.assign(new Error('не-JSON'), {
    code: 'upstream_invalid_json',
    details: { status: 401, contentType: 'text/html', snippet: '' },
  });
  const fetch = stubFetch([err]);
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    fetchImpl: fetch.impl,
    retryNonJson: { count: 2, delayMs: 0 },
  });
  const result = await client.get('/x');
  assert.equal(result.status, 502);
  assert.equal(fetch.calls.length, 1, 'один поход, без повторов');
});

test('своё сообщение для не-JSON (антибот WAF)', async () => {
  const err = Object.assign(new Error('не-JSON'), {
    code: 'upstream_invalid_json',
    details: { status: 200, contentType: 'text/html', snippet: 'aliyun_waf challenge' },
  });
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    fetchImpl: stubFetch([err]).impl,
    onBadResponse: ({ snippet }) => (snippet.includes('aliyun_waf') ? 'антибот' : 'обычный'),
  });
  const result = await client.get('/x');
  assert.equal(result.data.message, 'антибот');
});

test('debug-лог маскирует секреты', async () => {
  const lines = [];
  const fetch = stubFetch([ok(200, {})]);
  const client = createProviderClient({
    name: 'P',
    upstream: 'https://example.test',
    auth: bearerAuth(),
    log: { info: (line, fields) => lines.push(JSON.stringify([line, fields])) },
    debug: true,
    fetchImpl: fetch.impl,
  });
  await client.get('/x', { credential: { key: 'secret-key' } });
  assert.ok(lines.join('').includes('***'), 'значение замаскировано');
  assert.ok(!lines.join('').includes('secret-key'), 'секрет не утёк');
});

test('схемы авторизации', () => {
  assert.deepEqual(apiKeyAuth().buildHeaders({ key: 'k' }), { 'x-api-key': 'k' });
  assert.deepEqual(apiKeyAuth().buildHeaders({ key: '' }), {});
  assert.deepEqual(bearerAuth().buildHeaders({ key: 'k' }), { authorization: 'Bearer k' });
  assert.deepEqual(
    bearerAuth(cred => (cred.userId ? { 'new-api-user': cred.userId } : null)).buildHeaders({
      key: 'k',
      userId: '42',
    }),
    { authorization: 'Bearer k', 'new-api-user': '42' }
  );
});
