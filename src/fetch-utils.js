'use strict';

const { AppError } = require('./http');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new AppError(504, 'upstream_timeout', `Таймаут при запросе к ${url}`);
    }
    throw new AppError(502, 'upstream_error', `Ошибка соединения с ${url}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const body = await response.text();
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

async function fetchWithRetry(url, options = {}, retries = DEFAULT_RETRIES, delayMs = DEFAULT_RETRY_DELAY_MS, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fetchJson(url, options, timeoutMs);
      const status = result.response.status;
      if (status >= 500 && attempt < retries) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retries && (error.code === 'upstream_timeout' || error.code === 'upstream_error')) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new AppError(502, 'upstream_failed', 'Не удалось выполнить запрос после нескольких попыток');
}

module.exports = {
  fetchWithTimeout,
  fetchJson,
  fetchWithRetry,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
};