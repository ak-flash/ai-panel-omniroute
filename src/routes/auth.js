'use strict';

// ============================================================
// /api/auth/* — вход по AIPANEL_AUTH_TOKEN и выход (логика — src/auth.js).
// Маршруты публичные: через них получают сессию.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');
const { readCookie } = require('../auth');

const NO_STORE = { 'cache-control': 'no-store' };

/** IP клиента для лимита попыток; X-Forwarded-For — только при TRUST_PROXY. */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Нужен ли cookie флаг Secure: внешний адрес панели — https. */
function isSecureRequest(req, { publicOrigin, trustProxy }) {
  if (publicOrigin) return publicOrigin.startsWith('https:');
  if (trustProxy) {
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }
  return Boolean(req.socket && req.socket.encrypted);
}

function registerAuthRoutes(router, { auth, publicOrigin = '', trustProxy = false, logger = console }) {
  const secureOpts = { publicOrigin, trustProxy };

  router.add(['GET', 'HEAD'], '/api/auth/status', ({ req, res }) =>
    sendJson(
      res,
      200,
      {
        authEnabled: auth.enabled,
        authenticated: !auth.enabled || auth.verifySession(readCookie(req)),
      },
      NO_STORE
    )
  );

  router.add(['POST'], '/api/auth/login', async ({ req, res }) => {
    if (!auth.enabled) return sendJson(res, 200, { ok: true, authEnabled: false }, NO_STORE);
    const ip = clientIp(req, trustProxy);
    const wait = auth.limiter.retryAfter(ip);
    if (wait) {
      throw new AppError(429, 'too_many_attempts', `Слишком много попыток входа — повторите через ${wait} с`, {
        headers: { 'retry-after': String(wait) },
      });
    }
    const body = await readJson(req, { maxBytes: 4096 });
    const token = body && typeof body.token === 'string' ? body.token.trim() : '';
    if (!auth.checkToken(token)) {
      auth.limiter.recordFailure(ip);
      logger.warn(`[auth] неудачная попытка входа с ${ip}`);
      throw new AppError(401, 'invalid_token', 'Неверный токен доступа');
    }
    auth.limiter.recordSuccess(ip);
    return sendJson(res, 200, { ok: true }, {
      ...NO_STORE,
      'set-cookie': auth.sessionCookie({ secure: isSecureRequest(req, secureOpts) }),
    });
  });

  router.add(['POST'], '/api/auth/logout', ({ req, res }) =>
    sendJson(res, 200, { ok: true }, {
      ...NO_STORE,
      'set-cookie': auth.clearCookie({ secure: isSecureRequest(req, secureOpts) }),
    })
  );
}

module.exports = { registerAuthRoutes, clientIp, isSecureRequest };
