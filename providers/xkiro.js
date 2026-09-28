'use strict';

// ============================================================
// Провайдер xKiro — фабрика адаптера для работы с его API.
//
// Окружение не используется: адрес API вшит (DEFAULT_URL), ключ
// всегда присылает клиент. config нужен тестам (подмена адреса на
// mock-upstream).
//
// Запросы идёт общий клиент (src/provider-client.js): таймаут,
// коды ошибок и диагностика не-JSON ответов у всех провайдеров
// одинаковые, здесь только адрес и заголовок авторизации.
// ============================================================

const { createProviderClient, apiKeyAuth } = require('../src/provider-client');
const { getDescriptor } = require('../src/provider-descriptors');

const descriptor = getDescriptor('xkiro');
const DEFAULT_NAME = descriptor.name;
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
 *   log    — логгер (по умолчанию консоль: тесты, dev)
 *   debug  — подробный лог запросов к провайдеру
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
  const apiKey = config.apiKey || '';

  const client = createProviderClient({
    // В логах — каноническое имя провайдера, а не подпись из config
    name: descriptor.name,
    upstream: config.url || DEFAULT_URL,
    auth: apiKeyAuth(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    log: config.log,
    debug: config.debug === true,
    fetchImpl: config.fetchImpl,
  });

  // xKiro авторизует запросы заголовком x-api-key
  const authScheme = 'x-api-key';
  const buildHeaders = key => apiKeyAuth().buildHeaders({ key });

  const apiGet = (pathname, key = '') =>
    client.get(pathname, { credential: { key: key || apiKey } });

  return {
    id: 'xkiro',
    name,
    site: descriptor.site,
    upstream: client.upstream,
    apiKey,
    authScheme,
    buildHeaders,
    // Функции взаимодействия с API xKiro
    getUsage: key => apiGet('/v1/usage', key),
    getModels: key => apiGet('/v1/models', key),
  };
}

module.exports = { createXKiroProvider };
