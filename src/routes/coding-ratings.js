'use strict';

const { AppError, readJson, sendJson } = require('../http');
const { getCodingRatings, refreshCodingRatings } = require('../coding-ratings');

/**
 * Ключ OpenRouter для обновления рейтинга. Приоритет:
 *   1) заголовок x-openrouter-api-key / x-api-key (клиент, проверка ключа);
 *   2) тело { apiKey } / { openrouter_api_key } / { key };
 *   3) ключ провайдера OpenRouter из серверного хранилища
 *      (активный аккаунт → legacy-поле openrouterKey).
 */
async function resolveOpenRouterKey({ req, getStore }) {
  const apiKey = req.headers['x-openrouter-api-key']
    || req.headers['x-api-key']
    || '';
  if (apiKey) return apiKey;
  if (req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (body && (body.apiKey || body.openrouter_api_key || body.key)) {
        return body.apiKey || body.openrouter_api_key || body.key;
      }
    } catch { /* тело не JSON — берём ключ из хранилища */ }
  }
  try {
    const st = await getStore();
    if (st.accounts && typeof st.accounts.getActiveCredential === 'function') {
      const active = await st.accounts.getActiveCredential('openrouter');
      if (active && (active.api_key || active.key)) return active.api_key || active.key;
    }
    const s = await st.snapshot();
    if (s && s.openrouterKey) return s.openrouterKey;
  } catch { /* нет хранилища — фолбэк ниже */ }
  return '';
}

function registerCodingRatingsRoutes(router, { getStore, logger = console } = {}) {
  router.add(['GET', 'HEAD'], '/api/coding-ratings', async ({ res }) => {
    const data = await getCodingRatings();
    return sendJson(res, 200, data, { 'cache-control': 'no-store' });
  });

  router.add(['POST'], '/api/coding-ratings/refresh', async ({ req, res }) => {
    // Ключ можно прислать с запросом; иначе сервер берёт сохранённый
    // ключ провайдера OpenRouter из настроек.
    const apiKey = await resolveOpenRouterKey({ req, getStore });
    try {
      const fresh = await refreshCodingRatings({ apiKey });
      return sendJson(res, 200, fresh, { 'cache-control': 'no-store' });
    } catch (err) {
      const status = err.status || 502;
      const code = err.code || 'refresh_failed';
      logger.warn && logger.warn('[coding-ratings] refresh failed: ' + err.message);
      throw new AppError(status, code, err.message);
    }
  });
}

module.exports = { registerCodingRatingsRoutes, resolveOpenRouterKey };