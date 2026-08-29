'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message || code, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = options.expose !== false;
    this.headers = options.headers || {};
  }
}

function sendJson(res, status, data, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, error, requestId) {
  const appError = error instanceof AppError
    ? error
    : new AppError(500, 'server_error', 'Внутренняя ошибка сервера', { expose: false });
  const body = {
    error: appError.code,
    message: appError.expose ? appError.message : 'Внутренняя ошибка сервера',
  };
  if (requestId) body.requestId = requestId;
  sendJson(res, appError.status, body, appError.headers);
}

function sendNoContent(res, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(204, headers);
  res.end();
}

function readBody(req, { maxBytes = DEFAULT_MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new AppError(413, 'payload_too_large', `Тело запроса превышает лимит ${Math.ceil(maxBytes / 1024 / 1024)} МБ`, {
          headers: { connection: 'close' },
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(new AppError(400, 'bad_request', 'Не удалось прочитать тело запроса', { cause: error }));
    });
  });
}

async function readJson(req, options) {
  const body = await readBody(req, options);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new AppError(400, 'bad_json', 'Некорректный JSON', { cause: error });
  }
}

function createRequestContext(req, res, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  res.setHeader('x-request-id', requestId);
  req.setTimeout(timeoutMs);
  return { requestId, startedAt, timeoutMs };
}

function safeLog(logger, level, event, fields = {}) {
  const output = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|key|authorization|cookie/i.test(key)) continue;
    output[key] = value instanceof Error ? value.name : value;
  }
  const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
  if (fn) fn(event, output);
}

function handleError(error, req, res, context, logger = console) {
  if (res.headersSent) return res.destroy();
  safeLog(logger, 'error', 'request_failed', {
    requestId: context.requestId,
    method: req.method,
    path: new URL(req.url, 'http://localhost').pathname,
    status: error instanceof AppError ? error.status : 500,
    error,
  });
  sendError(res, error, context.requestId);
}

module.exports = {
  AppError,
  DEFAULT_MAX_BODY,
  DEFAULT_TIMEOUT_MS,
  createRequestContext,
  handleError,
  readBody,
  readJson,
  safeLog,
  sendError,
  sendJson,
  sendNoContent,
};
