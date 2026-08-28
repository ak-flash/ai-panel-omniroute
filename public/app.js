'use strict';

/* ============================================================
   AI Panel — vanilla JS, no build step
   ============================================================ */

const LS_KEY = 'aipanel.apikey';
const LS_COMBO_ACTIVE = 'aipanel.combo.active';
const LS_MODELS_PROVIDER = 'aipanel.models.provider';
const LS_ALIASES = 'aipanel.combo.aliases';
const LS_XKIRO_KEY = 'aipanel.xkiro.key.v2';
const LS_OMNI_URL = 'aipanel.omni.url';
const LS_OMNI_KEY = 'aipanel.omni.key.v2';
const LS_AG_REFRESH = 'aipanel.antigravity.refresh';
const LS_DLG_PROVIDER = 'aipanel.dlg.provider';

// Серверное хранилище (SQLite, зашифровано AES-256-GCM) — источник правды.
// При file:// фолбэк на localStorage. Кеш загружается в boot() один раз.
let vaultCache = null; // null = ещё не загружен, {} = пусто
let vaultLoaded = false;
async function loadVault(){
  if(vaultLoaded) return vaultCache;
  if(location.protocol==='file:'){ vaultLoaded=true; vaultCache={}; return vaultCache; }
  try{ const r=await fetch('/api/settings/vault'); const j=await r.json(); vaultCache=(j&&j.data)||{}; }catch{ vaultCache={}; }
  vaultLoaded=true; return vaultCache;
}
function vaultGet(key, fallback=''){ if(vaultCache&&key in vaultCache) return vaultCache[key]; return fallback; }
async function vaultSet(key, value){
  const v=value==null?'':String(value);
  if(vaultCache) vaultCache[key]=v;
  if(location.protocol==='file:'){ try{ if(v) localStorage.setItem(key,v); else localStorage.removeItem(key);}catch{} return; }
  try{ await fetch('/api/settings/vault',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value:v})}); }catch{}
}
async function vaultRemove(key){ return vaultSet(key,''); }

// Текущая страница: index (Статистика) | models (Модели) | combo (Combo).
// Панель состоит из отдельных HTML-страниц с одним общим app.js.
// У каждой страницы свой набор элементов, поэтому DOM-ссылки могут
// отсутствовать: они проверяются на null (helpers $id и on).
const PAGE = (document.body.dataset.page || 'index').toLowerCase();

/* ---------- DOM refs ---------- */
let $statusDot, $statusText, $cards, $statsProvider, $setup;
let $banner, $bannerText, $updated, $live, $planBadge;
let $walletBalance, $walletHeld;
let $shortCard, $longCard, $freeCard;
let $btnRefresh, $btnSettings;
let $topbarCollapse, $topbarToggle;
let $modelsStatus, $modelsBody, $modelsSearch, $modelsTier, $modelsProvider, $modelsProviderName, $setupProviderName;
let $comboSelect, $comboRefresh, $comboEmpty, $comboStatus, $comboDetails;
let $comboStrategyBadge, $comboTargetsCount, $comboModelSelect, $comboMoveTop, $comboList;
let $btnUpgrade, $copyStatus, $cmdText;
let $agSection, $agCards, $agHint, $agBadge, $agEmail;
let $dlg, $dlgKey, $dlgToggle, $dlgSave, $dlgRemove, $dlgResult;

// Прямой адрес API xKiro — используется только когда панель открыта как файл
// (file://), без локального сервера. При работе через сервер данные идут
// через /api/providers/<id>/… — пути и авторизацию знает серверный адаптер
// провайдера (см. providers/ на сервере).
const DIRECT_API_BASE = 'https://api.xkiro.com';
const DIRECT_PATHS = {
  usage: '/v1/usage',
  models: '/v1/models',
};

// Провайдер по умолчанию — когда /api/config недоступен (режим file://).
// Список провайдеров и активный приходят с сервера (/api/config).
const PROVIDER_FALLBACK = { id: 'xkiro', name: 'xKiro', hasKey: false };

// OmniRoute API: базовый адрес и пути.
// Адрес и ключ хранятся в localStorage (настройки), иначе — прокси /omniroute.
function getOmniBase() { return normalizeOmniUrl(getOmniUrl()); }
const COMBO_LIST_PATH = '/api/combos';
const COMBO_PATH = (id) => '/api/combos/' + encodeURIComponent(id);

const state = {
  usage: null,
  fetchedAt: null,
  models: null,
    providers: [],                  // список с сервера (/api/config)
  activeProvider: PROVIDER_FALLBACK, // провайдер блока статистики
  modelsProvider: PROVIDER_FALLBACK, // провайдер каталога моделей (выбирается на странице «Модели»)
  combos: [],
  combosLoaded: false,
  comboError: null,   // текст последней ошибки загрузки (не затирается рендером)
  activeComboId: null,
  comboModels: [],     // массив target-объектов: { provider, model, display, weight }
  activeComboData: null, // полный объект combo с сервера для PUT
  antigravityQuota: null, // квоты Antigravity (модели Google AI Pro)
  antigravityEmail: '',    // email аккаунта Google (из сервера, после входа)
};

/* ---------- vault helpers (server SQLite, file:// fallback localStorage) ---------- */
function getKey() {
  if(vaultLoaded) return vaultGet('xkiroKey')||'';
  try{ const v=localStorage.getItem(LS_XKIRO_KEY); if(v) return v.startsWith('enc:')?atob(v.slice(4)):v; }catch{}
  try{ return localStorage.getItem(LS_KEY)||''; }catch{ return ''; }
}
function setKey(k){ vaultSet('xkiroKey', k); }
function removeKey(){ vaultSet('xkiroKey',''); }
function getOmniUrl(){ return vaultLoaded ? (vaultGet('omniUrl')||'') : (()=>{try{return localStorage.getItem(LS_OMNI_URL)||'';}catch{return '';}})(); }
function getOmniKey(){ return vaultLoaded ? (vaultGet('omniKey')||'') : (()=>{try{const v=localStorage.getItem(LS_OMNI_KEY);return v&&v.startsWith('enc:')?atob(v.slice(4)):v||'';}catch{return '';}})(); }
function getAgRefreshToken(){ return vaultGet('agRefreshToken')||''; }
function setAgRefreshToken(t){ vaultSet('agRefreshToken', t); }

// Нормализация URL OmniRoute: убираем хвостовые слэши и лишние суффиксы
// (/v1, /v1/, /api), которые пользователь мог ввести по ошибке.
function normalizeOmniUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/(v\d+|api)$/i, '');
  return u;
}
function setOmniConfig(url, key) {
  const clean = normalizeOmniUrl(url);
  vaultSet('omniUrl', clean);
  vaultSet('omniKey', key||'');
}

// getElementById, безопасный для страниц, где элемента нет
const $id = (id) => document.getElementById(id);

