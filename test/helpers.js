'use strict';

// ============================================================
// Общие утилиты для тестов:
//   - mock-upstream       — фейковый API xKiro (реальный API не вызывается)
//   - startPanel          — server.js in-process (createApp) на свободном порту
//   - startServerProcess  — CLI-запуск node server.js (smoke-тест входной точки)
//   - getFreePort         — свободный порт для слушающих сокетов
//
// Провайдеры передаются в панель напрямую (инъекция), окружение
// не настраивается — в env остаётся только PORT.
// ============================================================

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('../server');
const { createXKiroProvider } = require('../providers/xkiro');

const ROOT = path.join(__dirname, '..');

/** Возвращает свободный порт (listen(0) → close). */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Простой JSON-ответ mock-сервера. */
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Mock upstream, похожий на API xKiro.
 *
 * Маршруты:
 *   /v1/usage  → canned-JSON статистики (+ _seenKey — какой ключ пришёл)
 *   /v1/models → { models: [] }
 *   остальное  → 404
 *
 * Опции:
 *   requireKey — требовать x-api-key, иначе 401 (по умолчанию true)
 *   usageCode / usageBody — переопределить ответ /v1/usage
 *   usageRaw   — отдать сырую строку вместо JSON (тесты не-JSON ответов)
 *
 * Возвращает { url, seen, close }: seen — лог запросов { url, key }.
 */
function startMockUpstream(opts = {}) {
  const requireKey = opts.requireKey !== false;
  const seen = [];

  const server = http.createServer((req, res) => {
    const key = req.headers['x-api-key'] || '';
    seen.push({ url: req.url, key });

    if (requireKey && !key) return json(res, 401, { error: 'unauthorized' });

    if (req.url === '/v1/usage') {
      if (opts.usageRaw !== undefined) {
        res.writeHead(opts.usageCode || 200, { 'content-type': 'text/plain' });
        return res.end(opts.usageRaw);
      }
      return json(res, opts.usageCode || 200, opts.usageBody || {
        plan: 'pro',
        wallet: { balance_usd: '12.34', held_usd: '0' },
        windows: [],
        free_tokens: null,
        _seenKey: key,
      });
    }
    if (req.url === '/v1/models') {
      return json(res, 200, { models: [], _seenKey: key });
    }
    return json(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen,
        close: () =>
          new Promise((done) => {
            // Гасим keep-alive соединения, иначе close() ждёт их таймаута
            server.closeIdleConnections();
            server.close(done);
          }),
      });
    });
  });
}

/**
 * Поднимает server.js in-process (через createApp) на свободном порту.
 * Провайдеры передаются напрямую — окружение не используется. По
 * умолчанию один xKiro, смотрящий на opts.upstream (mock-upstream
 * в тестах). Возвращает { base, stop }.
 */
async function startPanel(opts = {}) {
  const port = await getFreePort();
  const providers = opts.providers ||
    [createXKiroProvider({ url: opts.upstream || 'http://127.0.0.1:1' })];
  const { createStore } = require('../store');
  const store = opts.store || await createStore({ memory: true });
  const app = createApp({ providers, antigravity: opts.antigravity, googleOauth: opts.googleOauth, store });

  await new Promise((resolve) => app.listen(port, '127.0.0.1', resolve));

  return {
    base: 'http://127.0.0.1:' + port,
    stop: () =>
      new Promise((resolve) => {
        // Гасим keep-alive соединения, иначе close() ждёт их таймаута
        if (app.closeIdleConnections) app.closeIdleConnections();
        app.close(resolve);
      }),
  };
}

/**
 * CLI-запуск: node server.js как дочерний процесс — smoke-тест
 * входной точки (поднялся, слушает порт, отдаёт /api/config).
 * Провайдеры вшитые, upstream не вызывается.
 */
async function startServerProcess() {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  });

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += String(d);
  });

  const base = 'http://127.0.0.1:' + port;

  // Ждём, пока сервер начнёт отвечать (или упадёт при старте)
  const deadline = Date.now() + 10000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error('server.js упал при запуске: ' + stderr);
    }
    try {
      if ((await fetch(base + '/api/config')).ok) break;
    } catch {}
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error('server.js не поднялся за 10 с');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    stop: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill();
      }),
  };
}

module.exports = { ROOT, getFreePort, json, startMockUpstream, startPanel, startServerProcess };
