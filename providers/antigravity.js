// ============================================================
// Провайдер antigravity — квоты Google AI Pro (Claude через Google).
//
// Референс: Antigravity-Manager (src-tauri/src/modules/quota.rs).
// Эндпоинт Google internal API: POST /v1internal:fetchAvailableModels.
// Обязателен заголовок User-Agent вида «vscode/1.X.X (Antigravity/x)» —
// без него Google отвергает запрос.
//
// Токен Google OAuth здесь не хранится: его присылает server.js из
// памяти процесса (POST /api/settings/google-token). Ключей в env нет,
// адрес API вшит, config нужен тестам (подмена адреса на mock-upstream).
// ============================================================

const DEFAULT_NAME = 'Antigravity';
const DEFAULT_URL = 'https://cloudcode-pa.googleapis.com';

// Требуемый User-Agent (Google отвергает запросы без него)
const USER_AGENT = 'vscode/1.96.0 (Antigravity/4.3.0)';

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Создаёт адаптер провайдера antigravity.
 *
 * config:
 *   name — отображаемое имя
 *   url  — базовый адрес API (тесты подменяют на mock-upstream)
 */
function createAntigravityProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');

  /** Один POST к указанному internal-методу Google. */
  async function callInternal(method, token, project) {
    try {
      const response = await fetch(upstream + '/v1internal:' + method, {
        method: 'POST',
        headers: {
          'authorization': 'Bearer ' + token,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(project ? { project } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let body = null;
      try { body = await response.json(); } catch {}
      return { status: response.status, body };
    } catch {
      // Сеть / DNS / таймаут — наружу мапится в 502 (см. getQuota)
      return { status: 0, body: null };
    }
  }

  const requestOnce = (token, project) =>
    callInternal('fetchAvailableModels', token, project);

  /** Очищенный список моделей для карточек. */
  function cleanModels(models) {
    return Object.entries(models || {}).map(([id, m]) => ({
      id,
      displayName: (m && m.displayName) || id,
      remainingFraction:
        m && m.quotaInfo && Number.isFinite(m.quotaInfo.remainingFraction)
          ? m.quotaInfo.remainingFraction
          : null,
      resetTime:
        m && m.quotaInfo && m.quotaInfo.resetTime
          ? m.quotaInfo.resetTime
          : null,
      supportsThinking: Boolean(m && m.supportsThinking),
    }));
  }

  /**
   * Запрос квот. token приходит из памяти сервера, project — из настроек.
   * Fallback: при 403 с project повторяем с пустым телом {} (как в референсе).
   *
   * Возвращает { status, data }: data — очищенный JSON для клиента либо
   * { error } по таблице ошибок из плана (п.4.1):
   *   401 → token_expired, 403 → project_required, 429 → rate_limited,
   *   сеть/таймаут → 502 provider_error.
   */
  async function getQuota({ token, project } = {}) {
    let r = await requestOnce(token, project);

    if (r.status === 403 && project) {
      r = await requestOnce(token, '');
    }

    if (r.status === 200 && r.body) {
      return {
        status: 200,
        data: {
          models: cleanModels(r.body.models),
          deprecatedModelIds: r.body.deprecatedModelIds || {},
        },
      };
    }

    if (r.status === 401) return { status: 401, data: { error: 'token_expired' } };
    if (r.status === 403) return { status: 403, data: { error: 'project_required' } };
    if (r.status === 429) return { status: 429, data: { error: 'rate_limited' } };

    // 0 — сеть/таймаут; прочие коды Google — тоже как bad gateway
    return { status: 502, data: { error: 'provider_error' } };
  }

  /**
   * Групповые квоты (weekly + 5h окна) из retrieveUserQuotaSummary.
   * Опциональное расширение: любая ошибка → data:null — вызывающий код
   * просто опускает окна, не ломая основной ответ.
   *
   * Возвращает { status, data }: data.windows — по одной записи на окно
   * (минимальный remainingFraction среди моделей): { windowSize ('5h'|'weekly'),
   * remainingFraction, resetTime }.
   */
  async function getQuotaSummary({ token, project } = {}) {
    const r = await callInternal('retrieveUserQuotaSummary', token, project);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.groups)) {
      return { status: r.status === 200 ? 502 : r.status, data: null };
    }

    // Агрегируем бакеты по windowSize: худший (минимальный) остаток
    const byWindow = new Map();
    for (const group of r.body.groups) {
      for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
        if (!bucket || !Number.isFinite(bucket.remainingFraction)) continue;
        const size = bucket.windowSize === 'WEEKLY' ? 'weekly'
          : bucket.windowSize === '5h' ? '5h'
          : String(bucket.windowSize || '').toLowerCase();
        const prev = byWindow.get(size);
        if (!prev || bucket.remainingFraction < prev.remainingFraction) {
          byWindow.set(size, {
            windowSize: size,
            remainingFraction: bucket.remainingFraction,
            resetTime: bucket.resetTime || null,
          });
        }
      }
    }

    return { status: 200, data: { windows: [...byWindow.values()] } };
  }

  return {
    id: 'antigravity',
    name,
    upstream,
    getQuota,
    getQuotaSummary,
  };
}

module.exports = { createAntigravityProvider, USER_AGENT };
