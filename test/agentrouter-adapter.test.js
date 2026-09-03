'use strict';

// Юнит-тесты фабрики адаптера AgentRouter (providers/agentrouter.js)
// против mock-upstream: путь, Authorization, формула квоты, ошибки.

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRouterProvider } = require('../providers/agentrouter');
const { startAgentRouterUpstream, getFreePort } = require('./helpers');

const TOKEN = 'pat-token-123';

test('getUsage: GET /api/user/self, Authorization, квота → баланс', async () => {
  const mock = await startAgentRouterUpstream();
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    // 41157471 / 500000 = 82.314942 → 82.31
    assert.equal(data.wallet.balance_usd, 82.31);
    assert.equal(data.plan, 'vip');
    assert.deepEqual(data.windows, []);
    // 908842529 / 500000 = 1817.685058 → 1817.69
    assert.equal(data.used_usd, 1817.69);
    assert.equal(data.requests, 7756);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0].url, '/api/user/self');
    assert.equal(mock.seen[0].auth, 'Bearer ' + TOKEN);
  } finally {
    await mock.close();
  }
});

// В профиле нет used_quota/request_count — поля просто нули
// (карточка на главной скроет их, а не покажет «NaN»)
test('нет used_quota/request_count → used_usd: 0, requests: 0', async () => {
  const mock = await startAgentRouterUpstream({
    body: {
      success: true,
      message: '',
      data: { id: 7, username: 'tester', group: 'vip', quota: 500000 },
    },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    assert.equal(data.wallet.balance_usd, 1);
    assert.equal(data.used_usd, 0);
    assert.equal(data.requests, 0);
  } finally {
    await mock.close();
  }
});

test('клиентский токен приоритетнее токена из config', async () => {
  const mock = await startAgentRouterUpstream();
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    await provider.getUsage('client-token-456');
    assert.equal(mock.seen[0].auth, 'Bearer client-token-456');
  } finally {
    await mock.close();
  }
});

test('401 мапится в unauthorized с подсказкой про access-токен', async () => {
  const mock = await startAgentRouterUpstream({
    code: 401,
    body: { success: false, message: '无权进行此操作，未登录且未提供 access token' },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
    assert.match(data.message, /System Access Token/);
    assert.match(data.message, /sk-…/);
  } finally {
    await mock.close();
  }
});

// Живой сайт на невалидный токен отвечает HTTP 200 + success:false,
// а не 401 (проверено curl-ом) — не путать это с «нет поля quota»
test('HTTP 200 + success:false (невалидный токен) → 401 unauthorized', async () => {
  const mock = await startAgentRouterUpstream({
    body: { message: '无权进行此操作，access token 无效', success: false },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: 'bad-token' });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
    // Короткое сообщение без китайского текста (тот — только в лог сервера)
    assert.match(data.message, /System Access Token/);
    assert.doesNotMatch(data.message, /无效/);
  } finally {
    await mock.close();
  }
});

