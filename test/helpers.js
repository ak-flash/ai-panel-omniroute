'use strict';

// ============================================================
// Общие утилиты для тестов:
//   - mock-upstream       — фейковый API xKiro (реальный API не вызывается)
//   - startPanel          — server.js in-process (createApp) на свободном порту
//   - startServerProcess  — CLI-запуск node server.js (smoke-тест входной точки)
//   - getFreePort         — свободный порт для слушающих сокетов
//
// Провайдеры передаются в панель напрямую (инъекция). Конфигурация
// строится из явного env (testEnv), а не из окружения разработчика:
// каталоги data/ и logs/ — во временной папке, .env не читается.
// ============================================================

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('../server');
const { ENV_VARS, loadConfig } = require('../src/config');
const { createXKiroProvider } = require('../providers/xkiro');

const ROOT = path.join(__dirname, '..');

// Временный корень на процесс тест-файла; удаляется при выходе
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

/** Новый пустой каталог внутри TMP_ROOT. */
function makeTmpDir(prefix = 'dir-') {
  return fs.mkdtempSync(path.join(TMP_ROOT, prefix));
}

/** Env панели для тестов: изолированные data/logs + переопределения. */
function testEnv(extra = {}) {
  return {
    AIPANEL_ENV_FILE: 'none',
    AIPANEL_DATA_DIR: path.join(TMP_ROOT, 'data'),
    AIPANEL_LOG_DIR: path.join(TMP_ROOT, 'logs'),
    ...extra,
  };
}

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
 * Возвращает { url, seen, close }: seen — лог запросов { url, key, accept }.
 */
function startMockUpstream(opts = {}) {
  const requireKey = opts.requireKey !== false;
  const seen = [];

  const server = http.createServer((req, res) => {
    const key = req.headers['x-api-key'] || '';
    seen.push({ url: req.url, key, accept: req.headers['accept'] || '' });

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
 * Mock upstream AgentRouter (new-api): GET /api/user/self требует
 * Authorization (Bearer, префикс опционален) и отдаёт
 * { success, data: { group, quota, … } } — как UserAuth() в new-api.
 *
 * Опции:
 *   code / body — переопределить код и JSON-ответ
 *   raw         — отдать сырую строку вместо JSON (тесты не-JSON ответов)
 *   responses   — последовательность объектов { code, body, raw, contentType }
 *   routes      — ответы по конкретным URL: { '/api/user/models': { code, body, raw } }
 *
 * Возвращает { url, seen, close }: seen — лог запросов { url, auth, accept }.
 */
function startAgentRouterUpstream(opts = {}) {
  const seen = [];

  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    seen.push({
      url: req.url,
      auth,
      uid: req.headers['new-api-user'] || '',
      accept: req.headers['accept'] || '',
    });

    // Ответ по конкретному URL (routes) приоритетнее общего сценария
    const route = opts.routes && opts.routes[req.url];
    if (route) {
      if (route.raw !== undefined) {
        res.writeHead(route.code || 200, {
          'content-type': route.contentType || 'text/plain',
        });
        return res.end(route.raw);
      }
      return json(res, route.code || 200, route.body);
    }

    const responseOpts = Array.isArray(opts.responses)
      ? opts.responses[Math.min(seen.length - 1, opts.responses.length - 1)]
      : opts;
    if (responseOpts.raw !== undefined) {
      res.writeHead(responseOpts.code || 200, {
        'content-type': responseOpts.contentType || 'text/plain',
      });
      return res.end(responseOpts.raw);
    }
    return json(res, responseOpts.code || 200, responseOpts.body || {
      success: true,
      message: '',
      data: {
        id: 7,
        username: 'tester',
        group: 'vip',
        quota: 41157471,
        used_quota: 908842529,
        request_count: 7756,
      },
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        seen,
        close: () =>
          new Promise((done) => {
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
  const { createStore } = require('../src/store');
  const store = opts.store || await createStore({ memory: true });
  const app = createApp({
    config: opts.config || loadConfig(testEnv(opts.env)),
    providers,
    antigravity: opts.antigravity,
    googleOauth: opts.googleOauth,
    store,
    logger: opts.logger,
    publicOrigin: opts.publicOrigin,
    requestTimeoutMs: opts.requestTimeoutMs,
  });

  await new Promise((resolve) => app.listen(port, '127.0.0.1', resolve));

  return {
    base: 'http://127.0.0.1:' + port,
    app,
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
 * Провайдеры вшитые, upstream не вызывается. Переменные панели из
 * окружения разработчика не наследуются; data/ и logs/ — во временной
 * папке (возвращаются как dataDir/logDir). stop() → код выхода.
 */
async function startServerProcess(extraEnv = {}) {
  const port = await getFreePort();
  const dir = makeTmpDir('cli-');
  const env = { ...process.env };
  for (const name of ENV_VARS) delete env[name];
  Object.assign(env, testEnv({
    AIPANEL_DATA_DIR: path.join(dir, 'data'),
    AIPANEL_LOG_DIR: path.join(dir, 'logs'),
    PORT: String(port),
    ...extraEnv,
  }));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
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
    dataDir: env.AIPANEL_DATA_DIR,
    logDir: env.AIPANEL_LOG_DIR,
    stop: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve(null);
        }, 8000);
        proc.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        proc.kill('SIGTERM');
      }),
  };
}

module.exports = {
  ROOT,
  TMP_ROOT,
  getFreePort,
  json,
  makeTmpDir,
  startMockUpstream,
  startAgentRouterUpstream,
  startPanel,
  startServerProcess,
  testEnv,
};
