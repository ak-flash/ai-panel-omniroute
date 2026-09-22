'use strict';

// ============================================================
// Юнит-тесты фабрики адаптера Selora (providers/selora.js)
// против mock-upstream: /v1/me + /v1/me/windows (окна расхода
// сессии 4 ч и недели), /v1/models (каталог без авторизации).
// Реальный API selora.lol не вызывается.
// ============================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createSeloraProvider } = require('../providers/selora');
const { json, getFreePort } = require('./helpers');

const CONFIG_KEY = 'sk-gw-config-123';

/** Профиль из GET /v1/me (план + кошелёк; окна здесь — фолбэк). */
function meBody() {
  return {
    user: { id: 'u_1', plan_id: 'starter', balance_usd: 42.5 },
    plan: { name: 'Pro' },
    wallet: { balance: '42.50' },
  };
}

/** Окна из GET /v1/me/windows: camelCase, сброс в ms и ISO-строкой. */
function windowsBody() {
  return {
    session: { usedUsd: 1.25, limitUsd: 5, resetsInMs: 7200000, enforced: true, exhausted: false },
    week: {
      usedUsd: 18.4,
      limitUsd: 100,
      resetsAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      enforced: true,
      exhausted: false,
    },
  };
}

/** Каталог из GET /v1/models: цены за 1M токенов строками. */
function modelsBody() {
  return {
    models: [
      {
        id: 'anthropic/claude-sonnet-4.6',
        display_name: 'Claude Sonnet 4.6',
        status: 'active',
        supports_1m_context: true,
        pricing: { input_per_1m: '0.25', output_per_1m: '1.25' },
      },
      {
        id: 'openai/gpt-6-astra',
        display_name: 'GPT-6 Astra',
        status: 'active',
        supports_1m_context: false,
        pricing: { input_per_1m: '0.5', output_per_1m: '1.5' },
      },
    ],
  };
}

/**
 * Mock upstream, похожий на API Selora (api.selora.lol).
 *
 * Маршруты:
 *   /v1/me         → профиль (под ключом)
 *   /v1/me/windows → окна расхода (под ключом)
 *   /v1/models     → каталог моделей (без авторизации — как у Selora)
 *   остальное      → 404
 *
 * Опции:
 *   requireKey — требовать x-api-key на /v1/me* (по умолчанию true)
 *   routes     — переопределить ответ по URL: { '/v1/me': { code, body, raw } }
 *
 * Возвращает { url, seen, close }: seen — лог запросов { url, key, accept }.
 */
function startSeloraUpstream(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const key = req.headers['x-api-key'] || '';
    seen.push({ url: req.url, key, accept: req.headers['accept'] || '' });

    // Каталог моделей у Selora открыт; профиль и окна — под ключом
    if (!req.url.startsWith('/v1/models') && opts.requireKey !== false && !key) {
      return json(res, 401, { error: 'unauthorized', message: 'Invalid API key' });
    }

    const route = opts.routes && opts.routes[req.url];
    if (route) {
      if (route.raw !== undefined) {
        res.writeHead(route.code || 200, { 'content-type': route.contentType || 'text/plain' });
        return res.end(route.raw);
      }
      return json(res, route.code || 200, route.body);
    }

    if (req.url === '/v1/me') return json(res, 200, meBody());
    if (req.url === '/v1/me/windows') return json(res, 200, windowsBody());
    if (req.url === '/v1/models') return json(res, 200, modelsBody());
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

test('getUsage: /v1/me + /v1/me/windows → план, баланс и окна (сессия/неделя)', async () => {
  const mock = await startSeloraUpstream();
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    assert.equal(data.plan, 'Pro');
    assert.equal(data.wallet.balance_usd, 42.5);
    assert.equal(data.free_tokens, null);

    // Оба запроса ушли с ключом из config
    const urls = mock.seen.map((r) => r.url).sort();
    assert.deepEqual(urls, ['/v1/me', '/v1/me/windows']);
    assert.ok(mock.seen.every((r) => r.key === CONFIG_KEY));

    // Короткое окно — 4-часовая сессия
    assert.equal(data.windows.length, 2);
    const [short, long] = data.windows;
    assert.equal(short.kind, 'short');
    assert.equal(short.spent_usd, 1.25);
    assert.equal(short.cap_usd, 5);
    assert.equal(short.window_sec, 4 * 3600);
    assert.equal(short.resets_in_sec, 7200);

    // Длинное — скользящая неделя; сброс из ISO-строки resetsAt
    assert.equal(long.kind, 'long');
    assert.equal(long.spent_usd, 18.4);
    assert.equal(long.cap_usd, 100);
    assert.equal(long.window_sec, 7 * 24 * 3600);
    // 3 дня с небольшим допуском на округление и ход времени в тесте
    assert.ok(long.resets_in_sec >= 3 * 24 * 3600 - 10, 'resets_in_sec: ' + long.resets_in_sec);
    assert.ok(long.resets_in_sec <= 3 * 24 * 3600);
  } finally {
    await mock.close();
  }
});

test('клиентский ключ приоритетнее ключа из config', async () => {
  const mock = await startSeloraUpstream();
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    await provider.getUsage('sk-gw-client-456');
    assert.ok(mock.seen.every((r) => r.key === 'sk-gw-client-456'));
  } finally {
    await mock.close();
  }
});

