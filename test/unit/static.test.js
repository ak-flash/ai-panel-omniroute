'use strict';

// Раздача статики (src/static.js): защита от path traversal, MIME и 404.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStaticHandler, resolveStaticPath, MIME } = require('../../src/static');
const { startPanel, makeTmpDir } = require('../helpers');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

test('resolveStaticPath: корень → index.html, обычный файл как есть', () => {
  assert.equal(resolveStaticPath(PUBLIC_DIR, '/'), path.join(PUBLIC_DIR, 'index.html'));
  assert.equal(
    resolveStaticPath(PUBLIC_DIR, '/js/boot.js'),
    path.join(PUBLIC_DIR, 'js', 'boot.js')
  );
  assert.equal(
    resolveStaticPath(PUBLIC_DIR, '/css/%D0%B1%D0%B0%D0%B7%D0%B0.css'),
    path.join(PUBLIC_DIR, 'css', 'база.css'),
    'percent-encoding декодируется'
  );
});

test('resolveStaticPath: обход каталога и битый URL отклоняются', () => {
  for (const attack of [
    '/../src/config.js',
    '/..%2f..%2fserver.js',
    '/js/../../server.js',
    '/%E0%A4%A', // невалидный UTF-8
  ]) {
    assert.equal(resolveStaticPath(PUBLIC_DIR, attack), null, attack);
  }
});

test('MIME покрывает используемые расширения, неизвестное — octet-stream', () => {
  for (const ext of ['.html', '.css', '.js', '.svg', '.png', '.woff2']) {
    assert.ok(MIME[ext], ext);
  }
  assert.equal(MIME['.weird'], undefined);
});

test('обработчик отдаёт файл, каталог и обход — с нужным кодом', async () => {
  const panel = await startPanel();
  try {
    const css = await fetch(panel.base + '/css/base.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(css.headers.get('cache-control'), 'no-cache');
    assert.match(await css.text(), /body\.is-booting/);

    // Каталог не файл
    const dir = await fetch(panel.base + '/js/');
    assert.equal(dir.status, 404);

    const missing = await fetch(panel.base + '/js/nope.js');
    assert.equal(missing.status, 404);

    // Сырой обход каталога: %2e%2e%2f не схлопывается парсером URL
    const escape = await fetch(panel.base + '/%2e%2e%2f%2e%2e%2fserver.js');
    assert.equal(escape.status, 403);
    assert.equal(await escape.text(), '403 Forbidden');
  } finally {
    await panel.stop();
  }
});

test('обработчик на своём каталоге: файл отдаётся, неизвестное — 404', async () => {
  const dir = makeTmpDir('static-');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'привет');
  const serve = createStaticHandler({ publicDir: dir });
  const { createServer } = require('node:http');
  const server = createServer((req, res) => serve(req, res, req.url));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const ok = await fetch(base + '/note.txt');
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'привет');

    // Неизвестное расширение отдаётся как application/octet-stream
    fs.writeFileSync(path.join(dir, 'blob.bin'), 'x');
    const binary = await fetch(base + '/blob.bin');
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');

    const missing = await fetch(base + '/absent.txt');
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), '404 Not Found');
  } finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
