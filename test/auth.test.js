'use strict';

// Юнит-тесты входа (src/auth.js): подписанные cookie-сессии, сравнение
// токена за постоянное время, ограничение числа попыток.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, readCookie, COOKIE_NAME } = require('../src/auth');

let nowMs = 1000000;
const now = () => nowMs;
const TOKEN = 'a'.repeat(32);

function auth(token = TOKEN) {
  return createAuth({ token, now });
}

test('без токена вход отключён, checkToken и сессии не работают', () => {
  const a = createAuth({ token: '', now });
  assert.equal(a.enabled, false);
  assert.equal(a.checkToken(TOKEN), false);
  assert.equal(a.verifySession(a.issueSession().value), false);
});

test('checkToken проходит верный токен и отклоняет неверный', () => {
  const a = auth();
  assert.equal(a.checkToken(TOKEN), true);
  assert.equal(a.checkToken('wrong-token'), false);
  assert.equal(a.checkToken(''), false);
});

test('сессия подписана: валидна, повреждённая и протухшая — нет', () => {
  const a = auth();
  const { value } = a.issueSession();
  assert.equal(a.verifySession(value), true);
  // изменение подписи
  assert.equal(a.verifySession(value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a')), false);
  // протухшая
  nowMs += 8 * 24 * 60 * 60 * 1000;
  assert.equal(a.verifySession(value), false);
});

test('cookie: HttpOnly, SameSite=Strict, Max-Age; Secure — только при https', () => {
  const a = auth();
  const insecure = a.sessionCookie({ secure: false });
  assert.match(insecure, new RegExp(`^${COOKIE_NAME}=.+; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  const secure = a.sessionCookie({ secure: true });
  assert.match(secure, /; Secure$/);
  assert.match(a.clearCookie({ secure: true }), /^aipanel_session=; .*Max-Age=0/);
});

test('readCookie разбирает заголовок Cookie по имени', () => {
  assert.equal(readCookie({ headers: { cookie: 'a=1; aipanel_session=x; b=2' } }), 'x');
  assert.equal(readCookie({ headers: { cookie: 'a=1' } }), '');
  assert.equal(readCookie({ headers: {} }), '');
});

test('лимитер блокирует перебор по IP и глобально', () => {
  const a = auth();
  for (let i = 0; i < 9; i++) {
    a.limiter.recordFailure('1.2.3.4');
    assert.equal(a.limiter.retryAfter('1.2.3.4'), 0);
  }
  a.limiter.recordFailure('1.2.3.4');
  assert.ok(a.limiter.retryAfter('1.2.3.4') > 0);
  // другой IP не заблокирован локальным лимитом
  assert.equal(a.limiter.retryAfter('5.6.7.8'), 0);
  // успех снимает блокировку IP
  nowMs += 16 * 60 * 1000;
  a.limiter.recordSuccess('1.2.3.4');
  assert.equal(a.limiter.retryAfter('1.2.3.4'), 0);
});
