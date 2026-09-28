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
// Отличие от остальных: CDN здесь периодически отдаёт HTML-заглушку
// с HTTP 200 вместо JSON, поэтому клиенту разрешены повторы (P2-1).
//
// Окружение не используется: адрес API вшит, ключ и ID всегда присылает
// клиент. config нужен тестам (подмена адреса на mock-upstream).
// ============================================================

const { createProviderClient, bearerAuth } = require('../src/provider-client');
const { getDescriptor } = require('../src/provider-descriptors');

const descriptor = getDescriptor('agentrouter');
const DEFAULT_NAME = descriptor.name;
const DEFAULT_URL = 'https://agentrouter.org'; // вшит в фабрику — не выносится в настройки

// $1 = 500000 внутренних единиц (quota_per_unit из /api/status AgentRouter)
const QUOTA_PER_UNIT = 500000;

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

// График высвобождения пула ресурсов (модели Claude и GPT) — по объявлению
// провайдера: Пекин 10:00 / 19:00, что соответствует UTC 02:00 / 11:00.
// Часы храним в UTC: расчёт «следующего высвобождения» не зависит от
// часового пояса панели, а браузер сам переводит момент в локальное
// время пользователя.
const AGENTROUTER_POOL_RELEASE_HOURS_UTC = [2, 11];
// Якорный часовой пояс графика — Пекин (UTC+8, без перевода часов).
const AGENTROUTER_POOL_RELEASE_TIMEZONE = 'Asia/Shanghai';

/** Разбирает значение env (AGENTROUTER_RELEASE_HOURS_UTC): «0,8,16» → [0,8,16].
 *  Часы 0..23, дубли отбрасываются, порядок сортируется. Пустой или
 *  полностью невалидный ввод → дефолтный график провайдера. */
function parsePoolReleaseHours(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return AGENTROUTER_POOL_RELEASE_HOURS_UTC;
  const seen = new Set();
  for (const part of raw.split(',')) {
    const h = Number(part.trim());
    if (Number.isInteger(h) && h >= 0 && h <= 23 && !seen.has(h)) seen.add(h);
  }
  return seen.size ? [...seen].sort((a, b) => a - b) : AGENTROUTER_POOL_RELEASE_HOURS_UTC;
}

/** Момент ближайшего высвобождения пула (мс в UTC). now — Date или число.
 *  Если хотя бы один час из hoursUtc валиден — вернёт ближайший из них;
 *  иначе null. Часы интерпретируются в UTC (график провайдера). */
function getNextPoolReleaseUtc(now = new Date(), hoursUtc = AGENTROUTER_POOL_RELEASE_HOURS_UTC) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Array.isArray(hoursUtc) || !Number.isFinite(nowMs)) return null;
  const valid = hoursUtc.filter(h => Number.isInteger(h) && h >= 0 && h <= 23);
  if (!valid.length) return null;
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let best = null;
  for (const h of valid) {
    let t = dayStart + h * 3600000;
    if (t <= nowMs) t += 86400000; // уже прошёл сегодня — следующий завтра
    if (best === null || t < best) best = t;
  }
  return best;
}

// CDN периодически отдаёт HTML-заглушку с HTTP 200 вместо JSON. Повторяем
// такой запрос с паузой: немедленные ретраи бесполезны против WAF с CC-защитой
// и только усугубляют частотный блок (Aliyun WAF у AgentRouter так реагировал
// на регулярные опросы панели).
const NON_JSON_RETRY_COUNT = 2;
const NON_JSON_RETRY_DELAY_MS = 1500;

// Анти-бот WAF (Aliyun) у AgentRouter.org: даём понять пользователю,
// что это не его токен и что это временно.
const WAF_CHALLENGE_RE = /aliyun_waf|acw_sc/i;

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
  const apiKey = config.apiKey || '';
  const configUserId = config.userId || '';

  // Задержка между ретраями настраивается: тесты сразу выходят на 2-ю попытку,
  // в проде — пауза, чтобы не усугублять CC-блокировку WAF.
  const retryDelayMs = Number.isFinite(config.retryDelayMs)
    ? config.retryDelayMs
    : NON_JSON_RETRY_DELAY_MS;

  // Авторизация: Authorization: Bearer <access-токен> + New-Api-User <id>
  const authScheme = 'authorization';
  const auth = bearerAuth(cred => {
    const headers = {};
    const uid = String(cred.userId || '').trim();
    if (uid) headers['new-api-user'] = uid;
    return headers;
  });
  const buildHeaders = (key, userId) => auth.buildHeaders({ key, userId });

  const client = createProviderClient({
    // В логах — каноническое имя провайдера, а не подпись из config
    name: descriptor.name,
    upstream: config.url || DEFAULT_URL,
    auth,
    // Свой User-Agent: без него CDN отдаёт HTML-заглушку вместо JSON
    extraHeaders: { 'user-agent': 'AI-Panel/0.1 (+https://agentrouter.org)' },
    timeoutMs: REQUEST_TIMEOUT_MS,
    log: config.log,
    debug: config.debug === true,
    fetchImpl: config.fetchImpl,
    retryNonJson: { count: NON_JSON_RETRY_COUNT, delayMs: retryDelayMs },
    // Анти-бот WAF (Aliyun) — это не токен пользователя и не навсегда
    onBadResponse: ({ status, contentType, snippet }) =>
      WAF_CHALLENGE_RE.test(String(snippet || ''))
        ? 'Сайт AgentRouter временно отдаёт анти-бот страницу (WAF CDN) вместо API-ответа. Токен ни при чём — обычно это проходит через несколько минут, попробуйте обновить позже.'
        : `Провайдер вернул не-JSON ответ (HTTP ${status}, ${contentType})`,
  });

  const apiGet = (pathname, key = '', userId = '') =>
    client.get(pathname, {
      credential: { key: key || apiKey, userId: String(userId || configUserId || '').trim() },
    });

  // new-api на неудачной авторизации ведёт себя по-разному: без
  // заголовка — HTTP 401, с невалидным токеном — HTTP 200 +
  // success:false (проверено на живом сайте). Наружу — понятная
  // подсказка с оригинальным сообщением сайта; причина отклонения
  // (китайский текст) — только в лог.
  const isAuthFailure = (status, data) =>
    status === 401 || (status === 200 && data && data.success === false);

  function authFailure(data) {
    const upstreamMsg = data && typeof data.message === 'string' ? data.message : '';
    if (upstreamMsg) client.log('[AgentRouter] токен отклонён:', upstreamMsg);
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
        used_usd: Number.isFinite(usedRaw) && usedRaw > 0 ? Math.round(usedRaw * 100) / 100 : 0,
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
    const raw = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : null;
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
      .map(item => (typeof item === 'string' ? item : item && item.id))
      .filter(id => typeof id === 'string' && id);
    return {
      status: 200,
      data: { data: ids.map(id => ({ id, access_tier: 'paid' })) },
    };
  }

  return {
    id: 'agentrouter',
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

module.exports = {
  createAgentRouterProvider,
  AGENTROUTER_POOL_RELEASE_HOURS_UTC,
  AGENTROUTER_POOL_RELEASE_TIMEZONE,
  parsePoolReleaseHours,
  getNextPoolReleaseUtc,
  NON_JSON_RETRY_COUNT,
  WAF_CHALLENGE_RE,
};
