'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let formatErrorDetail;
test.before(async () => {
  ({ formatErrorDetail } = await import('../../public/js/error-detail.js'));
});

test('formatErrorDetail returns message for plain errors', () => {
  assert.equal(formatErrorDetail(new Error('boom')), 'boom');
  assert.equal(formatErrorDetail('net'), 'net');
});

test('formatErrorDetail appends status and body', () => {
  const err = new Error('failed');
  err.status = 502;
  err.statusText = 'Bad Gateway';
  err.body = { error: 'upstream' };
  assert.equal(
    formatErrorDetail(err),
    'failed (статус: 502 Bad Gateway) Тело: {"error":"upstream"}'
  );
});

test('formatErrorDetail keeps string body as-is', () => {
  const err = new Error('failed');
  err.body = 'raw text';
  assert.equal(formatErrorDetail(err), 'failed Тело: raw text');
});

test('formatErrorDetail reads nested response status', () => {
  const err = new Error('failed');
  err.response = { status: 404, statusText: 'Not Found' };
  assert.equal(formatErrorDetail(err), 'failed (статус ответа: 404 Not Found)');
});
