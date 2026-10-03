'use strict';

// Прокси до OmniRoute (src/routes/omniroute.js): разбор списка
// адресов, probe с переключением, повтор на следующем адресе и
// запрет failover для POST.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  parseOmniUrls,
  collectCandidates,
  registerOmnirouteRoutes,
} = require('../../src/routes/omniroute');
const { Router } = require('../../src/router');
const { handleError, createRequestContext, parseRequestUrl } = require('../../src/http');
const { createStore } = require('../../src/store');
const { validateUpstreamUrl } = require('../../src/security');

/** Upstream, который отвечает заданным кодом и пишет запросы в seen. */
function startUpstream(body = { ok: true }, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || '' });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen,
        close: () => new Promise(done => server.close(done)),
      })
    )
  );
}

/** Панель с настроенным хранилищем и одним маршрутом /omniroute. */
async function startRouter(store, logger) {
  const router = new Router();
  registerOmnirouteRoutes(router, {
    getStore: async () => store,
    validateUpstreamUrl,
    logger,
  });
  const SILENT_LOG = { info() {}, warn() {}, error() {} };
  const server = http.createServer((req, res) => {
    const context = createRequestContext(req, res);
    const url = parseRequestUrl(req.url);
    router
      .dispatch(req, res, { url })
      .catch(err => handleError(err, req, res, context, SILENT_LOG));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(done => server.close(done)),
  };
}

test('parseOmniUrls: строки и запятые, дедупликация с сохранением порядка', () => {
  assert.deepEqual(parseOmniUrls('http://a\nhttp://b, http://a\n\n http://c '), [
    'http://a',
    'http://b',
    'http://c',
  ]);
  assert.deepEqual(parseOmniUrls(''), []);
  assert.deepEqual(parseOmniUrls(null), []);
});

test('collectCandidates: omniUrls плюс legacy omniUrl без дубля', () => {
  assert.deepEqual(collectCandidates({ omniUrls: 'http://a', omniUrl: 'http://b' }), [
    'http://a',
    'http://b',
  ]);
  assert.deepEqual(collectCandidates({ omniUrls: 'http://a', omniUrl: 'http://a' }), ['http://a']);
  assert.deepEqual(collectCandidates({}), []);
  assert.deepEqual(collectCandidates({ omniUrl: '  ' }), []);
});

test('одиночный адрес обслуживает запрос без probe', async () => {
  const upstream = await startUpstream({ single: true });
  const store = await createStore({ memory: true });
  await store.set('omniUrls', upstream.url);
  const panel = await startRouter(store);
  try {
    const res = await fetch(panel.base + '/omniroute/v1/usage', {
      headers: { 'x-omniroute-url': 'http://169.254.169.254' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { single: true });
    // Клиентский x-omniroute-url вырезан, ключ подставляется сервером
    assert.equal(upstream.seen[0].auth, '');
    await store.set('omniKey', 'omni-secret');
    await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(upstream.seen[1].auth, 'Bearer omni-secret');
  } finally {
    await panel.close();
    await store.close();
    await upstream.close();
  }
});

test('без адресов → 400 no_omniroute_url', async () => {
  const store = await createStore({ memory: true });
  const panel = await startRouter(store);
  try {
    const res = await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'no_omniroute_url');
  } finally {
    await panel.close();
    await store.close();
  }
});

test('недоступный единственный адрес → 502 proxy_error', async () => {
  const store = await createStore({ memory: true });
  await store.set('omniUrl', 'http://127.0.0.1:1');
  const panel = await startRouter(store, { info() {}, warn() {}, error() {} });
  try {
    const res = await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'proxy_error');
  } finally {
    await panel.close();
    await store.close();
  }
});

test('некорректный адрес → 400 invalid_omniroute_url', async () => {
  const store = await createStore({ memory: true });
  await store.set('omniUrl', 'не-url');
  const panel = await startRouter(store);
  try {
    const res = await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_omniroute_url');
  } finally {
    await panel.close();
    await store.close();
  }
});

test('мульти-адрес: недоступный первый, работает второй', async () => {
  const dead = 'http://127.0.0.1:1';
  const alive = await startUpstream({ viaSecond: true });
  const infos = [];
  const warns = [];
  const logger = {
    info: line => infos.push(String(line)),
    warn: line => warns.push(String(line)),
    error: () => {},
  };
  const store = await createStore({ memory: true });
  await store.set('omniUrls', dead + '\n' + alive.url);
  const panel = await startRouter(store, logger);
  try {
    const res = await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { viaSecond: true });
    assert.ok(warns.some(line => /адрес недоступен: http:\/\/127\.0\.0\.1:1/.test(line)));
    assert.ok(infos.some(line => /выбран доступный адрес/.test(line)));
  } finally {
    await panel.close();
    await store.close();
    await alive.close();
  }
});

test('все адреса недоступны → 502 omniroute_unreachable со списком', async () => {
  const store = await createStore({ memory: true });
  await store.set('omniUrls', 'http://127.0.0.1:1\nhttp://127.0.0.1:2');
  const panel = await startRouter(store, { info() {}, warn() {}, error() {} });
  try {
    const res = await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'omniroute_unreachable');
    assert.match(body.message, /127\.0\.0\.1:1/);
    assert.match(body.message, /127\.0\.0\.1:2/);
  } finally {
    await panel.close();
    await store.close();
  }
});

test('POST не переключается на другой адрес после обрыва', async () => {
  const first = await startUpstream({ first: true });
  const second = await startUpstream({ second: true });
  const warns = [];
  const store = await createStore({ memory: true });
  await store.set('omniUrls', first.url + '\n' + second.url);
  const panel = await startRouter(store, {
    info() {},
    warn: line => warns.push(String(line)),
    error() {},
  });
  try {
    // Первый адрес закрывается после probe: обрыв приходит уже по прокси
    const res = await fetch(panel.base + '/omniroute/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(res.status, 200, 'текущий адрес отвечает');
    // probe делает GET /, интересует только сам проксированный вызов
    assert.equal(first.seen.filter(r => r.url === '/v1/chat').length, 1);

    // Роняем первый upstream и повторяем POST: тело могло быть принято
    // upstream до обрыва, поэтому failover для POST запрещён (P1-5)
    await first.close();
    const res2 = await fetch(panel.base + '/omniroute/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 2 }),
    });
    assert.equal(res2.status, 502, 'POST не повторяется на другом адресе');
    assert.equal((await res2.json()).error, 'proxy_error');
    assert.equal(
      second.seen.filter(r => r.url === '/v1/chat').length,
      0,
      'второй адрес не должен получать POST'
    );
  } finally {
    await panel.close();
    await store.close();
    await second.close();
  }
});

test('GET переключается на следующий адрес после обрыва', async () => {
  const first = await startUpstream({ first: true });
  const second = await startUpstream({ second: true });
  const warns = [];
  const store = await createStore({ memory: true });
  await store.set('omniUrls', first.url + '\n' + second.url);
  const panel = await startRouter(store, {
    info() {},
    warn: line => warns.push(String(line)),
    error() {},
  });
  try {
    // Прогреваем кеш рабочего адреса и закрываем его
    assert.equal((await fetch(panel.base + '/omniroute/v1/usage')).status, 200);
    await first.close();

    const res = await fetch(panel.base + '/omniroute/v1/usage');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { second: true }, 'ответил второй адрес');
    assert.ok(
      warns.some(line => /не ответил — повтор на/.test(line)),
      'в лог уходит предупреждение о переключении'
    );
  } finally {
    await panel.close();
    await store.close();
    await second.close();
  }
});
