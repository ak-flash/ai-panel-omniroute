/* ============================================================
   AI Panel — страница «Модели»: каталог моделей выбранного
   провайдера с фильтрами по тарифу/рейтингу и поиском; метки Combo.
   ============================================================ */

import { session } from '../session.js';
import { $id, on } from '../dom.js';
import { setStatus, touchUpdated } from '../topbar.js';
import { providerRequest, omniFetch, COMBO_LIST_PATH, COMBO_PATH } from '../api.js';
import { vaultSet, keyForProvider, setProviderKey } from '../settings.js';
import { rebootPage, start } from '../boot.js';
import { compact } from '../formatters.js';
import { matchModel, normModelName } from '../../model-match.js';
import {
  codingRatingResolved,
  codingScoreResolved,
  setOnlineRatings,
  getOnlineMeta,
} from '../../coding-rating.js';
import { extractComboTargets, combosFromResponse } from '../combos.js';

// Статичные элементы страницы — доступны на момент eval модуля
const $setup = $id('setup');
const $modelsStatus = $id('models-status');
const $modelsBody = $id('models-body');
const $modelsSearch = $id('models-search');
const $modelsTier = $id('models-tier');
const $modelsCoding = $id('models-coding');
const $modelsProvider = $id('models-provider');
const $modelsProviderName = $id('models-provider-name');
const $setupProviderName = $id('setup-provider-name');
const $codingRefreshBtn = $id('coding-refresh-btn');
const $codingSourceStatus = $id('coding-source-status');

function isModelInCombo(model) {
  if (!session.comboTargetIds || !session.comboTargetIds.length) return false;
  // matchModel ожидает массив каталога и id из combo — проверяем каждым target'ом
  for (const tid of session.comboTargetIds) {
    const m = matchModel([model], tid);
    if (m) return true;
  }
  return false;
}

function formatCodingSourceLabel(meta) {
  if (!meta || !meta.source || meta.source === 'none') return '';
  const when = meta.updatedAt ? new Date(meta.updatedAt).toLocaleDateString('ru-RU') : '';
  const src = meta.source === 'artificial-analysis via openrouter'
    ? 'Artificial Analysis (Coding Index) via OpenRouter'
    : meta.source;
  return when ? `${src} • ${when}` : src;
}

function updateCodingSourceStatus() {
  if (!$codingSourceStatus) return;
  const meta = getOnlineMeta();
  if (!meta || !meta.ratings || !Object.keys(meta.ratings).length) {
    $codingSourceStatus.textContent = 'Нет онлайн-данных — нажмите «Обновить рейтинг»';
    $codingSourceStatus.title = 'Нужен ключ OpenRouter: Настройки → Провайдер → OpenRouter';
    return;
  }
  const label = formatCodingSourceLabel(meta);
  const count = Object.keys(meta.ratings).length;
  $codingSourceStatus.textContent = label
    ? `Источник: ${label} • в кэше ${count} моделей`
    : `В кэше ${count} моделей`;
  if (meta.citation) $codingSourceStatus.title = meta.citation + (meta.sourceUrl ? ' — ' + meta.sourceUrl : '');
  else $codingSourceStatus.title = label;
}

