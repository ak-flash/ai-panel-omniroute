'use strict';

// Тесты квот Antigravity: mock Google upstream (fetchAvailableModels),
// панель in-process с инъекцией адаптера на mock-адрес. Реальный
// cloudcode-pa.googleapis.com не вызывается.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { json, startPanel } = require('./helpers');
const { createAntigravityProvider } = require('../providers/antigravity');
const { createGoogleOauth } = require('../providers/google-oauth');

const TOKEN = 'test-google-oauth-token';
const UA = 'vscode/1.96.0 (Antigravity/4.3.0)';

/**
 * Mock Google internal API.
 * Опции: status / body — ответ на :fetchAvailableModels; seen — лог запросов.
 * По умолчанию отвечает 200 с двумя моделями Claude.
 */
async function startMockGoogle(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({
        url: req.url,
        method: req.method,
        auth: req.headers['authorization'] || '',
        ua: req.headers['user-agent'] || '',
        body,
      });
      // Групповые квоты: по умолчанию 404 (окна просто опускаются),
      // чтобы не менять счётчики запросов в старых тестах
      if (req.url.includes('retrieveUserQuotaSummary')) {
        if (opts.summaryBody !== undefined || opts.summaryStatus !== undefined) {
          return json(res, opts.summaryStatus || 200,
            opts.summaryBody !== undefined ? opts.summaryBody : { groups: [] });
        }
        return json(res, 404, { error: 'not_found' });
      }
      if (opts.status === undefined || opts.status === 200) {
        return json(res, 200, opts.body || {
          models: {
            'claude-opus-4-6-thinking': {
              quotaInfo: { remainingFraction: 0.83, resetTime: '2026-08-27T09:00:00Z' },
              displayName: 'Claude Opus 4.6 (Thinking)',
              supportsThinking: true,
            },
            'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 1.0 } },
          },
          deprecatedModelIds: {},
        });
      }
      json(res, opts.status || 200, opts.body || {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    url,
    seen,
    close: () =>
      new Promise((done) => {
        server.closeIdleConnections();
        server.close(done);
      }),
  };
}

/** Панель с antigravity-адаптером на mock + токен уже задан. */
async function startWithMock(mock, project = '', oauth) {
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
    googleOauth: oauth || createGoogleOauth(),
  });
  const res = await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, project }),
  });
  assert.equal(res.status, 200);
  return panel;
}

/** Mock OAuth-эндпоинта Google (oauth2.googleapis.com/token). */
async function startMockOauth(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(Object.fromEntries(new URLSearchParams(body)));
      if (opts.status && opts.status !== 200) {
        return json(res, opts.status, opts.body || { error: 'invalid_grant' });
      }
      json(res, 200, { access_token: opts.accessToken || 'refreshed-token', expires_in: 3600 });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    seen,
    close: () => new Promise((done) => { server.closeIdleConnections(); server.close(done); }),
  };
}

/** Только основные вызовы квот (без retrieveUserQuotaSummary). */
function modelCalls(mock) {
  return mock.seen.filter((s) => s.url.includes('fetchAvailableModels'));
}

