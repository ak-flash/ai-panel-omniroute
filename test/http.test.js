'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { AppError, readBody, readJson, safeLog } = require('../src/http');
const { Router } = require('../src/router');

function request(body = '') {
  const req = new EventEmitter();
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

test('readJson читает JSON и стандартизирует malformed payload', async () => {
  assert.deepEqual(await readJson(request('{"ok":true}')), { ok: true });
  await assert.rejects(readJson(request('{')), (error) => error instanceof AppError && error.status === 400 && error.code === 'bad_json');
});

test('readBody ограничивает размер payload', async () => {
  await assert.rejects(readBody(request('12345'), { maxBytes: 4 }), (error) => error.status === 413 && error.code === 'payload_too_large');
});

test('safeLog удаляет поля с секретами', () => {
  const entries = [];
  safeLog({ info: (event, fields) => entries.push({ event, fields }) }, 'info', 'request', {
    requestId: 'id', authorization: 'Bearer secret', apiKey: 'secret', path: '/api/config',
  });
  assert.deepEqual(entries, [{ event: 'request', fields: { requestId: 'id', path: '/api/config' } }]);
});

test('Router извлекает params и возвращает 405 для неверного метода', async () => {
  const router = new Router();
  let seen;
  router.add('GET', '/api/items/:id', ({ params }) => { seen = params.id; });
  await router.dispatch({ method: 'GET', url: '/api/items/a%20b' }, {}, {});
  assert.equal(seen, 'a b');
  await assert.rejects(router.dispatch({ method: 'POST', url: '/api/items/a' }, {}, {}), (error) => error.status === 405 && error.code === 'method_not_allowed');
});
