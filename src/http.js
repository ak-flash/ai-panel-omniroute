'use strict';

const crypto = require('crypto');
const { recordRequest } = require('./metrics');

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   * @param {{expose?: boolean, headers?: Record<string, string>, details?: unknown, cause?: unknown}} [options]
   */
  constructor(status, code, message, options = {}) {
    super(message || code, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = options.expose !== false;
    this.headers = options.headers || {};
    // Детали для диагностики в логах (в ответ клиенту не попадают)
    this.details = options.details || {};
  }
}

/** @param {import('http').ServerResponse} res @param {number} status @param {unknown} data @param {Record<string, string>} [headers] */
function sendJson(res, status, data, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

/** @param {import('http').ServerResponse} res @param {unknown} error @param {string} [requestId] */
function sendError(res, error, requestId) {
  const appError =
    error instanceof AppError
      ? error
      : new AppError(500, 'server_error', 'Внутренняя ошибка сервера', { expose: false });
  /** @type {Record<string, unknown>} */
  const body = {
    error: appError.code,
    message: appError.expose ? appError.message : 'Внутренняя ошибка сервера',
  };
  if (requestId) body.requestId = requestId;
  sendJson(res, appError.status, body, appError.headers);
}

/** @param {import('http').ServerResponse} res @param {Record<string, string>} [headers] */
function sendNoContent(res, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(204, headers);
  res.end();
}

/** @param {import('http').IncomingMessage} req @param {{maxBytes?: number}} [options] @returns {Promise<Buffer>} */
function readBody(req, { maxBytes = DEFAULT_MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on(
      'data',
      /** @param {Buffer} chunk */ chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          settled = true;
          reject(
            new AppError(
              413,
              'payload_too_large',
              `Тело запроса превышает лимит ${Math.ceil(maxBytes / 1024 / 1024)} МБ`,
              {
                headers: { connection: 'close' },
              }
            )
          );
          return;
        }
        chunks.push(chunk);
      }
    );
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', error => {
      if (!settled)
        reject(
          new AppError(400, 'bad_request', 'Не удалось прочитать тело запроса', { cause: error })
        );
    });
  });
}

/** @param {import('http').IncomingMessage} req @param {{maxBytes?: number}} [options] @returns {Promise<any>} */
async function readJson(req, options) {
  const body = await readBody(req, options);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new AppError(400, 'bad_json', 'Некорректный JSON', { cause: error });
  }
}

/** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res @param {{timeoutMs?: number}} [options] */
function createRequestContext(req, res, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  res.setHeader('x-request-id', requestId);
  req.setTimeout(timeoutMs);
  res.on('finish', () =>
    recordRequest(res.statusCode, Date.now() - startedAt, { route: requestPath(req) })
  );
  return { requestId, startedAt, timeoutMs };
}

/**
 * Разбирает req.url. Origin-form (/path?q) склеивается с фиктивным
 * origin строкой, а не через base-URL: иначе «//host/path» превратился
 * бы в другой хост и другой путь. Некорректный URL — 400, а не исключение.
 */
/** @param {string} [rawUrl] @returns {URL} */
function parseRequestUrl(rawUrl) {
  const raw = typeof rawUrl === 'string' && rawUrl ? rawUrl : '/';
  try {
    return raw.startsWith('/') ? new URL('http://localhost' + raw) : new URL(raw);
  } catch {
    throw new AppError(400, 'bad_request', 'Некорректный URL запроса');
  }
}

/** Путь запроса для логов; никогда не бросает. */
/** @param {import('http').IncomingMessage} req @returns {string} */
function requestPath(req) {
  try {
    return parseRequestUrl(req.url).pathname;
  } catch {
    return String(req.url || '').slice(0, 200);
  }
}

/** @param {unknown} err @returns {unknown} */
function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return {
    message: err.message,
    stack: err.stack,
    ...(err.cause ? { cause: serializeError(err.cause) } : {}),
  };
}

/** @param {any} logger @param {string} level @param {string} event @param {Record<string, unknown>} [fields] */
function safeLog(logger, level, event, fields = {}) {
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|key|authorization|cookie/i.test(key)) continue;
    output[key] = value instanceof Error ? serializeError(value) : value;
  }
  const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null;
  if (fn) fn(event, output);
}

/** Последний рубеж обработки запроса: сам не бросает никогда. */
/** @param {unknown} error @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res @param {{requestId?: string}} context @param {any} [logger] */
function handleError(error, req, res, context, logger = console) {
  try {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    try {
      safeLog(logger, 'error', 'request_failed', {
        requestId: context.requestId,
        method: req.method,
        path: requestPath(req),
        status: error instanceof AppError ? error.status : 500,
        error,
      });
    } catch {}
    sendError(res, error, context.requestId);
  } catch {
    try {
      res.destroy();
    } catch {}
  }
}

module.exports = {
  AppError,
  DEFAULT_MAX_BODY,
  DEFAULT_TIMEOUT_MS,
  createRequestContext,
  handleError,
  parseRequestUrl,
  readBody,
  readJson,
  requestPath,
  safeLog,
  sendError,
  sendJson,
  sendNoContent,
  serializeError,
};
