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
let $modelsStatus, $modelsBody, $modelsSearch, $modelsProvider, $modelsProviderName, $setupProviderName;
let $comboSelect, $comboRefresh, $comboEmpty, $comboStatus, $comboDetails;
let $comboStrategyBadge, $comboTargetsCount, $comboModelSelect, $comboMoveTop, $comboList;
let $btnUpgrade, $copyStatus, $cmdText;
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
// Список провайдеров и активный приходят с сервера из .env (PROVIDERS=…).
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
  tickId: null,
  providers: [],                  // список с сервера (/api/config)
  activeProvider: PROVIDER_FALLBACK, // провайдер блока статистики
  modelsProvider: PROVIDER_FALLBACK, // провайдер каталога моделей (выбирается на странице «Модели»)
  combos: [],
  combosLoaded: false,
  comboError: null,   // текст последней ошибки загрузки (не затирается рендером)
  activeComboId: null,
  comboModels: [],     // массив target-объектов: { provider, model, display, weight }
  activeComboData: null, // полный объект combo с сервера для PUT
};

/* ---------- secure storage (obfuscation, not real encryption) ---------- */
// localStorage доступен любому скрипту на origin — «защищённо» означает
// лишь обфускацию (XOR + base64), чтобы ключи не лежали plain-text.
// Для настоящей защиты нужен backend-vault.

function _xorB64Encode(str) {
  const key = location.hostname || 'ai-panel';
  let out = '';
  for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return btoa(unescape(encodeURIComponent(out)));
}
function _xorB64Decode(b64) {
  try {
    const key = location.hostname || 'ai-panel';
    const raw = decodeURIComponent(escape(atob(b64)));
    let out = '';
    for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return out;
  } catch { return null; }
}
function secureGet(lsKey) {
  try {
    const v = localStorage.getItem(lsKey);
    if (!v) return null;
    // backward compat: plain value without encoding
    if (!v.startsWith('enc:')) return v;
    return _xorB64Decode(v.slice(4));
  } catch { return null; }
}
function secureSet(lsKey, val) {
  try { localStorage.setItem(lsKey, 'enc:' + _xorB64Encode(val)); } catch {}
}
function secureRemove(lsKey) {
  try { localStorage.removeItem(lsKey); } catch {}
}

/* ---------- helpers ---------- */

function getKey() {
  return secureGet(LS_XKIRO_KEY) || (() => { try { return localStorage.getItem(LS_KEY); } catch { return null; } })();
}

function setKey(k) {
  secureSet(LS_XKIRO_KEY, k);
  try { localStorage.removeItem(LS_KEY); } catch {}
}

function removeKey() {
  secureRemove(LS_XKIRO_KEY);
  try { localStorage.removeItem(LS_KEY); } catch {}
}
function getOmniUrl() { return secureGet(LS_OMNI_URL) || (() => { try { return localStorage.getItem(LS_OMNI_URL); } catch { return null; } })() || ''; }
function getOmniKey() { return secureGet(LS_OMNI_KEY) || ''; }