// addEventListener только если элемент есть на текущей странице
function on(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

// Внедряем шаблонные компоненты (шапка, диалог, баннер) в заглушки
injectPartials(PAGE);
resolveRefs();

function fmtUsd(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return '$' + (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function compact(n) {
  return new Intl.NumberFormat('ru', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

function dur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec >= 86400) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return h ? `${d} дн ${h} ч` : `${d} дн`;
  }
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} мин ${s} с` : `${m} мин`;
  }
  return `${sec} с`;
}

function num(v) {
  return typeof v === 'string' ? parseFloat(v) : v;
}

function pct(spent, cap) {
  spent = num(spent);
  cap = num(cap);
  if (!Number.isFinite(spent) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(100, Math.max(0, (spent / cap) * 100));
}

function barClass(p) {
  if (p < 70) return '';
  if (p < 90) return 'warn';
  return 'danger';
}

function windowTitle(kind) {
  return kind === 'short' ? 'Короткое окно' : 'Длинное окно';
}

/* ---------- API ---------- */

/**
 * Запрос к API активного провайдера (resource: 'usage' | 'models').
 *
 * Через сервер — /api/providers/<id>/<resource>: сервер вызывает функцию
 * адаптера провайдера (providers/ на сервере), передавая клиентский
 * ключ из заголовка x-api-key.
 * В режиме file:// — прямой запрос к API xKiro (нужен разрешённый CORS).
 */
async function providerRequest(resource, opts = {}) {
  const provider = opts.provider || state.activeProvider;

  // Ключ: явный (проверка в настройках) → сохранённый локально.
  // Ключей на сервере нет — upstream всегда уходит клиентский ключ.
  const key = opts.key || getKey() || '';
  const headers = {};
  if (key) headers['x-api-key'] = key;

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
  } catch {}

  if (!response.ok) {
    const err = new Error(
      (data && (data.message || data.error)) || 'HTTP ' + response.status
    );
    err.status = response.status;
    throw err;
  }
  return data;
}

function resolveRefs() {
  $statusDot = $id('status-dot');
  $statusText = $id('status-text');
  $cards = $id('cards');
  $statsProvider = $id('stats-provider');
  $setup = $id('setup');
  $banner = $id('banner');
  $bannerText = $id('banner-text');
  $updated = $id('updated');
  $live = $id('live');
  $planBadge = $id('plan-badge');
  $walletBalance = $id('wallet-balance');
  $walletHeld = $id('wallet-held');
  $shortCard = $id('card-short');
  $longCard = $id('card-long');
  $freeCard = $id('card-free');
  $btnRefresh = $id('btn-refresh');
  $btnSettings = $id('btn-settings');
  $topbarCollapse = $id('topbar-collapse');
  $topbarToggle = $id('btn-topbar-toggle');
  $modelsStatus = $id('models-status');
  $modelsBody = $id('models-body');
  $modelsSearch = $id('models-search');
  $modelsTier = $id('models-tier');
  $modelsProvider = $id('models-provider');
  $modelsProviderName = $id('models-provider-name');
  $setupProviderName = $id('setup-provider-name');
  $comboSelect = $id('combo-select');
  $comboRefresh = $id('combo-refresh');
  $comboEmpty = $id('combo-empty');
  $comboStatus = $id('combo-status');
  $comboDetails = $id('combo-details');
  $comboStrategyBadge = $id('combo-strategy-badge');
  $comboTargetsCount = $id('combo-targets-count');
  $comboModelSelect = $id('combo-model-select');
  $comboMoveTop = $id('combo-move-top');
  $comboList = $id('combo-models-list');
  $btnUpgrade = $id('btn-copy-cmd');
  $copyStatus = $id('copy-status');
  $cmdText = $id('manage-cmd-text');
  $agSection = $id('antigravity-quota');
  $agCards = $id('ag-cards');
  $agHint = $id('ag-hint');
  $agBadge = $id('ag-status-badge');
  $agEmail = $id('ag-account-email');
  $dlg = $id('dlg');
  $dlgKey = $id('dlg-key');
  $dlgToggle = $id('dlg-toggle');
  $dlgSave = $id('dlg-save');
  $dlgRemove = $id('dlg-remove');
  $dlgResult = $id('dlg-result');
}


/* ---------- rendering ---------- */

function setStatus(type, text) {
  if (!$statusDot || !$statusText) return;
  $statusDot.className = 'dot ' + type;
  $statusText.textContent = text;
}

// Подпись блока статистики: «провайдер xKiro».
// Активный провайдер приходит с сервера (/api/config).
function renderProviderLabel() {
  if ($statsProvider) {
    $statsProvider.textContent =
      'провайдер ' + (state.activeProvider.name || '—');
  }
}

function showBanner(msg) {
  if (!$banner) return;
  $bannerText.textContent = msg;
  $banner.hidden = false;
}

function hideBanner() {
  if ($banner) $banner.hidden = true;
}

// Отметка времени в шапке — на любой странице после успешной загрузки
function touchUpdated() {
  if ($updated) {
    $updated.textContent = new Date().toLocaleTimeString('ru', {
      hour12: false,
    });
    $updated.dateTime = new Date().toISOString();
    $updated.hidden = false;
  }
}

function setWindow(kind, w) {
  const card = kind === 'short' ? $shortCard : $longCard;
  if (!card || !w) {
    if (card) card.hidden = true;
    return;
  }

  const p = pct(w.spent_usd, w.cap_usd);
  document.getElementById(kind + '-pct').textContent =
    w.cap_usd ? Math.round(p) + '%' : '';

  card.querySelector('.stat-meta').textContent = dur(w.window_sec);
  card.querySelector('.stat-value').innerHTML =
    `<span class="val-used">${fmtUsd(w.spent_usd)}</span>` +
    ` <span class="val-sep">/</span> ` +
    `<span class="val-limit">${fmtUsd(w.cap_usd)}</span>`;

  const bar = card.querySelector('.bar-fill');
  bar.style.width = p + '%';
  bar.classList.remove('warn', 'danger');
  const cls = barClass(p);
  if (cls) bar.classList.add(cls);

  state['deadline_' + kind] =
    state.fetchedAt + (w.resets_in_sec || 0) * 1000;

  tickWindow(kind);
}

function tickWindow(kind) {
  const el = document.getElementById(kind + '-reset');
  const deadline = state['deadline_' + kind];
  if (!el || !deadline) return;
  const remainSec = Math.floor((deadline - Date.now()) / 1000);
  el.textContent = remainSec <= 0 ? 'обновляется…' : dur(remainSec);
}

function tickFree() {
  const el = document.getElementById('free-reset');
  const deadline = state.deadline_free;
  if (!el || !deadline) return;
  const remainSec = Math.floor((deadline - Date.now()) / 1000);
  el.textContent = remainSec <= 0 ? 'обновляется…' : dur(remainSec);
}

function renderFreeTokens(free) {
  if (!free || free.used_today == null) {
    if ($freeCard) $freeCard.hidden = true;
    return;
  }
  $freeCard.hidden = false;

  const used = num(free.used_today);
  const limit = free.limit_per_day == null ? null : num(free.limit_per_day);

  const usedPct = limit ? pct(used, limit) : 0;
  document.getElementById('free-pct').textContent =
    limit != null ? Math.round(usedPct) + '%' : '';
  document.getElementById('free-value').innerHTML =
    limit == null
      ? `<span class="val-used">${compact(used)}</span>`
      : `<span class="val-used">${compact(used)}</span>` +
        ` <span class="val-sep">/</span> ` +
        `<span class="val-limit">${compact(limit)}</span>`;

  const bar = $freeCard.querySelector('.bar-fill');
  bar.style.width = usedPct + '%';
  bar.classList.remove('warn', 'danger');
  const cls = barClass(usedPct);
  if (cls) bar.classList.add(cls);

  state.deadline_free =
    state.fetchedAt + (free.resets_in_sec || 0) * 1000;
  if (!free.resets_in_sec) {
    const now = new Date();
    state.deadline_free = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
  }
  tickFree();
}

function renderUsage(data) {
  state.usage = data;
  state.fetchedAt = Date.now();

  $cards.hidden = false;
  $setup.hidden = true;

  $planBadge.textContent = data.plan
    ? String(data.plan).toUpperCase()
    : 'payg';

  const wallet = data.wallet || {};
  $walletBalance.textContent = fmtUsd(wallet.balance_usd);
  const held = num(wallet.held_usd);
  $walletHeld.textContent = held > 0 ? 'В холде: ' + fmtUsd(held) : '';

  // API отдаёт окна массивом объектов с полем kind: 'short' | 'long'
  const list = Array.isArray(data.windows) ? data.windows : [];
  const byKind = Object.fromEntries(list.map((w) => [w.kind, w]));
  setWindow('short', byKind.short);
  setWindow('long', byKind.long);

  renderFreeTokens(data.free_tokens);

  setStatus('ok', '');
  touchUpdated();

  if ($live) {
    $live.textContent =
      'Баланс ' + fmtUsd(wallet.balance_usd) +
      ', план ' + (data.plan || 'PAYG');
  }
}

/* ---------- models ---------- */

function modelRow(model) {
  const tr = document.createElement('tr');

  const tdId = document.createElement('td');
  tdId.textContent = model.id;

  const tdTier = document.createElement('td');
  const badge = document.createElement('span');
  const tier = model.access_tier || 'paid';
  badge.className = 'badge ' + tier;
  badge.textContent = tier;
  tdTier.appendChild(badge);

  const tdCtx = document.createElement('td');
  tdCtx.className = 'num-col';
  tdCtx.textContent =
    model.context_length != null ? compact(model.context_length) : '—';

  const pricing = model.pricing || {};
  const tdIn = document.createElement('td');
  tdIn.className = 'num-col';
  tdIn.textContent = Number(pricing.input || 0).toFixed(2);
  const tdOut = document.createElement('td');
  tdOut.className = 'num-col';
  tdOut.textContent = Number(pricing.output || 0).toFixed(2);

  tr.append(tdId, tdTier, tdCtx, tdIn, tdOut);
  return tr;
}

function renderModels(data) {
  state.models = data.data || [];
  filterModels();
}

// Суммарная цена за 1M токенов — метрика сортировки каталога
function modelPrice(m) {
  const pricing = m.pricing || {};
  return Number(pricing.input || 0) + Number(pricing.output || 0);
}

function filterModels() {
  if (!$modelsBody) return;
  const q = ($modelsSearch ? $modelsSearch.value : '').trim().toLowerCase();
  const tier = $modelsTier && $modelsTier.value !== 'all' ? $modelsTier.value : null;
  $modelsBody.replaceChildren();
  const rows = state.models
    .filter((m) => {
      if (tier && (m.access_tier || 'paid') !== tier) return false;
      if (!q) return true;
      const hay = (m.id + ' ' + (m.display_name || '')).toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => modelPrice(a) - modelPrice(b));
  for (const m of rows) $modelsBody.appendChild(modelRow(m));
}

/**
 * Селект провайдеров на странице «Модели»: каталог загружается
 * для выбранного провайдера (выбор сохраняется в localStorage).
 */
function renderModelsProviders() {
  if (!$modelsProvider) return;
  const list = state.providers.length ? state.providers : [state.activeProvider];
  const selectedId = state.modelsProvider ? state.modelsProvider.id : '';
  $modelsProvider.replaceChildren();
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    opt.selected = p.id === selectedId;
    $modelsProvider.appendChild(opt);
  }
  const name = state.modelsProvider
    ? (state.modelsProvider.name || state.modelsProvider.id)
    : '';
  if ($modelsProviderName) $modelsProviderName.textContent = name;
  if ($setupProviderName) $setupProviderName.textContent = name;
}

/* ---------- combos (OmniRoute API) ---------- */

/** Сохраняет выбранную combo в localStorage */
function saveActiveCombo() {
  try {
    if(vaultLoaded) vaultSet('comboActive', state.activeComboId||'');
  } catch {}
}

function activeCombo() {
  return state.combos.find((c) => c.id === state.activeComboId) || null;
}

/* --- OmniRoute fetch: отдельный fetch, не через xKiro-прокси --- */

async function omniFetch(path, opts = {}) {
  const headers = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const omniKey = getOmniKey();
  if (omniKey) headers['authorization'] = 'Bearer ' + omniKey;

  const omniBase = getOmniBase();
  let url;
  if (location.protocol !== 'file:') {
    // Через прокси server.js: адрес инстанса передаём заголовком
    url = '/omniroute' + path;
    if (omniBase) headers['x-omniroute-url'] = omniBase;
  } else if (omniBase) {
    // Прямой запрос (режим file://) — OmniRoute должен разрешать CORS
    url = omniBase + path;
  } else {
    throw new Error('Адрес OmniRoute не задан — откройте Настройки и укажите URL');
  }

  const response = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!response.ok) {
    let msg = 'HTTP ' + response.status;
    if (response.status === 400) {
      msg += ' — укажите OmniRoute URL в Настройках';
    }
    if (response.status === 401 || response.status === 403) {
      msg += ' — проверьте OmniRoute API Key в Настройках';
    }
    throw Object.assign(new Error(msg), { status: response.status });
  }
  return response.json();
}

/* ---------- алиасы провайдеров OmniRoute ---------- */

// Хранится как массив пар [id, name] под одним ключом LS_ALIASES (JSON).
function loadAliases() {
  try {
    const raw = (vaultGet('aliases')||'');
    const arr = raw ? JSON.parse(raw) : [];
    const map = {};
    if (Array.isArray(arr)) for (const [id, name] of arr) if (id && name) map[id] = name;
    return map;
  } catch { return {}; }
}

function saveAliasesMap(map) {
  try {
    const arr = Object.entries(map).filter(([id, name]) => id && name);
    vaultSet('aliases', JSON.stringify(arr));
  } catch {}
}

// Рендер списка alias-строк в #dlg-aliases-list
function renderAliasRows() {
  const list = $id('dlg-aliases-list');
  if (!list) return;
  const map = loadAliases();
  list.replaceChildren();
  const entries = Object.entries(map);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.marginTop = '0';
    empty.textContent = 'Пока нет сопоставлений.';
    list.appendChild(empty);
    return;
  }
  for (const [id, name] of entries) {
    const row = document.createElement('div');
    row.className = 'alias-row';
    const inId = document.createElement('input');
    inId.type = 'text';
    inId.placeholder = 'ID из OmniRoute';
    inId.value = id;
    inId.dataset.aliasId = id;
    const inName = document.createElement('input');
    inName.type = 'text';
    inName.placeholder = 'Имя';
    inName.value = name;
    inName.dataset.aliasId = id;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Удалить');
    del.addEventListener('click', () => {
      const m = loadAliases();
      delete m[id];
      saveAliasesMap(m);
      renderAliasRows();
    });
    row.append(inId, inName, del);
    list.appendChild(row);
  }
}

// Собирает map из текущих строк ввода (с учётом несохранённых правок)
function collectAliasesFromUI() {
  const list = $id('dlg-aliases-list');
  const map = {};
  if (!list) return map;
  list.querySelectorAll('.alias-row').forEach((row) => {
    const inputs = row.querySelectorAll('input');
    if (inputs.length < 2) return;
    const id = (inputs[0].value || '').trim();
    const name = (inputs[1].value || '').trim();
    if (id && name) map[id] = name;
  });
  return map;
}

// Заменяет префикс провайдера «<id>/rest» на его алиас
function applyAliases(model, aliases) {
  const i = String(model || '').indexOf('/');
  if (i < 0) return model;
  const prov = model.slice(0, i);
  const rest = model.slice(i + 1);
  return (aliases && aliases[prov] ? aliases[prov] : prov) + '/' + rest;
}

/** Извлекает models из combo-объекта OmniRoute */
function extractComboTargets(combo) {
  // Поле models: каждый элемент { model, providerId, label, weight, … }.
  // На всякий случай понимаем также targets и candidatePool.
  let raw = null;
  if (Array.isArray(combo.models)) raw = combo.models;
  else if (Array.isArray(combo.targets)) raw = combo.targets;
  else if (combo.config && Array.isArray(combo.config.auto && combo.config.auto.candidatePool)) {
    raw = combo.config.auto.candidatePool;
  }
  if (!raw) return [];

  return raw.map((t) => {
    if (typeof t === 'string') {
      return { key: t, display: t };
    }
    const model = t.model || '';
    // «provider/model» без длинного префикса провайдера вида openai-compatible-chat-…
    const shortModel = model.includes('/')
      ? model.slice(model.indexOf('/') + 1)
      : model;
    return {
      key: t.id || model || shortModel,
      display: applyAliases(model, loadAliases()) + (t.label ? '  [' + t.label + ']' : ''),
      modelId: model || shortModel,
      weight: t.weight,
    };
  });
}

/** Загружает список combo с OmniRoute API */
async function loadCombos() {
  $comboStatus.textContent = 'Загружаю список combo…';
  try {
    const data = await omniFetch(COMBO_LIST_PATH);
    // Формат ответа: { combos: [...], total } (или просто массив)
    state.combos = Array.isArray(data) ? data
      : Array.isArray(data.combos) ? data.combos
      : Array.isArray(data.data) ? data.data
      : [];
    state.combosLoaded = true;
    state.comboError = null;
    // Восстановить активный, если он ещё существует
    if (!state.combos.some((c) => c.id === state.activeComboId)) {
      state.activeComboId = state.combos.length ? state.combos[0].id : null;
      saveActiveCombo();
    }
    renderComboControls();
    $comboStatus.textContent = '';
    setStatus('ok', 'OmniRoute · combo: ' + state.combos.length);    touchUpdated();
    // Если есть выбранная combo — подгрузить детали
    if (activeCombo()) loadComboModels();
  } catch (err) {
    state.combosLoaded = true;
    state.comboError =
      'Ошибка загрузки списка combo: ' + (err && err.message ? err.message : err);
    console.error('[Combo] loadCombos failed:', err);
    setStatus('err', 'Ошибка');
    $comboStatus.textContent = state.comboError;
    renderComboControls();
  }
}

function renderComboControls() {
  $comboSelect.replaceChildren();

  if (!state.combos.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = state.combosLoaded ? 'Нет combo' : 'Загрузка…';
    $comboSelect.appendChild(opt);
    $comboSelect.disabled = !state.combosLoaded;
    $comboEmpty.hidden = !state.combosLoaded;
    $comboDetails.hidden = true;
    // Ошибку не затираем — она должна остаться видимой
    if (state.combosLoaded && !state.comboError) $comboStatus.textContent = '';
    return;
  }

  state.comboError = null;

  if (!activeCombo()) {
    state.activeComboId = state.combos[0].id;
    saveActiveCombo();
  }

  for (const c of state.combos) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    $comboSelect.appendChild(opt);
  }
  $comboSelect.value = state.activeComboId;
  $comboSelect.disabled = false;
  $comboEmpty.hidden = true;
}

// matchModel — из model-match.js (подключается на странице Combo)
function findModel(id) {
  return matchModel(state.models, id);
}

function renderComboList() {
  if (!$comboList) return; // элемент есть только на странице Combo
  $comboList.replaceChildren();
  state.comboModels.forEach((t, i) => {
    const li = document.createElement('li');
    if (i === 0) li.classList.add('top');

    const rank = document.createElement('span');
    rank.className = 'combo-rank num';
    rank.textContent = String(i + 1);

    const m = findModel(t.modelId);
    const name = document.createElement('code');
    name.className = 'combo-model-id';
    name.textContent = t.display;
    if (m && m.display_name) name.title = m.display_name;

    li.append(rank, name);

    if (m) {
      const tier = m.access_tier || 'paid';
      const tierBadge = document.createElement('span');
      tierBadge.className = 'badge ' + tier;
      tierBadge.textContent = tier;
      li.appendChild(tierBadge);
    }

    if (t.weight != null && t.weight !== 0) {
      const wBadge = document.createElement('span');
      wBadge.className = 'badge';
      wBadge.textContent = 'w:' + t.weight;
      li.appendChild(wBadge);
    }

    if (i === 0) {
      const badge = document.createElement('span');
      badge.className = 'badge top';
      badge.textContent = 'первая';
      li.appendChild(badge);
    }
    $comboList.appendChild(li);
  });
}

function renderComboDetails() {
  if (!state.comboModels.length) {
    $comboDetails.hidden = true;
    $comboStatus.textContent = 'Combo пуста или не содержит targets.';
    return;
  }

  $comboDetails.hidden = false;

  renderComboList();

  $comboModelSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— выберите target —';
  $comboModelSelect.appendChild(placeholder);
  for (let i = 0; i < state.comboModels.length; i++) {
    const t = state.comboModels[i];
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = t.display;
    $comboModelSelect.appendChild(opt);
  }
  $comboModelSelect.value = '';
  $comboMoveTop.disabled = true;
}

async function loadComboModels() {
  const combo = activeCombo();
  if (!combo) return;

  $comboDetails.hidden = true;
  $comboStatus.textContent = 'Загружаю combo «' + (combo.name || combo.id) + '»…';
  try {
    const data = await omniFetch(COMBO_PATH(combo.id));
    state.activeComboData = data;
    state.comboModels = extractComboTargets(data);
    // Стратегия и число targets из шапки панели
    if ($comboStrategyBadge) {
      $comboStrategyBadge.textContent = data.strategy || '?';
      $comboStrategyBadge.hidden = !data.strategy;
    }
    if ($comboTargetsCount) {
      $comboTargetsCount.textContent = state.comboModels.length
        ? 'targets: ' + state.comboModels.length
        : '';
    }
    renderComboDetails();
    $comboStatus.textContent = '';
  } catch (err) {
    console.error('[Combo] loadComboModels failed:', err);
    $comboStatus.textContent =
      'Ошибка загрузки combo: ' + (err && err.message ? err.message : err);
  }
}

function selectCombo(id) {
  if (!state.combos.some((c) => c.id === id)) return;
  state.activeComboId = id;
  saveActiveCombo();
  $comboSelect.value = id;
  loadComboModels();
}

/* ---------- antigravity quota ---------- */

async function loadAntigravityQuota() {
  if (!$agSection) return null;
  try {
    const [qRes, tRes] = await Promise.all([
      fetch('/api/antigravity-quota'),
      fetch('/api/settings/google-token'),
    ]);
    const data = await qRes.json().catch(() => ({}));
    const tok = await tRes.json().catch(() => ({}));
    state.antigravityEmail = (tok && tok.email) || '';
    if (!qRes.ok) {
      state.antigravityQuota = { error: data.error || 'provider_error' };
    } else {
      state.antigravityQuota = data;
    }
  } catch {
    state.antigravityQuota = { error: 'network' };
  }
  renderAntigravityQuota();
  return state.antigravityQuota;
}

const AG_ERROR_MESSAGES = {
  no_token: 'Токен не задан — вставьте Antigravity OAuth-токен в настройках.',
  token_expired: 'Токен истёк — обновите его в настройках или задайте refresh-связку для автообновления.',
  project_required: 'Google требует project_id — укажите его в настройках Antigravity.',
  rate_limited: 'Слишком частые запросы к Google — попробуйте позже.',
  provider_error: 'Не удалось получить квоты Google.',
  network: 'Нет доступа к панели — запустите node server.js',
};

function agCard(model) {
  const card = document.createElement('article');
  card.className = 'stat compact';

  const main = document.createElement('div');
  main.className = 'ag-model';

  const head = document.createElement('span');
  head.className = 'stat-head';
  const label = document.createElement('span');
  label.className = 'stat-label';
  label.textContent = model.displayName || model.id;
  head.appendChild(label);
  if (model.supportsThinking) {
    const meta = document.createElement('span');
    meta.className = 'stat-meta ag-thinking';
    meta.setAttribute('role', 'img');
    meta.setAttribute('aria-label', 'режим размышлений');
    meta.title = 'Режим размышлений (thinking)';
    meta.innerHTML =
      '<svg class="ag-thinking-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 2l2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7z"/></svg>';
    head.appendChild(meta);
  }
  main.appendChild(head);

  // Компактный прогресс остатка: полный и зелёный, при использовании
  // убывает и меняет цвет (remainingFraction → ширина).
  const rem = model.remainingFraction;

  // Проценты — сразу у прогресс-бара
  const barRow = document.createElement('div');
  barRow.className = 'ag-bar-row';

  const bar = document.createElement('div');
  bar.className = 'bar-track ag-bar';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  if (Number.isFinite(rem)) {
    fill.style.width = Math.min(100, Math.max(0, rem * 100)) + '%';
    const cls = agRemClass(rem);
    if (cls) fill.classList.add(cls);
  } else {
    fill.style.width = '0%';
  }
  bar.appendChild(fill);
  barRow.appendChild(bar);

  const pct = document.createElement('span');
  pct.className = 'ag-pct';
  pct.textContent = Number.isFinite(rem)
    ? Math.round(rem * 100) + '%'
    : '—';
  barRow.appendChild(pct);

  main.appendChild(barRow);
  card.appendChild(main);
  return card;
}

// Цвет прогресса остатка: зелёный → жёлтый → красный при снижении остатка
function agRemClass(rem) {
  if (rem >= 0.5) return '';
  if (rem >= 0.25) return 'warn';
  return 'danger';
}

// Порядок и состояние свёрнутости групп моделей Antigravity
const AG_GROUPS = [
  { key: 'claude', label: 'Claude', collapsed: false },
  { key: 'gemini', label: 'Gemini', collapsed: true },
  { key: 'other', label: 'Прочие', collapsed: true },
];

// К какой группе отнести модель по id / displayName
function agGroupOf(model) {
  const s = ((model.id || '') + ' ' + (model.displayName || '')).toLowerCase();
  if (s.includes('claude')) return 'claude';
  if (s.includes('gemini')) return 'gemini';
  return 'other';
}

// Контейнер группы со сворачиваемой шапкой
function agGroupContainer(group, models) {
  const wrap = document.createElement('div');
  wrap.className = 'ag-group' + (group.collapsed ? ' collapsed' : '');
  wrap.dataset.group = group.key;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'ag-group-head';
  head.setAttribute('aria-expanded', String(!group.collapsed));
  const title = document.createElement('span');
  title.className = 'ag-group-title';
  title.textContent = group.label;
  const count = document.createElement('span');
  count.className = 'ag-group-count';
  count.textContent = String(models.length);
  head.append(title, count);
  // Время сброса у моделей группы одинаковое (Google AI Pro) — показываем один раз
  const firstReset = models.find((m) => m.resetTime);
  if (firstReset) {
    const reset = document.createElement('span');
    reset.className = 'ag-group-reset';
    const remainSec = Math.floor((new Date(firstReset.resetTime) - Date.now()) / 1000);
    reset.appendChild(document.createTextNode('Сброс: '));
    const resetVal = document.createElement('span');
    resetVal.textContent = dur(remainSec);
    reset.appendChild(resetVal);
    head.appendChild(reset);
  }
  const chev = document.createElement('span');
  chev.className = 'ag-chevron';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '▾';
  head.append(chev);
  head.addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
  });

  const body = document.createElement('div');
  body.className = 'ag-group-body stats-row';
  for (const m of models) body.appendChild(agCard(m));

  wrap.append(head, body);
  return wrap;
}

function renderAntigravityQuota() {
  if (!$agSection) return;
  const q = state.antigravityQuota;
  $agCards.replaceChildren();
  $agHint.hidden = true;
  if ($agBadge) $agBadge.textContent = '';

  // Email аккаунта — приходит с сервера после входа через Google
  if ($agEmail) {
    const email = state.antigravityEmail || '';
    if (email) { $agEmail.textContent = email; $agEmail.hidden = false; }
    else $agEmail.hidden = true;
  }

  if (!q) { $agSection.hidden = true; return; }
  $agSection.hidden = false;

  if (q.error) {
    if (q.error === 'no_token') { $agSection.hidden = true; return; }
    $agHint.textContent = AG_ERROR_MESSAGES[q.error] || 'Ошибка загрузки квот.';
    $agHint.hidden = false;
    if ($agBadge) $agBadge.textContent = 'нет данных';
    return;
  }

  const models = Array.isArray(q.models) ? q.models : [];

  if (!models.length) {
    $agHint.textContent = 'Google не вернул данные по моделям.';
    $agHint.hidden = false;
    return;
  }

  const grouped = {};
  for (const m of models) (grouped[agGroupOf(m)] ||= []).push(m);

  for (const g of AG_GROUPS) {
    const list = grouped[g.key];
    if (!list || !list.length) continue;
    $agCards.appendChild(agGroupContainer(g, list));
  }
}

/* ---------- loading ---------- */

async function loadUsage() {
  setStatus('loading', 'Обновляю…');
  $btnRefresh.disabled = true;
  $btnRefresh.classList.add('spinning');
  try {
    const data = await providerRequest('usage');
    renderUsage(data);
    hideBanner();
  } catch (err) {
    setStatus('err', 'Ошибка');
    let msg = err && err.message ? err.message : String(err);
    if (err && err.status === 401) msg += ' — проверьте ключ';
    showBanner(msg);
  } finally {
    $btnRefresh.disabled = false;
    $btnRefresh.classList.remove('spinning');
  }
}

async function loadModels() {
  $modelsStatus.hidden = false;
  $modelsStatus.textContent = 'Загружаю каталог…';
  setStatus('loading', 'Обновляю…');
  try {
    const data = await providerRequest('models', { provider: state.modelsProvider });
    renderModels(data);
    $modelsStatus.hidden = true;
    setStatus('ok', 'Моделей: ' + (state.models ? state.models.length : 0));
    touchUpdated();
  } catch (err) {
    setStatus('err', 'Ошибка');
    $modelsStatus.textContent =
      'Ошибка загрузки каталога: ' + (err.message || err);
  }
}

/* ---------- copy command ---------- */

async function copyCommand() {
  const cmd = $cmdText ? $cmdText.textContent : 'opencode upgrade';
  try {
    await navigator.clipboard.writeText(cmd);
    if ($copyStatus) $copyStatus.textContent = 'Скопировано!';
    setTimeout(() => { if ($copyStatus) $copyStatus.textContent = ''; }, 2000);
  } catch {
    if ($copyStatus) $copyStatus.textContent = 'Не удалось скопировать';
  }
}


/* ---------- init & events ---------- */

/**
 * Инициализация текущей страницы. Вызывается при загрузке и после
 * изменения ключа в настройках (диалог есть на каждой странице).
 */
async function init() {
  // Страница «Модели»: каталог моделей выбранного провайдера
  if (PAGE === 'models') {
    renderModelsProviders();
    if (!getKey() && !state.modelsProvider.hasKey) {
      state.models = [];
      if ($modelsBody) $modelsBody.replaceChildren();
      if ($modelsStatus) $modelsStatus.hidden = true;
      $setup.hidden = false;
      setStatus('idle', 'Нужен ключ');
      return;
    }
    if ($setup) $setup.hidden = true;
    await loadModels();
    return;
  }

  // Страница «Шпаргалка»
  if (PAGE === 'cheatsheet') {
    setStatus('ok', 'Готово');
    return;
  }

  // Страница «Combo»: ключ xKiro не нужен — работает через OmniRoute
  if (PAGE === 'combo') {
    try { state.activeComboId = vaultGet('comboActive')||''; } catch {}
    renderComboControls();
    setStatus('loading', 'Обновляю…');
    await loadCombos();
    // Тихо подгружаем каталог моделей — для бейджей тарифа (free/paid/premium)
    try {
      const data = await providerRequest('models', { provider: state.modelsProvider });
      state.models = data.data || [];
      renderComboList();
    } catch {}
    return;
  }

  // Главная страница — статистика
  renderProviderLabel();
  const $pageTitle = $id('page-title');
  if (!getKey() && !state.activeProvider.hasKey) {
    $cards.hidden = true;
    if ($pageTitle) $pageTitle.hidden = true;
    $setup.hidden = false;
    setStatus('idle', 'Нужен ключ');
    // Квоты Antigravity не зависят от ключа xKiro — грузим всегда
    loadAntigravityQuota();
    return;
  }

  if ($pageTitle) $pageTitle.hidden = false;
  $setup.hidden = true;
  await loadUsage();
  loadAntigravityQuota();
}

on($id('setup-open-settings'), 'click', () => { if($btnSettings) $btnSettings.click(); });

on($modelsSearch, 'input', filterModels);
on($modelsTier, 'change', filterModels);

on($modelsProvider, 'change', () => {
  const id = $modelsProvider.value;
  state.modelsProvider =
    state.providers.find((p) => p.id === id) || state.activeProvider;
  try { vaultSet('modelsProvider', state.modelsProvider.id); } catch {}
  reboot();
});

on($btnRefresh, 'click', () => { loadUsage(); loadAntigravityQuota(); });

// Показ/скрытие полей выбранного в настройках провайдера
function renderDlgProviderFields() {
  const $sel = $id('dlg-provider');
  if (!$sel) return;
  const v = $sel.value;
  const $xkiro = $id('dlg-xkiro-fields');
  const $ag = $id('dlg-ag-fields');
  if ($xkiro) $xkiro.hidden = v !== 'xkiro';
  if ($ag) $ag.hidden = v !== 'antigravity';
}

on($btnSettings, 'click', () => {
  $dlgKey.value = getKey() || '';
  renderAliasRows();
  const $omniUrl = $id('dlg-omni-url');
  const $omniKey = $id('dlg-omni-key');
  if ($omniUrl) $omniUrl.value = getOmniUrl();
  if ($omniKey) $omniKey.value = getOmniKey();
  // Статус токена — с сервера (сами секреты клиенту не возвращаются)
  refreshAgStatus();
  $dlgResult.textContent = '';
  $dlgResult.hidden = true;
  // Восстанавливаем последнего выбранного в диалоге провайдера
  const $dlgProvider = $id('dlg-provider');
  if ($dlgProvider) {
    let savedDlgProvider = 'xkiro';
    try { savedDlgProvider = (vaultGet('dlgProvider')||'') || 'xkiro'; } catch {}
    $dlgProvider.value =
      savedDlgProvider === 'antigravity'
        ? savedDlgProvider
        : 'xkiro';
    renderDlgProviderFields();
  }
  const $hint = document.getElementById('dlg-env-hint');
  if ($hint) $hint.hidden = true;
  $dlg.showModal();
  closeTopbar();
});

function isMobile() {
  return window.innerWidth <= 600;
}

function closeTopbar() {
  if ($topbarCollapse && $topbarToggle) {
    $topbarCollapse.removeAttribute('data-open');
    if (isMobile()) {
      $topbarCollapse.setAttribute('aria-hidden', 'true');
    } else {
      $topbarCollapse.removeAttribute('aria-hidden');
    }
    $topbarToggle.setAttribute('aria-expanded', 'false');
  }
}

on($topbarToggle, 'click', () => {
  if (!$topbarCollapse || !$topbarToggle) return;
  const expanded = $topbarToggle.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    closeTopbar();
  } else {
    $topbarCollapse.setAttribute('data-open', '');
    $topbarCollapse.removeAttribute('aria-hidden');
    $topbarToggle.setAttribute('aria-expanded', 'true');
  }
});

document.addEventListener('click', (e) => {
  if (!$topbarToggle || !$topbarCollapse) return;
  if ($topbarToggle.getAttribute('aria-expanded') !== 'true') return;
  const bar = $topbarToggle.closest('.topbar');
  if (bar && !bar.contains(e.target)) closeTopbar();
});

if ($topbarCollapse) {
  $topbarCollapse.querySelectorAll('.topnav a').forEach((a) => {
    a.addEventListener('click', closeTopbar);
  });
}

window.addEventListener('resize', () => {
  if (window.innerWidth > 600) closeTopbar();
});

// Добавление пустой строки сопоставления
on($id('dlg-alias-add'), 'click', () => {
  const list = $id('dlg-aliases-list');
  if (!list) return;
  const empty = list.querySelector('.hint');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'alias-row';
  const inId = document.createElement('input');
  inId.type = 'text';
  inId.placeholder = 'ID из OmniRoute';
  inId.dataset.aliasId = '__new_' + Date.now();
  const inName = document.createElement('input');
  inName.type = 'text';
  inName.placeholder = 'Имя';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-ghost';
  del.textContent = '✕';
  del.setAttribute('aria-label', 'Удалить');
  del.addEventListener('click', () => row.remove());
  row.append(inId, inName, del);
  list.appendChild(row);
  inId.focus();
});

// Переключение полей провайдера в настройках (один обработчик на всё время жизни)
on($id('dlg-provider'), 'change', () => {
  const $sel = $id('dlg-provider');
  if (!$sel) return;
  vaultSet('dlgProvider', $sel.value);
  renderDlgProviderFields();
});

on($dlgToggle, 'click', () => {
  $dlgKey.type = $dlgKey.type === 'password' ? 'text' : 'password';
});

// Обновляет статусную строку в форме Antigravity по данным сервера
// (сами токены клиенту не возвращаются — только флаги и время истечения)
async function refreshAgStatus(prefix) {
  const $exp = $id('dlg-ag-exp');
  if (!$exp) return;
  try {
    const s = await (await fetch('/api/settings/google-token')).json();
    const parts = [];
    if (s.hasToken) parts.push('✓ Токен задан на сервере');
    else if (getAgRefreshToken()) parts.push('Связка в браузере — сервер обновит токен сам');
    else parts.push('Токен не задан');
    if (s.hasToken && s.tokenExpiresAt) {
      const remainSec = Math.floor((s.tokenExpiresAt - Date.now()) / 1000);
      parts.push(remainSec > 0
        ? 'истекает через ' + dur(remainSec)
        : (s.hasRefresh ? 'истёк — обновится автоматически' : 'истёк — войдите заново'));
    }
    if (s.hasRefresh) parts.push('автообновление включено');
    $exp.textContent = (prefix ? prefix + ' ' : '') + parts.join(', ') + '.';
    $exp.hidden = false;
  } catch {}
}

// Вход через Google: открываем вкладку авторизации, после входа пользователь
// копирует адрес из адресной строки (loopback-redirect) и вставляет его
// в поле «Ссылка после входа» — сервер обменяет код на токены.
//
// Важно: открываем именно НОВУЮ ВКЛАДКУ (target '_blank'), а не popup-окно.
// Браузеры принудительно закрывают popup после редиректа на loopback, а
// вкладки — никогда, поэтому адрес остаётся доступен для копирования.
on($id('dlg-ag-login'), 'click', async () => {
  const $st = $id('dlg-ag-login-status');
  const setStatus = (t) => { if ($st) $st.textContent = t; };
  // Вкладку открываем синхронно по клику (до await), иначе сработает
  // блокировщик всплывающих окон; адрес подставляем после ответа сервера.
  const tab = window.open('', '_blank');
  try {
    const res = await fetch('/api/antigravity-auth/start');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.message || 'HTTP ' + res.status);
    if (tab) tab.location.href = data.url;
    else window.open(data.url, '_blank');
    setStatus('Открыта вкладка Google. После входа скопируйте адрес из адресной строки (http://127.0.0.1:…) и вставьте в поле ниже.');
    const $paste = $id('dlg-ag-paste');
    if ($paste) $paste.focus();
  } catch (err) {
    setStatus('Ошибка: ' + (err && err.message ? err.message : err));
  }
});

// Основной flow: вставить ссылку, на которую ушёл браузер после входа в Google
on($id('dlg-ag-paste-btn'), 'click', async () => {
  const $st = $id('dlg-ag-login-status');
  const $inp = $id('dlg-ag-paste');
  if (!$inp || !$inp.value.trim()) return;
  try {
    if ($st) $st.textContent = 'Обмениваю код авторизации…';
    const res = await fetch('/api/antigravity-auth/paste', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: $inp.value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || 'HTTP ' + res.status);
    $inp.value = '';
    // Refresh уже сохранён сервером в SQLite (зашифровано).
    const q = await loadAntigravityQuota();
    if ($st) {
      $st.textContent = q && !q.error
        ? 'Авторизация выполнена ✓ — квоты загружены'
        : 'Авторизация выполнена, но квоты не получены: ' +
          ((q && AG_ERROR_MESSAGES[q.error]) || (q && q.error) || 'неизвестная ошибка');
    }
    refreshAgStatus();
  } catch (err) {
    if ($st) $st.textContent = 'Ошибка: ' + (err && err.message ? err.message : err);
  }
});

// Enter в поле вставки = «Применить»
on($id('dlg-ag-paste'), 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const $btn = $id('dlg-ag-paste-btn');
    if ($btn) $btn.click();
  }
});

on($dlgSave, 'click', () => {
  const $omniUrl = $id('dlg-omni-url');
  const $omniKey = $id('dlg-omni-key');
  const candidate = $dlgKey.value.trim();

  // Сохраняем всё сразу (синхронно), не дожидаясь проверки ключа,
  // чтобы кнопка никогда не «зависала».
  saveAliasesMap(collectAliasesFromUI());
  renderComboList();
  const omniUrlRaw = $omniUrl ? $omniUrl.value.trim() : '';
  const omniUrlClean = normalizeOmniUrl(omniUrlRaw);
  if ($omniUrl && omniUrlClean !== omniUrlRaw) {
    // Показываем пользователю нормализованный адрес
    $omniUrl.value = omniUrlClean;
  }
  if ($omniUrl || $omniKey) setOmniConfig(omniUrlClean, $omniKey ? $omniKey.value.trim() : '');
  if (candidate) setKey(candidate);

  $dlgSave.disabled = false;
  $dlgSave.textContent = 'Проверить и сохранить';
  $dlgResult.hidden = false;
  $dlgResult.className = 'dlg-result ok';
  // Две строки результата: OmniRoute и xKiro — обновляются независимо, новая строка
  let omniLine = omniUrlClean ? 'OmniRoute: ' + omniUrlClean + ' — проверяю…' : 'OmniRoute: не задан';
  let xkiroLine = '';
  const renderResult = (isErr) => {
    $dlgResult.className = isErr ? 'dlg-result err' : 'dlg-result ok';
    $dlgResult.textContent = 'Сохранено.\n' + omniLine + (xkiroLine ? '\n' + xkiroLine : '');
  };
  $dlgResult.textContent = 'Сохранено.\n' + omniLine;
  reboot();

  // Фоновая проверка OmniRoute — уточняет строку OmniRoute
  if (omniUrlClean) {
    console.info('[OmniRoute] проверка', omniUrlClean);
    omniFetch(COMBO_LIST_PATH).then((data) => {
      const n = Array.isArray(data) ? data.length : Array.isArray(data.combos) ? data.combos.length : Array.isArray(data.data) ? data.data.length : 0;
      console.info('[OmniRoute] OK', data);
      omniLine = 'OmniRoute ✓ ' + omniUrlClean + ' — доступно combo: ' + n;
      renderResult(false);
    }).catch((err) => {
      console.warn('[OmniRoute] проверка не прошла', err);
      omniLine = 'OmniRoute ✗ ' + omniUrlClean + ' — ' + (err && err.message ? err.message : String(err));
      const isErr = !(err && err.status === 400); // 400 без URL не считаем критичным
      renderResult(isErr);
    });
  } else {
    renderResult(false);
  }
  const setXkiroLine = (line, isErr) => { xkiroLine = line; renderResult(isErr); };
  if (candidate) {
    console.info('[xKiro] проверка ключа…');
    setXkiroLine('xKiro: проверяю ключ…', false);
    providerRequest('usage', { key: candidate })
      .then((data) => {
        const wallet = (data && data.wallet) || {};
        const bal = wallet.balance_usd ?? wallet.balance ?? 0;
        console.info('[xKiro] ключ OK', data);
        setXkiroLine('xKiro ✓ ключ работает — баланс: ' + fmtUsd(bal) + (data.plan ? ' · план: ' + data.plan : ''), false);
      })
      .catch((err) => {
        console.warn('[xKiro] проверка не прошла', err);
        let msg = 'xKiro ✗ ключ не прошёл проверку: ' + (err && err.message ? err.message : String(err));
        if (err && err.status === 401) msg += ' — проверьте ключ';
        setXkiroLine(msg, true);
      });
  } else {
    console.info('[xKiro] ключ не задан');
    setXkiroLine('xKiro: ключ не задан', false);
  }
});

on($dlgRemove, 'click', () => {
  removeKey();
  $dlg.close();
  reboot();
});

on($comboSelect, 'change', () => selectCombo($comboSelect.value));

on($comboRefresh, 'click', () => loadCombos());

on($btnUpgrade, 'click', copyCommand);

on($comboModelSelect, 'change', () => {
  $comboMoveTop.disabled = !$comboModelSelect.value;
});

// Главная функция: выбранный target встаёт первым, отправляем PUT в OmniRoute
on($comboMoveTop, 'click', async () => {
  const selectedIdx = parseInt($comboModelSelect.value, 10);
  const combo = activeCombo();
  if (isNaN(selectedIdx) || !combo || !state.activeComboData) return;

  $comboModelSelect.value = '';
  if (selectedIdx <= 0) {
    $comboMoveTop.disabled = true;
    return;
  }

  // Оптимистично переставляем models
  const target = state.comboModels.splice(selectedIdx, 1)[0];
  state.comboModels.unshift(target);
  renderComboList();
  $comboStatus.textContent = 'Сохраняю порядок…';

  $comboMoveTop.disabled = true;
  $comboModelSelect.disabled = true;
  $comboSelect.disabled = true;

  // Тот же порядок — в полном объекте combo для PUT.
  // Реальное поле OmniRoute — models; на всякий случай умеем targets/candidatePool.
  const updatedCombo = Object.assign({}, state.activeComboData);
  const arr = Array.isArray(updatedCombo.models)
    ? updatedCombo.models
    : Array.isArray(updatedCombo.targets)
      ? updatedCombo.targets
      : updatedCombo.config && Array.isArray(updatedCombo.config.auto && updatedCombo.config.auto.candidatePool)
        ? updatedCombo.config.auto.candidatePool
        : null;
  if (arr) {
    const m = arr.splice(selectedIdx, 1)[0];
    arr.unshift(m);
  }

  try {
    await omniFetch(COMBO_PATH(combo.id), {
      method: 'PUT',
      body: updatedCombo,
    });
    state.activeComboData = updatedCombo;
    $comboStatus.textContent =
      'Порядок сохранён: «' + target.display + '» теперь первая.';
  } catch (err) {
    $comboStatus.textContent =
      'Не удалось сохранить порядок: ' +
      (err && err.message ? err.message : err) +
      ' — перечитываю с сервера.';
    await loadComboModels();
    return;
  } finally {
    $comboModelSelect.disabled = false;
    $comboSelect.disabled = false;
  }

  renderComboDetails();
});

on($id('banner-close'), 'click', hideBanner);

// Обновление при возврате на вкладку — только для статистики
if (PAGE === 'index') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadUsage(); loadAntigravityQuota(); }
  });
}

/* ---------- запуск ---------- */

/**
 * Повторная инициализация: скрываем контент, перезагружаем, показываем.
 * Используется после смены ключа или провайдера, чтобы не мелькать.
 */
async function reboot() {
  // Пока открыт диалог настроек — не прячем страницу (visibility:hidden
  // делал бы диалог некликабельным на время загрузки данных).
  const hide = !$dlg || !$dlg.open;
  if (hide) document.body.classList.add('is-booting');
  try {
    await init();
  } finally {
    document.body.classList.remove('is-booting');
  }
}

async function boot() {
  await loadVault();
  if (location.protocol !== 'file:') {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const cfg = await res.json();
        state.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
        state.activeProvider =
          state.providers.find((p) => p.id === cfg.activeProvider) ||
          state.providers[0] ||
          PROVIDER_FALLBACK;
      }
    } catch {}
  }
  // Провайдер каталога на странице «Модели»: сохранённый или активный
  let savedModelsProviderId = null;
  try { savedModelsProviderId = (vaultGet('modelsProvider')||''); } catch {}
  state.modelsProvider =
    state.providers.find((p) => p.id === savedModelsProviderId) ||
    state.activeProvider;
  try {
    await init();
  } finally {
    document.body.classList.remove('is-booting');
  }
}

boot();