/** Задаёт только refresh-связку (без access-token). */
async function setRefreshOnly(panel) {
  const res = await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '', refreshToken: 'rt-123', clientId: 'cid', clientSecret: 'csec' }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('нет токена на сервере → 400 no_token', async () => {
  const mock = await startMockGoogle();
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
  });
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'no_token');
    assert.equal(mock.seen.length, 0); // в Google не ходим
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('успех: прокси до Google, заголовки и очищенный JSON', async () => {
  const mock = await startMockGoogle();
  const panel = await startWithMock(mock);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 200);
    const data = await res.json();

    // Запрос к Google: Bearer-токен, обязательный User-Agent, пустое тело {}
    assert.equal(modelCalls(mock).length, 1);
    const call = modelCalls(mock)[0];
    assert.equal(call.url, '/v1internal:fetchAvailableModels');
    assert.equal(call.method, 'POST');
    assert.equal(call.auth, 'Bearer ' + TOKEN);
    assert.equal(call.ua, UA);
    assert.deepEqual(JSON.parse(call.body), {});

    // Очищенный ответ: remainingFraction, resetTime, displayName
    assert.equal(data.models.length, 2);
    const opus = data.models.find((m) => m.id === 'claude-opus-4-6-thinking');
    assert.equal(opus.displayName, 'Claude Opus 4.6 (Thinking)');
    assert.equal(opus.remainingFraction, 0.83);
    assert.equal(opus.resetTime, '2026-08-27T09:00:00Z');
    assert.equal(opus.supportsThinking, true);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('project из настроек уходит в тело запроса', async () => {
  const mock = await startMockGoogle();
  const panel = await startWithMock(mock, 'my-project-id');
  try {
    await fetch(panel.base + '/api/antigravity-quota');
    assert.deepEqual(modelCalls(mock).map((c) => JSON.parse(c.body)), [{ project: 'my-project-id' }]);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('403 с project → повтор с {} → успех (fallback)', async () => {
  // Mock отвечает 403 только на запросы с project в теле
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.includes('retrieveUserQuotaSummary')) {
        return json(res, 404, { error: 'not_found' });
      }
      seen.push(body);
      if (JSON.parse(body || '{}').project) return json(res, 403, { error: 'forbidden' });
      return json(res, 200, { models: { 'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 1 } } } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;

  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url }),
  });
  await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, project: 'p1' }),
  });

  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 200);
    assert.deepEqual(seen.map((b) => JSON.parse(b)), [{ project: 'p1' }, {}]);
  } finally {
    await panel.stop();
    await new Promise((done) => { server.closeIdleConnections(); server.close(done); });
  }
});

test('403 без project → project_required', async () => {
  const mock = await startMockGoogle({ status: 403, body: { error: 'forbidden' } });
  const panel = await startWithMock(mock);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'project_required');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('401 от Google → token_expired', async () => {
  const mock = await startMockGoogle({ status: 401, body: { error: 'unauthorized' } });
  const panel = await startWithMock(mock);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'token_expired');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('429 от Google → rate_limited', async () => {
  const mock = await startMockGoogle({ status: 429, body: { error: 'quota' } });
  const panel = await startWithMock(mock);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, 'rate_limited');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('кеш 60 с: повторный запрос не бьёт в Google', async () => {
  const mock = await startMockGoogle();
  const panel = await startWithMock(mock);
  try {
    const r1 = await fetch(panel.base + '/api/antigravity-quota');
    const r2 = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(modelCalls(mock).length, 1);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('новый токен сбрасывает кеш', async () => {
  const mock = await startMockGoogle();
  const panel = await startWithMock(mock);
  try {
    await fetch(panel.base + '/api/antigravity-quota');
    await fetch(panel.base + '/api/settings/google-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'other-token' }),
    });
    await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(modelCalls(mock).length, 2);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('токен не попадает в ответы и логи сервера', async () => {
  const logs = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    // Ошибочный upstream — чтобы проверить именно путь ошибок
    const mock = await startMockGoogle({ status: 401, body: { error: 'unauthorized' } });
    const panel = await startWithMock(mock);
    try {
      const res = await fetch(panel.base + '/api/antigravity-quota');
      const text = await res.text();
      assert.ok(!text.includes(TOKEN), 'токен утёк в ответ клиенту');

      // GET статуса тоже не отдаёт сам токен
      const st = await fetch(panel.base + '/api/settings/google-token');
      assert.ok(!(await st.text()).includes(TOKEN));
    } finally {
      await panel.stop();
      await mock.close();
    }
    for (const line of logs) {
      assert.ok(!line.includes(TOKEN), 'токен утёк в логи: ' + line);
    }
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
});

test('сеть недоступна → 502 provider_error', async () => {
  // Адрес-заглушка: соединение отклоняется
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: 'http://127.0.0.1:1' }),
  });
  await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'provider_error');
  } finally {
    await panel.stop();
  }
});

/* ---------- фаза 2: refresh-token flow ---------- */

test('только refresh-связка: автообновление перед запросом квот', async () => {
  const mock = await startMockGoogle();
  const oauth = await startMockOauth({ accessToken: 'fresh-token' });
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
    googleOauth: createGoogleOauth({ url: oauth.url }),
  });
  const saved = await setRefreshOnly(panel);
  assert.equal(saved.hasRefresh, true);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 200);

    // OAuth: grant_type=refresh_token и все креденшелы ушли в Google OAuth
    assert.equal(oauth.seen.length, 1);
    assert.equal(oauth.seen[0].grant_type, 'refresh_token');
    assert.equal(oauth.seen[0].refresh_token, 'rt-123');
    assert.equal(oauth.seen[0].client_id, 'cid');
    assert.equal(oauth.seen[0].client_secret, 'csec');

    // В Google ушёл уже обновлённый токен
    assert.equal(mock.seen[0].auth, 'Bearer fresh-token');
  } finally {
    await panel.stop();
    await mock.close();
    await oauth.close();
  }
});

