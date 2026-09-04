'use strict';

// Интеграционные тесты server.js: панель поднимается in-process
// (createApp), адаптеры смотрят на mock-upstream. Реальный API xKiro
// не вызывается; ключ всегда присылает клиент (env не используется).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockUpstream, startAgentRouterUpstream, startPanel, startServerProcess } = require('./helpers');
const { createStore } = require('../src/compat/store');
const { WRITABLE_KEYS } = require('../src/routes/config');
const { STORE_KEYS } = require('../src/store');

const CLIENT_KEY = 'client-key-456';
const STORED_TOKEN = 'stored-agentrouter-token';
const STORED_USER_ID = '49521';

test('WRITABLE_KEYS маршрута — подмножество STORE_KEYS хранилища', () => {
  // Дрейф этих двух списков ломает PUT /api/config: ключ проходит
  // route-allowlist, но отвергается хранилищем (unknown_key → 500).
  for (const key of WRITABLE_KEYS) {
    assert.ok(
      STORE_KEYS.includes(key),
      `ключ «${key}» есть в WRITABLE_KEYS, но отсутствует в STORE_KEYS`
    );
  }
});

test('PUT /api/config: частичная запись ключей и чтение назад', async () => {
  const panel = await startPanel();
  try {
    const put = await fetch(panel.base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dlgTab: 'dlg-tab-notifications',
        notificationThresholds: '{"xkiro":{"short_window_pct":80}}',
        agentrouterUserId: '49521',
      }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true });

    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.data.dlgTab, 'dlg-tab-notifications');
    assert.equal(cfg.data.notificationThresholds, '{"xkiro":{"short_window_pct":80}}');
    assert.equal(cfg.data.agentrouterUserId, '49521');
  } finally {
    await panel.stop();
  }
});

