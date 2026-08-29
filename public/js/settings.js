/* ============================================================
   AI Panel — settings client: серверное хранилище как источник
   правды (SQLite, зашифровано AES-256-GCM).

   Секреты write-only: сервер их не возвращает (только булевы
   has*), а клиент после отправки очищает поля формы. Пустое
   значение секрета при сохранении означает «не изменять».
   При file:// используется пустой кеш и localStorage-фолбэки
   для чтения старых ключей.
   ============================================================ */

// Legacy localStorage-ключи: только чтение старых данных (file://
// и базы до перехода на серверное хранилище). Ничего нового туда
// не пишем.
const LS_KEY = 'aipanel.apikey';
const LS_XKIRO_KEY = 'aipanel.xkiro.key.v2';
const LS_OMNI_URL = 'aipanel.omni.url';

let vaultCache = null; // null = ещё не загружен, {} = пусто
let vaultLoaded = false;

export async function loadVault() {
  if (vaultLoaded) return vaultCache;
  if (location.protocol === 'file:') { vaultLoaded = true; vaultCache = {}; return vaultCache; }
  try {
    const r = await fetch('/api/config');
    const j = await r.json();
    vaultCache = (j && j.data) || {};
  } catch {
    console.warn('[settings] /api/config недоступен — начинаю с пустых настроек');
    vaultCache = {};
  }
  vaultLoaded = true;
  return vaultCache;
}

export function vaultGet(key, fallback = '') {
  if (vaultCache && key in vaultCache) return vaultCache[key];
  return fallback;
}

// Отдельная запись одного ключа — для несекретных предпочтений UI
// (выбор провайдера, активная combo). Ошибки не глушим совсем:
// пишем в консоль, чтобы пропажу настройки можно было диагностировать.
export async function vaultSet(key, value) {
  const v = value == null ? '' : String(value);
  if (vaultCache) vaultCache[key] = v;
  if (location.protocol === 'file:') return;
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: v }),
    });
    if (!res.ok) console.warn('[settings] не сохранился ключ «' + key + '»: HTTP ' + res.status);
  } catch {
    console.warn('[settings] не сохранился ключ «' + key + '»: нет доступа к API');
  }
}

export async function vaultRemove(key) { return vaultSet(key, ''); }

/**
 * Батч-сохранение настроек одним PUT /api/config (сервер пишет
 * всё одной транзакцией хранилища). Не бросает исключений —
 * возвращает { ok, status?, error?, message? }, чтобы вызывающий
 * код показал ошибку пользователю.
 */
export async function saveSettings(entries) {
  if (location.protocol === 'file:') return { ok: true }; // некуда сохранять
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entries),
    });
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch { /* не JSON */ }
      return {
        ok: false,
        status: res.status,
        error: payload && payload.error,
        message: (payload && payload.message) || 'HTTP ' + res.status,
      };
    }
    // Кеш обновляем после успешного ответа — vaultGet сразу видит новое
    for (const [k, v] of Object.entries(entries)) {
      if (vaultCache) vaultCache[k] = v;
    }
    return { ok: true };
  } catch {
    return { ok: false, message: 'Нет доступа к API — запустите node server.js' };
  }
}

/** GET /api/config: список провайдеров и несекретные поля. null — недоступен. */
export async function loadAppConfig() {
  if (location.protocol === 'file:') return null;
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------- ключи провайдеров ---------- */

export function getKey() {
  if (vaultLoaded) return vaultGet('xkiroKey') || '';
  try { const v = localStorage.getItem(LS_XKIRO_KEY); if (v) return v.startsWith('enc:') ? atob(v.slice(4)) : v; } catch { /* нет localStorage */ }
  try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
}
export function setKey(k) { vaultSet('xkiroKey', k); }
export function removeKey() { vaultSet('xkiroKey', ''); }

export function getAgentRouterKey() { return vaultGet('agentrouterKey') || ''; }
// Числовой ID пользователя AgentRouter — второй фактор авторизации
// (заголовок New-Api-User); не секрет, но храним рядом с токеном
export function getAgentRouterUserId() { return vaultGet('agentrouterUserId') || ''; }

// Ключ провайдера статистики/моделей: у каждого своё поле в хранилище
// (xkiro — с legacy-фолбэками на localStorage для режима file://)
export function keyForProvider(id) {
  if (id === 'xkiro') return getKey();
  if (id === 'agentrouter') return getAgentRouterKey();
  return '';
}

export function getOmniUrl() {
  return vaultLoaded
    ? (vaultGet('omniUrl') || '')
    : (() => { try { return localStorage.getItem(LS_OMNI_URL) || ''; } catch { return ''; } })();
}

export function getAgRefreshToken() { return vaultGet('agRefreshToken') || ''; }

// Нормализация URL OmniRoute: убираем хвостовые слэши и лишние суффиксы
// (/v1, /v1/, /api), которые пользователь мог ввести по ошибке.
export function normalizeOmniUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/(v\d+|api)$/i, '');
  return u;
}