test('401 от Google → refresh → повторный запрос успешен', async () => {
  // Mock отвечает 401 на старый токен, 200 — на обновлённый
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.includes('retrieveUserQuotaSummary')) return json(res, 200, { groups: [] });
      seen.push(req.headers['authorization']);
      if (req.headers['authorization'] === 'Bearer ' + TOKEN) {
        return json(res, 401, { error: 'unauthorized' });
      }
      json(res, 200, { models: { 'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.5 } } } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mockUrl = 'http://127.0.0.1:' + server.address().port;
  const oauth = await startMockOauth({ accessToken: 'fresh-token' });

  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mockUrl }),
    googleOauth: createGoogleOauth({ url: oauth.url }),
  });
  await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, refreshToken: 'rt', clientId: 'cid', clientSecret: 'csec' }),
  });

  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 200);
    assert.equal(oauth.seen.length, 1); // одно обновление
    // Два захода в Google: старый токен (401) и обновлённый (200)
    assert.deepEqual(seen, ['Bearer ' + TOKEN, 'Bearer fresh-token']);
  } finally {
    await panel.stop();
    await new Promise((done) => { server.closeIdleConnections(); server.close(done); });
    await oauth.close();
  }
});

test('refresh отозван (invalid_grant) → 401 token_expired', async () => {
  const mock = await startMockGoogle();
  const oauth = await startMockOauth({ status: 400, body: { error: 'invalid_grant' } });
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
    googleOauth: createGoogleOauth({ url: oauth.url }),
  });
  await setRefreshOnly(panel);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'token_expired');
    assert.equal(mock.seen.length, 0); // в Google с битым токеном не ходим
  } finally {
    await panel.stop();
    await mock.close();
    await oauth.close();
  }
});