// Нормализация URL OmniRoute: убираем хвостовые слэши и лишние суффиксы
// (/v1, /v1/, /api), которые пользователь мог ввести по ошибке.
function normalizeOmniUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/(v\d+|api)$/i, '');
  return u;
}
function setOmniConfig(url, key) {
  try {
    const clean = normalizeOmniUrl(url);
    if (clean) localStorage.setItem(LS_OMNI_URL, clean);
    else localStorage.removeItem(LS_OMNI_URL);
  } catch {}
  if (key) secureSet(LS_OMNI_KEY, key); else secureRemove(LS_OMNI_KEY);
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
 * адаптера провайдера (providers/ на сервере) и подставляет ключ из .env,
 * если клиент не прислал свой в заголовке x-api-key.
 * В режиме file:// — прямой запрос к API xKiro (нужен разрешённый CORS).
 */
async function providerRequest(resource, opts = {}) {
  const provider = opts.provider || state.activeProvider;

  // Ключ: явный (проверка в настройках) → сохранённый локально.
  // Если ключ есть в .env — ничего не отправляем, сервер подставит свой.
  const key = opts.key || (provider.hasKey ? '' : getKey());
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
// Активный провайдер приходит с сервера из .env (PROVIDERS=…).
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

function tick() {
  tickWindow('short');
  tickWindow('long');
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

function filterModels() {
  if (!$modelsBody) return;
  const q = ($modelsSearch ? $modelsSearch.value : '').trim().toLowerCase();
  $modelsBody.replaceChildren();
  for (const m of state.models) {
    const hay = (m.id + ' ' + (m.display_name || '')).toLowerCase();
    if (q && !hay.includes(q)) continue;
    $modelsBody.appendChild(modelRow(m));
  }
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
    if (state.activeComboId) localStorage.setItem(LS_COMBO_ACTIVE, state.activeComboId);
    else localStorage.removeItem(LS_COMBO_ACTIVE);
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
    const raw = localStorage.getItem(LS_ALIASES);
    const arr = raw ? JSON.parse(raw) : [];
    const map = {};
    if (Array.isArray(arr)) for (const [id, name] of arr) if (id && name) map[id] = name;
    return map;
  } catch { return {}; }
}

function saveAliasesMap(map) {
  try {
    const arr = Object.entries(map).filter(([id, name]) => id && name);
    localStorage.setItem(LS_ALIASES, JSON.stringify(arr));
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

function normModelName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
}

function findModel(id) {
  if (!id || !Array.isArray(state.models)) return null;
  const nid = normModelName(id);
  const lastSeg = normModelName(
    String(id).includes('/') ? String(id).slice(String(id).lastIndexOf('/') + 1) : id
  );
  // 1) точное совпадение id
  let m = state.models.find((x) => normModelName(x.id) === nid);
  // 2) совпадение по последнему сегменту (grok-4.6 и т.п.)
  if (!m) m = state.models.find((x) => {
    const nx = normModelName(x.id);
    return nx === lastSeg || nx.endsWith('/' + lastSeg);
  });
  // 3) каталог-имя содержится в названии из combo или наоборот
  if (!m) m = state.models.find((x) => {
    const nx = normModelName(x.id);
    return nx.length > 3 && (nid.includes(nx) || nx.includes(lastSeg));
  });
  return m || null;
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
    if (state.tickId) clearInterval(state.tickId);
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
    if (state.tickId) clearInterval(state.tickId);
    setStatus('ok', 'Готово');
    return;
  }

  // Страница «Combo»: ключ xKiro не нужен — работает через OmniRoute
  if (PAGE === 'combo') {
    try { state.activeComboId = localStorage.getItem(LS_COMBO_ACTIVE); } catch {}
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

  if (state.tickId) clearInterval(state.tickId);

  if (!getKey() && !state.activeProvider.hasKey) {
    $cards.hidden = true;
    $setup.hidden = false;
    setStatus('idle', 'Нужен ключ');
    return;
  }

  $setup.hidden = true;
  await loadUsage();
  state.tickId = setInterval(tick, 1000);
}

on($id('setup-form'), 'submit', (e) => {
  e.preventDefault();
  const value = $id('setup-key').value.trim();
  if (value) setKey(value);
  reboot();
});

on($modelsSearch, 'input', filterModels);

on($modelsProvider, 'change', () => {
  const id = $modelsProvider.value;
  state.modelsProvider =
    state.providers.find((p) => p.id === id) || state.activeProvider;
  try { localStorage.setItem(LS_MODELS_PROVIDER, state.modelsProvider.id); } catch {}
  reboot();
});

on($btnRefresh, 'click', loadUsage);

on($btnSettings, 'click', () => {
  $dlgKey.value = getKey() || '';
  renderAliasRows();
  const $omniUrl = $id('dlg-omni-url');
  const $omniKey = $id('dlg-omni-key');
  if ($omniUrl) $omniUrl.value = getOmniUrl();
  if ($omniKey) $omniKey.value = getOmniKey();
  $dlgResult.textContent = '';
  $dlgResult.hidden = true;
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

on($dlgToggle, 'click', () => {
  $dlgKey.type = $dlgKey.type === 'password' ? 'text' : 'password';
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
  $dlgResult.textContent = 'Сохранено.' + (omniUrlClean ? ' OmniRoute: ' + omniUrlClean : '');
  reboot();

  // Проверку ключа делаем в фоне — она не блокирует кнопку/диалог.
  if (candidate) {
    providerRequest('usage', { key: candidate })
      .then((data) => {
        const wallet = (data && data.wallet) || {};
        $dlgResult.className = 'dlg-result ok';
        $dlgResult.textContent =
          'Сохранено. Ключ работает — баланс: ' + fmtUsd(wallet.balance) +
          (omniUrlClean ? ' · OmniRoute: ' + omniUrlClean : '');
      })
      .catch((err) => {
        $dlgResult.className = 'dlg-result err';
        let msg = 'Сохранено, но ключ не прошёл проверку: ' +
          (err && err.message ? err.message : String(err));
        if (err && err.status === 401) msg += ' — проверьте ключ';
        $dlgResult.textContent = msg;
      });
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
    if (!document.hidden) loadUsage();
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
  try { savedModelsProviderId = localStorage.getItem(LS_MODELS_PROVIDER); } catch {}
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
