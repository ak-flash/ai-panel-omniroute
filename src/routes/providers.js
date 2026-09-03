'use strict';

// ============================================================
// Маршруты провайдеров: /api/providers/<id>/usage и /models.
//
// Ключ берётся из заголовков клиента (x-api-key, для AgentRouter —
// ещё x-agentrouter-user-id); отсутствующие поля добираются из
// серверного хранилища (фолбэк). Ответ адаптера уходит клиенту
// как есть; для AgentRouter добавляется стартовый баланс дня.
// ============================================================

const { AppError, sendJson } = require('../../http');

function registerProviderRoutes(router, {
  providers,
  getStore,
  storeKeys,
  userFields,
  getDayBalanceUsd,
  logger = console,
}) {
  async function handle(action, { req, res, params }) {
    const provider = providers.find((p) => p.id === params.id);
    if (!provider) throw new AppError(404, 'unknown_provider', 'Провайдер не найден');

    let clientKey = req.headers['x-api-key'] || '';
    let clientUserId = req.headers['x-agentrouter-user-id'] || '';
    if (!clientKey || !clientUserId) {
      try {
        const s = await (await getStore()).snapshot();
        const storeField = storeKeys[params.id];
        if (!clientKey && storeField && s[storeField]) clientKey = s[storeField];
        const userField = userFields[params.id];
        if (!clientUserId && userField && s[userField]) clientUserId = s[userField];
      } catch {}
    }

    const fn = action === 'usage' ? provider.getUsage : provider.getModels;
    const result = await fn(clientKey, clientUserId);
    if (result.status === 502 || result.status === 0) {
      logger.warn(
        `[providers] ${params.id} ${action}: HTTP ${result.status}` +
          (result.data && result.data.message ? ` — ${result.data.message}` : ''),
      );
    }
    if (result.status === 200 && params.id === 'agentrouter' && result.data) {
      const dayBal = await getDayBalanceUsd();
      if (dayBal !== null) result.data.day_balance_usd = dayBal;
    }
    return sendJson(res, result.status, result.data, { 'cache-control': 'no-store' });
  }

  router.add(['GET', 'HEAD'], '/api/providers/:id/usage', handle.bind(null, 'usage'));
  router.add(['GET', 'HEAD'], '/api/providers/:id/models', handle.bind(null, 'models'));
}

module.exports = { registerProviderRoutes };
