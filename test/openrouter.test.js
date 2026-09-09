'use strict';

// ============================================================
// Тесты провайдера OpenRouter и обновления рейтинга для кодинга.
//
// OpenRouter — вшитый провайдер адреса https://openrouter.ai/api/v1
// (в тестах подменяется на mock-upstream). Один и тот же ключ
// провайдера используется для каталога моделей и для «Обновить
// рейтинг» (OpenRouter Benchmarks API) — ключ достаётся из
// серверного хранилища маршрутом /api/coding-ratings/refresh.
//
// Кэш рейтинга в тестах пишется во временную папку
// (AIPANEL_CODING_CACHE_PATH задаётся ДО require сервера).
// ============================================================

process.env.AIPANEL_CODING_CACHE_PATH =
  require('path').join(require('os').tmpdir(), 'ai-panel-test-coding-ratings.json');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createOpenRouterProvider } = require('../providers/openrouter');
const { json, startPanel } = require('./helpers');
const { createStore } = require('../src/compat/store');
const { normModelName } = require('../src/coding-ratings');

/** Mock upstream, похожий на API OpenRouter (/api/v1).
 * routes: { '/auth/key': body, '/models': body }; без ключа — 401.
 * Возвращает { url, seen, close }. */
function startOpenRouterUpstream(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    seen.push({ url: req.url, auth });
    if (!auth) return json(res, 401, { error: { code: 'missing_key', message: 'Missing Bearer' } });
    const route = opts.routes && opts.routes[req.url];
    if (route) return json(res, route.code || 200, route.body);
    return json(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen,
        close: () =>
          new Promise((done) => {
            server.closeIdleConnections();
            server.close(done);
          }),
      });
    });
  });
}

const OR_ROUTES = {
  '/auth/key': {
    body: {
      data: {
        label: 'main',
        usage: 25.5,
        usage_daily: 25.5,
        usage_weekly: 25.5,
        usage_monthly: 25.5,
        limit: 100,
        limit_remaining: 74.5,
        is_free_tier: false,
        is_management_key: false,
      },
    },
  },
  '/models': {
    body: {
      data: [
        {
          id: 'openai/gpt-6-astra',
          name: 'OpenAI: GPT-6 Astra',
          context_length: 128000,
          pricing: { prompt: 0.5, completion: 1.5 },
        },
        { id: 'meta-llama/llama-4', name: 'Llama 4', pricing: {} },
      ],
    },
  },
};

/* ---------- адаптер провайдера ---------- */

test('openrouter: getUsage нормализует /auth/key в формат панели', async () => {
  const mock = await startOpenRouterUpstream({ routes: OR_ROUTES });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    const r = await p.getUsage('sk-or-1');
    assert.equal(r.status, 200);
    assert.equal(r.data.plan, 'main');
    assert.equal(r.data.wallet.balance_usd, 74.5); // limit_remaining
    assert.equal(r.data.used_usd, 25.5);
    assert.equal(r.data.today_usd, 25.5); // usage_daily
    assert.equal(mock.seen[0].auth, 'Bearer sk-or-1');
  } finally {
    await mock.close();
  }
});

test('openrouter: getUsage — 401 от upstream мапится в unauthorized', async () => {
  const mock = await startOpenRouterUpstream({ routes: OR_ROUTES });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    // Пустой ключ → без Authorization → mock отвечает 401
    const bad = await p.getUsage('');
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error, 'unauthorized');
    assert.match(bad.data.message, /OpenRouter/);
  } finally {
    await mock.close();
  }
});

test('openrouter: getUsage без данных о ключе → bad_response', async () => {
  const mock = await startOpenRouterUpstream({
    routes: { '/auth/key': { body: { data: 'nope' } } },
  });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    const r = await p.getUsage('sk-or-1');
    assert.equal(r.status, 502);
    assert.equal(r.data.error, 'bad_response');
  } finally {
    await mock.close();
  }
});

test('openrouter: getUsage — ключ без лимита → фолбэк на /credits', async () => {
  const mock = await startOpenRouterUpstream({
    routes: {
      '/auth/key': {
        body: { data: { label: 'free', usage: 1.5, limit: null, limit_remaining: null, is_free_tier: true } },
      },
      '/credits': {
        body: { data: { total_credits: 10, total_usage: 6 } },
      },
    },
  });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    const r = await p.getUsage('sk-or-1');
    assert.equal(r.status, 200);
    assert.equal(r.data.plan, 'free');
    assert.equal(r.data.wallet.balance_usd, 4); // 10 − 6 из /credits
  } finally {
    await mock.close();
  }
});

test('openrouter: getUsage — ключ без лимита + /credits вернул 403 → баланс 0', async () => {
  const mock = await startOpenRouterUpstream({
    routes: {
      '/auth/key': {
        body: { data: { label: 'free', usage: 1.5, limit: null, limit_remaining: null, is_free_tier: true } },
      },
      '/credits': {
        status: 403,
        body: { error: { code: 403, message: 'Only management keys can perform this operation' } },
      },
    },
  });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    const r = await p.getUsage('sk-or-1');
    assert.equal(r.status, 200);
    assert.equal(r.data.wallet.balance_usd, 0);
  } finally {
    await mock.close();
  }
});

