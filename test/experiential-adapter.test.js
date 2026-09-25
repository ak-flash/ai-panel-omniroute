'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createExperientialProvider } = require('../providers/experiential');

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startUpstream(options = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || '' });
    if (req.url === '/api/models') {
      return json(res, 200, {
        data: [{
          id: 'gpt-test', name: 'GPT Test', pricing: {
            input_nano_usd_per_million: '10000000',
            output_nano_usd_per_million: '20000000',
          }
        }],
      });
    }
    if (req.url === '/api/whoami') return json(res, 200, { org_id: 'org-test' });
    if (req.url === '/api/v1/credits') {
      if (options.creditsStatus) {
        return json(res, options.creditsStatus, { error: 'credits_unavailable' });
      }
      return json(res, 200, { data: { total_credits: '10', total_usage: '2.5' } });
    }
    if (req.url.startsWith('/api/gateway/usage/daily')) {
      return json(res, 200, {
        data: [{
          day: new Date().toISOString().slice(0, 10),
          requests: 7,
          spend_nano_usd: '1250000000',
        }]
      });
    }
    return json(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/v1',
    seen,
    close: () => new Promise((done) => server.close(done)),
  })));
}

test('getUsage reads credits and daily usage from management API', async () => {
  const mock = await startUpstream();
  try {
    const provider = createExperientialProvider({ url: mock.url });
    const result = await provider.getUsage('xpl_test');
    assert.equal(result.status, 200);
    assert.equal(result.data.wallet.balance_usd, 7.5);
    assert.equal(result.data.today_usd, 1.25);
    assert.equal(result.data.requests, 7);
    assert.deepEqual(mock.seen.map((item) => item.url).sort(), [
      '/api/gateway/usage/daily?org_id=org-test&scope=org&group_by=day',
      '/api/v1/credits',
      '/api/whoami',
    ].sort());
    assert.ok(mock.seen.every((item) => item.authorization === 'Bearer xpl_test'));
  } finally {
    await mock.close();
  }
});

test('getModels maps nano-USD catalog prices to USD per million tokens', async () => {
  const mock = await startUpstream();
  try {
    const provider = createExperientialProvider({ url: mock.url });
    const result = await provider.getModels('xpl_test');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.data[0].pricing, { input: 0.01, output: 0.02 });
  } finally {
    await mock.close();
  }
});

test('getUsage returns upstream error when credits response is unavailable', async () => {
  const mock = await startUpstream({ creditsStatus: 503 });
  try {
    const provider = createExperientialProvider({ url: mock.url });
    const result = await provider.getUsage('xpl_test');
    assert.equal(result.status, 503);
    assert.deepEqual(result.data, { error: 'credits_unavailable' });
    assert.equal(result.data.wallet, undefined);
  } finally {
    await mock.close();
  }
});