async function loadCodingRatings() {
  try {
    const res = await fetch('/api/coding-ratings', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    setOnlineRatings(data);
    updateCodingSourceStatus();
    if (session.models && session.models.length) filterModels();
  } catch (e) {
    console.warn('[Models] loadCodingRatings failed', e);
    updateCodingSourceStatus();
  }
}

async function refreshCodingRatings() {
  if (!$codingRefreshBtn) return;
  const btn = $codingRefreshBtn;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Обновляю…';
  setStatus('loading', 'Обновляю рейтинг…');
  try {
    const res = await fetch('/api/coding-ratings/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data && data.message ? data.message : 'HTTP ' + res.status;
      throw new Error(msg);
    }
    setOnlineRatings(data);
    updateCodingSourceStatus();
    filterModels();
    setStatus('ok', 'Рейтинг обновлён: ' + (data.source || 'онлайн'));
    // лёгкий тост через setStatus, дополнительно — консоль
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setStatus('err', 'Ошибка обновления рейтинга');
    if ($codingSourceStatus) {
      $codingSourceStatus.textContent = 'Ошибка обновления: ' + msg;
      $codingSourceStatus.title = msg;
    }
    console.error('[Models] refreshCodingRatings failed', err);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
    touchUpdated();
  }
}

function codingCell(model) {
  const td = document.createElement('td');
  td.className = 'coding-col';
  const r = codingRatingResolved(model);
  const wrap = document.createElement('div');
  wrap.className = 'coding-cell-inner';

  const badge = document.createElement('span');
  const hasScore = r.score != null;
  badge.className = 'badge coding-badge coding-' + r.tier + (r.hasOnline ? ' coding-online' : ' coding-none-state');
  if (!hasScore || r.tier === 'none') {
    badge.textContent = '—';
  } else if (r.tier === 'top') {
    badge.textContent = '★ ' + r.score;
  } else {
    badge.textContent = String(r.score);
  }
  const reasons = r.reasons.length ? r.reasons.join(' · ') : (r.hasOnline ? 'онлайн-бенчмарк' : 'нет онлайн-данных');
  const srcLabel = r.hasOnline ? 'онлайн' : 'нет данных';
  const scoreLabel = hasScore ? r.score + '/100' : '—';
  badge.title = reasons + ' — ' + scoreLabel + ' (' + srcLabel + ')';
  if (r.citation) badge.title += ' — ' + r.citation;
  badge.setAttribute('aria-label', 'Рейтинг для кодинга ' + scoreLabel + ' (' + srcLabel + '): ' + reasons);
  wrap.appendChild(badge);

  // Тонкая полоска-бар под бейджем для быстрого визуального сравнения.
  const bar = document.createElement('div');
  bar.className = 'coding-bar';
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('div');
  fill.className = 'coding-bar-fill coding-' + r.tier;
  fill.style.width = hasScore ? r.score + '%' : '0%';
  bar.appendChild(fill);
  wrap.appendChild(bar);

  td.appendChild(wrap);
  // Тултип на всю ячейку для удобства наведения.
  td.title = badge.title;
  td.dataset.codingSource = r.hasOnline ? 'online' : 'none';
  return td;
}

function modelRow(model) {
  const tr = document.createElement('tr');
  if (isModelInCombo(model)) tr.classList.add('in-combo');

  const tdId = document.createElement('td');
  tdId.textContent = model.id;
  if (isModelInCombo(model)) {
    const b = document.createElement('span');
    b.className = 'badge combo';
    b.textContent = 'Combo';
    b.style.marginLeft = '8px';
    tdId.appendChild(b);
  }

  const tdCode = codingCell(model);

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

  tr.append(tdId, tdCode, tdTier, tdCtx, tdIn, tdOut);
  return tr;
}

function filterModels() {
  if (!$modelsBody) return;
  const q = ($modelsSearch ? $modelsSearch.value : '').trim().toLowerCase();
  const tier = $modelsTier && $modelsTier.value !== 'all' ? $modelsTier.value : null;
  const codingFilter = $modelsCoding && $modelsCoding.value !== 'all' ? $modelsCoding.value : null;
  $modelsBody.replaceChildren();
  const rows = session.models
    .filter((m) => {
      if (tier && (m.access_tier || 'paid') !== tier) return false;
      if (codingFilter) {
        const r = codingRatingResolved(m);
        if (codingFilter === 'top' && r.tier !== 'top') return false;
        if (codingFilter === 'good' && !(r.tier === 'top' || r.tier === 'good')) return false;
        if (codingFilter === 'low' && r.tier !== 'low') return false;
        if (codingFilter === 'none' && r.tier !== 'none') return false;
      }
      if (!q) return true;
      const hay = (m.id + ' ' + (m.display_name || '')).toLowerCase();
      return hay.includes(q);
    });
  // «Все для кода» — сортировка по цене: сначала вход $/1M,
  // при равенстве — выход. «Топ и хорошие» — по рейтингу
  // от большего к меньшему, при равенстве — по цене.
  const inPrice = (m) => Number((m.pricing || {}).input || 0);
  const outPrice = (m) => Number((m.pricing || {}).output || 0);
  const byPrice = (a, b) =>
    inPrice(a) - inPrice(b) || outPrice(a) - outPrice(b) || a.id.localeCompare(b.id);
  if (!codingFilter) {
    rows.sort(byPrice);
  } else if (codingFilter === 'good') {
    rows.sort(
      (a, b) => codingScoreResolved(b) - codingScoreResolved(a) || byPrice(a, b)
    );
  }
  for (const m of rows) $modelsBody.appendChild(modelRow(m));
  // Обновляем сводку в статус-баре, если есть данные.
  if ($modelsStatus && ! $modelsStatus.hidden && session.models && session.models.length) {
    // не трогаем текст «Загружаю…» во время загрузки
  } else if (session.models && session.models.length && rows.length !== session.models.length) {
    setStatus('ok', 'Показано ' + rows.length + ' из ' + session.models.length);
  }
}

function renderModels(data) {
  session.models = data.data || [];
  filterModels();
}

/**
 * Селект провайдеров на странице «Модели»: каталог загружается
 * для выбранного провайдера (выбор сохраняется в хранилище).
 */
function renderModelsProviders() {
  if (!$modelsProvider) return;
  const list = session.providers.length ? session.providers : [session.activeProvider];
  const selectedId = session.modelsProvider ? session.modelsProvider.id : '';
  $modelsProvider.replaceChildren();
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    opt.selected = p.id === selectedId;
    $modelsProvider.appendChild(opt);
  }
  const name = session.modelsProvider
    ? (session.modelsProvider.name || session.modelsProvider.id)
    : '';
  if ($modelsProviderName) $modelsProviderName.textContent = name;
  if ($setupProviderName) $setupProviderName.textContent = name;
  const $setupKey = $id('setup-key');
  if ($setupKey) {
    $setupKey.placeholder =
      session.modelsProvider && session.modelsProvider.id === 'openrouter'
        ? 'sk-or-…'
        : session.modelsProvider && session.modelsProvider.id === 'agentrouter'
          ? 'токен + user ID'
          : 'sk-xt-…';
  }
}

