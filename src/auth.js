'use strict';

// ============================================================
// Вход в панель по общему секрету AIPANEL_AUTH_TOKEN.
//
// Сессия — подписанная HMAC cookie без состояния на сервере:
//   v1.<истекает, мс>.<nonce>.<HMAC-SHA256>
// Ключ подписи выводится из токена, поэтому смена AIPANEL_AUTH_TOKEN
// отзывает все сессии, а перезапуск сервера их сохраняет. Cookie —
// HttpOnly, SameSite=Strict, Secure при https. Токен сравнивается за
// постоянное время; неудачные попытки ограничены по IP и глобально.
// ============================================================

const crypto = require('crypto');

const COOKIE_NAME = 'aipanel_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_GLOBAL = 100;
const MAX_TRACKED_IPS = 10000;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

/** Значение cookie по имени из заголовка Cookie (без зависимостей). */
function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/**
 * token — AIPANEL_AUTH_TOKEN (пусто — вход отключён); now — часы (тесты).
 * Возвращает { enabled, checkToken, issueSession, verifySession,
 * sessionCookie, clearCookie, limiter }.
 */
function createAuth({ token = '', ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
  const enabled = Boolean(token);
  const signingKey = enabled
    ? crypto.createHmac('sha256', 'ai-panel/session/v1').update(token).digest()
    : null;
  const tokenDigest = enabled ? sha256(token) : null;

  const sign = (payload) => crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');

  function checkToken(candidate) {
    if (!enabled || typeof candidate !== 'string' || !candidate) return false;
    return crypto.timingSafeEqual(sha256(candidate), tokenDigest);
  }

  function issueSession() {
    if (!enabled || !signingKey) return { value: '', expiresAt: 0 };
    const expiresAt = now() + ttlMs;
    const payload = `v1.${expiresAt}.${crypto.randomBytes(16).toString('base64url')}`;
    return { value: `${payload}.${sign(payload)}`, expiresAt };
  }

  function verifySession(value) {
    if (!enabled || typeof value !== 'string') return false;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const expiresAt = Number(parts[1]);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) return false;
    const expected = Buffer.from(sign(parts.slice(0, 3).join('.')));
    const actual = Buffer.from(parts[3]);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function sessionCookie({ secure }) {
    const { value } = issueSession();
    const maxAge = Math.floor(ttlMs / 1000);
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  function clearCookie({ secure }) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  // ---------- Ограничение перебора ----------
  const failures = new Map(); // ip → { count, resetAt }
  let global = { count: 0, resetAt: 0 };

  function windowFor(entry) {
    return entry && entry.resetAt > now() ? entry : { count: 0, resetAt: now() + LOGIN_WINDOW_MS };
  }

  /** Секунды до следующей попытки; 0 — попытка разрешена. */
  function retryAfter(ip) {
    const perIp = windowFor(failures.get(ip));
    global = windowFor(global);
    const blockedUntil = Math.max(
      perIp.count >= MAX_FAILURES_PER_IP ? perIp.resetAt : 0,
      global.count >= MAX_FAILURES_GLOBAL ? global.resetAt : 0
    );
    return blockedUntil ? Math.max(1, Math.ceil((blockedUntil - now()) / 1000)) : 0;
  }

  function recordFailure(ip) {
    if (failures.size >= MAX_TRACKED_IPS) failures.clear();
    const perIp = windowFor(failures.get(ip));
    perIp.count += 1;
    failures.set(ip, perIp);
    global = windowFor(global);
    global.count += 1;
  }

  function recordSuccess(ip) {
    failures.delete(ip);
  }

  return {
    enabled,
    checkToken,
    issueSession,
    verifySession,
    sessionCookie,
    clearCookie,
    limiter: { retryAfter, recordFailure, recordSuccess },
  };
}

module.exports = {
  COOKIE_NAME,
  MAX_FAILURES_PER_IP,
  SESSION_TTL_MS,
  createAuth,
  readCookie,
};
