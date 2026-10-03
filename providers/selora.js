'use strict';

// ============================================================
// Провайдер Selora (selora.lol, «AI API Gateway») — фабрика адаптера.
//
// Окружение не используется: адрес API вшит (DEFAULT_URL), ключ
// всегда присылает клиент. config нужен тестам (подмена адреса на
// mock-upstream).
//
// Эндпоинты:
//   GET /v1/me          → профиль: план, кошелёк, окна (план, fallback)
//   GET /v1/me/windows  → окна расхода: session (4 ч) и week (7 д)
//   GET /v1/models      → каталог моделей с ценами за 1M токенов
//
// Авторизация: x-api-key <sk-gw-…> (принимается и Bearer).
// Ответы нормализуются в формат панели (как у xKiro):
//   usage → { plan, wallet: { balance_usd }, windows: [{ kind, … }] }
//   models → { data: [{ id, display_name, pricing: { input, output } }] }
// ============================================================

const { createProviderClient, apiKeyAuth } = require('../src/provider-client');
const { getDescriptor } = require('../src/provider-descriptors');

const descriptor = /** @type {import('../src/provider-descriptors').ProviderDescriptor} */ (
  getDescriptor('selora')
);
const DEFAULT_NAME = descriptor.name;
const DEFAULT_URL = 'https://api.selora.lol'; // вшит в фабрику — не выносится в настройки

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

// Длительности окон Selora: короткое — 4-часовая сессия,
// длинное — скользящая неделя
const SHORT_WINDOW_SEC = 4 * 3600;
const LONG_WINDOW_SEC = 7 * 24 * 3600;

const UNAUTHORIZED = {
  error: 'unauthorized',
  message: 'Selora не принял ключ — проверьте его в Настройках → Провайдер → Selora',
};

/**
 * Создаёт адаптер провайдера Selora.
 *
 * config:
 *   name   — отображаемое имя
 *   url    — базовый адрес API (тесты подменяют на mock-upstream)
 *   apiKey — ключ адаптера; по умолчанию пуст — ключ присылает клиент
 *
 * Каждый метод возвращает { status, data }: код ответа upstream и
 * нормализованный JSON в формате панели. Ключ из аргумента
 * приоритетнее ключа из config.
 */
function createSeloraProvider(config = {}) {
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

  // Selora авторизует запросы заголовком x-api-key (Bearer тоже принимается)
  const authScheme = 'x-api-key';
  const buildHeaders = key => apiKeyAuth().buildHeaders({ key });

  const toNum = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Первое непустое поле из списка (окна приходят camelCase из
  // /v1/me/windows и snake_case из user.windows в /v1/me)
  const pick = (obj, fields) => {
    for (const f of fields) {
      const v = obj && obj[f];
      if (v != null && v !== '') return v;
    }
    return null;
  };

  /**
   * Окно расхода Selora → формат панели. Секунды до сброса берутся
   * из resetsInMs (число) или resetsAt (ISO-строка).
   */
  function normalizeWindow(raw, kind, windowSec) {
    const spent = pick(raw, ['usedUsd', 'used_usd']);
    const cap = pick(raw, ['limitUsd', 'limit_usd']);
    let resetsInSec = 0;
    const ms = pick(raw, ['resetsInMs', 'resets_in_ms']);
    if (ms != null) {
      resetsInSec = Math.max(0, Math.floor(toNum(ms) / 1000));
    } else {
      const at = Date.parse(String(pick(raw, ['resetsAt', 'resets_at']) || ''));
      if (Number.isFinite(at)) resetsInSec = Math.max(0, Math.floor((at - Date.now()) / 1000));
    }
    return {
      kind,
      spent_usd: spent == null ? 0 : toNum(spent),
      // limitUsd "0" — окно без лимита: фронтенд не показывает процент
      cap_usd: cap == null ? 0 : toNum(cap),
      window_sec: windowSec,
      resets_in_sec: resetsInSec,
    };
  }

  // GET /v1/me + /v1/me/windows → статистика в формате панели
  async function getUsage(key = '') {
    const credential = { key: key || apiKey };
    const [meRes, winRes] = await Promise.all([
      client.get('/v1/me', { credential }),
      client.get('/v1/me/windows', { credential }),
    ]);

    // 401 от любого эндпоинта — ключ не принят
    if (meRes.status === 401 || winRes.status === 401) {
      return { status: 401, data: { ...UNAUTHORIZED } };
    }
    if (meRes.status !== 200) return meRes;

    const me = meRes.data && typeof meRes.data === 'object' ? meRes.data : {};
    const user = me.user && typeof me.user === 'object' ? me.user : {};
    const plan = me.plan && typeof me.plan === 'object' ? me.plan : {};
    const wallet = me.wallet && typeof me.wallet === 'object' ? me.wallet : {};

    const balanceRaw = wallet.balance != null ? wallet.balance : user.balance_usd;
    const balance = balanceRaw != null ? toNum(balanceRaw) : null;

    // Окна: приоритет — /v1/me/windows (использование/лимит/сброс);
    // 404 или сбой — фолбэк на краткие окна из профиля (used_usd/limit_usd)
    let sessionRaw;
    let weekRaw;
    if (winRes.status === 200) {
      const w = winRes.data && typeof winRes.data === 'object' ? winRes.data : {};
      sessionRaw = w.session || null;
      weekRaw = w.week || null;
    } else {
      const uw = user.windows && typeof user.windows === 'object' ? user.windows : {};
      sessionRaw = uw.session || null;
      weekRaw = uw.week || null;
    }

    const windows = [];
    if (sessionRaw) windows.push(normalizeWindow(sessionRaw, 'short', SHORT_WINDOW_SEC));
    if (weekRaw) windows.push(normalizeWindow(weekRaw, 'long', LONG_WINDOW_SEC));

    return {
      status: 200,
      data: {
        plan: plan.name || user.plan_id || '',
        wallet: { balance_usd: balance },
        windows,
        free_tokens: null,
      },
    };
  }

  // GET /v1/models → { models: […] } → каталог в формате панели
  async function getModels(key = '') {
    const { status, data } = await client.get('/v1/models', {
      credential: { key: key || apiKey },
    });
    if (status === 401) {
      return { status: 401, data: { ...UNAUTHORIZED } };
    }
    if (status !== 200) return { status, data };

    const raw = Array.isArray(data.models)
      ? data.models
      : Array.isArray(data.data)
        ? data.data
        : null;
    if (!raw) {
      return {
        status: 502,
        data: {
          error: 'bad_response',
          message: 'В ответе /v1/models нет списка моделей',
        },
      };
    }
    const models = raw
      .filter(m => m && typeof m.id === 'string' && m.id)
      .map(m => {
        const pricing = m.pricing || {};
        const input = Number(pricing.input_per_1m);
        const output = Number(pricing.output_per_1m);
        return {
          id: m.id,
          display_name: m.display_name || m.id,
          access_tier: 'paid',
          // У Selora нет поля контекста — только признак 1M-контекста
          context_length: m.supports_1m_context === true ? 1000000 : null,
          pricing: {
            input: Number.isFinite(input) && input > 0 ? input : null,
            output: Number.isFinite(output) && output > 0 ? output : null,
          },
        };
      });
    return { status: 200, data: { data: models } };
  }

  return {
    id: 'selora',
    name,
    site: descriptor.site,
    upstream: client.upstream,
    apiKey,
    authScheme,
    buildHeaders,
    getUsage,
    getModels,
  };
}

module.exports = { createSeloraProvider };
