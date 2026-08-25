'use strict';

// ============================================================
// Общие утилиты для тестов:
//   - mock-upstream — фейковый API xKiro (реальный API не вызывается)
//   - startPanel    — запуск server.js как дочернего процесса
//   - getFreePort   — свободный порт для слушающих сокетов
// ============================================================

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

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
 * Поднимает server.js на свободном порту и ждёт готовности (/api/config).
 * extraEnv переопределяет переменные из .env на диске, поэтому тесты
 * не зависят от локального .env и не ходят в реальный API xKiro.
 * Возвращает { base, proc, stderr, stop }.
 */
async function startPanel(extraEnv = {}) {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      // Детерминизм: базовые значения, которые extraEnv может переопределить
      PORT: String(port),
      PROVIDERS: 'xkiro',
      XKIRO_NAME: 'xKiro',
      XKIRO_API_URL: '',
      XKIRO_API_KEY: '',
      OMNIROUTE_URL: '',
      ...extraEnv,
    },
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
    proc,
    stderr: () => stderr,
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

module.exports = { ROOT, getFreePort, json, startMockUpstream, startPanel };
