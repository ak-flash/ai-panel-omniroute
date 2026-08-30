/* ============================================================
   AI Panel — страница «Combo»: маршруты OmniRoute, просмотр
   targets и перестановка модели первой (PUT в OmniRoute).
   Ключ xKiro не нужен — всё идёт через серверный прокси.
   ============================================================ */

import { session } from '../session.js';
import { $id, on } from '../dom.js';
import { setStatus, touchUpdated } from '../topbar.js';
import { providerRequest, omniFetch, COMBO_LIST_PATH, COMBO_PATH, CALL_LOGS_URL } from '../api.js';
import { vaultSet, vaultGet } from '../settings.js';
import { start } from '../boot.js';
import { extractComboTargets, combosFromResponse } from '../combos.js';
import { recentComboRows, requestedOf, realModelOf, formatCallLogTime, modelUsageSummary } from '../call-logs.js';
import { matchModel } from '../../model-match.js';
import { showToast } from '../toast.js';

// Статичные элементы страницы — доступны на момент eval модуля
const $comboSelect = $id('combo-select');
const $comboRefresh = $id('combo-refresh');
const $comboEmpty = $id('combo-empty');
const $comboStatus = $id('combo-status');
const $comboDetails = $id('combo-details');
const $comboStrategyBadge = $id('combo-strategy-badge');
const $comboTargetsCount = $id('combo-targets-count');
const $comboList = $id('combo-models-list');
const $comboRecent = $id('combo-recent');
const $comboRecentMeta = $id('combo-recent-meta');
const $comboRecentStatus = $id('combo-recent-status');
const $comboRecentBody = $id('combo-recent-body');
const $comboRecentSummary = $id('combo-recent-summary');

// Сколько последних combo-запросов показывать
const RECENT_LIMIT = 10;
// Сколько записей лога запросить у OmniRoute, чтобы выбрать из них combo-строки
const RECENT_FETCH_LIMIT = 200;

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

let dragSrcIdx = null;

function saveReorderedCombo() {
  const combo = activeCombo();
  if (!combo || !activeComboData) return;

  // Определяем целевой массив внутри activeComboData
  const arr = Array.isArray(activeComboData.models)
    ? activeComboData.models
    : Array.isArray(activeComboData.targets)
      ? activeComboData.targets
      : activeComboData.config && activeComboData.config.auto && Array.isArray(activeComboData.config.auto.candidatePool)
        ? activeComboData.config.auto.candidatePool
        : null;
  if (!arr) {
    console.warn('[Combo] saveReorderedCombo: no models/targets/candidatePool array found');
    return;
  }

  // Пересобираем массив в новом порядке из _raw
  const reordered = comboModels.map((t) => t._raw);
  if (reordered.some((r) => r == null)) {
    console.warn('[Combo] saveReorderedCombo: some _raw entries are missing', reordered);
    return;
  }

  // Заменяем содержимое исходного массива in-place
  arr.length = 0;
  reordered.forEach((item) => arr.push(item));

  $comboStatus.textContent = 'Сохраняю порядок…';
  omniFetch(COMBO_PATH(combo.id), {
    method: 'PUT',
    body: activeComboData,
  }).then(() => {
    $comboStatus.textContent = '';
    showToast('Порядок сохранён');
  }).catch((err) => {
    console.error('[Combo] saveReorderedCombo PUT failed:', err);
    showToast('Не удалось сохранить порядок: ' + (err && err.message ? err.message : err), { type: 'error', timeout: 6000 });
    loadComboModels();
  });
}

