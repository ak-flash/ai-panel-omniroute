/* ============================================================
   AI Panel — страница «Combo»: маршруты OmniRoute, просмотр
   targets и перестановка модели первой (PUT в OmniRoute).
   Ключ xKiro не нужен — всё идёт через серверный прокси.
   ============================================================ */

import { session } from '../session.js';
import { $id, on } from '../dom.js';
import { setStatus, touchUpdated } from '../topbar.js';
import { providerRequest, omniFetch, COMBO_LIST_PATH, COMBO_PATH } from '../api.js';
import { vaultSet, vaultGet } from '../settings.js';
import { start } from '../boot.js';
import { extractComboTargets, combosFromResponse } from '../combos.js';
import { matchModel } from '../../model-match.js';

// Статичные элементы страницы — доступны на момент eval модуля
const $comboSelect = $id('combo-select');
const $comboRefresh = $id('combo-refresh');
const $comboEmpty = $id('combo-empty');
const $comboStatus = $id('combo-status');
const $comboDetails = $id('combo-details');
const $comboStrategyBadge = $id('combo-strategy-badge');
const $comboTargetsCount = $id('combo-targets-count');
const $comboModelSelect = $id('combo-model-select');
const $comboMoveTop = $id('combo-move-top');
const $comboList = $id('combo-models-list');

// Состояние страницы Combo (локальное — другим страницам не нужно)
let combos = [];
let combosLoaded = false;
let comboError = null;   // текст последней ошибки загрузки (не затирается рендером)
let activeComboId = null;
let comboModels = [];    // массив target-объектов: { provider, model, display, weight }
let activeComboData = null; // полный объект combo с сервера для PUT

/** Сохраняет выбранную combo в хранилище сервера */
function saveActiveCombo() {
  vaultSet('comboActive', activeComboId || '');
}

function activeCombo() {
  return combos.find((c) => c.id === activeComboId) || null;
}

function renderComboControls() {
  $comboSelect.replaceChildren();

  if (!combos.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = combosLoaded ? 'Нет combo' : 'Загрузка…';
    $comboSelect.appendChild(opt);
    $comboSelect.disabled = !combosLoaded;
    $comboEmpty.hidden = !combosLoaded;
    $comboDetails.hidden = true;
    // Ошибку не затираем — она должна остаться видимой
    if (combosLoaded && !comboError) $comboStatus.textContent = '';
    return;
  }

  comboError = null;

  if (!activeCombo()) {
    activeComboId = combos[0].id;
    saveActiveCombo();
  }

  for (const c of combos) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    $comboSelect.appendChild(opt);
  }
  $comboSelect.value = activeComboId;
  $comboSelect.disabled = false;
  $comboEmpty.hidden = true;
}

// matchModel — из model-match.js
function findModel(id) {
  return matchModel(session.models, id);
}

function renderComboList() {
  if (!$comboList) return; // элемент есть только на странице Combo
  $comboList.replaceChildren();
  comboModels.forEach((t, i) => {
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
  if (!comboModels.length) {
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
  for (let i = 0; i < comboModels.length; i++) {
    const t = comboModels[i];
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
    activeComboData = data;
    comboModels = extractComboTargets(data);
    // Стратегия и число targets из шапки панели
    if ($comboStrategyBadge) {
      $comboStrategyBadge.textContent = data.strategy || '?';
      $comboStrategyBadge.hidden = !data.strategy;
    }
    if ($comboTargetsCount) {
      $comboTargetsCount.textContent = comboModels.length
        ? 'targets: ' + comboModels.length
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

/** Загружает список combo с OmniRoute API */
async function loadCombos() {
  $comboStatus.textContent = 'Загружаю список combo…';
  try {
    const data = await omniFetch(COMBO_LIST_PATH);
    combos = combosFromResponse(data);
    combosLoaded = true;
    comboError = null;
    // Восстановить активный, если он ещё существует
    if (!combos.some((c) => c.id === activeComboId)) {
      activeComboId = combos.length ? combos[0].id : null;
      saveActiveCombo();
    }
    renderComboControls();
    $comboStatus.textContent = '';
    setStatus('ok', 'OmniRoute · combo: ' + combos.length);
    touchUpdated();
    // Если есть выбранная combo — подгрузить детали
    if (activeCombo()) loadComboModels();
  } catch (err) {
    combosLoaded = true;
    comboError =
      'Ошибка загрузки списка combo: ' + (err && err.message ? err.message : err);
    console.error('[Combo] loadCombos failed:', err);
    setStatus('err', 'Ошибка');
    $comboStatus.textContent = comboError;
    renderComboControls();
  }
}

function selectCombo(id) {
  if (!combos.some((c) => c.id === id)) return;
  activeComboId = id;
  saveActiveCombo();
  $comboSelect.value = id;
  loadComboModels();
}

export async function init() {
  try { activeComboId = vaultGet('comboActive') || ''; } catch { /* нет хранилища */ }
  renderComboControls();
  setStatus('loading', 'Обновляю…');
  await loadCombos();
  // Тихо подгружаем каталог моделей — для бейджей тарифа (free/paid/premium)
  try {
    const data = await providerRequest('models', { provider: session.modelsProvider });
    session.models = data.data || [];
    renderComboList();
  } catch { /* бейджи необязательны */ }
}

/* ---------- события (привязываются один раз) ---------- */

on($comboSelect, 'change', () => selectCombo($comboSelect.value));

on($comboRefresh, 'click', () => loadCombos());

on($comboModelSelect, 'change', () => {
  $comboMoveTop.disabled = !$comboModelSelect.value;
});

// Главная функция: выбранный target встаёт первым, отправляем PUT в OmniRoute
on($comboMoveTop, 'click', async () => {
  const selectedIdx = parseInt($comboModelSelect.value, 10);
  const combo = activeCombo();
  if (isNaN(selectedIdx) || !combo || !activeComboData) return;

  $comboModelSelect.value = '';
  if (selectedIdx <= 0) {
    $comboMoveTop.disabled = true;
    return;
  }

  // Оптимистично переставляем models
  const target = comboModels.splice(selectedIdx, 1)[0];
  comboModels.unshift(target);
  renderComboList();
  $comboStatus.textContent = 'Сохраняю порядок…';

  $comboMoveTop.disabled = true;
  $comboModelSelect.disabled = true;
  $comboSelect.disabled = true;

  // Тот же порядок — в полном объекте combo для PUT.
  // Реальное поле OmniRoute — models; на всякий случай умеем targets/candidatePool.
  const updatedCombo = Object.assign({}, activeComboData);
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
    activeComboData = updatedCombo;
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

start();
