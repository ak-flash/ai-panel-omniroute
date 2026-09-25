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

const { loadConfig } = require('./config');
const { loadProviders } = require('../providers');
const { AGENTROUTER_POOL_RELEASE_TIMEZONE } = require('../providers/agentrouter');
const { createAntigravityProvider } = require('../providers/antigravity');
const { createGoogleOauth } = require('../providers/google-oauth');
const { createStore } = require('./store');
const { createRequestContext, handleError, requestPath, sendJson } = require('./http');
const { getMetrics } = require('./metrics');
const { normalizeLog } = require('./file-logger');
const { Router } = require('./router');
const { applyRequestSecurity, validateUpstreamUrl } = require('./security');

const { createStaticHandler } = require('./static');
const { createAgentRouterTracker, AGENTROUTER_DAY_BALANCE_KEY } = require('./agentrouter-tracker');
const { createAntigravityService } = require('./antigravity-service');
const { PROVIDER_STORE_KEYS, PROVIDER_STORE_USER_FIELDS } = require('./provider-store-fields');
const { registerProviderRoutes } = require('./routes/providers');
const { registerProxyRoutes } = require('./routes/proxy');
const { registerOmnirouteRoutes } = require('./routes/omniroute');
const { registerAntigravityRoutes } = require('./routes/antigravity');
const { registerConfigRoutes } = require('./routes/config');
const { registerAccountRoutes } = require('./routes/accounts');
const { registerCodingRatingsRoutes } = require('./routes/coding-ratings');

/**
 * Собирает HTTP-сервер панели. Провайдеры/адаптеры передаются
 * снаружи (CLI — вшитые, тесты — mock-upstream). Значения по умолчанию
 * берутся из config (src/config.js); отдельные параметры его перекрывают.
 */
function createApp({
  config = loadConfig(),
  providers = loadProviders(),
  antigravity,
  googleOauth,
  store,
  allowedOrigins = config.allowedOrigins,
  publicOrigin = config.publicOrigin,
  logger = console,
  providerLogger = logger,
  requestTimeoutMs = 30000,
  authLoopbackPort = String(config.port),
  providerDebug = config.providerDebug,
  agentrouterReleaseHoursUtc = config.agentrouterReleaseHoursUtc,
  codingCachePath = config.codingCachePath,
} = {}) {
  const activeProvider = providers[0] || null;
  // Не перетираем явно переданный antigravity/googleOauth (тесты передают mock).
  const providerLog = normalizeLog(providerLogger);
  const appLog = normalizeLog(logger);
  if (!antigravity) antigravity = createAntigravityProvider({ log: providerLog, debug: providerDebug });
  if (!googleOauth) {
    googleOauth = createGoogleOauth({
      log: providerLog,
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
    });
  }

  // Хранилище ключей/настроек: SQLite на сервере (зашифровано AES-256-GCM).
  // createStore — async, поэтому store может прийти Promise; нормализуем
  // лениво в обработчиках запросов (они async).
  if (!store) {
    store = createStore({ dbPath: config.dbPath, masterKey: config.masterKey || undefined, logger: appLog });
  }
  async function getStore() {
    if (store && typeof store.then === 'function') store = await store;
    return store;
  }

  // ---------- Сервисы ----------
  const antigravityService = createAntigravityService({
    googleOauth,
    antigravity,
    getStore,
    getBuiltinClientId: () => config.googleClientId,
    getBuiltinClientSecret: () => config.googleClientSecret,
  });
  const tracker = createAgentRouterTracker({
    getStore,
    provider: providers.find((p) => p.id === 'agentrouter'),
    storeKey: PROVIDER_STORE_KEYS.agentrouter,
    userField: PROVIDER_STORE_USER_FIELDS.agentrouter,
    balanceKey: AGENTROUTER_DAY_BALANCE_KEY,
  });

  const router = new Router();
  router.add(['GET', 'HEAD'], '/api/health', ({ res }) =>
    sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' }));

  // Готовность: хранилище открыто, последние изменения легли на диск,
  // трекер AgentRouter запущен (если этот провайдер подключён).
  // Наружу — только булевы флаги, подробности сбоя — в логе сервера.
  router.add(['GET', 'HEAD'], '/api/ready', async ({ res }) => {
    let storeStatus = { open: false, persisted: false };
    try {
      storeStatus = (await getStore()).status();
    } catch {}
    const trackerOk = !tracker.enabled || tracker.isRunning();
    const ready = Boolean(storeStatus.open && storeStatus.persisted && trackerOk);
    sendJson(
      res,
      ready ? 200 : 503,
      { ready, store: Boolean(storeStatus.open), persisted: Boolean(storeStatus.persisted), tracker: trackerOk },
      { 'cache-control': 'no-store' }
    );
  });

  router.add(['GET', 'HEAD'], '/api/metrics', ({ res }) =>
    sendJson(res, 200, getMetrics(), { 'cache-control': 'no-store' }));

  // ---------- Маршруты (порядок важен: статика — catch-all в конце) ----------
  registerProviderRoutes(router, {
    providers,
    getStore,
    storeKeys: PROVIDER_STORE_KEYS,
    userFields: PROVIDER_STORE_USER_FIELDS,
    getDayBalanceUsd: tracker.getDayBalanceUsd,
    logger: appLog,
  });
  registerProxyRoutes(router, { providers, activeProvider, logger: providerLog, debug: providerDebug });
  registerOmnirouteRoutes(router, { getStore, validateUpstreamUrl, logger: appLog });
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
    agentrouterReleases: {
      timezone: AGENTROUTER_POOL_RELEASE_TIMEZONE,
      hoursUtc: agentrouterReleaseHoursUtc,
    },
  });
  registerAccountRoutes(router, { getStore });
  registerCodingRatingsRoutes(router, { getStore, logger: appLog, cachePath: codingCachePath });
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
      // Используем метод *File, чтобы писать только в файл, не дублируя в консоль
      const fn = typeof logger[level + 'File'] === 'function' ? logger[level + 'File'].bind(logger) : null;
      const method = req.method || '?';
      if (fn) fn(`[access] ${method} ${requestPath(req)} → ${res.statusCode} (${Date.now() - startedAt} ms)`);
    });
    handleRequest(req, res).catch((err) => handleError(err, req, res, context, logger));
  });

  // ---------- Lifecycle: трекер, снимок, graceful close ----------
  server.startDailyAgentRouterTracker = () => tracker.start();
  server.snapshotAgentRouterDayBalance = () => tracker.snapshotDayBalance();

  let storeClosing = null;
  function closeStore() {
    if (!storeClosing) {
      storeClosing = getStore().then((s) => {
        if (s && typeof s.close === 'function') return s.close();
      });
    }
    return storeClosing;
  }

  // close(cb): перестать принимать соединения, дождаться их закрытия и
  // сброса хранилища на диск; ошибка сохранения уходит в callback.
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    tracker.stop();
    originalClose((closeErr) => {
      const serverErr = closeErr && closeErr.code !== 'ERR_SERVER_NOT_RUNNING' ? closeErr : null;
      closeStore().then(
        () => callback && callback(serverErr || undefined),
        (storeErr) => callback && callback(storeErr)
      );
    });
    return server;
  };

  /** Graceful shutdown для CLI: промис завершается после закрытия
   * соединений и хранилища; отклоняется, если данные не сохранились. */
  server.shutdown = () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeIdleConnections();
    });

  return server;
}

module.exports = { createApp };
