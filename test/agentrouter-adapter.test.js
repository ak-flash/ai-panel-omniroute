'use strict';

// Юнит-тесты фабрики адаптера AgentRouter (providers/agentrouter.js)
// против mock-upstream: путь, Authorization, формула квоты, ошибки.

const test = require('node:test');
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

test('не-JSON ответ → 502 bad_response с диагнозом upstream', async () => {
  const mock = await startAgentRouterUpstream({ raw: '<html>502 Bad Gateway</html>' });
  try {
    const provider = createAgentRouterProvider({ url: mock.url, apiKey: TOKEN });
    const { status, data } = await provider.getUsage();
    assert.equal(status, 502);
    assert.equal(data.error, 'bad_response');
    // В сообщении — HTTP-статус и content-type upstream (диагностика
    // HTML-заглушек защиты вроде Cloudflare без доступа к серверу)
    assert.match(data.message, /HTTP 200, text\/plain/);
    // Запрос помечен как ожидающий JSON
    assert.equal(mock.seen[0].accept, 'application/json');
  } finally {
    await mock.close();
  }
});

test('ошибка сети (upstream не отвечает) → 502 provider_error', async () => {
  const port = await getFreePort();
  const provider = createAgentRouterProvider({ url: 'http://127.0.0.1:' + port });
  const { status, data } = await provider.getUsage(TOKEN);
  assert.equal(status, 502);
  assert.equal(data.error, 'provider_error');
});

test('конфигурация: имя, upstream, схема авторизации; getModels → 501', async () => {
  const provider = createAgentRouterProvider({});
  assert.equal(provider.id, 'agentrouter');
  assert.equal(provider.name, 'AgentRouter');
  assert.equal(provider.upstream, 'https://agentrouter.org');
  assert.equal(provider.apiKey, '');
  assert.equal(provider.authScheme, 'authorization');
  assert.deepEqual(provider.buildHeaders('k'), { authorization: 'Bearer k' });
  assert.deepEqual(provider.buildHeaders(''), {});

  const { status, data } = await provider.getModels();
  assert.equal(status, 501);
  assert.equal(data.error, 'not_implemented');
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