test('HTTP boundary: request ID, malformed JSON и безопасные ошибки', async () => {
  const logs = [];
  const panel = await startPanel({ logger: { error: (event, fields) => logs.push({ event, fields }) } });
  try {
    const badJson = await fetch(panel.base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(badJson.status, 400);
    assert.ok(badJson.headers.get('x-request-id'));
    const badBody = await badJson.json();
    assert.equal(badBody.error, 'bad_json');
    assert.equal(badBody.requestId, badJson.headers.get('x-request-id'));

    const wrongMethod = await fetch(panel.base + '/api/health', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error, 'method_not_allowed');

    const oversized = await fetch(panel.base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(2 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error, 'payload_too_large');

    assert.ok(logs.every(({ fields }) => !JSON.stringify(fields).includes('Unexpected token')));
  } finally {
    await panel.stop();
  }
});

test('security: same-origin, headers и write-only config', async () => {
  const store = await createStore({ memory: true });
  await store.set('xkiroKey', 'secret-xkiro');
  await store.set('omniKey', 'secret-omni');
  await store.set('omniUrl', 'https://omniroute.example/api');
  const panel = await startPanel({ store });
  try {
    const forbidden = await fetch(panel.base + '/api/config', { headers: { origin: 'https://evil.example' } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get('access-control-allow-origin'), null);

    const response = await fetch(panel.base + '/api/config');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const text = await response.text();
    assert.ok(!text.includes('secret-xkiro'));
    assert.ok(!text.includes('secret-omni'));
    const config = JSON.parse(text);
    assert.equal(config.data.hasXkiroKey, true);
    assert.equal(config.data.hasOmniKey, true);
    assert.equal(config.data.omniUrl, 'https://omniroute.example/api');

    const oldVault = await fetch(panel.base + '/api/settings/vault');
    assert.equal(oldVault.status, 404);
  } finally {
    await panel.stop();
  }
});

test('security: OmniRoute URL берётся с сервера, клиентский URL игнорируется', async () => {
  const mock = await startMockUpstream({ requireKey: false });
  const store = await createStore({ memory: true });
  await store.set('omniUrl', mock.url);
  await store.set('omniKey', 'server-omni-key');
  const panel = await startPanel({ store });
  try {
    const response = await fetch(panel.base + '/omniroute/v1/usage', {
      headers: { 'x-omniroute-url': 'http://169.254.169.254', authorization: 'Bearer client-key' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plan, 'pro');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('security: PUT через /omniroute с loopback Origin проходит при настроенном PUBLIC_ORIGIN', async () => {
  // Регрессия: панель за reverse proxy (PUBLIC_ORIGIN), но локальный
  // браузер шлёт PUT с Origin http://127.0.0.1:<port> — раньше это
  // отбивалось 403 origin_forbidden (combo drag-and-drop не сохранялся)
  const mock = await startMockUpstream({ requireKey: false });
  const store = await createStore({ memory: true });
  await store.set('omniUrl', mock.url);
  await store.set('omniKey', 'server-omni-key');
  const panel = await startPanel({ store, publicOrigin: 'https://panel.example' });
  try {
    const response = await fetch(panel.base + '/omniroute/v1/usage', {
      method: 'PUT',
      headers: { origin: panel.base, 'content-type': 'application/json' },
      body: JSON.stringify({ models: [] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plan, 'pro');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('сохранение с пустыми полями секретов не затирает сохранённые ключи', async () => {
  const panel = await startPanel();
  try {
    const put = (body) => fetch(panel.base + '/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Пользователь установил ключи
    const setup = await put({
      xkiroKey: 'sk-live-1',
      agentrouterKey: 'ar-live-1',
      agentrouterUserId: '49521',
      omniKey: 'omni-live-1',
      omniUrl: 'http://127.0.0.1:1',
    });
    assert.equal(setup.status, 200);

    // Диалог при пустых полях секретов шлёт только несекретные поля
    // (agentrouterUserId/omniUrl заполняются из хранилища при открытии)
    const res = await put({ agentrouterUserId: '49521', omniUrl: 'http://127.0.0.1:1' });
    assert.equal(res.status, 200);

    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.data.hasXkiroKey, true);
    assert.equal(cfg.data.hasAgentrouterKey, true);
    assert.equal(cfg.data.hasOmniKey, true);
    assert.equal(cfg.data.hasOmniRoute, true);
    assert.equal(cfg.data.agentrouterUserId, '49521');

    // Явная очистка пустой строкой продолжает работать («Удалить ключ»)
    assert.equal((await put({ xkiroKey: '' })).status, 200);
    const after = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(after.data.hasXkiroKey, false);
    assert.equal(after.data.hasAgentrouterKey, true);
  } finally {
    await panel.stop();
  }
});

test('интеграция: /api/config, адаптеры, статика', async () => {
  const mock = await startMockUpstream();
  const panel = await startPanel({ upstream: mock.url });
  try {
    // Конфиг: список провайдеров, активный — первый
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.equal(cfg.ok, true);
    assert.equal(cfg.activeProvider, 'xkiro');
    assert.deepEqual(cfg.providers, [
      { id: 'xkiro', name: 'xKiro', site: 'https://xkiro.com/dashboard', hasKey: false },
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

test('agentrouter: ключ и User ID из хранилища уходят адаптеру, hasKey в /api/config', async () => {
  const { createAgentRouterProvider } = require('../providers/agentrouter');
  const { createStore } = require('../src/compat/store');
  const mock = await startAgentRouterUpstream();
  const store = await createStore({ memory: true });
  await store.set('agentrouterKey', STORED_TOKEN);
  await store.set('agentrouterUserId', STORED_USER_ID);
  const panel = await startPanel({
    providers: [createAgentRouterProvider({ url: mock.url })],
    store,
  });
  try {
    // hasKey — по полю хранилища (STORE_KEYS), не по apiKey адаптера
    const cfg = await (await fetch(panel.base + '/api/config')).json();
    assert.deepEqual(cfg.providers, [
      { id: 'agentrouter', name: 'AgentRouter', site: 'https://agentrouter.org', hasKey: true },
    ]);

    // usage без x-api-key: сервер подставляет ключ из хранилища и
    // адаптер шлёт его upstream как Authorization: Bearer + New-Api-User
    const res = await fetch(panel.base + '/api/providers/agentrouter/usage');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.wallet.balance_usd, 82.31);
    assert.equal(mock.seen[0].auth, 'Bearer ' + STORED_TOKEN);
    assert.equal(mock.seen[0].uid, STORED_USER_ID);

    // Заголовки клиента приоритетнее хранилища
    const res2 = await fetch(panel.base + '/api/providers/agentrouter/usage', {
      headers: { 'x-api-key': 'client-token', 'x-agentrouter-user-id': '999' },
    });
    assert.equal(res2.status, 200);
    assert.equal(mock.seen[1].auth, 'Bearer client-token');
    assert.equal(mock.seen[1].uid, '999');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('agentrouter: разовый снимок баланса дня сохраняется и уходит в usage', async () => {
  const { createAgentRouterProvider } = require('../providers/agentrouter');
  const { createStore } = require('../src/compat/store');
  const mock = await startAgentRouterUpstream();
  const store = await createStore({ memory: true });
  await store.set('agentrouterKey', STORED_TOKEN);
  await store.set('agentrouterUserId', STORED_USER_ID);
  const panel = await startPanel({
    providers: [createAgentRouterProvider({ url: mock.url })],
    store,
  });
  try {
    // Снимок ещё не снят — usage без day_balance_usd
    let data = await (await fetch(panel.base + '/api/providers/agentrouter/usage')).json();
    assert.equal('day_balance_usd' in data, false);

    // Ручной разовый снимок (как это делает планировщик в 00:00)
    await panel.app.snapshotAgentRouterDayBalance();
    const now = new Date();
    const saved = JSON.parse(await store.get('agentrouterDayBalance'));
    assert.equal(
      saved.date,
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'),
    );
    assert.equal(saved.balance_usd, 82.31);

    // Теперь usage отдаёт стартовый баланс дня
    data = await (await fetch(panel.base + '/api/providers/agentrouter/usage')).json();
    assert.equal(data.day_balance_usd, 82.31);
    assert.equal(data.wallet.balance_usd, 82.31);
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
    // Состав вшитых провайдеров; hasKey зависит от реального data/store.db
    // (пользовательского), поэтому проверяем только тип
    assert.deepEqual(
      cfg.providers.map((p) => ({ id: p.id, name: p.name })),
      [
        { id: 'xkiro', name: 'xKiro' },
        { id: 'agentrouter', name: 'AgentRouter' },
      ]
    );
    assert.ok(cfg.providers.every((p) => typeof p.hasKey === 'boolean'));
  } finally {
    await panel.stop();
  }
});
