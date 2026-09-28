'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createExperientialProvider } = require('../../providers/experiential');

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Одна модель каталога: nano-цены, имя, окно контекста. */
const CATALOG_ENTRY = {
  id: 'gpt-test',
  name: 'GPT Test',
  context_length: 8192,
  pricing: {
    input_nano_usd_per_million: '10000000',
    output_nano_usd_per_million: '20000000',
  },
};

/** Модель с устаревшими полями цены (input_per_1m) и без имени. */
const LEGACY_ENTRY = {
  id: 'legacy-test',
  context_window: 8192,
  pricing: { input_per_1m: 1.5, output_per_1m: 6 },
};

/** Каталог в одной из форм ответа: data / rows / массив / мусор. */
function catalogBody(shape) {
  if (shape === 'rows') return { rows: [CATALOG_ENTRY, LEGACY_ENTRY] };
  if (shape === 'array') return [CATALOG_ENTRY];
  if (shape === 'junk') return { data: [CATALOG_ENTRY, null, { name: 'без id' }, { id: '' }] };
  return { data: [CATALOG_ENTRY] };
}

function startUpstream(options = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || '' });
    if (req.url === '/api/models') {
      if (options.modelsStatus) return json(res, options.modelsStatus, options.modelsBody || {});
      return json(res, 200, catalogBody(options.modelsRows));
    }
    if (req.url === '/api/whoami') {
      if (options.whoamiStatus) return json(res, options.whoamiStatus, options.whoamiBody || {});
      return json(res, 200, options.whoamiBody || { org_id: 'org-test' });
    }
    if (req.url === '/api/v1/credits') {
      if (options.creditsStatus) {
        return json(res, options.creditsStatus, { error: 'credits_unavailable' });
      }
      return json(
        res,
        200,
        options.creditsBody || { data: { total_credits: '10', total_usage: '2.5' } }
      );
    }
    if (req.url.startsWith('/api/gateway/usage/daily')) {
      if (options.dailyStatus) return json(res, options.dailyStatus, options.dailyBody || {});
      const row = options.row || {
        day: new Date().toISOString().slice(0, 10),
        requests: 7,
        spend_nano_usd: '1250000000',
      };
      return json(res, 200, { [options.dailyRows || 'data']: [row] });
    }
    return json(res, 404, { error: 'not_found' });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: 'http://127.0.0.1:' + server.address().port + '/v1',
        seen,
        close: () => new Promise(done => server.close(done)),
      })
    )
  );
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
    assert.deepEqual(
      mock.seen.map(item => item.url).sort(),
      [
        '/api/gateway/usage/daily?org_id=org-test&scope=org&group_by=day',
        '/api/v1/credits',
        '/api/whoami',
      ].sort()
    );
    assert.ok(mock.seen.every(item => item.authorization === 'Bearer xpl_test'));
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

test('конфигурация адаптера: имя, адрес без слэша, схема авторизации', () => {
  const provider = createExperientialProvider({
    name: 'My XPL',
    url: 'https://api.example.com/v1///',
    apiKey: 'cfg-key',
  });
  assert.equal(provider.id, 'experiential');
  assert.equal(provider.name, 'My XPL');
  assert.equal(provider.upstream, 'https://api.example.com/v1', 'слэши в конце убраны');
  assert.equal(provider.apiKey, 'cfg-key');
  assert.equal(provider.authScheme, 'authorization');
  assert.deepEqual(provider.buildHeaders('k'), { authorization: 'Bearer k' });
  assert.deepEqual(provider.buildHeaders(''), {}, 'без ключа заголовка нет');

  // Без конфигурации берутся значения по умолчанию
  const fallback = createExperientialProvider();
  assert.equal(fallback.name, 'Experiential Labs');
  assert.equal(fallback.upstream, 'https://api.experientiallabs.ai/v1');
  assert.equal(fallback.site, 'https://platform.experientiallabs.ai/overview');
});

test('getUsage: 401 на whoami, отсутствие org_id и ошибка сети', async () => {
  // 401 от провайдера
  const unauthorized = await startUpstream({ whoamiStatus: 401 });
  try {
    const provider = createExperientialProvider({ url: unauthorized.url });
    const result = await provider.getUsage('bad');
    assert.equal(result.status, 401);
    assert.equal(result.data.error, 'unauthorized');
  } finally {
    await unauthorized.close();
  }

  // whoami без org_id — ответ не пригоден для расчёта баланса
  const noOrg = await startUpstream({ whoamiBody: { user: 'x' } });
  try {
    const provider = createExperientialProvider({ url: noOrg.url });
    const result = await provider.getUsage('k');
    assert.equal(result.status, 502);
    assert.equal(result.data.error, 'bad_response');
  } finally {
    await noOrg.close();
  }

  // Недоступный upstream → 502 provider_error, а не исключение
  const provider = createExperientialProvider({ url: 'http://127.0.0.1:1/v1', log: () => {} });
  const result = await provider.getUsage('k');
  assert.equal(result.status, 502);
  assert.equal(result.data.error, 'provider_error');
  assert.ok(result.data.message, 'причина сети попадает в ответ');
});

