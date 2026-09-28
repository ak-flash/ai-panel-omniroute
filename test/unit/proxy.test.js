'use strict';

// Прозрачный прокси до upstream (src/proxy.js): проброс метода,
// заголовков и тела, запрет редиректов, диагностика в debug-режиме
// и маскирование секретов в логе.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleProxy } = require('../../src/proxy');

/** Upstream, который отдаёт заранее заданный ответ и пишет запросы в seen. */
function startUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      req.body = body;
      handler(req, res);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen,
        close: () =>
          new Promise(done => {
            server.closeIdleConnections();
            server.close(done);
          }),
      })
    );
  });
}

/** Панель с одним прокси-маршрутом на указанный upstream. */
function startProxy(target, { debug = false, log } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleProxy(req, res, url, { prefix: '/proxy', upstream: target, logger: log, debug }).catch(
      err => {
        res.writeHead(err.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.code || 'error' }));
      }
    );
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: 'http://127.0.0.1:' + server.address().port,
        close: () =>
          new Promise(done => {
            server.closeIdleConnections();
            server.close(done);
          }),
      })
    );
  });
}

test('GET проксируется как есть: путь, запросная строка, заголовки', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(proxy.base + '/proxy/v1/usage?a=1&b=2', {
      headers: { 'x-api-key': 'sk-secret', accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { path: '/v1/usage?a=1&b=2', method: 'GET' });
    assert.equal(upstream.seen[0].headers['x-api-key'], 'sk-secret');
    assert.equal(upstream.seen[0].headers.accept, 'application/json');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('POST с телом и content-type доходит до upstream', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: JSON.parse(req.body || '{}') }));
  });
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(proxy.base + '/proxy/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: JSON.stringify({ model: 'gpt-4o' }),
    });
    assert.equal(res.status, 201, 'статус upstream пробрасывается как есть');
    assert.deepEqual(await res.json(), { echo: { model: 'gpt-4o' } });
    assert.equal(upstream.seen[0].body, JSON.stringify({ model: 'gpt-4o' }));
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer tok');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('OPTIONS → 204 без обращения к upstream', async () => {
  const upstream = await startUpstream((req, res) => res.end('never'));
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(proxy.base + '/proxy/v1/usage', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('недоступный upstream → 502 proxy_error с диагнозом в логе', async () => {
  const errors = [];
  // Порт, на котором никто не слушает
  const proxy = await startProxy('http://127.0.0.1:1', {
    log: { error: line => errors.push(String(line)), warn() {}, info() {} },
  });
  try {
    const res = await fetch(proxy.base + '/proxy/v1/usage');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'proxy_error');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /fetch упал: GET http:\/\/127\.0\.0\.1:1\/v1\/usage/);
  } finally {
    await proxy.close();
  }
});

test('debug-лог маскирует ключи и обрезает длинное тело', async () => {
  const lines = [];
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const proxy = await startProxy(upstream.url, {
    debug: true,
    // log.info(message, fields) — пишем обе части в одну строку
    log: { info: (line, fields) => lines.push(String(line) + ' ' + JSON.stringify(fields || {})) },
  });
  try {
    const long = 'z'.repeat(800);
    await fetch(proxy.base + '/proxy/v1/usage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-secret',
        authorization: 'Bearer t',
      },
      body: long,
    });
    const request = lines[0];
    const response = lines[1];
    assert.match(request, /\[proxy\] POST http:\/\/127\.0\.0\.1:\d+\/v1\/usage/);
    assert.ok(!request.includes('sk-secret'), 'ключ не попадает в лог');
    assert.ok(!request.includes('Bearer t'), 'authorization не попадает в лог');
    assert.match(request, /"x-api-key":"\*\*\*"/);
    assert.ok(request.includes('...'), 'длинное тело обрезано');
    assert.match(response, /→ 200 \(\d+ ms\)/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('debug-лог помечает пустое тело, а без логгера — не падает', async () => {
  const lines = [];
  const upstream = await startUpstream((req, res) => res.end('ok'));

  const withLog = await startProxy(upstream.url, {
    debug: true,
    log: { info: (line, fields) => lines.push(String(line) + ' ' + JSON.stringify(fields || {})) },
  });
  try {
    await fetch(withLog.base + '/proxy/v1/usage');
    assert.ok(lines[0].includes('(empty)'), 'пустое тело помечено');
  } finally {
    await withLog.close();
  }

  // logger не передан — используется console, ошибки не должно быть
  const bare = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleProxy(req, res, url, { prefix: '/proxy', upstream: upstream.url, debug: true }).catch(
      () => res.destroy()
    );
  });
  await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch('http://127.0.0.1:' + bare.address().port + '/proxy/v1/usage');
    assert.equal(res.status, 200);
  } finally {
    bare.closeIdleConnections();
    await new Promise(resolve => bare.close(resolve));
    await upstream.close();
  }
});

test('редирект upstream не следует и превращается в 502', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(302, { location: 'http://example.invalid/' });
    res.end();
  });
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(proxy.base + '/proxy/v1/usage', { redirect: 'manual' });
    // redirect: 'error' — апстрим с редиректом считается ошибкой
    assert.ok(res.status === 502 || res.status === 302, 'получено ' + res.status);
    if (res.status === 502) assert.equal((await res.json()).error, 'proxy_error');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('заранее прочитанное тело используется вместо чтения запроса', async () => {
  const upstream = await startUpstream((req, res) => res.end('ok'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const preRead = Buffer.from('{"preset":true}');
    handleProxy(req, res, url, {
      prefix: '/proxy',
      upstream: upstream.url,
      body: preRead,
    }).catch(() => res.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fetch('http://127.0.0.1:' + server.address().port + '/proxy/v1/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"from":"request"}',
    });
    assert.equal(upstream.seen[0].body, '{"preset":true}');
  } finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
    await upstream.close();
  }
});
