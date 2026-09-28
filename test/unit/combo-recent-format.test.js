'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let statusClass;
let extractErrorText;
let statusText;
let pluralRequests;
test.before(async () => {
  ({ statusClass, extractErrorText, statusText, pluralRequests } =
    await import('../../public/js/combo-recent-format.js'));
});

test('statusClass maps successful, failed and pending statuses', () => {
  assert.equal(statusClass(200, false), 'status-ok');
  assert.equal(statusClass(500, false), 'status-err');
  assert.equal(statusClass(0, false), 'status-other');
  assert.equal(statusClass(200, true), 'status-err');
});

test('extractErrorText selects useful error detail', () => {
  assert.equal(extractErrorText('network'), 'network');
  assert.equal(extractErrorText({ message: 'failed' }), 'failed');
  assert.equal(extractErrorText({ error: { message: 'nested' } }), 'nested');
  assert.equal(extractErrorText({ statusText: 'Bad Gateway' }), 'Bad Gateway');
  assert.equal(extractErrorText(null), '');
});

test('statusText handles active, error and HTTP rows', () => {
  assert.equal(statusText({ active: true }), '…');
  assert.equal(statusText({ error: { message: 'failed' } }), 'failed');
  assert.equal(statusText({ status: 204 }), '204');
  assert.equal(statusText({}), '—');
});

test('pluralRequests uses Russian request forms', () => {
  assert.equal(pluralRequests(1), 'запрос');
  assert.equal(pluralRequests(2), 'запроса');
  assert.equal(pluralRequests(5), 'запросов');
  assert.equal(pluralRequests(11), 'запросов');
  assert.equal(pluralRequests(21), 'запрос');
});
