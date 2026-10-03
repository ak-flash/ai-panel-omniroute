'use strict';

// ============================================================
// Общий клиент API провайдера (P2-1).
//
// Раньше `apiGet` был написан отдельно в каждом адаптере — с разными
// кодами ошибок для не-JSON ответа, разными таймаутами и разной
// диагностикой. Здесь одна реализация со стандартным контрактом:
//
//   { status, data }   — ответ upstream как есть;
//   { status: 502, data: { error: 'bad_response',   … } }
//                     — провайдер ответил не-JSON (WAF-заглушка,
//                       страница ошибки, прокси);
//   { status: 502, data: { error: 'provider_error', code, … } }
//                     — сеть, DNS, таймаут, оборванное тело;
//                       code: provider_timeout | provider_unreachable.
//
// Тело HTML-заглушки в интерфейс не попадает: одна строка с
// обрезкой уходит в лог сервера, по ней видно, кто отвечает.
//
// Адаптер описывает только различие: адрес, заголовки авторизации и
// пути. fetch и now внедряются — тесты не ходят в сеть.
// ============================================================

const { fetchJson } = require('./fetch-utils');
const { normalizeLog } = require('./file-logger');

// Таймаут по умолчанию, если адаптер его не задал
const DEFAULT_TIMEOUT_MS = 20_000;

/** Маскирует значения секретных заголовков для debug-лога. */
/** @param {Record<string, string>} headers @param {string[]} secrets */
function maskHeaders(headers, secrets) {
  const out = { ...headers };
  for (const name of secrets) {
    if (out[name]) out[name] = '***';
  }
  return out;
}

/**
 * @typedef {object} ProviderCredential
 * @property {string} [key]    ключ провайдера
 * @property {string} [userId] числовой ID пользователя (AgentRouter)
 */

/**
 * @typedef {object} ProviderAuth
 * @property {(cred: ProviderCredential) => Record<string, string>} buildHeaders
 * @property {string[]} [maskSecrets]     заголовки, маскируемые в debug-логе
 * @property {Record<string, string>} [extraHeaders] постоянные заголовки
 */

/**
 * @typedef {object} ProviderClientOptions
 * @property {string} name         отображаемое имя (для логов и сообщений)
 * @property {string} [upstream]   базовый адрес API; хвостовые слэши срезаются
 * @property {ProviderAuth} [auth]  схема авторизации
 * @property {Record<string, string>} [extraHeaders] постоянные заголовки (User-Agent)
 * @property {number} [timeoutMs]  таймаут запроса (по умолчанию 20 с)
 * @property {*} [log]             логгер (нормализуется через normalizeLog)
 * @property {boolean} [debug]     подробный лог запросов и ответов
 * @property {Function} [fetchImpl] подмена fetchJson (тесты)
 * @property {{count?: number, baseDelayMs?: number, maxDelayMs?: number, sleep?: (ms: number) => Promise<void>}} [retryTransient]
 *   exponential backoff с jitter для повторяемых сетевых ошибок и 429/5xx;
 *   по умолчанию повторов нет
 * @property {{count?: number, delayMs?: number, sleep?: (ms: number) => Promise<void>}} [retryNonJson]
 *   повтор не-JSON с HTTP 200 (CDN-заглушки); по умолчанию повторов нет
 * @property {(info: BadResponseInfo) => string} [onBadResponse]
 *   своё сообщение для панели вместо общего текста (P2-1)
 * @property {{failureThreshold?: number, cooldownMs?: number, now?: () => number}} [circuitBreaker]
 *   размыкатель для повторяемых сетевых/5xx/429 сбоев
 */

/**
 * @typedef {object} BadResponseInfo
 * @property {number} [status]       HTTP-код не-JSON ответа
 * @property {string} [contentType]  content-type ответа
 * @property {string} [snippet]      начало тела (в интерфейс не попадает)
 */