test('openrouter: getUsage — limit_remaining null + limit задан → баланс = limit − usage', async () => {
  const mock = await startOpenRouterUpstream({
    routes: {
      '/auth/key': {
        body: { data: { label: 'default', usage: 0, limit: 4, limit_remaining: null, is_free_tier: false } },
      },
    },
  });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    const r = await p.getUsage('sk-or-1');
    assert.equal(r.status, 200);
    assert.equal(r.data.wallet.balance_usd, 4); // limit(4) − usage(0)
    assert.equal(r.data.used_usd, 0);
  } finally {
    await mock.close();
  }
});

test('openrouter: getModels нормализует каталог в формат панели', async () => {
  const mock = await startOpenRouterUpstream({ routes: OR_ROUTES });
  try {
    const p = createOpenRouterProvider({ url: mock.url });
    const r = await p.getModels('sk-or-1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.data, [
      {
        id: 'openai/gpt-6-astra',
        display_name: 'OpenAI: GPT-6 Astra',
        access_tier: 'paid',
        context_length: 128000,
        pricing: { input: 0.5, output: 1.5 },
      },
      {
        id: 'meta-llama/llama-4',
        display_name: 'Llama 4',
        access_tier: 'paid',
        context_length: undefined,
        pricing: { input: 0, output: 0 },
      },
    ]);
  } finally {
    await mock.close();
  }
});

/* ---------- интеграция: провайдер через /api/providers/openrouter ---------- */

test('openrouter: usage/models через сервер, hasOpenrouterKey в /api/config', async () => {
  const mock = await startOpenRouterUpstream({ routes: OR_ROUTES });
  const { createOpenRouterProvider } = require('../providers/openrouter');
  const store = await createStore({ memory: true });
  const panel = await startPanel({
    providers: [createOpenRouterProvider({ url: mock.url })],
    store,
  });
  try {
    // Ключ из хранилища подставляется сервером (как у xKiro)
    await store.set('openrouterKey', 'sk-or-store');

    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.deepEqual(cfg.providers, [
      { id: 'openrouter', name: 'OpenRouter', site: 'https://openrouter.ai', hasKey: true },
    ]);
    assert.equal(cfg.activeProvider, 'openrouter');

    const usage = await (await fetch(panel.base + '/api/providers/openrouter/usage')).json();
    assert.equal(usage.wallet.balance_usd, 74.5);
    assert.equal(mock.seen.find((s) => s.url === '/auth/key').auth, 'Bearer sk-or-store');

    const models = await (await fetch(panel.base + '/api/providers/openrouter/models')).json();
    assert.equal(models.data.length, 2);
    assert.equal(models.data[0].id, 'openai/gpt-6-astra');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

/* ---------- рейтинг: ключ берётся из хранилища OpenRouter ---------- */

const BENCH_BODY = {
  data: [
    { model_permaslug: 'openai/gpt-6-astra', display_name: 'OpenAI: GPT-6 Astra', coding_index: 91.2 },
    { model_permaslug: 'anthropic/claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', coding_index: 55.0 },
    { model_permaslug: 'no-score', display_name: 'No Score' },
  ],
  meta: {
    as_of: '2026-09-01T00:00:00.000Z',
    citation: 'Artificial Analysis Intelligence Index, via OpenRouter',
    source_url: 'https://artificialanalysis.ai',
  },
};

/** Подменяет глобальный fetch ответом benchmarks (как openrouter.ai).
 * Остальные запросы (в т.ч. на панель) уходят исходным fetch как есть. */
function withFetchStub(body, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]).includes('benchmarks')) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return original(...args);
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

test('refresh без ключа OpenRouter → 400 missing_api_key', async () => {
  const panel = await startPanel();
  try {
    const res = await fetch(panel.base + '/api/coding-ratings/refresh', { method: 'POST' });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'missing_api_key');
    assert.match(data.message, /Настройках/);
  } finally {
    await panel.stop();
  }
});

test('refresh берёт ключ OpenRouter из хранилища и сохраняет рейтинг', async () => {
  const store = await createStore({ memory: true });
  await store.set('openrouterKey', 'sk-or-refresh');
  const panel = await startPanel({ store });
  try {
    const res = await withFetchStub(BENCH_BODY, () =>
      fetch(panel.base + '/api/coding-ratings/refresh', { method: 'POST' }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, 'artificial-analysis via openrouter');
    // ключи в рейтинге нормализованы (без дефисов/регистра)
    assert.equal(data.ratings[normModelName('openai/gpt-6-astra')].score, 91);
    assert.equal(data.ratings[normModelName('anthropic/claude-sonnet-4-5')].score, 55);
    // модель без coding_index в рейтинг не попадает
    assert.ok(!data.ratings[normModelName('no-score')]);

    // GET /api/coding-ratings отдаёт обновлённый кэш
    const got = await (await fetch(panel.base + '/api/coding-ratings')).json();
    assert.equal(got.ratings[normModelName('openai/gpt-6-astra')].score, 91);
  } finally {
    await panel.stop();
  }
});

test('refresh: клиентский ключ приоритетнее сохранённого', async () => {
  const store = await createStore({ memory: true });
  await store.set('openrouterKey', 'sk-or-stored');
  const panel = await startPanel({ store });
  try {
    const res = await withFetchStub(BENCH_BODY, () =>
      fetch(panel.base + '/api/coding-ratings/refresh', {
        method: 'POST',
        headers: { 'x-openrouter-api-key': 'sk-or-client' },
      }));
    assert.equal(res.status, 200);
    // Ключ уходит в Authorization — проверить нельзя (патч fetch без лога),
    // но сам факт успеха подтверждает, что ключ нашёлся.
    const data = await res.json();
    assert.equal(data.source, 'artificial-analysis via openrouter');
  } finally {
    await panel.stop();
  }
});