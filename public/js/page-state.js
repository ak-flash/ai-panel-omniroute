/* ============================================================
   AI Panel — единое состояние загрузки страницы.

   Модуль отвечает за предсказуемое состояние данных страницы:
     - markSuccess(): данные загружены — время обновления в шапке;
     - markFailure(err): ошибка загрузки — статус «stale»/«err»,
       баннер с причиной, время последнего успешного обновления;
     - withRetry(fn): повтор с ограниченным exponential backoff
       и jitter для сетевых ошибок, 429 и 5xx; открытый circuit
       breaker провайдера уважает retry_after_ms сервера;
     - 401 — сессия истекла: баннер с предложением войти.

   Ошибки API несут status (HTTP-код) и, опционально, code и
   retryAfterMs — см. public/js/api.js.
   ============================================================ */

import { setStatus } from './topbar.js';
import { showBanner } from './banner.js';

/* --- Повторные попытки --- */

const RETRYABLE_STATUSES = new Set([0, 429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 15000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(err) {
  // 0 — сеть недоступна (fetch выбросил или aborted)
  const status = err && err.status;
  if (status !== undefined) return RETRYABLE_STATUSES.has(status);
  return true; // сетевая ошибка без статуса — повторяем
}

/**
 * Ограниченный exponential backoff с full jitter на верхней половине
 * (как retryTransient на сервере). При открытом circuit breaker
 * сервер присылает retry_after_ms — ждём не меньше этого времени.
 *
 * @param {() => Promise<any>} fn запрос
 * @param {{ attempts?: number, baseDelayMs?: number, maxDelayMs?: number,
 *           onRetry?: (attempt: number, waitMs: number) => void }} [opts]
 * @returns {Promise<any>} ответ первого успешного запроса
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 2; // всего попыток: 1 + attempts
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = Math.min(opts.maxDelayMs ?? 4000, MAX_RETRY_DELAY_MS);

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < attempts && isRetryable(err);
      if (!canRetry) throw err;

      // Circuit breaker сервера: ждём сколько сказал сервер
      const serverWait = err && err.retryAfterMs ? Number(err.retryAfterMs) : 0;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = backoff / 2 + Math.random() * (backoff / 2);
      const waitMs = Math.max(jitter, serverWait);
      if (opts.onRetry) opts.onRetry(attempt + 1, waitMs);
      await delay(waitMs);
    }
  }
}

/* --- Время последнего успеха и stale-состояние --- */

let lastSuccessAt = 0;
let lastErrorText = '';

const STALE_AFTER_MS = 10 * 60 * 1000;

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru', { hour12: false });
}

function renderErrorStatus(err) {
  if (err && err.status === 401) {
    setStatus('err', 'Сессия истекла');
    return;
  }
  if (err && err.code === 'provider_circuit_open') {
    const sec = err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : 0;
    setStatus('err', 'Провайдер недоступен' + (sec ? `, повтор через ${sec} с` : ''));
    return;
  }
  setStatus('err', 'Ошибка');
}

/** Успешная загрузка данных страницы. */
export function markSuccess() {
  lastSuccessAt = Date.now();
  lastErrorText = '';
  setStatus('ok', '');
}

/**
 * Неудачная загрузка. Показывает причину в статусе и баннере;
 * если раньше данные уже загружались — помечает их как устаревшие
 * (stale), а не как «ошибку».
 *
 * @param {unknown} err ошибка из api.js (status, code, retryAfterMs)
 * @param {{ banner?: boolean }} [opts] показывать баннер (по умолчанию да)
 */
export function markFailure(err, opts = {}) {
  const text = err && err.message ? err.message : String(err);
  lastErrorText = text;
  if (lastSuccessAt > 0) {
    setStatus('stale', 'Данные от ' + fmtTime(lastSuccessAt));
  } else {
    renderErrorStatus(err);
  }
  if (opts.banner !== false) {
    let msg = text;
    if (err && err.status === 401) {
      msg = 'Сессия истекла — войдите заново. ' + msg;
    }
    showBanner(msg);
  }
}

/** Текст последней ошибки (для тестов и diagnostics). */
export function lastError() {
  return lastErrorText;
}

/**
 * Проверка stale-состояния по времени: если последний успех был
 * давно, а данные не обновлялись — статус «stale». Вызывается
 * по таймеру страницы (не критично — можно и не вызывать).
 */
export function checkStale() {
  if (!lastSuccessAt) return false;
  if (Date.now() - lastSuccessAt < STALE_AFTER_MS) return false;
  setStatus('stale', 'Данные от ' + fmtTime(lastSuccessAt));
  return true;
}
