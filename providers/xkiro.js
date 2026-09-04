// ============================================================
// Провайдер xKiro — фабрика адаптера для работы с его API.
//
// Окружение не используется: адрес API вшит (DEFAULT_URL), ключ
// всегда присылает клиент. config нужен тестам (подмена адреса на
// mock-upstream) и будущим вшитым провайдерам.
// ============================================================

const { fetchJson } = require('../src/fetch-utils');

const DEFAULT_NAME = 'xKiro';
const DEFAULT_URL = 'https://api.xkiro.com'; // вшит в фабрику — не выносится в настройки

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Создаёт адаптер провайдера xKiro.
 *
 * config:
 *   name   — отображаемое имя
 *   url    — базовый адрес API (тесты подменяют на mock-upstream)
 *   apiKey — ключ адаптера; по умолчанию пуст — ключ присылает клиент
 *
 * Адаптер предоставляет функции взаимодействия с API:
 *   getUsage(key)  → GET /v1/usage  (кошелёк, окна расхода, free-токены)
 *   getModels(key) → GET /v1/models (каталог моделей)
 *
 * Каждый метод возвращает { status, data }: код ответа upstream и его JSON
 * как есть — данные в формате xKiro рендерит фронтенд.
 * Ключ из аргумента приоритетнее ключа из config.
 */
function createXKiroProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  // Диагностика уходит в log из config (в CLI — файловый логгер,
  // см. src/file-logger.js); по умолчанию — консоль (тесты, dev)
  const log = typeof config.log === 'function' ? config.log : console.warn;
  const debug = config.debug === true;

  // xKiro авторизует запросы заголовком x-api-key
  const authScheme = 'x-api-key';
  const buildHeaders = (key) => (key ? { 'x-api-key': key } : {});

  async function apiGet(pathname, key = '') {
    const headers = { accept: 'application/json', ...buildHeaders(key || apiKey) };
    const startedAt = Date.now();
    if (debug) {
      const safeHeaders = { ...headers };
      if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = '***';
      log.info(`[xKiro] ${pathname}`, { headers: safeHeaders });
    }
    try {
      const { response, data } = await fetchJson(upstream + pathname, { headers }, REQUEST_TIMEOUT_MS);
      if (debug) {
        log.info(`[xKiro] ${pathname} → ${response.status} (${Date.now() - startedAt} ms)`);
      }
      return { status: response.status, data: data || {} };
    } catch (error) {
      if (error.code === 'upstream_invalid_json') {
        // Не-JSON вместо JSON — обычно HTML-заглушка защиты (Cloudflare и
        // т.п.) или страница ошибки: показываем статус и content-type
        // upstream в интерфейсе панели, а тело заглушки (одной строкой,
        // с обрезкой) — в лог сервера, по нему видно, кто отвечает.
        const { status, contentType, snippet } = error.details;
        log(
          `[xKiro] ${pathname}: не-JSON ответ (HTTP ${status}, ${contentType}):`,
          snippet || '(пустое тело)',
        );
        return {
          status: 502,
          data: {
            error: 'bad_response',
            message: `Провайдер вернул не-JSON ответ (HTTP ${status}, ${contentType})`,
          },
        };
      }
      // Ошибка сети / DNS / таймаут
      const msg = error.message || 'Ошибка запроса';
      const cause = error.cause instanceof Error ? error.cause.message : '';
      log(`[xKiro] ${pathname}: сеть/таймаут — ${msg}${cause ? ' (причина: ' + cause + ')' : ''}`);
      return {
        status: 502,
        data: {
          error: 'provider_error',
          message: msg,
        },
      };
    }
  }

  return {
    id: 'xkiro',
    name,
    site: 'https://xkiro.com/dashboard',
    upstream,
    apiKey,
    authScheme,
    buildHeaders,
    // Функции взаимодействия с API xKiro
    getUsage: (key) => apiGet('/v1/usage', key),
    getModels: (key) => apiGet('/v1/models', key),
  };
}

module.exports = { createXKiroProvider };
