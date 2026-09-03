'use strict';

// ============================================================
// Сборка HTTP-приложения панели: createApp — композиция модулей.
//
// Маршруты регистрируют отдельные файлы в src/routes/, сервисы
// (antigravity, трекер AgentRouter) получают зависимости через
// параметры. Здесь только склейка, security-периметр, error
// boundary и lifecycle (трекер, graceful close).
// ============================================================

const http = require('http');
const path = require('path');

const { loadProviders } = require('../providers');
const { createAntigravityProvider } = require('../providers/antigravity');
const { createGoogleOauth, getBuiltinClientId, getBuiltinClientSecret } = require('../providers/google-oauth');
const { createStore } = require('../store');
const { createRequestContext, handleError, sendJson } = require('../http');
const { Router } = require('../router');
const {
  applyRequestSecurity,
  parseAllowedOrigins,
  validateUpstreamUrl,
} = require('../security');

const { createStaticHandler } = require('./static');
const { createAgentRouterTracker, AGENTROUTER_DAY_BALANCE_KEY } = require('./agentrouter-tracker');
const { createAntigravityService } = require('./antigravity-service');
const { PROVIDER_STORE_KEYS, PROVIDER_STORE_USER_FIELDS } = require('./provider-store-fields');
const { registerProviderRoutes } = require('./routes/providers');
const { registerProxyRoutes } = require('./routes/proxy');
const { registerOmnirouteRoutes } = require('./routes/omniroute');
const { registerAntigravityRoutes } = require('./routes/antigravity');
const { registerConfigRoutes } = require('./routes/config');

/**
 * Собирает HTTP-сервер панели. Провайдеры/адаптеры передаются
 * снаружи (CLI — вшитые, тесты — mock-upstream); окружение читается
 * только здесь, на композиционном уровне, для значений по умолчанию.
 */
function createApp({
  providers = loadProviders(),
  antigravity,
  googleOauth,
  store,
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
  publicOrigin = process.env.PUBLIC_ORIGIN || '',
  logger = console,
  requestTimeoutMs = 30000,
  authLoopbackPort = process.env.PORT || '8765',
} = {}) {
  const activeProvider = providers[0] || null;
  // Логгер провайдеров (функция warn-уровня): включает файл при запуске CLI.
  // Не перетираем явно переданный antigravity/googleOauth (тесты передают mock).
  const providerLog = typeof logger.log === 'function'
    ? logger.log.bind(logger)
    : (typeof logger === 'function' ? logger : console.warn);
  if (!antigravity) antigravity = createAntigravityProvider({ log: providerLog });
  if (!googleOauth) googleOauth = createGoogleOauth({ log: providerLog });

  // Хранилище ключей/настроек: SQLite на сервере (зашифровано AES-256-GCM).
  // createStore — async, поэтому store может прийти Promise; нормализуем
  // лениво в обработчиках запросов (они async).
  if (!store) store = createStore({});
  async function getStore() {
    if (store && typeof store.then === 'function') store = await store;
    return store;
  }

  const router = new Router();
  router.add(['GET', 'HEAD'], '/api/health', ({ res }) =>
    sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' }));

  router.add(['GET', 'HEAD'], '/api/ready', async ({ res }) => {
    const store = await getStore();
    const storeOk = store && typeof store.exec === 'function';
    const trackerOk = tracker && typeof tracker.isRunning === 'function' ? tracker.isRunning() : true;
    const antigravityOk = antigravityService && typeof antigravityService.checkHealth === 'function'
      ? await antigravityService.checkHealth().catch(() => false)
      : true;
    const ready = storeOk && trackerOk && antigravityOk;
    const status = ready ? 200 : 503;
    sendJson(res, status, { ready, store: storeOk, tracker: trackerOk, antigravity: antigravityOk }, { 'cache-control': 'no-store' });
  });

  router.add(['GET', 'HEAD'], '/api/metrics', ({ res }) => {
    const { getMetrics } = require('./metrics');
    sendJson(res, 200, getMetrics(), { 'cache-control': 'no-store' });
  });

  // ---------- Сервисы ----------
  const antigravityService = createAntigravityService({
    googleOauth,
    antigravity,
    getStore,
    getBuiltinClientId,
    getBuiltinClientSecret,
  });
  const tracker = createAgentRouterTracker({
    getStore,
    provider: providers.find((p) => p.id === 'agentrouter'),
    storeKey: PROVIDER_STORE_KEYS.agentrouter,
    userField: PROVIDER_STORE_USER_FIELDS.agentrouter,
    balanceKey: AGENTROUTER_DAY_BALANCE_KEY,
  });

  // ---------- Маршруты (порядок важен: статика — catch-all в конце) ----------
  registerProviderRoutes(router, {
    providers,
    getStore,
    storeKeys: PROVIDER_STORE_KEYS,
    userFields: PROVIDER_STORE_USER_FIELDS,
    getDayBalanceUsd: tracker.getDayBalanceUsd,
    logger,
  });
  registerProxyRoutes(router, { providers, activeProvider, logger });
  registerOmnirouteRoutes(router, { getStore, validateUpstreamUrl, logger });
  registerAntigravityRoutes(router, {
    service: antigravityService,
    googleOauth,
    defaultPort: authLoopbackPort,
  });
  registerConfigRoutes(router, {
    getStore,
    providers,
    activeProvider,
    antigravityService,
    storeKeys: PROVIDER_STORE_KEYS,
    validateUpstreamUrl,
  });
  const serveStatic = createStaticHandler({ publicDir: path.join(__dirname, '..', 'public') });
  router.add(['GET', 'HEAD'], '*', ({ req, res, url }) => serveStatic(req, res, url.pathname));

  async function handleRequest(req, res) {
    if (!applyRequestSecurity(req, res, allowedOrigins, publicOrigin)) return;
    return router.dispatch(req, res, {});
  }

  const server = http.createServer((req, res) => {
    const context = createRequestContext(req, res, { timeoutMs: requestTimeoutMs });
    const startedAt = Date.now();
    res.on('finish', () => {
      let level = 'info';
      if (res.statusCode >= 500) level = 'error';
      else if (res.statusCode >= 400) level = 'warn';
      const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
      const method = req.method || '?';
      if (fn) fn(`[access] ${method} ${new URL(req.url, 'http://localhost').pathname} → ${res.statusCode} (${Date.now() - startedAt} ms)`);
    });
    handleRequest(req, res).catch((err) => handleError(err, req, res, context, logger));
  });

  // ---------- Lifecycle: трекер, снимок, graceful close ----------
  server.startDailyAgentRouterTracker = () => tracker.start();
  server.snapshotAgentRouterDayBalance = () => tracker.snapshotDayBalance();

  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    tracker.stop();
    // store.close(): сброс очереди записи на диск и освобождение базы
    // (идемпотентно; ошибки закрытия не мешают остановке сервера)
    Promise.resolve(store)
      .then((s) => { if (s && typeof s.close === 'function') return s.close(); })
      .catch(() => {});
    return originalClose(callback);
  };

  return server;
}

module.exports = { createApp };