/**
 * @typedef {object} ProviderResponse
 * @property {number} status код ответа upstream (502 — наш синтетический код)
 * @property {any} data      JSON провайдера либо { error, code?, message }
 */

/**
 * @typedef {object} ProviderClient
 * @property {string} name
 * @property {string} upstream
 * @property {(pathname: string, opts?: {credential?: ProviderCredential, base?: string, query?: Record<string, unknown>}) => Promise<ProviderResponse>} get
 * @property {(message: string, extra?: unknown) => void} log
 */

/**
 * Создаёт клиента одного провайдера.
 *
 * opts:
 *   name         — отображаемое имя (для логов и сообщений)
 *   upstream     — базовый адрес API; хвостовые слэши срезаются
 *   auth         — { buildHeaders(cred), maskSecrets?, extraHeaders? };
 *                 cred = { key, userId }
 *   timeoutMs    — таймаут запроса (по умолчанию 20 с)
 *   log          — логгер (нормализуется через normalizeLog)
 *   debug        — подробный лог запросов и ответов
 *   fetchImpl    — подмена fetchJson (тесты)
 *   extraHeaders — заголовки поверх стандартных (свой User-Agent)
 *   retryTransient — { count, baseDelayMs, maxDelayMs, sleep }:
 *                   ограниченный exponential backoff с jitter для
 *                   сетевых ошибок и transient-статусов (429/5xx)
 *   retryNonJson — { count, delayMs, sleep }: повтор не-JSON с HTTP 200
 *                   (CDN-заглушки); по умолчанию повторов нет
 *   onBadResponse — ({ status, contentType, snippet }) => сообщение для
 *                   панели; по умолчанию общий текст (P2-1)
 *
 * Метод get(pathname, { credential, base, query }):
 *   credential — { key, userId } от клиента или хранилища
 *   base       — другой базовый адрес (management-эндпоинты)
 *   query      — объект query-параметров
 *
 * @param {ProviderClientOptions} [opts]
 * @returns {ProviderClient}
 */
