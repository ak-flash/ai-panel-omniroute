'use strict';

// ============================================================
// Маршруты провайдеров: /api/providers/<id>/usage и /models.
//
// Ключ берётся из заголовков клиента (x-api-key, для AgentRouter —
// ещё x-agentrouter-user-id); отсутствующие поля добираются из
// серверного хранилища (фолбэк). Ответ адаптера уходит клиенту
// как есть; для AgentRouter добавляется стартовый баланс дня.
//
// Ответы провайдера кешируются на сервере (src/ttl-cache.js), а
// одинаковые параллельные запросы объединяются в один поход в
// upstream: страница и трекер не устраивают провайдеру всплесков
// запросов, на которые тот отвечает 429 (P3-3).
// ============================================================

const { AppError, sendJson } = require('../http');
const { recordCache, recordProvider } = require('../metrics');
const { createTtlCache, fingerprint } = require('../ttl-cache');

function registerProviderRoutes(
  router,
  {
    providers,
    getStore,
    storeKeys,
    userFields,
    getDayBalanceUsd,
    usageCacheTtlMs = 30_000,
    modelsCacheTtlMs = 10 * 60_000,
    now = () => Date.now(),
    logger = console,
  }
) {
  const usageCache = createTtlCache({ ttlMs: usageCacheTtlMs, now });
  const modelsCache = createTtlCache({ ttlMs: modelsCacheTtlMs, now });

  /**
   * @param {string} action
   * @param {{req: import('http').IncomingMessage, res: import('http').ServerResponse, params: Record<string, string>}} ctx
   */
  async function handle(action, { req, res, params }) {
    const provider = providers.find(p => p.id === params.id);
    if (!provider) throw new AppError(404, 'unknown_provider', 'Провайдер не найден');

    let clientKey = req.headers['x-api-key'] || '';
    let clientUserId = req.headers['x-agentrouter-user-id'] || '';
    if (!clientKey || !clientUserId) {
      try {
        const st = await getStore();
        const active = await st.accounts.getActiveCredential(params.id);
        if (active) {
          if (!clientKey) clientKey = active.api_key || active.key || '';
          if (!clientUserId) clientUserId = active.user_id || '';
        }
        if (!clientKey || !clientUserId) {
          const s = await st.snapshot();
          const storeField = storeKeys[params.id];
          const userField = userFields[params.id];
          if (!clientKey && storeField) clientKey = s[storeField] || '';
          if (!clientUserId && userField) clientUserId = s[userField] || '';
        }
      } catch (e) {
        // Фолбэк учётных данных не сработал — запрос уйдёт без ключа или 401
        try {
          logger.warn('[providers] фолбэк ключа из хранилища не удался', {
            event: 'provider_store_fallback_failed',
            provider: params.id,
            reason: e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : 'unknown',
          });
        } catch {}
      }
    }

    const fn = action === 'usage' ? provider.getUsage : provider.getModels;
    const cache = action === 'usage' ? usageCache : modelsCache;
    // Ключ кеша — отпечаток учётных данных: смена ключа или аккаунта
    // даёт другую запись, а сам секрет в памяти не хранится.
    const cacheKey = `${params.id}:${fingerprint(clientKey)}:${fingerprint(clientUserId)}`;
    recordProvider(params.id);
    // Чтение без записи: если запись уже в кеше — это hit, иначе miss.
    recordCache(cache.peek(cacheKey) !== undefined ? 'hit' : 'miss');
    let result = await cache.get(
      cacheKey,
      () => fn(clientKey, clientUserId),
      // Успех живёт usageCacheTtlMs/modelsCacheTtlMs, неуспех — короткий
      // errorTtlMs (5 с): 429 от антибот-файрвола не должен превращаться
      // в поток повторных попыток, но и залипать надолго не должен.
      value => Boolean(value) && value.status === 200
    );
    if (result.status === 502 || result.status === 0) {
      logger.warn(
        `[providers] ${params.id} ${action}: HTTP ${result.status}` +
          (result.data && result.data.message ? ` — ${result.data.message}` : '')
      );
    }
    if (result.status === 200 && params.id === 'agentrouter' && result.data) {
      const dayBal = await getDayBalanceUsd();
      if (dayBal !== null) {
        // Копия: запись в кеше не должна зависеть от баланса дня
        result = { status: result.status, data: { ...result.data, day_balance_usd: dayBal } };
      }
    }
    return sendJson(res, result.status, result.data, { 'cache-control': 'no-store' });
  }

  router.add(['GET', 'HEAD'], '/api/providers/:id/usage', handle.bind(null, 'usage'));
  router.add(['GET', 'HEAD'], '/api/providers/:id/models', handle.bind(null, 'models'));

  /** Сброс кеша: весь или по провайдеру (после смены ключей/аккаунтов). */
  function invalidateCache(providerId = '') {
    if (!providerId) {
      usageCache.invalidate();
      modelsCache.invalidate();
      return;
    }
    const prefix = providerId + ':';
    for (const cache of [usageCache, modelsCache]) {
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.invalidate(key);
      }
    }
  }

  return {
    invalidateCache,
    stats: () => ({ usage: usageCache.stats(), models: modelsCache.stats() }),
  };
}

module.exports = { registerProviderRoutes };