test('getUsage: 401 на credits и на daily, ошибка daily', async () => {
  const credits401 = await startUpstream({ creditsStatus: 401 });
  try {
    const provider = createExperientialProvider({ url: credits401.url });
    const result = await provider.getUsage('k');
    assert.equal(result.status, 401);
    assert.equal(result.data.error, 'unauthorized');
  } finally {
    await credits401.close();
  }

  const daily401 = await startUpstream({ dailyStatus: 401 });
  try {
    const provider = createExperientialProvider({ url: daily401.url });
    assert.equal((await provider.getUsage('k')).status, 401);
  } finally {
    await daily401.close();
  }

  const daily500 = await startUpstream({ dailyStatus: 500, dailyBody: { error: 'daily_down' } });
  try {
    const provider = createExperientialProvider({ url: daily500.url });
    const result = await provider.getUsage('k');
    assert.equal(result.status, 500);
    assert.deepEqual(result.data, { error: 'daily_down' });
  } finally {
    await daily500.close();
  }
});

test('getUsage: org_id в data.data, credits без обёртки, нули как null', async () => {
  const mock = await startUpstream({
    whoamiBody: { data: { org_id: 'org-nested' } },
    creditsBody: { total_credits: '0', total_usage: '0' },
    dailyRows: 'rows',
    // Строка за вчера — сегодняшнего расхода нет
    row: { day: '2000-01-01', spend_nano_usd: '5' },
  });
  try {
    const provider = createExperientialProvider({ url: mock.url });
    const result = await provider.getUsage('k');
    assert.equal(result.status, 200);
    assert.equal(result.data.wallet.balance_usd, 0);
    // Сегодняшней строки нет — расход за день неизвестен, а не ноль
    assert.equal(result.data.today_usd, null);
    assert.equal(result.data.requests, null);
  } finally {
    await mock.close();
  }

  // Отсутствующие суммы кредитов → баланс неизвестен (null), а не 0
  const unknown = await startUpstream({ creditsBody: {} });
  try {
    const provider = createExperientialProvider({ url: unknown.url });
    const result = await provider.getUsage('k');
    assert.equal(result.data.wallet.balance_usd, null);
  } finally {
    await unknown.close();
  }
});

test('getUsage: сегодняшняя строка по cost_nano_usd и request_count', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const mock = await startUpstream({
    dailyRows: 'rows',
    row: { date: today, cost_nano_usd: '500000000', request_count: 3 },
  });
  try {
    const provider = createExperientialProvider({ url: mock.url });
    const result = await provider.getUsage('k');
    assert.equal(result.data.today_usd, 0.5);
    assert.equal(result.data.requests, 3);
  } finally {
    await mock.close();
  }
});

test('getModels: 401, ошибка и альтернативные формы каталога', async () => {
  const unauthorized = await startUpstream({ modelsStatus: 401 });
  try {
    const provider = createExperientialProvider({ url: unauthorized.url });
    const result = await provider.getModels('bad');
    assert.equal(result.status, 401);
    assert.equal(result.data.error, 'unauthorized');
  } finally {
    await unauthorized.close();
  }

  const broken = await startUpstream({ modelsStatus: 500, modelsBody: { error: 'catalog_down' } });
  try {
    const provider = createExperientialProvider({ url: broken.url });
    const result = await provider.getModels('k');
    assert.equal(result.status, 500);
    assert.deepEqual(result.data, { error: 'catalog_down' });
  } finally {
    await broken.close();
  }

  // rows / простой массив / записи без id — приводятся к каталогу
  for (const [shape, ids] of [
    ['rows', ['gpt-test', 'legacy-test']],
    ['array', ['gpt-test']],
    ['junk', ['gpt-test']],
  ]) {
    const mock = await startUpstream({ modelsRows: shape });
    try {
      const provider = createExperientialProvider({ url: mock.url });
      const result = await provider.getModels('k');
      assert.equal(result.status, 200, shape);
      assert.deepEqual(
        result.data.data.map(m => m.id),
        ids,
        shape
      );
      for (const model of result.data.data) {
        assert.equal(model.access_tier, 'paid', shape);
        assert.equal(model.context_length, 8192, shape);
      }
    } finally {
      await mock.close();
    }
  }

  // Запись без имени берёт display_name из id, цены — из *_per_1m
  const legacy = await startUpstream({ modelsRows: 'rows' });
  try {
    const provider = createExperientialProvider({ url: legacy.url });
    const model = (await provider.getModels('k')).data.data.find(m => m.id === 'legacy-test');
    assert.equal(model.display_name, 'legacy-test');
    assert.deepEqual(model.pricing, { input: 1.5, output: 6 });
  } finally {
    await legacy.close();
  }
});