test('в ответе нет quota → 502 bad_response', async () => {
  const mock = await startAgentRouterUpstream({
    body: { success: true, message: '', data: { id: 7, username: 'tester' } },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
  } finally {
    await mock.close();
  }
});

test('временный не-JSON ответ с HTTP 200 повторяется', async () => {
  const mock = await startAgentRouterUpstream({
    responses: [
      { raw: '<html>Checking your browser</html>', contentType: 'text/html' },
      { body: { success: true, data: { group: 'vip', quota: 500000 } } },
    ],
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 200);
    assert.equal(data.wallet.balance_usd, 1);
    assert.equal(mock.seen.length, 2);
    assert.equal(mock.seen[0].accept, 'application/json');
  } finally {
    await mock.close();
  }
});

test('постоянный не-JSON ответ → 502 после трёх попыток', async () => {
  const mock = await startAgentRouterUpstream({
    raw: '<html>502 Bad Gateway</html>',
    contentType: 'text/html',
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    assert.match(data.message, /HTTP 200, text\/html/);
    assert.equal(mock.seen.length, 3);
  } finally {
    await mock.close();
  }
});

test('не-JSON HTTP-ошибка не повторяется', async () => {
  const mock = await startAgentRouterUpstream({
    code: 503,
    raw: '<html>Service Unavailable</html>',
    contentType: 'text/html',
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    assert.match(data.message, /HTTP 503, text\/html/);
    assert.equal(mock.seen.length, 1);
  } finally {
    await mock.close();
  }
});

// Тело HTML-заглушки — только в консоль сервера (диагностика), в интерфейс
// панели попадает короткое сообщение со статусом и content-type
test('не-JSON ответ логируется в консоль сервера с телом заглушки', async () => {
  const warn = mock.method(console, 'warn');
  const upstream = await startAgentRouterUpstream({
    raw: '<html>Request blocked by WAF</html>',
    contentType: 'text/html',
  });
  try {
    const provider = createAgentRouterProvider({ url: upstream.url, apiKey: TOKEN });
    await provider.getUsage();
    const lines = warn.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(
      lines.some((l) => l.includes('/api/user/self') && l.includes('text/html') && l.includes('Request blocked by WAF')),
    );
  } finally {
    warn.mock.restore();
    await upstream.close();
  }
});

// В CLI вместо console.warn внедряется файловый логгер (src/main.js):
// все диагностические строки адаптера должны уходить в него
test('log из config используется вместо console.warn (включая отказ токена)', async () => {
  const warn = mock.method(console, 'warn');
  const logs = [];
  const upstream = await startAgentRouterUpstream({
    body: { message: '无权进行此操作，access token 无效', success: false },
  });
  try {
    const provider = createAgentRouterProvider({
      url: upstream.url,
      apiKey: 'bad-token',
      log: (...args) => logs.push(args.join(' ')),
    });
    await provider.getUsage();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[AgentRouter\] токен отклонён: 无权/);
    // Внедрённый log перехватил всё — в консоль адаптер не писал
    assert.equal(
      warn.mock.calls.filter((c) => c.arguments.join(' ').includes('[AgentRouter]')).length,
      0,
    );
  } finally {
    warn.mock.restore();
    await upstream.close();
  }
});

test('ошибка сети (upstream не отвечает) → 502 provider_error', async () => {
  const port = await getFreePort();
  const provider = createAgentRouterProvider({ url: 'http://127.0.0.1:' + port });
  const { status, data } = await provider.getUsage(TOKEN);
  assert.equal(status, 502);
  assert.equal(data.error, 'provider_error');
});

test('конфигурация: имя, upstream, схема авторизации', () => {
  const provider = createAgentRouterProvider({});
  assert.equal(provider.id, 'agentrouter');
  assert.equal(provider.name, 'AgentRouter');
  assert.equal(provider.upstream, 'https://agentrouter.org');
  assert.equal(provider.apiKey, '');
  assert.equal(provider.authScheme, 'authorization');
  assert.deepEqual(provider.buildHeaders('k'), { authorization: 'Bearer k' });
  assert.deepEqual(provider.buildHeaders(''), {});
});

// Новые версии new-api требуют вместе с токеном заголовок New-Api-User
// с числовым ID пользователя (анти-кража токенов; проверено на живом
// сайте: без него — 401 «未提供 New-Api-User»)
test('New-Api-User: ID уходит заголовком, приоритет аргумента над config', async () => {
  const mock = await startAgentRouterUpstream();
  try {
    const provider = createAgentRouterProvider({
      url: mock.url,
      apiKey: TOKEN,
      userId: '111',
    });
    await provider.getUsage();
    assert.equal(mock.seen[0].uid, '111');

    // ID из аргумента приоритетнее ID из config
    await provider.getUsage('', '222');
    assert.equal(mock.seen[1].uid, '222');

    // Без ID заголовок не отправляется
    const bare = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    await bare.getUsage();
    assert.equal(mock.seen[2].uid, '');
    assert.deepEqual(
      bare.buildHeaders('k', '  333  '),
      { authorization: 'Bearer k', 'new-api-user': '333' }
    );
  } finally {
    await mock.close();
  }
});

// Живой сайт: токен валиден, но ID не передан → подсказка про «User ID»
test('нет New-Api-User → подсказка про поле User ID', async () => {
  const mock = await startAgentRouterUpstream({
    body: { message: '无权进行此操作，未提供 New-Api-User', success: false },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
    assert.match(data.message, /User ID/);
  } finally {
    await mock.close();
  }
});

// Живой сайт: ID не совпадает с владельцем токена → своя подсказка
test('New-Api-User не совпал с токеном → подсказка про User ID', async () => {
  const mock = await startAgentRouterUpstream({
    body: { message: '无权进行此操作，与登录用户不匹配', success: false },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN, userId: '1' });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 401);
    assert.match(data.message, /не совпадает/);
  } finally {
    await mock.close();
  }
});

// ============================================================
// Каталог моделей: GET /api/user/models (этап 9, RFC-0001)
// ============================================================

test('getModels: GET /api/user/models, Authorization + New-Api-User', async () => {
  const mock = await startAgentRouterUpstream({
    routes: { '/api/user/models': { body: ['gpt-4o', 'claude-sonnet-4'] } },
  });
  try {
    const provider = createAgentRouterProvider({
      url: mock.url,
      apiKey: TOKEN,
      userId: '42',
    });
    const { status, data } = await provider.getModels('', '42');
    assert.equal(status, 200);
    assert.equal(mock.seen[0].url, '/api/user/models');
    assert.equal(mock.seen[0].auth, 'Bearer ' + TOKEN);
    assert.equal(mock.seen[0].uid, '42');
    assert.deepEqual(
      data.data.map((m) => m.id),
      ['gpt-4o', 'claude-sonnet-4'],
    );
    assert.equal(data.data[0].access_tier, 'paid');
  } finally {
    await mock.close();
  }
});

test('getModels: обёртка { data: [...] } и объекты с id нормализуются', async () => {
  const mock = await startAgentRouterUpstream({
    routes: {
      '/api/user/models': { body: { data: ['m1', { id: 'm2' }] } },
    },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getModels();
    assert.equal(status, 200);
    assert.deepEqual(data.data.map((m) => m.id), ['m1', 'm2']);
  } finally {
    await mock.close();
  }
});

test('getModels: 401 без заголовков → unauthorized с подсказкой', async () => {
  const mock = await startAgentRouterUpstream({
    routes: {
      '/api/user/models': {
        code: 401,
        body: { success: false, message: '无权进行此操作，未登录且未提供 access token' },
      },
    },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: '' });
    const { status, data } = await provider.getModels();
    assert.equal(status, 401);
    assert.equal(data.error, 'unauthorized');
    assert.match(data.message, /System Access Token/);
  } finally {
    await mock.close();
  }
});

test('getModels: не-JSON ответ → 502 bad_response', async () => {
  const mock = await startAgentRouterUpstream({
    routes: { '/api/user/models': { raw: '<html>blocked</html>' } },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getModels();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    assert.match(data.message, /HTTP 200, text\/plain/);
  } finally {
    await mock.close();
  }
});

test('getModels: неожидаемая форма ответа → 502 bad_response', async () => {
  const mock = await startAgentRouterUpstream({
    routes: {
      '/api/user/models': { body: { success: true, data: { nope: true } } },
    },
  });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getModels();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    assert.match(data.message, /нет списка моделей/);
  } finally {
    await mock.close();
  }
});
