'use strict';

const { AppError, readJson, sendJson } = require('../http');
const { createCodingRatings } = require('../coding-ratings');

/**
 * Ключ OpenRouter для обновления рейтинга. Приоритет:
 *   1) заголовок x-openrouter-api-key / x-api-key (клиент, проверка ключа);
 *   2) тело { apiKey } / { openrouter_api_key } / { key };
 *   3) ключ провайдера OpenRouter из серверного хранилища
 *      (активный аккаунт → legacy-поле openrouterKey).
 */
/**
 * @param {{req: import('http').IncomingMessage, getStore: () => Promise<any>}} ctx
 * @returns {Promise<string>}
 */
async function resolveOpenRouterKey({ req, getStore }) {
  const apiKey =
    /** @type {string|undefined} */ (req.headers['x-openrouter-api-key']) ||
    /** @type {string|undefined} */ (req.headers['x-api-key']) ||
    '';
  if (apiKey) return apiKey;
  if (req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (body && (body.apiKey || body.openrouter_api_key || body.key)) {
        return body.apiKey || body.openrouter_api_key || body.key;
      }
    } catch {
      /* тело не JSON — берём ключ из хранилища */
    }
  }
  try {
    const st = await getStore();
    if (st.accounts && typeof st.accounts.getActiveCredential === 'function') {
      const active = await st.accounts.getActiveCredential('openrouter');
      if (active && (active.api_key || active.key)) return active.api_key || active.key;
    }
    const s = await st.snapshot();
    if (s && s.openrouterKey) return s.openrouterKey;
  } catch {
    /* нет хранилища — фолбэк ниже */
  }
  return '';
}

/**
 * @param {{ add: (methods: string[] | string, path: string, handler: Function) => any }} router
 * @param {{ getStore?: () => Promise<any>, logger?: Console, cachePath?: string }} [options]
 */
function registerCodingRatingsRoutes(router, { getStore, logger = console, cachePath } = {}) {
  const { getCodingRatings, refreshCodingRatings } = createCodingRatings({ cachePath, logger });

  router.add(
    ['GET', 'HEAD'],
    '/api/coding-ratings',
    /** @param {{res: import('http').ServerResponse}} ctx */
    async ({ res }) => {
      const data = await getCodingRatings();
      return sendJson(res, 200, data, { 'cache-control': 'no-store' });
    }
  );

  router.add(
    ['POST'],
    '/api/coding-ratings/refresh',
    /** @param {{req: import('http').IncomingMessage, res: import('http').ServerResponse}} ctx */
    async ({ req, res }) => {
      // Ключ можно прислать с запросом; иначе сервер берёт сохранённый
      // ключ провайдера OpenRouter из настроек.
      const apiKey = await resolveOpenRouterKey({
        req,
        getStore: /** @type {() => Promise<any>} */ (getStore),
      });
      try {
        const fresh = await refreshCodingRatings({ apiKey });
        return sendJson(res, 200, fresh, { 'cache-control': 'no-store' });
      } catch (err) {
        const e = /** @type {Error & { code?: string, status?: number, message?: string }} */ (err);
        const status = e.status || 502;
        const code = e.code || 'refresh_failed';
        logger.warn && logger.warn('[coding-ratings] refresh failed: ' + (e.message || ''));
        throw new AppError(status, code, e.message || 'refresh failed');
      }
    }
  );
}

module.exports = { registerCodingRatingsRoutes, resolveOpenRouterKey };
