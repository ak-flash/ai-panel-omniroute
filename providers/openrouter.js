// ============================================================
// Провайдер OpenRouter (openrouter.ai) — фабрика адаптера.
//
// Один API-ключ OpenRouter обслуживает и каталог моделей, и
// внешний рейтинг для страницы «Модели» (Artificial Analysis
// Coding Index via OpenRouter Benchmarks API): маршрут
// /api/coding-ratings/refresh берёт ключ этого провайдера из
// серверного хранилища.
//
// Эндпоинты:
//   GET /auth/key  → остаток средств ключа (limit_remaining, баланс)
//   GET /models    → каталог моделей (id, name, context_length,
//                    pricing.prompt/.completion)
//
// Авторизация: Authorization: Bearer <ключ>. Окружение не
// используется: адрес API вшит, ключ всегда присылает клиент
// или достаётся из хранилища маршрутом /api/config. config нужен
// тестам (подмена адреса на mock-upstream).
// ============================================================

const { fetchJson } = require('../src/fetch-utils');
const { normalizeLog } = require('../src/file-logger');

const DEFAULT_NAME = 'OpenRouter';
const DEFAULT_URL = 'https://openrouter.ai/api/v1'; // вшит в фабрику — не выносится в настройки

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Создаёт адаптер провайдера OpenRouter.
 *
 * config:
 *   name   — отображаемое имя
 *   url    — базовый адрес API (тесты подменяют на mock-upstream)
 *   apiKey — ключ адаптера; по умолчанию пуст — ключ присылает клиент
 *
 * Адаптер предоставляет функции взаимодействия с API:
 *   getUsage(key)  → GET /auth/key (кредиты/баланс кошелька)
 *   getModels(key) → GET /models   (каталог моделей в формате панели)
 *
 * Каждый метод возвращает { status, data }: код ответа upstream
 * и нормализованный JSON в формате панели (как у xKiro).
 * Ключ из аргумента приоритетнее ключа из config.
 */
function createOpenRouterProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  // Диагностика уходит в log из config (в CLI — файловый логгер,
  // см. src/file-logger.js); по умолчанию — консоль (тесты, dev)
  const log = normalizeLog(config.log);
  const debug = config.debug === true;

  // OpenRouter авторизует запросы заголовком Authorization: Bearer
  const authScheme = 'authorization';
  const buildHeaders = (key) => (key ? { authorization: 'Bearer ' + key } : {});

  async function apiGet(pathname, key = '') {
    const headers = { accept: 'application/json', ...buildHeaders(key || apiKey) };
    const startedAt = Date.now();
    if (debug) {
      const safeHeaders = { ...headers };
      if (safeHeaders.authorization) safeHeaders.authorization = 'Bearer ***';
      log.info(`[OpenRouter] ${pathname}`, { headers: safeHeaders });
    }
    try {
      const { response, data } = await fetchJson(upstream + pathname, { headers }, REQUEST_TIMEOUT_MS);
      if (debug) {
        log.info(`[OpenRouter] ${pathname} → ${response.status} (${Date.now() - startedAt} ms)`);
      }
      return { status: response.status, data: data || {} };
    } catch (error) {
      // Сеть / DNS / таймаут / не-JSON — наружу 502 с понятным сообщением
      const msg = error instanceof Error ? error.message : String(error);
      log(`[OpenRouter] ${pathname}: сеть/таймаут — ${msg}`);
      return {
        status: 502,
        data: {
          error: 'provider_error',
          message: msg,
        },
      };
    }
  }

  const isAuthFailure = (status) => status === 401;

  // GET /auth/key → { data: { label, limit, limit_remaining, usage, … } }
  async function getUsage(key = '') {
    const { status, data } = await apiGet('/auth/key', key);
    if (isAuthFailure(status)) {
      return {
        status: 401,
        data: {
          error: 'unauthorized',
          message: 'OpenRouter не принял ключ — проверьте его в Настройках → Провайдер → OpenRouter',
        },
      };
    }
    if (status !== 200) return { status, data };

    const info = data && typeof data.data === 'object' && data.data ? data.data : null;
    if (!info) {
      return {
        status: 502,
        data: {
          error: 'bad_response',
          message: 'В ответе /auth/key нет данных о ключе',
        },
      };
    }
    // Остаток средств: limit_remaining (остаток лимита ключа в USD).
    // У ключей без лимита поля нет — считаем как limit − usage; иначе 0.
    const rawRemaining = info.limit_remaining;
    const rawLimit = info.limit;
    const rawUsage = info.usage;
    const rawDaily = info.usage_daily;
    const remaining = rawRemaining != null ? Number(rawRemaining) : null;
    const limit = rawLimit != null ? Number(rawLimit) : null;
    const usage = rawUsage != null ? Number(rawUsage) : null;
    const daily = rawDaily != null ? Number(rawDaily) : null;
    let balance =
      remaining != null && Number.isFinite(remaining)
        ? remaining
        : (limit != null && usage != null && Number.isFinite(limit) && Number.isFinite(usage)
          ? limit - usage
          : 0);
    let used = Number.isFinite(usage) ? usage : 0;
    let today = Number.isFinite(daily) ? daily : 0;

    // limit_remaining и limit оба null → баланс ключа неизвестен;
    // пробуем реальный баланс кошелька через /credits (работает с обычными ключами)
    if (balance === 0 && remaining == null && limit == null) {
      const cr = await apiGet('/credits', key);
      if (cr.status === 200 && cr.data && cr.data.data) {
        const cd = cr.data.data;
        const tc = cd.total_credits != null ? Number(cd.total_credits) : null;
        const tu = cd.total_usage != null ? Number(cd.total_usage) : null;
        if (Number.isFinite(tc) && Number.isFinite(tu)) {
          balance = Math.round((tc - tu) * 100) / 100;
          used = tu;
        }
      }
    }

    return {
      status: 200,
      data: {
        plan: info.label || (info.is_free_tier ? 'Free' : name),
        wallet: { balance_usd: balance },
        windows: [], // окна расхода — только у xKiro
        used_usd: Math.round(used * 100) / 100,
        today_usd: Math.round(today * 100) / 100,
        requests: 0,
      },
    };
  }

  // GET /models → { data: [{ id, name, context_length, pricing: { prompt, completion } }] }
  async function getModels(key = '') {
    const { status, data } = await apiGet('/models', key);
    if (isAuthFailure(status, data)) {
      return {
        status: 401,
        data: {
          error: 'unauthorized',
          message: 'OpenRouter не принял ключ — проверьте его в Настройках → Провайдер → OpenRouter',
        },
      };
    }
    if (status !== 200) return { status, data };

    const raw = Array.isArray(data.data) ? data.data : null;
    if (!raw) {
      return {
        status: 502,
        data: {
          error: 'bad_response',
          message: 'В ответе /models нет списка моделей',
        },
      };
    }
    const models = raw
      .filter((m) => m && typeof m.id === 'string' && m.id)
      .map((m) => {
        const pricing = m.pricing || {};
        const input = Number(pricing.prompt);
        const output = Number(pricing.completion);
        return {
          id: m.id,
          display_name: m.name || m.id,
          // OpenRouter помечает бесплатные модели суффиксом :free
          access_tier: /:free/.test(m.id + ' ' + (m.name || '')) ? 'free' : 'paid',
          context_length: m.context_length,
          pricing: {
            input: Number.isFinite(input) ? input : 0,
            output: Number.isFinite(output) ? output : 0,
          },
        };
      });
    return { status: 200, data: { data: models } };
  }

  return {
    id: 'openrouter',
    name,
    site: 'https://openrouter.ai',
    upstream,
    apiKey,
    authScheme,
    buildHeaders,
    getUsage,
    getModels,
  };
}

module.exports = { createOpenRouterProvider };