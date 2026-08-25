// ============================================================
// Провайдер xKiro — фабрика адаптера для работы с его API.
//
// Переменные .env (префикс XKIRO_):
//   XKIRO_NAME    — отображаемое имя (по умолчанию xKiro)
//   XKIRO_API_URL — адрес API (по умолчанию https://api.xkiro.com)
//   XKIRO_API_KEY — ключ; если пуст, ключ присылает клиент
// ============================================================

const DEFAULT_NAME = 'xKiro';
const DEFAULT_URL = 'https://api.xkiro.com'; // вшит в фабрику — не выносится в настройки

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Создаёт адаптер провайдера xKiro.
 *
 * config:
 *   name   — отображаемое имя
 *   url    — базовый адрес API
 *   apiKey — ключ из .env (может быть пустым)
 *
 * Адаптер предоставляет функции взаимодействия с API:
 *   getUsage(key)  → GET /v1/usage  (кошелёк, окна расхода, free-токены)
 *   getModels(key) → GET /v1/models (каталог моделей)
 *
 * Каждый метод возвращает { status, data }: код ответа upstream и его JSON
 * как есть — данные в формате xKiro рендерит фронтенд.
 * Ключ из аргумента приоритетнее ключа из .env.
 */
function createXKiroProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey || '';

  // xKiro авторизует запросы заголовком x-api-key
  const authScheme = 'x-api-key';
  const buildHeaders = (key) => (key ? { 'x-api-key': key } : {});

  async function apiGet(pathname, key = '') {
    const headers = buildHeaders(key || apiKey);
    try {
      const response = await fetch(upstream + pathname, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const text = await response.text();
      if (!text) return { status: response.status, data: {} };

      try {
        return { status: response.status, data: JSON.parse(text) };
      } catch {
        return {
          status: 502,
          data: {
            error: 'bad_response',
            message: 'Провайдер вернул не-JSON ответ',
          },
        };
      }
    } catch (err) {
      // Ошибка сети / DNS / таймаут
      return {
        status: 502,
        data: {
          error: 'provider_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    id: 'xkiro',
    name,
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
