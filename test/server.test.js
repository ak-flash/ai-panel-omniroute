'use strict';

// Интеграционные тесты server.js: панель поднимается in-process
// (createApp), адаптеры смотрят на mock-upstream. Реальный API xKiro
// не вызывается; ключ всегда присылает клиент (env не используется).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockUpstream, startPanel, startServerProcess } = require('./helpers');

const CLIENT_KEY = 'client-key-456';

test('интеграция: /api/config, адаптеры, статика', async () => {
  const mock = await startMockUpstream();
  const panel = await startPanel({ upstream: mock.url });
  try {
    // Конфиг: список провайдеров, активный — первый
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.ok, true);
    assert.equal(cfg.activeProvider, 'xkiro');
    assert.deepEqual(cfg.providers, [
      { id: 'xkiro', name: 'xKiro', hasKey: false },
    ]);

    // usage: ключ присылает клиент
    const u = await (await fetch(panel.base + '/api/providers/xkiro/usage', {
      headers: { 'x-api-key': CLIENT_KEY },
    })).json();
    assert.equal(u.plan, 'pro');
    assert.equal(u._seenKey, CLIENT_KEY);

    // models через адаптер
    const m = await (await fetch(panel.base + '/api/providers/xkiro/models', {
      headers: { 'x-api-key': CLIENT_KEY },
    })).json();
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
  const panel = await startPanel();
  try {
    const res = await fetch(panel.base + '/api/providers/nope/usage');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'unknown_provider');
  } finally {
    await panel.stop();
  }
});

test('нет ключа у клиента → 401 от upstream доходит до клиента', async () => {
  const mock = await startMockUpstream({ requireKey: true });
  const panel = await startPanel({ upstream: mock.url });
  try {
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
  const panel = await startPanel({ upstream: mock.url });
  try {
    // Прокси с указанием провайдера: префикс /proxy/xkiro отрезается,
    // клиентский x-api-key пробрасывается upstream как есть
    const p1 = await fetch(panel.base + '/proxy/xkiro/v1/usage', {
      headers: { 'x-api-key': CLIENT_KEY },
    });
    assert.equal(p1.status, 200);
    assert.equal((await p1.json())._seenKey, CLIENT_KEY);

    // Легаси-путь без id → активный провайдер
    const p2 = await fetch(panel.base + '/proxy/v1/usage', {
      headers: { 'x-api-key': CLIENT_KEY },
    });
    assert.equal(p2.status, 200);
    assert.equal((await p2.json())._seenKey, CLIENT_KEY);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('CLI: node server.js поднимается и отдаёт /api/config', async () => {
  const panel = await startServerProcess();
  try {
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.ok, true);
    assert.equal(cfg.activeProvider, 'xkiro');
    assert.deepEqual(cfg.providers, [
      { id: 'xkiro', name: 'xKiro', hasKey: false },
    ]);
  } finally {
    await panel.stop();
  }
});
