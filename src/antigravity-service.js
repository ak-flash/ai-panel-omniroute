'use strict';

// ============================================================
// Сервис Antigravity: состояние Google-авторизации и кеш квот.
//
// HTTP-слой (src/routes/antigravity.js) только разбирает запрос и
// ответ; сервис владеет токенами, OAuth-state, кешем и сохранением
// refresh-связки в зашифрованном хранилище. Зависимости приходят
// параметрами — process.env и файловая система сервису недоступны.
//
// Access-токен живёт в памяти процесса; refresh-связка и project_id —
// в серверном хранилище (SQLite, зашифровано) и загружаются при
// старте, поэтому перезапуск сервера не сбрасывает вход: сервер сам
// обновит access-токен по связке.
// ============================================================

const crypto = require('crypto');
const { AppError } = require('./http');

const AG_CACHE_TTL_MS = 60000; // серверный кеш квот, 60 с
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // время жизни одноразового OAuth state

function createAntigravityService({
  googleOauth,
  antigravity,
  getStore,
  getBuiltinClientId,
  getBuiltinClientSecret,
}) {
  const state = {
    token: '',
    refreshToken: '',
    clientId: '',
    clientSecret: '',
    project: '',
    tokenExpiresAt: 0,
    email: '',
  };
  let cache = { ts: 0, result: null, project: null };
  let loaded = false; // refresh-связка из хранилища читается один раз
  const oauthStates = new Map(); // state → expiresAt (анти-CSRF/replay)

  const resetCache = () => { cache = { ts: 0, result: null, project: null }; };
  const hasRefreshCreds = () =>
    Boolean(state.refreshToken && state.clientId && state.clientSecret);

  async function setStore(key, value) {
    await (await getStore()).set(key, value);
  }

  /** Сохраняет токены после успешного обмена кода или refresh. */
  function storeExchangedTokens(r) {
    state.token = r.accessToken;
    state.tokenExpiresAt = r.expiresIn ? Date.now() + r.expiresIn * 1000 : 0;
    if (r.refreshToken) state.refreshToken = r.refreshToken;
    state.clientId = getBuiltinClientId();
    state.clientSecret = getBuiltinClientSecret();
    resetCache();
  }

  /** Применяет сохранённые Antigravity-данные (entries) к состоянию. */
  function syncFromStore(entries = []) {
    for (const [k, v] of entries) {
      if (k === 'agRefreshToken') state.refreshToken = String(v || '');
      if (k === 'agProject') state.project = String(v || '');
      if (k === 'agEmail') state.email = String(v || '');
    }
    if (state.refreshToken) {
      state.clientId = getBuiltinClientId();
      state.clientSecret = getBuiltinClientSecret();
    }
    resetCache();
  }

  /** Загружает сохранённую refresh-связку при старте (один раз). */
  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      if (state.refreshToken) return; // уже установлено через POST/paste
      const s = await (await getStore()).snapshot();
      const entries = [];
      if (s.agRefreshToken) entries.push(['agRefreshToken', s.agRefreshToken]);
      if (s.agProject) entries.push(['agProject', s.agProject]);
      if (s.agEmail) entries.push(['agEmail', s.agEmail]);
      if (entries.length) syncFromStore(entries);
    } catch {}
  }

  /** Обновляет access-token по refresh-связке. true при успехе. */
  async function refresh() {
    if (!hasRefreshCreds()) return false;
    const r = await googleOauth.refresh({
      refreshToken: state.refreshToken,
      clientId: state.clientId,
      clientSecret: state.clientSecret,
    });
    if (r.ok) {
      state.token = r.accessToken;
      state.tokenExpiresAt = r.expiresIn ? Date.now() + r.expiresIn * 1000 : 0;
      resetCache();
      return true;
    }
    if (r.error === 'invalid_grant') {
      // Refresh-токен отозван — связка больше не поможет
      state.token = '';
    }
    return false;
  }

  /** Одноразовый OAuth state с TTL; заодно чистит протухшие. */
  function issueState() {
    const value = crypto.randomUUID();
    oauthStates.set(value, Date.now() + OAUTH_STATE_TTL_MS);
    for (const [key, expiresAt] of oauthStates) {
      if (expiresAt < Date.now()) oauthStates.delete(key);
    }
    return value;
  }

  /** Проверяет и «сжигает» state; невалидный — 400. */
  function consumeState(value) {
    const expiresAt = value ? oauthStates.get(value) : null;
    if (!expiresAt || expiresAt < Date.now()) {
      if (value) oauthStates.delete(value);
      throw new AppError(400, 'invalid_oauth_state', 'OAuth state отсутствует, истёк или уже использован');
    }
    oauthStates.delete(value);
  }

  /** POST /api/settings/google-token: частичное обновление данных.
   * Пустая строка очищает соответствующее поле. */
  async function applyCredentials(body) {
    const str = (v) => typeof v === 'string' ? v.trim() : '';
    if ('token' in body) state.token = str(body.token);
    if ('refreshToken' in body) state.refreshToken = str(body.refreshToken);
    if ('clientId' in body) state.clientId = str(body.clientId);
    if ('clientSecret' in body) state.clientSecret = str(body.clientSecret);
    if ('project' in body) state.project = str(body.project);
    // Самые важные поля персистим в хранилище (зашифровано на диске)
    if ('refreshToken' in body) await setStore('agRefreshToken', state.refreshToken);
    if ('project' in body) await setStore('agProject', state.project);
    if (!state.token && !hasRefreshCreds()) {
      throw new AppError(400, 'no_token', 'Нужен access-token или связка refresh-token + client_id + client_secret');
    }
    resetCache(); // новые данные — сбрасываем кеш
  }

  /** DELETE /api/settings/google-token: полный сброс входа. */
  async function clearCredentials() {
    state.token = '';
    state.refreshToken = '';
    state.clientId = '';
    state.clientSecret = '';
    state.project = '';
    state.tokenExpiresAt = 0;
    state.email = '';
    resetCache();
    await setStore('agRefreshToken', '');
    await setStore('agProject', '');
    await setStore('agEmail', '');
  }

  /** Публичный статус (без секретов) для /api/settings/google-token. */
  function status() {
    return {
      hasToken: Boolean(state.token),
      hasRefresh: hasRefreshCreds(),
      tokenExpiresAt: state.tokenExpiresAt || null,
      email: state.email || null,
    };
  }

  /** paste: обмен кода на токены + сохранение связки и email. */
  async function exchangeCallback({ code, redirectUri }) {
    const r = await googleOauth.exchangeCode({ code, redirectUri });
    if (!r.ok) {
      throw new AppError(502, r.error || 'oauth_exchange_failed', 'Не удалось обменять код авторизации');
    }
    storeExchangedTokens(r);
    // Refresh-связку сохраняем на сервере, чтобы вход переживал перезапуск;
    // клиенту её возвращать не обязательно
    if (state.refreshToken) await setStore('agRefreshToken', state.refreshToken);
    // Email аккаунта — best-effort из Google userinfo (не ломает вход);
    // сохраняем в хранилище, чтобы email переживал перезапуск сервера
    if (typeof googleOauth.getUserInfo === 'function') {
      try {
        const ui = await googleOauth.getUserInfo({ accessToken: state.token });
        if (ui.ok) state.email = ui.email || '';
        if (state.email) { try { await setStore('agEmail', state.email); } catch {} }
      } catch {}
    }
    return { ok: true, hasToken: true, hasRefresh: Boolean(state.refreshToken) };
  }

  /** Квоты Antigravity: кеш 60 с, авто-refresh по 401, групповые окна. */
  async function getQuota(project) {
    await ensureLoaded();
    if (!state.token && !hasRefreshCreds()) {
      throw new AppError(400, 'no_token', 'Задайте Antigravity OAuth-токен или refresh-связку в настройках');
    }
    if (cache.result && cache.project === project && Date.now() - cache.ts < AG_CACHE_TTL_MS) {
      return cache.result;
    }
    // Нет access-token, но есть refresh-связка — обновляем заранее
    if (!state.token) await refresh();
    // Email: разовый backfill после перезапуска — связка жива, а email в памяти пуст
    if (!state.email && state.token && typeof googleOauth.getUserInfo === 'function') {
      try {
        const ui = await googleOauth.getUserInfo({ accessToken: state.token });
        if (ui.ok && ui.email) {
          state.email = ui.email;
          try { await setStore('agEmail', state.email); } catch {}
        }
      } catch {}
    }
    let result = state.token
      ? await antigravity.getQuota({ token: state.token, project })
      : { status: 401, data: { error: 'token_expired' } }; // refresh не удался
    // Access-token истёк — обновляем и повторяем один раз
    if (result.status === 401 && hasRefreshCreds()) {
      if (await refresh()) {
        result = await antigravity.getQuota({ token: state.token, project });
      }
    }
    // Успех → дополняем групповыми окнами (weekly/5h); ошибка окон не ломает ответ
    if (result.status === 200 && state.token) {
      try {
        const summary = await antigravity.getQuotaSummary({ token: state.token, project });
        if (summary && summary.status === 200 && summary.data) result.data.windows = summary.data.windows;
      } catch {}
    }
    cache = { ts: Date.now(), result, project };
    return result;
  }

  return {
    ensureLoaded,
    getProject: () => state.project,
    issueState,
    consumeState,
    applyCredentials,
    clearCredentials,
    status,
    syncFromStore, // /api/config: применяет записанные в STORE antg-поля (agRefreshToken/Project/Email)
    exchangeCallback,
    getQuota,
  };
}

module.exports = { createAntigravityService, AG_CACHE_TTL_MS };
