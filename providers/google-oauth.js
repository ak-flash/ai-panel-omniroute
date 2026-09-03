// ============================================================
// Google OAuth: обновление access-token по refresh-token.
//
// Используется сервером, когда вставленный access-token истёк
// (~1 час), а пользователь задал связку refresh_token +
// client_id + client_secret в настройках. Адрес эндпоинта вшит,
// config нужен тестам (подмена на mock-OAuth).
// ============================================================

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// OAuth-клиент Antigravity берётся из переменных окружения, чтобы
// секреты не попадали в репозиторий. Задайте GOOGLE_CLIENT_ID и
// GOOGLE_CLIENT_SECRET (например, в .env) перед запуском.
// Читаем лениво (в момент вызова), т.к. .env загружается позже require.
function getBuiltinClientId() {
  return process.env.GOOGLE_CLIENT_ID || '';
}
function getBuiltinClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || '';
}

const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Скоупы Antigravity (как в референсе)
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Строит ссылку на окно авторизации Google.
 * access_type=offline + prompt=consent — чтобы гарантированно
 * получить refresh_token.
 */
function buildAuthUrl({ redirectUri, state, clientId = getBuiltinClientId(), authUrl = DEFAULT_AUTH_URL }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return authUrl + '?' + params.toString();
}

/**
 * Создаёт OAuth-клиент Google.
 *
 * config:
 *   url — адрес токен-эндпоинта (тесты подменяют на mock)
 */
function createGoogleOauth(config = {}) {
  const url = String(config.url || DEFAULT_TOKEN_URL);
  const userinfoUrl = String(config.userinfoUrl || DEFAULT_USERINFO_URL);
  const log = typeof config.log === 'function' ? config.log : console.warn;

  /**
   * Обновляет access-token.
   *
   * Возвращает:
   *   { ok:true, accessToken, expiresIn }        — успех
   *   { ok:false, error }                        — ошибка:
   *     no_credentials — не все поля заданы
   *     invalid_grant  — refresh-token отозван/неверен (400/401 Google)
   *     oauth_error    — прочие ошибки Google
   *     network        — сеть/таймаут
   */
  async function refresh({ refreshToken, clientId, clientSecret } = {}) {
    if (!refreshToken || !clientId || !clientSecret) {
      return { ok: false, error: 'no_credentials' };
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.access_token) {
        return {
          ok: true,
          accessToken: data.access_token,
          expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : 3600,
        };
      }
      if (response.status === 400 || response.status === 401) {
        return { ok: false, error: 'invalid_grant' };
      }
      return { ok: false, error: 'oauth_error' };
    } catch {
      log(`[google-oauth] refresh: сеть/таймаут`);
      return { ok: false, error: 'network' };
    }
  }

  /**
   * Обмен authorization code на токены (шаг после логина в Google).
   *
   * Возвращает:
   *   { ok:true, accessToken, refreshToken, expiresIn } — refreshToken
   *     может отсутствовать (Google отдаёт его не всегда)
   *   { ok:false, error } — invalid_grant / oauth_error / network
   */
  async function exchangeCode({ code, redirectUri, clientId = getBuiltinClientId(), clientSecret = getBuiltinClientSecret() } = {}) {
    if (!code || !redirectUri) return { ok: false, error: 'no_credentials' };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.access_token) {
        return {
          ok: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token || null,
          expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : 3600,
        };
      }
      if (response.status === 400 || response.status === 401) {
        return { ok: false, error: 'invalid_grant' };
      }
      return { ok: false, error: 'oauth_error' };
    } catch {
      log(`[google-oauth] exchangeCode: сеть/таймаут`);
      return { ok: false, error: 'network' };
    }
  }

  /**
   * Получает email аккаунта из Google userinfo (нужен скоуп
   * userinfo.email, уже запрошен в SCOPES). Best-effort: при
   * ошибке/таймауте возвращает { ok:false }.
   *
   * Возвращает:
   *   { ok:true, email }      — успех
   *   { ok:false, error }     — no_token / userinfo_error / network
   */
  async function getUserInfo({ accessToken } = {}) {
    if (!accessToken) return { ok: false, error: 'no_token' };
    try {
      const response = await fetch(userinfoUrl, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + accessToken },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.email) {
        return { ok: true, email: String(data.email) };
      }
      return { ok: false, error: 'userinfo_error' };
    } catch {
      log(`[google-oauth] getUserInfo: сеть/таймаут`);
      return { ok: false, error: 'network' };
    }
  }

  return { url, userinfoUrl, refresh, exchangeCode, buildAuthUrl, getUserInfo };
}

module.exports = {
  createGoogleOauth,
  buildAuthUrl,
  getBuiltinClientId,
  getBuiltinClientSecret,
  DEFAULT_USERINFO_URL,
};
