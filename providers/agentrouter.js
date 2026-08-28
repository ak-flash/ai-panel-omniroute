'use strict';

// ============================================================
// Провайдер AgentRouter (agentrouter.org) — фабрика адаптера.
//
// Сайт работает на new-api: баланс кошелька лежит в профиле
// пользователя — GET /api/user/self возвращает { success, data },
// где data.quota — остаток во внутренних единицах; $1 = 500000
// единиц (quota_per_unit из GET /api/status этого сайта).
//
// Пока поддерживается только баланс кошелька. Авторизация — двойная:
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

// $1 = 500000 внутренних единиц (quota_per_unit из /api/status AgentRouter)
const QUOTA_PER_UNIT = 500000;

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

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
 *   getUsage(key, userId) → GET /api/user/self (баланс кошелька)
 *   getModels()           → каталог моделей пока не подключён (501)
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

  // Авторизация: Authorization: Bearer <access-токен> + New-Api-User <id>
  const authScheme = 'authorization';
  const buildHeaders = (key, userId) => {
    const headers = key ? { authorization: 'Bearer ' + key } : {};
    const uid = String(userId || configUserId || '').trim();
    if (uid) headers['new-api-user'] = uid;
    return headers;
  };

  async function apiGet(pathname, key = '', userId = '') {
    const headers = buildHeaders(key || apiKey, userId);
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

  // GET /api/user/self → { success, data: { quota, group, … } }
  async function getUsage(key = '', userId = '') {
    const { status, data } = await apiGet('/api/user/self', key, userId);

    // new-api на неудачной авторизации ведёт себя по-разному: без
    // заголовка — HTTP 401, с невалидным токеном — HTTP 200 +
    // success:false (проверено на живом сайте). Наружу — понятная
    // подсказка с оригинальным сообщением сайта.
    const upstreamMsg =
      data && typeof data.message === 'string' ? data.message : '';
    const authFailed =
      status === 401 || (status === 200 && data && data.success === false);
    if (authFailed) {
      // Причина отклонения от new-api (китайский текст) — только в лог сервера
      if (upstreamMsg) console.warn('[AgentRouter] токен отклонён:', upstreamMsg);
      // Разные причины отклонения — разные подсказки (проверено на живом
      // сайте): токен не найден / нет заголовка New-Api-User / ID не совпал
      const message = /New-Api-User/i.test(upstreamMsg)
        ? 'Сайту нужен ещё и числовой ID пользователя — укажите его в настройках AgentRouter в поле «User ID»'
        : /不匹配/.test(upstreamMsg)
          ? 'ID пользователя не совпадает с владельцем токена — проверьте поле «User ID» в настройках AgentRouter'
          : 'Сайт не принял токен — нужен System Access Token из Security Settings на agentrouter.org, API-ключ sk-… не подходит';
      return {
        status: 401,
        data: { error: 'unauthorized', message },
      };
    }
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

  // Каталог моделей пока не подключается (только баланс кошелька)
  async function getModels() {
    return {
      status: 501,
      data: {
        error: 'not_implemented',
        message: 'Каталог моделей AgentRouter пока не подключён',
      },
    };
  }

  return {
    id: 'agentrouter',
    name,
    upstream,
    apiKey,
    authScheme,
    buildHeaders,
    getUsage,
    getModels,
  };
}

module.exports = { createAgentRouterProvider };