function createProviderClient(
  {
    name,
    upstream,
    auth = /** @type {ProviderAuth} */ ({}),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log,
    debug = false,
    fetchImpl,
    retryNonJson,
    retryTransient,
    onBadResponse,
    circuitBreaker,
  } = /** @type {ProviderClientOptions} */ ({})
) {
  const base = String(upstream || '').replace(/\/+$/, '');
  const write = normalizeLog(log);
  const doFetch = fetchImpl || fetchJson;
  const buildHeaders =
    typeof auth.buildHeaders === 'function'
      ? auth.buildHeaders
      : () => /** @type {Record<string, string>} */ ({});
  const maskSecrets = auth.maskSecrets || ['authorization', 'x-api-key', 'new-api-user'];
  const extraHeaders = auth.extraHeaders || {};
  /** @type {null | {failures: number, openedAt: number|null, threshold: number, cooldownMs: number, now: () => number}} */
  const breaker = circuitBreaker
    ? {
        failures: 0,
        openedAt: null,
        threshold: Math.max(1, Number(circuitBreaker.failureThreshold) || 3),
        cooldownMs: Math.max(0, Number(circuitBreaker.cooldownMs) || 30000),
        now: circuitBreaker.now || Date.now,
      }
    : null;
  /** @param {number} status */
  const isTransientStatus = status => status === 429 || status >= 500;
  const resetBreaker = () => {
    if (breaker) breaker.failures = 0;
  };
  const registerFailure = () => {
    if (!breaker) return;
    breaker.failures += 1;
    if (breaker.failures >= breaker.threshold && breaker.openedAt === null) {
      breaker.openedAt = breaker.now();
      write(
        `[${name}] circuit breaker открыт после ${breaker.failures} сбоев,` +
          ` пауза ${breaker.cooldownMs} мс`,
        {
          event: 'circuit_breaker_open',
          provider: name,
          failures: breaker.failures,
          cooldownMs: breaker.cooldownMs,
        }
      );
    }
  };
  const circuitResponse = () => {
    if (!breaker || breaker.openedAt === null) return null;
    const elapsed = breaker.now() - breaker.openedAt;
    if (elapsed >= breaker.cooldownMs) {
      breaker.openedAt = null;
      breaker.failures = 0;
      write(`[${name}] circuit breaker закрыт после паузы, пробую снова`, {
        event: 'circuit_breaker_reset',
        provider: name,
      });
      return null;
    }
    const retryAfterMs = breaker.cooldownMs - elapsed;
    write.info(`[${name}] запрос заблокирован открытым circuit breaker`, {
      event: 'circuit_breaker_blocked',
      provider: name,
      retry_after_ms: retryAfterMs,
    });
    return {
      status: 503,
      data: { error: 'provider_circuit_open', retry_after_ms: retryAfterMs },
    };
  };

  /** @param {ProviderCredential} [credential] */
  const authHeaders = credential => {
    const cred = credential || {};
    return buildHeaders({ key: cred.key || '', userId: cred.userId || '' });
  };

  /**
   * @param {string} pathname
   * @param {string} [baseOverride]
   * @param {Record<string, unknown>} [query]
   */
  function buildUrl(pathname, baseOverride, query) {
    let url = (baseOverride || base) + pathname;
    if (query && typeof query === 'object') {
      const parts = [];
      for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
      }
      if (parts.length) url += (url.includes('?') ? '&' : '?') + parts.join('&');
    }
    return url;
  }

  /**
   * GET с авторизацией и стандартной обработкой ошибок.
   * @returns {Promise<ProviderResponse>}
   */
  /**
   * @param {string} pathname
   * @param {{credential?: ProviderCredential, base?: string, query?: Record<string, unknown>}} [options]
   * @returns {Promise<ProviderResponse>}
   */
  async function get(
    pathname,
    {
      credential,
      base: baseOverride,
      query,
    } = /** @type {{credential?: ProviderCredential, base?: string, query?: Record<string, unknown>}} */ ({})
  ) {
    const url = buildUrl(pathname, baseOverride, query);
    const blocked = circuitResponse();
    if (blocked) return blocked;
    const headers = { accept: 'application/json', ...extraHeaders, ...authHeaders(credential) };
    const startedAt = Date.now();
    if (debug) {
      write.info(`[${name}] ${pathname}`, { headers: maskHeaders(headers, maskSecrets) });
    }

    const retries =
      retryNonJson && (retryNonJson.count ?? 0) > 0
        ? /** @type {number} */ (retryNonJson.count)
        : 0;
    const transientRetries =
      retryTransient && (retryTransient.count ?? 0) > 0
        ? /** @type {number} */ (retryTransient.count)
        : 0;
    const sleep =
      (retryTransient && retryTransient.sleep) ||
      (retryNonJson && retryNonJson.sleep) ||
      (ms => new Promise(resolve => setTimeout(resolve, ms)));
    // Exponential backoff с «full jitter» на верхней половине: delay = U(exp/2, exp)
    const baseDelayMs = Math.max(0, Number(retryTransient && retryTransient.baseDelayMs) || 500);
    const maxDelayMs = Math.max(
      baseDelayMs,
      Number(retryTransient && retryTransient.maxDelayMs) || 8000
    );
    /** @param {number} attempt */
    const backoffDelay = attempt => {
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      return Math.round(exp / 2 + Math.random() * (exp / 2));
    };

    for (let attempt = 0; ; attempt += 1) {
      try {
        const { response, data } = await doFetch(url, { headers }, timeoutMs);
        if (debug) {
          write.info(`[${name}] ${pathname} → ${response.status} (${Date.now() - startedAt} ms)`);
        }
        const result = { status: response.status, data: data || {} };
        if (isTransientStatus(response.status)) {
          registerFailure();
          if (attempt < transientRetries) {
            const delay = backoffDelay(attempt);
            write(
              `[${name}] ${pathname}: HTTP ${response.status} — повтор ${attempt + 1}` +
                ` из ${transientRetries} через ${delay} мс`
            );
            await sleep(delay);
            continue;
          }
        } else if (response.status >= 200 && response.status < 400) resetBreaker();
        return result;
      } catch (error) {
        const err =
          /** @type {Error & {code?: string, details?: {status?: number, contentType?: string, snippet?: string}}} */ (
            error
          );
        // Не-JSON вместо JSON: обычно HTML-заглушка защиты (Cloudflare,
        // Aliyun WAF) или страница ошибки. Такое бывает временным, и
        // немедленный повтор бесполезен против WAF с CC-защитой.
        if (err && err.code === 'upstream_invalid_json') {
          const { status, contentType, snippet } = err.details || {};
          if (status === 200 && attempt < retries) {
            write(
              `[${name}] ${pathname}: не-JSON ответ (HTTP ${status}, ${contentType}) —` +
                ` повтор ${attempt + 1} из ${retries}`
            );
            const delay = Number.isFinite(retryNonJson?.delayMs)
              ? /** @type {number} */ (retryNonJson?.delayMs)
              : 1500;
            if (delay > 0) await sleep(delay);
            continue;
          }
          write(
            `[${name}] ${pathname}: не-JSON ответ (HTTP ${status}, ${contentType}):`,
            snippet || '(пустое тело)'
          );
          return {
            status: 502,
            data: {
              error: 'bad_response',
              message: onBadResponse
                ? onBadResponse({ status, contentType, snippet })
                : `Провайдер вернул не-JSON ответ (HTTP ${status}, ${contentType})`,
            },
          };
        }

        // Сеть / DNS / таймаут / оборванное тело
        const msg = (err && err.message) || 'Ошибка запроса';
        const cause =
          err && /** @type {Error & {cause?: Error}} */ (err).cause instanceof Error
            ? /** @type {Error & {cause?: Error}} */ (err).cause?.message || ''
            : '';
        if (attempt < transientRetries) {
          const delay = backoffDelay(attempt);
          write(
            `[${name}] ${pathname}: сеть/таймаут — ${msg}${cause ? ' (причина: ' + cause + ')' : ''}` +
              ` — повтор ${attempt + 1} из ${transientRetries} через ${delay} мс`
          );
          registerFailure();
          await sleep(delay);
          continue;
        }
        write(
          `[${name}] ${pathname}: сеть/таймаут — ${msg}${cause ? ' (причина: ' + cause + ')' : ''}`
        );
        registerFailure();
        const code =
          err && err.code === 'upstream_timeout' ? 'provider_timeout' : 'provider_unreachable';
        return { status: 502, data: { error: 'provider_error', code, message: msg } };
      }
    }
  }

  return { name, upstream: base, get, log: write };
}

/** Авторизация заголовком x-api-key (xKiro, Selora).
 *  @returns {ProviderAuth} */
function apiKeyAuth() {
  return {
    buildHeaders: ({ key }) =>
      key ? { 'x-api-key': key } : /** @type {Record<string, string>} */ ({}),
    maskSecrets: ['x-api-key'],
  };
}

/**
 * Авторизация заголовком Authorization: Bearer (OpenRouter, AgentRouter…).
 * @param {(cred: ProviderCredential) => Record<string, string> | null} [extraHeadersFn]
 * @returns {ProviderAuth}
 */
function bearerAuth(extraHeadersFn) {
  return {
    buildHeaders: cred => {
      const headers = cred.key
        ? { authorization: 'Bearer ' + cred.key }
        : /** @type {Record<string, string>} */ ({});
      const extra = extraHeadersFn ? extraHeadersFn(cred) : null;
      return extra ? { ...headers, ...extra } : headers;
    },
  };
}

module.exports = { createProviderClient, apiKeyAuth, bearerAuth, DEFAULT_TIMEOUT_MS };
