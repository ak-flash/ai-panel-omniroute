'use strict';

// ============================================================
// Провайдер AgentRouter (agentrouter.org) — фабрика адаптера.
//
// Сайт работает на new-api: баланс кошелька лежит в профиле
// пользователя — GET /api/user/self возвращает { success, data },
// где data.quota — остаток во внутренних единицах; $1 = 500000
// единиц (quota_per_unit из GET /api/status этого сайта).
//
// Баланс кошелька и каталог моделей. Авторизация — двойная:
// System Access Token (Security Settings) в Authorization Bearer +
// числовой ID пользователя заголовком New-Api-User (анти-кража токенов
// в новых версиях new-api). API-ключ (sk-…) не подходит — он
// авторизует только relay-маршруты /v1/*.
//
// Окружение не используется: адрес API вшит, ключ и ID всегда присылает
// клиент. config нужен тестам (подмена адреса на mock-upstream).
// ============================================================

const DEFAULT_NAME = 'AgentRouter';
const DEFAULT_URL = 'https://agentrouter.org'; // вшит в фабрику — не выносится в настройки

const { fetchJson } = require('../src/fetch-utils');

// $1 = 500000 внутренних единиц (quota_per_unit из /api/status AgentRouter)
const QUOTA_PER_UNIT = 500000;

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

// CDN периодически отдаёт HTML-заглушку с HTTP 200 вместо JSON. Повторяем
// такой запрос сразу: это временный сбой upstream, а не невалидный токен.
const NON_JSON_RETRY_COUNT = 2;

/**
 * Создаёт адаптер провайдера AgentRouter.
 *
 * config:
 *   name   — отображаемое имя
 *   url    — базовый адрес API (тесты подменяют на mock-upstream)
 *   apiKey — ключ адаптера; по умолчанию пуст — ключ присылает клиент
 *   userId — числовой ID пользователя (New-Api-User); тоже от клиента
 *
 * Адаптер предоставляет функции взаимодействия с API:
 *   getUsage(key, userId)  → GET /api/user/self (баланс кошелька)
 *   getModels(key, userId) → GET /api/user/models (каталог моделей)
 *
 * Успешный ответ нормализуется в формат панели (как у xKiro):
 *   { plan, wallet: { balance_usd }, windows: [], used_usd, requests }
 * Ключ и ID из аргументов приоритетнее значений из config.
 */
function createAgentRouterProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  const configUserId = config.userId || '';
  // Диагностика уходит в log из config (в CLI — файловый логгер,
  // см. src/file-logger.js); по умолчанию — консоль (тесты, dev)
  const log = typeof config.log === 'function' ? config.log : console.warn;
  const debug = config.debug === true;

  // Авторизация: Authorization: Bearer <access-токен> + New-Api-User <id>
  const authScheme = 'authorization';
  const buildHeaders = (key, userId) => {
    const headers = key ? { authorization: 'Bearer ' + key } : {};
    const uid = String(userId || configUserId || '').trim();
    if (uid) headers['new-api-user'] = uid;
    return headers;
  };

  async function apiGet(pathname, key = '', userId = '') {
    const headers = {
      accept: 'application/json',
      'user-agent': 'AI-Panel/0.1 (+https://agentrouter.org)',
      ...buildHeaders(key || apiKey, userId),
    };
    const startedAt = Date.now();
    if (debug) {
      const safeHeaders = { ...headers };
      if (safeHeaders.authorization) safeHeaders.authorization = 'Bearer ***';
      if (safeHeaders['new-api-user']) safeHeaders['new-api-user'] = '***';
      log.info(`[AgentRouter] ${pathname}`, { headers: safeHeaders });
    }

    for (let attempt = 0; attempt <= NON_JSON_RETRY_COUNT; attempt += 1) {
      try {
        const { response, data } = await fetchJson(upstream + pathname, { headers }, REQUEST_TIMEOUT_MS);
        if (debug) {
          log.info(`[AgentRouter] ${pathname} → ${response.status} (${Date.now() - startedAt} ms)`);
        }
        return { status: response.status, data: data || {} };
      } catch (error) {
        if (error.code === 'upstream_invalid_json') {
          const { status, contentType, snippet } = error.details;
          // Не-JSON с HTTP 200 обычно является временной HTML-заглушкой
          // CDN/WAF. Повторять HTTP-ошибки нельзя: их статус уже описывает
          // постоянную для этого запроса проблему.
          if (status === 200 && attempt < NON_JSON_RETRY_COUNT) {
            log(
              `[AgentRouter] ${pathname}: не-JSON ответ (HTTP ${status}, ${contentType}) —` +
                ` повтор ${attempt + 1} из ${NON_JSON_RETRY_COUNT}`,
            );
            continue;
          }

          // Тело заглушки — в консоль сервера (одной строкой, с обрезкой):
          // по нему видно, кто отвечает (Cloudflare, страница провайдера,
          // анти-бот проверка), а в интерфейс панели HTML-мусор не попадает.
          log(
            `[AgentRouter] ${pathname}: не-JSON ответ (HTTP ${status}, ${contentType}):`,
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
        log(`[AgentRouter] ${pathname}: сеть/таймаут — ${msg}`);
        return {
          status: 502,
          data: {
            error: 'provider_error',
            message: msg,
          },
        };
      }
    }
  }

  // new-api на неудачной авторизации ведёт себя по-разному: без
  // заголовка — HTTP 401, с невалидным токеном — HTTP 200 +
  // success:false (проверено на живом сайте). Наружу — понятная
  // подсказка с оригинальным сообщением сайта; причина отклонения
  // (китайский текст) — только в лог.
  const isAuthFailure = (status, data) =>
    status === 401 || (status === 200 && data && data.success === false);

  function authFailure(data) {
    const upstreamMsg = data && typeof data.message === 'string' ? data.message : '';
    if (upstreamMsg) log('[AgentRouter] токен отклонён:', upstreamMsg);
    // Разные причины отклонения — разные подсказки (проверено на живом
    // сайте): токен не найден / нет заголовка New-Api-User / ID не совпал
    const message = /New-Api-User/i.test(upstreamMsg)
      ? 'Сайту нужен ещё и числовой ID пользователя — укажите его в настройках AgentRouter в поле «User ID»'
      : /不匹配/.test(upstreamMsg)
        ? 'ID пользователя не совпадает с владельцем токена — проверьте поле «User ID» в настройках AgentRouter'
        : 'Сайт не принял токен — нужен System Access Token из Security Settings на agentrouter.org, API-ключ sk-… не подходит';
    return { status: 401, data: { error: 'unauthorized', message } };
  }

  // GET /api/user/self → { success, data: { quota, group, … } }
  async function getUsage(key = '', userId = '') {
    const { status, data } = await apiGet('/api/user/self', key, userId);
    if (isAuthFailure(status, data)) return authFailure(data);
    if (status !== 200) return { status, data };

    const user = (data && data.data) || {};
    const quota = Number(user.quota);
    if (!Number.isFinite(quota)) {
      return {
        status: 502,
        data: {
          error: 'bad_response',
          message: 'В ответе /api/user/self нет поля quota',
        },
      };
    }

    // Баланс: quota / 500000, два знака после запятой (82.314942 → 82.31)
    const balance = Math.round((quota / QUOTA_PER_UNIT) * 100) / 100;
    const usedRaw = Number(user.used_quota) / QUOTA_PER_UNIT;
    return {
      status: 200,
      data: {
        plan: user.group || name, // у new-api вместо плана — группа аккаунта
        wallet: { balance_usd: balance },
        windows: [], // окна расхода — только у xKiro
        // Накопительные цифры профиля — для карточки на главной
        used_usd: Number.isFinite(usedRaw) && usedRaw > 0
          ? Math.round(usedRaw * 100) / 100
          : 0,
        requests: Number(user.request_count) || 0,
      },
    };
  }

  // GET /api/user/models → список id моделей, доступных аккаунту
  // (UserAuth — те же заголовки, что у /api/user/self; маршрут есть
  // на живом сайте: без токена отдаёт 401 «未提供 access token»).
  // Каталог в формате панели (как у xKiro): { data: [{ id, access_tier }] };
  // цены и контекст new-api здесь не отдаёт — фронтенд покажет прочерки.
  async function getModels(key = '', userId = '') {
    const { status, data } = await apiGet('/api/user/models', key, userId);
    if (isAuthFailure(status, data)) return authFailure(data);
    if (status !== 200) return { status, data };

    // new-api отдаёт массив строк либо обёртку { data: [...] } —
    // нормализуем оба формата в единый каталог панели
    const raw = Array.isArray(data)
      ? data
      : data && Array.isArray(data.data)
        ? data.data
        : null;
    if (!raw) {
      return {
        status: 502,
        data: {
          error: 'bad_response',
          message: 'В ответе /api/user/models нет списка моделей',
        },
      };
    }
    const ids = raw
      .map((item) => (typeof item === 'string' ? item : item && item.id))
      .filter((id) => typeof id === 'string' && id);
    return {
      status: 200,
      data: { data: ids.map((id) => ({ id, access_tier: 'paid' })) },
    };
  }

  return {
    id: 'agentrouter',
    name,
    site: 'https://agentrouter.org',
    upstream,
    apiKey,
    authScheme,
    buildHeaders,
    getUsage,
    getModels,
  };
}

module.exports = { createAgentRouterProvider };
