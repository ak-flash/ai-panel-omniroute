'use strict';

// Google OAuth-клиент (providers/google-oauth.js): обмен кода,
// refresh по связке и best-effort email. Сеть не используется —
// эндпоинты подменены на локальный mock.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleOauth, buildAuthUrl } = require('../../providers/google-oauth');
const { startAgentRouterUpstream } = require('../helpers');

/** Ответ на POST токен-эндпоинта с произвольным JSON. */
function tokenEndpoint(code, body) {
  return async () => ({
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
  });
}

test('buildAuthUrl содержит все параметры окна авторизации', () => {
  const url = new URL(
    buildAuthUrl({ redirectUri: 'http://127.0.0.1:8765/cb', state: 'st-1', clientId: 'cid' })
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8765/cb');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'st-1');
  assert.match(url.searchParams.get('scope'), /cloud-platform/);
});

test('createGoogleOauth: адреса и client_id по умолчанию', () => {
  const oauth = createGoogleOauth({ clientId: 'built-in', clientSecret: 'secret' });
  assert.equal(oauth.url, 'https://oauth2.googleapis.com/token');
  assert.equal(oauth.userinfoUrl, 'https://www.googleapis.com/oauth2/v2/userinfo');
  assert.equal(oauth.clientId, 'built-in');
  assert.equal(oauth.clientSecret, 'secret');
  assert.match(
    oauth.buildAuthUrl({ redirectUri: 'http://x/cb', state: 's' }),
    /client_id=built-in/
  );
});

test('refresh без полного набора учётных данных — no_credentials', async () => {
  const oauth = createGoogleOauth({ log: () => {} });
  assert.deepEqual(await oauth.refresh(), { ok: false, error: 'no_credentials' });
  assert.deepEqual(await oauth.refresh({ refreshToken: 'r' }), {
    ok: false,
    error: 'no_credentials',
  });
  assert.deepEqual(await oauth.refresh({ refreshToken: 'r', clientId: 'c' }), {
    ok: false,
    error: 'no_credentials',
  });
});

test('refresh: успех, дефолтный expires_in и network-ошибка', async () => {
  const ok = createGoogleOauth({ url: 'http://x/token', log: () => {} });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = tokenEndpoint(200, { access_token: 'at-1', expires_in: 1200 });
    assert.deepEqual(await ok.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' }), {
      ok: true,
      accessToken: 'at-1',
      expiresIn: 1200,
    });

    globalThis.fetch = tokenEndpoint(200, { access_token: 'at-2' });
    const noExpiry = await ok.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' });
    assert.equal(noExpiry.expiresIn, 3600, 'без expires_in берётся час');

    // 400/401 — отозванный refresh-token
    globalThis.fetch = tokenEndpoint(400, { error: 'invalid_grant' });
    assert.deepEqual(await ok.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' }), {
      ok: false,
      error: 'invalid_grant',
    });

    // Прочие коды — общая ошибка OAuth
    globalThis.fetch = tokenEndpoint(500, { error: 'server_error' });
    assert.deepEqual(await ok.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' }), {
      ok: false,
      error: 'oauth_error',
    });

    // Ответ без access_token при 200
    globalThis.fetch = tokenEndpoint(200, { scope: 'x' });
    assert.deepEqual(await ok.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' }), {
      ok: false,
      error: 'oauth_error',
    });

    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    assert.deepEqual(await ok.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' }), {
      ok: false,
      error: 'network',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exchangeCode: обмен кода, без refresh_token и без кода/redirectUri', async () => {
  const oauth = createGoogleOauth({
    url: 'http://x/token',
    clientId: 'cid',
    clientSecret: 'csec',
    log: () => {},
  });
  assert.deepEqual(await oauth.exchangeCode({}), { ok: false, error: 'no_credentials' });
  assert.deepEqual(await oauth.exchangeCode({ code: 'c' }), { ok: false, error: 'no_credentials' });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = tokenEndpoint(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 900,
    });
    assert.deepEqual(
      await oauth.exchangeCode({ code: 'code-1', redirectUri: 'http://127.0.0.1:1/cb' }),
      { ok: true, accessToken: 'at', refreshToken: 'rt', expiresIn: 900 }
    );

    globalThis.fetch = tokenEndpoint(200, { access_token: 'at' });
    const noRefresh = await oauth.exchangeCode({ code: 'c', redirectUri: 'http://x/cb' });
    assert.equal(noRefresh.refreshToken, null);
    assert.equal(noRefresh.expiresIn, 3600);

    globalThis.fetch = tokenEndpoint(401, {});
    assert.deepEqual(await oauth.exchangeCode({ code: 'c', redirectUri: 'http://x/cb' }), {
      ok: false,
      error: 'invalid_grant',
    });

    globalThis.fetch = tokenEndpoint(503, {});
    assert.deepEqual(await oauth.exchangeCode({ code: 'c', redirectUri: 'http://x/cb' }), {
      ok: false,
      error: 'oauth_error',
    });

    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    assert.deepEqual(await oauth.exchangeCode({ code: 'c', redirectUri: 'http://x/cb' }), {
      ok: false,
      error: 'network',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getUserInfo: без токена, успех, ошибка ответа и сети', async () => {
  const mock = await startAgentRouterUpstream();
  const oauth = createGoogleOauth({
    userinfoUrl: mock.url + '/userinfo',
    log: () => {},
  });
  try {
    assert.deepEqual(await oauth.getUserInfo(), { ok: false, error: 'no_token' });

    // Сеть недоступна после остановки mock — network
    await mock.close();
    assert.deepEqual(await oauth.getUserInfo({ accessToken: 'at' }), {
      ok: false,
      error: 'network',
    });
  } finally {
    await mock.close();
  }
});

test('getUserInfo: email из ответа userinfo', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ email: 'user@example.com' }),
    });
    const oauth = createGoogleOauth({ userinfoUrl: 'http://x/userinfo', log: () => {} });
    assert.deepEqual(await oauth.getUserInfo({ accessToken: 'at' }), {
      ok: true,
      email: 'user@example.com',
    });

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    assert.deepEqual(await oauth.getUserInfo({ accessToken: 'at' }), {
      ok: false,
      error: 'userinfo_error',
    });

    // Не-JSON ответ не роняет вызывающего
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    });
    assert.deepEqual(await oauth.getUserInfo({ accessToken: 'at' }), {
      ok: false,
      error: 'userinfo_error',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('логгер клиента нормализован: принимается и функция, и объект', async () => {
  const originalFetch = globalThis.fetch;
  const lines = [];
  try {
    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    const asFunction = createGoogleOauth({ log: line => lines.push(['fn', line]) });
    await asFunction.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' });
    assert.equal(lines.length, 1);
    assert.match(lines[0][1], /refresh: сеть\/таймаут/);

    const asObject = createGoogleOauth({ log: { warn: line => lines.push(['obj', line]) } });
    await asObject.exchangeCode({ code: 'c', redirectUri: 'http://x/cb' });
    assert.match(lines[1][1], /exchangeCode: сеть\/таймаут/);

    // Объект-логгер: вызов без уровня уходит в warn
    const asObject2 = createGoogleOauth({ log: { warn: line => lines.push(['obj2', line]) } });
    await asObject2.getUserInfo({ accessToken: 'at' });
    await asObject2.refresh({ refreshToken: 'r', clientId: 'c', clientSecret: 's' });
    assert.equal(lines[2][0], 'obj2');
    assert.match(lines[2][1], /getUserInfo: сеть\/таймаут/);
    assert.match(lines[3][1], /refresh: сеть\/таймаут/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
