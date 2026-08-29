/* ============================================================
   AI Panel — страница «Модели»: каталог моделей выбранного
   провайдера с фильтром по тарифу и поиском; метки Combo.
   ============================================================ */

import { session } from '../session.js';
import { $id, on } from '../dom.js';
import { setStatus, touchUpdated } from '../topbar.js';
import { providerRequest, omniFetch, COMBO_LIST_PATH, COMBO_PATH } from '../api.js';
import { vaultSet, keyForProvider } from '../settings.js';
import { rebootPage, start } from '../boot.js';
import { compact } from '../formatters.js';
import { matchModel, normModelName } from '../../model-match.js';
import { extractComboTargets, combosFromResponse } from '../combos.js';

// Статичные элементы страницы — доступны на момент eval модуля
const $setup = $id('setup');
const $modelsStatus = $id('models-status');
const $modelsBody = $id('models-body');
const $modelsSearch = $id('models-search');
const $modelsTier = $id('models-tier');
const $modelsProvider = $id('models-provider');
const $modelsProviderName = $id('models-provider-name');
const $setupProviderName = $id('setup-provider-name');

function isModelInCombo(model) {
  if (!session.comboTargetIds || !session.comboTargetIds.length) return false;
  // matchModel ожидает массив каталога и id из combo — проверяем каждым target'ом
  for (const tid of session.comboTargetIds) {
    const m = matchModel([model], tid);
    if (m) return true;
  }
  return false;
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
  const rows = session.models
    .filter((m) => {
      if (tier && (m.access_tier || 'paid') !== tier) return false;
      if (!q) return true;
      const hay = (m.id + ' ' + (m.display_name || '')).toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => modelPrice(a) - modelPrice(b));
  for (const m of rows) $modelsBody.appendChild(modelRow(m));
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

on($modelsProvider, 'change', () => {
  const id = $modelsProvider.value;
  session.modelsProvider =
    session.providers.find((p) => p.id === id) || session.activeProvider;
  vaultSet('modelsProvider', session.modelsProvider.id);
  rebootPage();
});

start();