test('групповые окна weekly/5h попадают в ответ (худший остаток)', async () => {
  const mock = await startMockGoogle({
    summaryBody: {
      groups: [
        { buckets: [
          { windowSize: '5h', remainingFraction: 0.9, resetTime: '2026-08-27T12:00:00Z' },
          { windowSize: '5h', remainingFraction: 0.4, resetTime: '2026-08-27T12:00:00Z' },
        ] },
        { buckets: [{ windowSize: 'WEEKLY', remainingFraction: 0.7 }] },
        { buckets: [{ windowSize: 'WEEKLY', remainingFraction: null }] }, // игнорируется
      ],
    },
  });
  const panel = await startWithMock(mock);
  try {
    const data = await (await fetch(panel.base + '/api/antigravity-quota')).json();
    assert.deepEqual(data.windows, [
      { windowSize: '5h', remainingFraction: 0.4, resetTime: '2026-08-27T12:00:00Z' },
      { windowSize: 'weekly', remainingFraction: 0.7, resetTime: null },
    ]);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('ошибка retrieveUserQuotaSummary не ломает основной ответ', async () => {
  const mock = await startMockGoogle({ summaryStatus: 500, summaryBody: {} });
  const panel = await startWithMock(mock);
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.models.length, 2);
    assert.equal(data.windows, undefined);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('секреты refresh-связки не возвращаются клиенту', async () => {
  const mock = await startMockGoogle();
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
  });
  await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, refreshToken: 'rt-secret', clientId: 'cid-x', clientSecret: 'csec-y' }),
  });
  try {
    const st = await fetch(panel.base + '/api/settings/google-token');
    const text = await st.text();
    for (const secret of ['rt-secret', 'cid-x', 'csec-y']) {
      assert.ok(!text.includes(secret), 'секрет утёк: ' + secret);
    }
    assert.deepEqual(JSON.parse(text), { hasToken: true, hasRefresh: true, tokenExpiresAt: null });
  } finally {
    await panel.stop();
    await mock.close();
  }
});

/* ---------- OAuth login-flow (кнопка «Войти через Google») ---------- */

test('start: ссылка Google с вшитым client_id и loopback redirect_uri', async () => {
  const mock = await startMockGoogle();
  // client_id/secret берутся из окружения — подставляем фикстурные значения,
  // чтобы не коммитить реальные (и не триггерить push-protection).
  const prevId = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
  });
  try {
    const res = await fetch(panel.base + '/api/antigravity-auth/start');
    assert.equal(res.status, 200);
    const { url } = await res.json();
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
    const params = new URL(url).searchParams;
    assert.equal(params.get('client_id'), 'test-google-client-id.apps.googleusercontent.com');
    assert.equal(params.get('response_type'), 'code');
    assert.equal(params.get('access_type'), 'offline');
    assert.equal(params.get('prompt'), 'consent');
    assert.ok(params.get('scope').includes('cloud-platform'));
    // redirect_uri — loopback этого же сервера
    const redirect = new URL(params.get('redirect_uri'));
    assert.equal(redirect.hostname, '127.0.0.1');
    assert.equal(redirect.pathname, '/api/antigravity-auth/callback');
    assert.equal(redirect.port, new URL(panel.base).port);
    assert.ok(params.get('state'));
  } finally {
    if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
    await panel.stop();
    await mock.close();
  }
});

