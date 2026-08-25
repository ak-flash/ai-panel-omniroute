'use strict';

// Интеграционные тесты server.js: поднимается настоящий сервер
// (дочерний процесс) + mock-upstream. Реальный API xKiro не вызывается.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockUpstream, startPanel } = require('./helpers');

const ENV_KEY = 'env-test-key-123';

test('интеграция: /api/config, адаптеры, статика', async () => {
  const mock = await startMockUpstream();
  const panel = await startPanel({
    XKIRO_API_URL: mock.url,
    XKIRO_API_KEY: ENV_KEY,
  });
  try {
    // Конфиг: список провайдеров, активный — первый
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.ok, true);
    assert.equal(cfg.activeProvider, 'xkiro');
    assert.deepEqual(cfg.providers, [
      { id: 'xkiro', name: 'xKiro', hasKey: true },
    ]);
    // Ключ не должен утекать в конфиг
    assert.ok(!JSON.stringify(cfg).includes(ENV_KEY));

    // usage: сервер подставил ключ из .env
    const u1 = await (await fetch(panel.base + '/api/providers/xkiro/usage')).json();
    assert.equal(u1.plan, 'pro');
    assert.equal(u1._seenKey, ENV_KEY);

    // usage: клиентский ключ приоритетнее ключа из .env
    const u2 = await (await fetch(panel.base + '/api/providers/xkiro/usage', {
      headers: { 'x-api-key': 'client-key-456' },
    })).json();
    assert.equal(u2._seenKey, 'client-key-456');

    // models через адаптер
    const m = await (await fetch(panel.base + '/api/providers/xkiro/models')).json();
    assert.deepEqual(m.models, []);

    // Статика
    const html = await (await fetch(panel.base + '/')).text();
    assert.ok(html.includes('stats-provider'));
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('неизвестный провайдер в URL → 404', async () => {
  // Upstream не нужен: запрос отсекается до обращения к API
  const panel = await startPanel({});
  try {
    const res = await fetch(panel.base + '/api/providers/nope/usage');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'unknown_provider');
  } finally {
    await panel.stop();
  }
});

test('нет ключа ни в .env, ни у клиента → 401 от upstream доходит до клиента', async () => {
  const mock = await startMockUpstream({ requireKey: true });
  const panel = await startPanel({ XKIRO_API_URL: mock.url });
  try {
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.providers[0].hasKey, false);

    const res = await fetch(panel.base + '/api/providers/xkiro/usage');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('прокси: /proxy/<id>/… и легаси /proxy/…', async () => {
  const mock = await startMockUpstream();
  const panel = await startPanel({
    XKIRO_API_URL: mock.url,
    XKIRO_API_KEY: ENV_KEY,
  });
  try {
    // Прокси с указанием провайдера: префикс /proxy/xkiro отрезается,
    // сервер подставляет ключ из .env
    const p1 = await fetch(panel.base + '/proxy/xkiro/v1/usage');
    assert.equal(p1.status, 200);
    assert.equal((await p1.json())._seenKey, ENV_KEY);

    // Легаси-путь без id → активный провайдер
    const p2 = await fetch(panel.base + '/proxy/v1/usage');
    assert.equal(p2.status, 200);
    assert.equal((await p2.json())._seenKey, ENV_KEY);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('PROVIDERS без известных id: пустой список, /proxy → 503', async () => {
  const panel = await startPanel({ PROVIDERS: 'unknown-provider' });
  try {
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.deepEqual(cfg.providers, []);
    assert.equal(cfg.activeProvider, null);

    const res = await fetch(panel.base + '/proxy/v1/usage');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'no_provider');
  } finally {
    await panel.stop();
  }
});