test('фолбэк окон из профиля: /v1/me/windows 404 → user.windows (snake_case)', async () => {
  const mock = await startSeloraUpstream({
    routes: {
      '/v1/me/windows': { code: 404, body: { error: 'not_found' } },
      '/v1/me': {
        body: {
          user: {
            plan_id: 'starter',
            balance_usd: 42.5,
            windows: {
              session: { used_usd: 2.5, limit_usd: 5, resets_in_ms: 3600000 },
              week: { used_usd: 20, limit_usd: 0 },
            },
          },
          wallet: { balance: '42.50' },
        },
      },
    },
  });
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    // Плана в теле нет — берётся plan_id из профиля
    assert.equal(data.plan, 'starter');
    const [short, long] = data.windows;
    assert.equal(short.kind, 'short');
    assert.equal(short.spent_usd, 2.5);
    assert.equal(short.cap_usd, 5);
    assert.equal(short.resets_in_sec, 3600);
    // limit_usd 0 — окно без лимита
    assert.equal(long.kind, 'long');
    assert.equal(long.cap_usd, 0);
  } finally {
    await mock.close();
  }
});

test('401 от /v1/me/windows — ключ не принят, хотя профиль отвечает 200', async () => {
  const mock = await startSeloraUpstream({
    routes: { '/v1/me/windows': { code: 401, body: { error: 'unauthorized' } } },
  });
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
  } finally {
    await mock.close();
  }
});

test('getUsage без ключа → 401 unauthorized', async () => {
  const mock = await startSeloraUpstream();
  try {
    const provider = createSeloraProvider({ url: mock.url });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
  } finally {
    await mock.close();
  }
});

test('getModels: цены за 1M → input/output, признак 1M-контекста', async () => {
  const mock = await startSeloraUpstream();
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getModels('sk-gw-models-789');
    assert.equal(status, 200);
    assert.equal(mock.seen[0].url, '/v1/models');
    assert.equal(mock.seen[0].key, 'sk-gw-models-789');

    const [sonnet, gpt] = data.data;
    assert.equal(sonnet.id, 'anthropic/claude-sonnet-4.6');
    assert.equal(sonnet.display_name, 'Claude Sonnet 4.6');
    assert.equal(sonnet.access_tier, 'paid');
    assert.equal(sonnet.context_length, 1000000);
    assert.equal(sonnet.pricing.input, 0.25);
    assert.equal(sonnet.pricing.output, 1.25);
    // Без supports_1m_context контекст неизвестен
    assert.equal(gpt.context_length, null);
    assert.equal(gpt.pricing.input, 0.5);
  } finally {
    await mock.close();
  }
});

test('getModels: каталог открыт без ключа', async () => {
  const mock = await startSeloraUpstream();
  try {
    const provider = createSeloraProvider({ url: mock.url });
    const { status, data } = await provider.getModels();
    assert.equal(status, 200);
    assert.equal(data.data.length, 2);
    assert.equal(mock.seen[0].key, '');
  } finally {
    await mock.close();
  }
});

test('getModels: в ответе нет списка моделей → 502 bad_response', async () => {
  const mock = await startSeloraUpstream({ routes: { '/v1/models': { body: { foo: 1 } } } });
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getModels();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
  } finally {
    await mock.close();
  }
});

test('не-JSON ответ профиля → 502 bad_response с диагнозом upstream', async () => {
  const mock = await startSeloraUpstream({
    routes: { '/v1/me': { raw: 'not-json{{' } },
  });
  try {
    const provider = createSeloraProvider({ url: mock.url, apiKey: CONFIG_KEY });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    // В сообщении — HTTP-статус и content-type upstream
    assert.match(data.message, /HTTP 200, text\/plain/);
    // Запрос помечен как ожидающий JSON
    assert.equal(mock.seen[0].accept, 'application/json');
  } finally {
    await mock.close();
  }
});

test('ошибка сети → 502 provider_error', async () => {
  // Порт свободен: никто не слушает → connection refused
  const port = await getFreePort();
  const provider = createSeloraProvider({
    url: 'http://127.0.0.1:' + port,
    apiKey: CONFIG_KEY,
  });
  const { status, data } = await provider.getUsage();
  assert.equal(status, 502);
  assert.equal(data.error, 'provider_error');
});

test('не-JSON ответ логируется через log из config, а не в консоль', async () => {
  const warn = mock.method(console, 'warn');
  const logs = [];
  const mockUpstream = await startSeloraUpstream({
    routes: { '/v1/me': { raw: '<html>Request blocked by WAF</html>' } },
  });
  try {
    const provider = createSeloraProvider({
      url: mockUpstream.url,
      apiKey: CONFIG_KEY,
      log: (...args) => logs.push(args.join(' ')),
    });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    assert.match(logs[0], /\[Selora\] \/v1\/me: не-JSON ответ \(HTTP 200, text\/plain\):/);
    assert.match(logs[0], /Request blocked by WAF/);
    assert.equal(
      warn.mock.calls.filter((c) => c.arguments.join(' ').includes('[Selora]')).length,
      0,
    );
  } finally {
    warn.mock.restore();
    await mockUpstream.close();
  }
});

test('конфигурация: имя по умолчанию, слэш в URL, схема авторизации', () => {
  assert.equal(createSeloraProvider({}).name, 'Selora');
  assert.equal(createSeloraProvider({ name: 'Custom' }).name, 'Custom');
  assert.equal(createSeloraProvider({ url: 'http://x/' }).upstream, 'http://x');
  assert.equal(createSeloraProvider({}).upstream, 'https://api.selora.lol');
  assert.equal(createSeloraProvider({}).authScheme, 'x-api-key');
  assert.deepEqual(createSeloraProvider({ apiKey: 'k' }).buildHeaders('k'), {
    'x-api-key': 'k',
  });
  assert.deepEqual(createSeloraProvider({}).buildHeaders(''), {});
});