function renderComboList() {
  if (!$comboList) return; // элемент есть только на странице Combo
  $comboList.replaceChildren();
  comboModels.forEach((t, i) => {
    const li = document.createElement('li');
    if (i === 0) li.classList.add('top');
    li.draggable = true;
    li.dataset.idx = String(i);

    const dragHandle = document.createElement('span');
    dragHandle.className = 'combo-drag-handle';
    dragHandle.title = 'Перетащить модель';
    dragHandle.setAttribute('aria-hidden', 'true');
    dragHandle.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" focusable="false"><circle cx="5" cy="3" r="1.25"/><circle cx="11" cy="3" r="1.25"/><circle cx="5" cy="8" r="1.25"/><circle cx="11" cy="8" r="1.25"/><circle cx="5" cy="13" r="1.25"/><circle cx="11" cy="13" r="1.25"/></svg>';

    const rank = document.createElement('span');
    rank.className = 'combo-rank num';
    rank.textContent = String(i + 1);

    const m = findModel(t.modelId);
    const name = document.createElement('code');
    name.className = 'combo-model-id';
    name.textContent = t.display;
    if (m && m.display_name) name.title = m.display_name;

    li.append(dragHandle, rank, name);

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

    li.addEventListener('dragstart', (e) => {
      dragSrcIdx = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      $comboList.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      dragSrcIdx = null;
    });

    li.addEventListener('dragover', (e) => {
      if (dragSrcIdx == null || dragSrcIdx === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (dragSrcIdx == null || dragSrcIdx === i) return;
      const moved = comboModels.splice(dragSrcIdx, 1)[0];
      comboModels.splice(i, 0, moved);
      renderComboList();
      saveReorderedCombo();
    });

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

/* ---------- последние combo-запросы → реальная модель ---------- */

/** Загружает последние combo-запросы и рендерит таблицу «combo → модель» */
async function loadComboRecent() {
  if (!$comboRecent || !$comboRecentBody) return;
  if ($comboRecentStatus) $comboRecentStatus.textContent = 'Загружаю последние запросы…';
  $comboRecent.hidden = false;
  try {
    const data = await omniFetch(CALL_LOGS_URL(RECENT_FETCH_LIMIT));
    const rows = recentComboRows(data, RECENT_LIMIT);
    renderComboRecent(rows);
  } catch (err) {
    console.error('[Combo] loadComboRecent failed:', err);
    if ($comboRecentStatus) {
      $comboRecentStatus.textContent =
        'Не удалось загрузить последние запросы: ' +
        (err && err.message ? err.message : String(err));
    }
    if ($comboRecentBody) $comboRecentBody.replaceChildren();
    if ($comboRecentMeta) $comboRecentMeta.textContent = '';
    if ($comboRecentSummary) $comboRecentSummary.textContent = '';
  }
}

/** Рендерит строки таблицы и сводку «какая модель сколько раз» */
function renderComboRecent(rows) {
  if (!$comboRecent || !$comboRecentBody) return;

  if (!rows.length) {
    $comboRecentBody.replaceChildren();
    if ($comboRecentStatus) {
      $comboRecentStatus.textContent =
        'Нет combo-запросов в логах OmniRoute — отправьте запрос через combo и обновите страницу.';
    }
    if ($comboRecentMeta) $comboRecentMeta.textContent = '';
    if ($comboRecentSummary) $comboRecentSummary.textContent = '';
    return;
  }

  if ($comboRecentStatus) $comboRecentStatus.textContent = '';
  if ($comboRecentMeta) {
    $comboRecentMeta.textContent = 'показано: ' + rows.length + ' ' +
      pluralRequests(rows.length);
  }

  const $tbody = $comboRecentBody;
  $tbody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    const time = document.createElement('span');
    time.className = 'num';
    time.textContent = formatCallLogTime(row.timestamp);
    time.title = row.timestamp || '';
    tdTime.appendChild(time);

    const tdCombo = document.createElement('td');
    const comboName = document.createElement('span');
    comboName.textContent = requestedOf(row) || '—';
    tdCombo.appendChild(comboName);

    const tdModel = document.createElement('td');
    const model = document.createElement('code');
    model.className = 'combo-model-id';
    model.textContent = realModelOf(row) || '—';
    tdModel.appendChild(model);

    const tdProvider = document.createElement('td');
    tdProvider.textContent = row.providerDisplay || row.provider || '—';

    const tdStatus = document.createElement('td');
    tdStatus.className = 'num-col';
    const status = document.createElement('span');
    status.className = 'badge ' + statusClass(row.status);
    status.textContent = statusText(row);
    tdStatus.appendChild(status);

    tr.append(tdTime, tdCombo, tdModel, tdProvider, tdStatus);
    $tbody.appendChild(tr);
  }

  // Сводка: какая реальная модель сколько раз обслуживала combo
  if ($comboRecentSummary) {
    const summary = modelUsageSummary(rows);
    if (summary.length) {
      const top = summary.slice(0, 3);
      $comboRecentSummary.textContent = 'Модели: ' + top
        .map((s) => s.model + ' ×' + s.count)
        .join(', ');
    } else {
      $comboRecentSummary.textContent = '';
    }
  }
}

function statusClass(status) {
  if (status >= 200 && status < 300) return 'status-ok';
  if (status >= 400) return 'status-err';
  return 'status-other';
}

function statusText(row) {
  if (row.active) return '…';
  if (row.error) return 'ошибка';
  return String(row.status || '—');
}

function pluralRequests(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запрос';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'запроса';
  return 'запросов';
}

export async function init() {
  try { activeComboId = vaultGet('comboActive') || ''; } catch { /* нет хранилища */ }
  renderComboControls();
  setStatus('loading', 'Обновляю…');
  await loadCombos();
  loadComboRecent();
  // Тихо подгружаем каталог моделей — для бейджей тарифа (free/paid/premium)
  try {
    const data = await providerRequest('models', { provider: session.modelsProvider });
    session.models = data.data || [];
    renderComboList();
  } catch { /* бейджи необязательны */ }
}

/* ---------- события (привязываются один раз) ---------- */

on($comboSelect, 'change', () => selectCombo($comboSelect.value));

on($comboRefresh, 'click', () => {
  loadCombos();
  loadComboRecent();
});

start();
