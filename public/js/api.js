/* ============================================================
   AI Panel — API client: все запросы панели к своему серверу.

   Через сервер — /api/providers/<id>/<resource>: сервер вызывает
   функцию адаптера провайдера (providers/ на сервере), передавая
   клиентский ключ из заголовка x-api-key.
   В режиме file:// — прямой запрос к API xKiro (нужен разрешённый
   CORS), остальное API недоступно.
   ============================================================ */

import { session, PROVIDER_FALLBACK } from './session.js';
import { keyForProvider, getAgentRouterUserId } from './settings.js';

// Прямой адрес API xKiro — используется только когда панель открыта как файл
// (file://), без локального сервера.
const DIRECT_API_BASE = 'https://api.xkiro.com';
const DIRECT_PATHS = {
  usage: '/v1/usage',
  models: '/v1/models',
};

// OmniRoute API: пути через серверный прокси /omniroute.
// URL и ключ хранятся на сервере (настройки) — клиент их не передаёт.
export const COMBO_LIST_PATH = '/api/combos';
export const COMBO_PATH = (id) => '/api/combos/' + encodeURIComponent(id);

// Call logs OmniRoute: список последних запросов с реальной моделью,
// которая обслужила запрос (поле model), и запрошенной (requestedModel).
export const CALL_LOGS_PATH = '/api/usage/call-logs';
export const CALL_LOGS_URL = (limit) =>
  CALL_LOGS_PATH + '?limit=' + encodeURIComponent(limit);

/**
 * Запрос к API активного провайдера (resource: 'usage' | 'models').
 * Ключ: явный (проверка в настройках) → ключ этого провайдера из
 * хранилища. Ключей на сервере нет — upstream всегда уходит
 * клиентский ключ.
 */
export async function providerRequest(resource, opts = {}) {
  const provider = opts.provider || session.activeProvider || PROVIDER_FALLBACK;

  const key = opts.key || keyForProvider(provider.id) || '';
  const headers = {};
  if (key) headers['x-api-key'] = key;
  // Доп. данные авторизации (AgentRouter: числовой ID для New-Api-User)
  const extraUserId = opts.userId !== undefined
    ? opts.userId
    : getAgentRouterUserId();
  if (extraUserId) headers['x-agentrouter-user-id'] = extraUserId;

  const url =
    location.protocol === 'file:'
      ? DIRECT_API_BASE + DIRECT_PATHS[resource]
      : '/api/providers/' + provider.id + '/' + resource;

  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new Error('Нет доступа к API — запустите node server.js');
  }

  let data = null;
  try {
    data = await response.json();
  } catch { /* не JSON — ошибка ниже с кодом статуса */ }

  if (!response.ok) {
    const err = new Error(
      (data && (data.message || data.error)) || 'HTTP ' + response.status
    );
    err.status = response.status;
    throw err;
  }
  return data;
}

/* --- OmniRoute fetch: отдельный fetch, не через xKiro-прокси --- */

export async function omniFetch(path, opts = {}) {
  const headers = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const url = '/omniroute' + path;

  const response = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { /* не JSON */ }
    let msg = payload && payload.message ? payload.message : 'HTTP ' + response.status;
    if (payload && payload.error === 'no_omniroute_url') {
      msg = 'Укажите OmniRoute URL в Настройках';
    } else if (payload && payload.error === 'invalid_omniroute_url') {
      msg = 'OmniRoute URL запрещён настройками сервера';
    } else if (response.status === 401 || response.status === 403) {
      msg += ' — проверьте OmniRoute API Key в Настройках';
    }
    throw Object.assign(new Error(msg), { status: response.status, code: payload && payload.error });
  }
  return response.json();
}

/* ---------- Antigravity (Google) ---------- */

// Коды ошибок квот Antigravity → человекочитаемые сообщения.
// Нужен и странице статистики, и диалогу настроек.
export const AG_ERROR_MESSAGES = {
  no_token: 'Токен не задан — вставьте Antigravity OAuth-токен в настройках.',
  token_expired: 'Токен истёк — обновите его в настройках или задайте refresh-связку для автообновления.',
  project_required: 'Google требует project_id — укажите его в настройках Antigravity.',
  rate_limited: 'Слишком частые запросы к Google — попробуйте позже.',
  provider_error: 'Не удалось получить квоты Google.',
  network: 'Нет доступа к панели — запустите node server.js',
};

export async function fetchAntigravityQuota() {
  const res = await fetch('/api/antigravity-quota');
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// Статус Google-токена с сервера (сами секреты клиенту не возвращаются)
export async function fetchGoogleTokenStatus() {
  const res = await fetch('/api/settings/google-token');
  return res.json();
}

/** URL авторизации Google для кнопки «Войти через Google». */
export async function startGoogleAuth() {
  const res = await fetch('/api/antigravity-auth/start');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.message || 'HTTP ' + res.status);
  return data.url;
}

/** Обмен вставленной ссылки с кодом авторизации на токены (на сервере). */
export async function pasteGoogleAuth(url) {
  const res = await fetch('/api/antigravity-auth/paste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || 'HTTP ' + res.status);
  return data;
}