test('callback: страница-подсказка без обмена токенов и без авто-закрытия', async () => {
  const mock = await startMockGoogle();
  let exchanged = 0;
  const oauthMock = {
    refresh: async () => ({ ok: false, error: 'no_credentials' }),
    buildAuthUrl: ({ state }) =>
      'https://accounts.google.com/o/oauth2/v2/auth?state=' + state,
    exchangeCode: async () => { exchanged++; return { ok: false, error: 'invalid_grant' }; },
  };
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
    googleOauth: oauthMock,
  });
  try {
    // Любой state (даже чужой/случайный) → 200, страница с подсказкой
    const res = await fetch(panel.base + '/api/antigravity-auth/callback?code=abc&state=whatever');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('адрес'));      // инструкция: скопировать адрес
    assert.ok(!text.includes('window.close')); // страница не закрывается сама
    // Обмен кода не выполнялся, токены не сохранены
    assert.equal(exchanged, 0);
    const st = await (await fetch(panel.base + '/api/settings/google-token')).json();
    assert.equal(st.hasToken, false);
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('paste: ссылка callback обменивается с её же redirect_uri', async () => {
  const mock = await startMockGoogle();
  let seenExchange = null;
  const oauthMock = {
    refresh: async () => ({ ok: false, error: 'no_credentials' }),
    buildAuthUrl: ({ state }) => 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state,
    exchangeCode: async (args) => {
      seenExchange = args;
      return { ok: true, accessToken: 'pasted-token', refreshToken: 'rt-paste', expiresIn: 3600 };
    },
  };
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
    googleOauth: oauthMock,
  });
  try {
    // Ссылка от чужого флоу (OmniRoute): другой порт и путь /callback
    const res = await fetch(panel.base + '/api/antigravity-auth/paste', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: 'http://127.0.0.1:20128/callback?state=s_x&code=4%2F0ABC&scope=email&authuser=0',
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { ok: true, hasToken: true, hasRefresh: true });

    // Обмен выполнен с тем же origin+path, что в ссылке; hash/прочее отброшено
    assert.equal(seenExchange.redirectUri, 'http://127.0.0.1:20128/callback');
    assert.equal(seenExchange.code, '4/0ABC');

    // Токены сохранены и работают
    const quota = await fetch(panel.base + '/api/antigravity-quota');
    assert.equal(quota.status, 200);
    assert.equal(modelCalls(mock)[0].auth, 'Bearer pasted-token');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('paste: не-ссылка или ссылка без code → 400', async () => {
  const mock = await startMockGoogle();
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
  });
  try {
    for (const bad of ['не ссылка', 'http://127.0.0.1:20128/callback', '']) {
      const res = await fetch(panel.base + '/api/antigravity-auth/paste', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: bad }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'bad_callback_url');
    }
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('start: Host без порта → redirect_uri на произвольном loopback-порту', async () => {
  const mock = await startMockGoogle();
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
  });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request(panel.base + '/api/antigravity-auth/start', {
        method: 'GET',
        headers: { host: 'ai-panel.home.ak-vps.ru' }, // домен без порта
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(b) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body.status, 200);
    assert.ok(!('mode' in body.data)); // режимов больше нет — flow один: paste
    // redirect_uri — произвольный loopback-порт (не порт панели!), чтобы
    // не попасть на локальный сервер пользователя; код применяется через /paste
    const redirect = new URL(body.data.url).searchParams.get('redirect_uri');
    assert.equal(redirect, 'http://127.0.0.1:44127/callback');
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('quota: project из query-параметра приоритетнее серверного', async () => {
  const mock = await startMockGoogle();
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
  });
  await fetch(panel.base + '/api/settings/google-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, project: 'server-project' }),
  });
  try {
    const res = await fetch(panel.base + '/api/antigravity-quota?project=query-project');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(modelCalls(mock)[0].body), { project: 'query-project' });
    // Другой project → кеш не переиспользуется, в Google уходит новый запрос
    await fetch(panel.base + '/api/antigravity-quota');
    assert.deepEqual(JSON.parse(modelCalls(mock)[1].body), { project: 'server-project' });
  } finally {
    await panel.stop();
    await mock.close();
  }
});

test('tokenExpiresAt появляется после paste-обмена', async () => {
  const mock = await startMockGoogle();
  const oauthMock = {
    refresh: async () => ({ ok: false, error: 'no_credentials' }),
    buildAuthUrl: ({ state }) => 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state,
    exchangeCode: async () => ({ ok: true, accessToken: 'tok', refreshToken: 'rt', expiresIn: 3600 }),
  };
  const panel = await startPanel({
    providers: [],
    antigravity: createAntigravityProvider({ url: mock.url }),
    googleOauth: oauthMock,
  });
  try {
    const res = await fetch(panel.base + '/api/antigravity-auth/paste', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:20128/callback?code=abc' }),
    });
    assert.equal(res.status, 200);
    const st = await (await fetch(panel.base + '/api/settings/google-token')).json();
    assert.equal(st.hasToken, true);
    assert.ok(Number.isFinite(st.tokenExpiresAt));
    assert.ok(st.tokenExpiresAt > Date.now()); // истекает через ~1 час
  } finally {
    await panel.stop();
    await mock.close();
  }
});
