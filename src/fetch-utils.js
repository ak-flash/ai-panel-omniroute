'use strict';

const { AppError } = require('./http');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  let settled = false;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const clear = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
  };
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = response.text.bind(response);
    response.text = async () => {
      try {
        return await text();
      } finally {
        clear();
      }
    };
    return response;
  } catch (error) {
    clear();
    if (error.name === 'AbortError') {
      throw new AppError(504, 'upstream_timeout', `Таймаут при запросе к ${url}`);
    }
    throw new AppError(502, 'upstream_error', `Ошибка соединения с ${url}`, { cause: error });
  }
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  let body;
  try {
    body = await response.text();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new AppError(504, 'upstream_timeout', `Таймаут при чтении ответа от ${url}`);
    }
    throw new AppError(502, 'upstream_error', `Ошибка чтения ответа от ${url}`, { cause: error });
  }
  let data;
  try {
    data = body ? JSON.parse(body) : null;
  } catch (error) {
    // Детали помогают адаптерам отличить HTML-заглушку CDN (HTTP 200)
    // от страницы ошибки и показать диагноз в интерфейсе панели
    const contentType = response.headers.get('content-type') || 'content-type отсутствует';
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new AppError(502, 'upstream_invalid_json', `Некорректный JSON от ${url}`, {
      cause: error,
      details: { status: response.status, contentType, snippet },
    });
  }
  return { response, data };
}

function isRetryableMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function retryAfterMs(response, fallbackMs) {
  const value = response.headers.get('retry-after');
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? fallbackMs : Math.max(0, date - Date.now());
}

async function fetchWithRetry(
  url,
  options = {},
  retries = DEFAULT_RETRIES,
  delayMs = DEFAULT_RETRY_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  let lastError;
  const method = options.method || 'GET';
  if (!isRetryableMethod(method)) return fetchJson(url, options, timeoutMs);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fetchJson(url, options, timeoutMs);
      const status = result.response.status;
      if ((status === 429 || status >= 500) && attempt < retries) {
        await sleep(retryAfterMs(result.response, delayMs * (attempt + 1)));
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (
        attempt < retries &&
        (error.code === 'upstream_timeout' || error.code === 'upstream_error')
      ) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw (
    lastError ||
    new AppError(502, 'upstream_failed', 'Не удалось выполнить запрос после нескольких попыток')
  );
}

module.exports = {
  fetchWithTimeout,
  fetchJson,
  fetchWithRetry,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
};