async function loadModels() {
  $modelsStatus.hidden = false;
  $modelsStatus.textContent = 'Загружаю каталог…';
  setStatus('loading', 'Обновляю…');
  try {
    const data = await providerRequest('models', { provider: session.modelsProvider });
    renderModels(data);
    $modelsStatus.hidden = true;
    setStatus('ok', 'Моделей: ' + (session.models ? session.models.length : 0));
    touchUpdated();
  } catch (err) {
    setStatus('err', 'Ошибка');
    $modelsStatus.textContent =
      'Ошибка загрузки каталога: ' + (err.message || err);
  }
}

// Тихо собирает id моделей из всех combo — для меток «Combo» в каталоге
async function loadModelsComboMarks() {
  try {
    const data = await omniFetch(COMBO_LIST_PATH);
    const combos = combosFromResponse(data);
    const set = new Set();
    const ids = [];
    for (const c of combos) {
      let targets = extractComboTargets(c);
      if (!targets.length) {
        try { const d = await omniFetch(COMBO_PATH(c.id)); targets = extractComboTargets(d); } catch { /* нет деталей — пропускаем */ }
      }
      for (const t of targets) {
        if (t.modelId) { set.add(normModelName(t.modelId)); ids.push(t.modelId); }
        if (t.key && t.key !== t.modelId) { set.add(normModelName(t.key)); ids.push(t.key); }
        if (t.display && t.display !== t.modelId) { set.add(normModelName(t.display)); ids.push(t.display); }
      }
    }
    session.comboModelKeys = set;
    session.comboTargetIds = ids;
    console.debug('[Combo] marks', ids.length, ids.slice(0, 3));
    if (session.models) filterModels();
  } catch (e) { console.warn('[Combo] loadModelsComboMarks failed', e); }
}

export async function init() {
  renderModelsProviders();
  updateCodingSourceStatus();
  // грузим онлайн-рейтинг параллельно — не блокирует каталог
  loadCodingRatings();
  if (!keyForProvider(session.modelsProvider.id) && !session.modelsProvider.hasKey) {
    session.models = [];
    if ($modelsBody) $modelsBody.replaceChildren();
    if ($modelsStatus) $modelsStatus.hidden = true;
    if ($setup) $setup.hidden = false;
    setStatus('idle', 'Нужен ключ');
    return;
  }
  if ($setup) $setup.hidden = true;
  await loadModels();
  loadModelsComboMarks();
}

/* ---------- события (привязываются один раз) ---------- */

on($modelsSearch, 'input', filterModels);
on($modelsTier, 'change', filterModels);
on($modelsCoding, 'change', filterModels);
on($codingRefreshBtn, 'click', refreshCodingRatings);

// Экран «Нужен ключ»: форма сохраняет ключ выбранного провайдера
// в настройках (write-only) и перезагружает страницу.
const $setupForm = $id('setup-form');
on($setupForm, 'submit', (e) => {
  e.preventDefault();
  const $inp = $id('setup-key');
  const key = ($inp ? $inp.value : '').trim();
  if (!key || !session.modelsProvider) return;
  setProviderKey(session.modelsProvider.id, key).then(() => rebootPage());
});

on($modelsProvider, 'change', () => {
  const id = $modelsProvider.value;
  session.modelsProvider =
    session.providers.find((p) => p.id === id) || session.activeProvider;
  vaultSet('modelsProvider', session.modelsProvider.id);
  rebootPage();
});

start();
