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
import { recentComboRows, requestedOf, realModelOf, formatCallLogTime, modelUsageSummary, formatTokensOf, tokensTitle } from '../call-logs.js';
import { matchModel } from '../../model-match.js';
import { showToast } from '../toast.js';
import { icon } from '../../icons.js';

const COMBO_DISABLED_CONFIG_KEY = 'comboDisabled';

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
// Таймаут тестового запроса модели
const MODEL_TEST_TIMEOUT_MS = 30000;

// Состояние страницы Combo (локальное — другим страницам не нужно)
let combos = [];
let combosLoaded = false;
let comboError = null;   // текст последней ошибки загрузки (не затирается рендером)
let activeComboId = null;
let comboModels = [];    // массив target-объектов: { provider, model, display, weight }
let activeComboData = null; // полный объект combo с сервера для PUT
let disabledComboTargets = new Set();
let disabledComboRaw = new Map();
let disabledComboModels = [];
// Результаты проверки моделей: key -> { state: 'loading'|'ok'|'err', ms, detail }
let comboTestResults = new Map();

/** Сохраняет выбранную combo в хранилище сервера */
function saveActiveCombo() {
  vaultSet('comboActive', activeComboId || '');
}

function activeCombo() {
  return combos.find((c) => c.id === activeComboId) || null;
}

function comboTargetKey(target) {
  const raw = target && target._raw;
  if (raw && typeof raw === 'object' && raw.id) return String(raw.id);
  return String(target && (target.key || target.modelId || target.display) || '');
}

function loadDisabledComboTargets() {
  disabledComboTargets = new Set();
  disabledComboRaw = new Map();
  try {
    const data = JSON.parse(vaultGet(COMBO_DISABLED_CONFIG_KEY) || '{}');
    const saved = data && data[activeComboId];
    if (!Array.isArray(saved)) return;
    for (const item of saved) {
      const key = item && item.key != null ? String(item.key) : '';
      if (!key) continue;
      disabledComboTargets.add(key);
      if (item.raw != null) disabledComboRaw.set(key, item.raw);
    }
  } catch { /* повреждённая настройка — считаем все модели включёнными */ }
}

async function saveDisabledComboTargets() {
  let data;
  try { data = JSON.parse(vaultGet(COMBO_DISABLED_CONFIG_KEY) || '{}') || {}; } catch { data = {}; }
  const saved = [...disabledComboTargets].map((key) => ({ key, raw: disabledComboRaw.get(key) }));
  if (saved.length) data[activeComboId] = saved;
  else delete data[activeComboId];
  await vaultSet(COMBO_DISABLED_CONFIG_KEY, JSON.stringify(data));
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
let pointerDrag = null;

/** Переставляет модель с позиции from на позицию to и сохраняет порядок */
function moveModel(from, to) {
  if (from == null || to == null || from === to) return;
  const moved = comboModels.splice(from, 1)[0];
  comboModels.splice(to, 0, moved);
  renderComboList();
  saveReorderedCombo();
}

/* --- Перетаскивание на сенсорных экранах: HTML5 DnD там не работает --- */

function startPointerDrag(e, idx, li) {
  const rect = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add('combo-drag-ghost');
  ghost.classList.remove('dragging', 'drag-over');
  ghost.style.width = rect.width + 'px';
  document.body.appendChild(ghost);
  li.classList.add('dragging');
  pointerDrag = {
    idx,
    ghost,
    offX: e.clientX - rect.left,
    offY: e.clientY - rect.top,
    overIdx: null,
    overLi: null,
  };
  movePointerGhost(e);
  if (e.cancelable) e.preventDefault();
}

function movePointerGhost(e) {
  pointerDrag.ghost.style.transform =
    'translate(' + (e.clientX - pointerDrag.offX) + 'px,' +
    (e.clientY - pointerDrag.offY) + 'px)';
}

function updatePointerDropTarget(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const li = hit && hit.closest ? hit.closest('#combo-models-list > li') : null;
  const prev = pointerDrag.overLi;
  if (prev && prev !== li) prev.classList.remove('drag-over');
  pointerDrag.overLi = null;
  pointerDrag.overIdx = null;
  if (li && li.dataset.idx != null && Number(li.dataset.idx) !== pointerDrag.idx) {
    li.classList.add('drag-over');
    pointerDrag.overLi = li;
    pointerDrag.overIdx = Number(li.dataset.idx);
  }
}

function endPointerDrag(commit) {
  const st = pointerDrag;
  if (!st) return;
  pointerDrag = null;
  st.ghost.remove();
  if (st.overLi) st.overLi.classList.remove('drag-over');
  $comboList.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  if (commit) moveModel(st.idx, st.overIdx);
}

async function toggleComboModel(target) {
  const key = comboTargetKey(target);
  const isDisabled = disabledComboTargets.has(key);
  if (isDisabled) {
    disabledComboTargets.delete(key);
    disabledComboRaw.delete(key);
    const restored = disabledComboModels.find((item) => comboTargetKey(item) === key) || target;
    disabledComboModels = disabledComboModels.filter((item) => comboTargetKey(item) !== key);
    comboModels.push(restored);
  } else {
    if (comboModels.length <= 1) {
      showToast('Нельзя выключить последнюю включённую модель', { type: 'error' });
      return;
    }
    disabledComboTargets.add(key);
    disabledComboRaw.set(key, target._raw);
    comboModels = comboModels.filter((item) => comboTargetKey(item) !== key);
    disabledComboModels.push(target);
  }

  renderComboDetails();
  const arr = comboTargetArray();
  if (!arr) return;
  arr.length = 0;
  comboModels.forEach((item) => arr.push(item._raw));
  try {
    await saveDisabledComboTargets();
    await omniFetch(COMBO_PATH(activeComboId), { method: 'PUT', body: activeComboData });
    showToast(isDisabled ? 'Модель включена' : 'Модель выключена');
    $comboStatus.textContent = '';
  } catch (err) {
    console.error('[Combo] toggle model failed:', err);
    showToast('Не удалось изменить состояние модели: ' + (err && err.message ? err.message : err), { type: 'error', timeout: 6000 });
    loadComboModels();
  }
}

function comboTargetArray() {
  if (Array.isArray(activeComboData.models)) return activeComboData.models;
  if (Array.isArray(activeComboData.targets)) return activeComboData.targets;
  if (activeComboData.config && activeComboData.config.auto && Array.isArray(activeComboData.config.auto.candidatePool)) {
    return activeComboData.config.auto.candidatePool;
  }
  return null;
}

function saveReorderedCombo(successMessage = 'Порядок сохранён') {
  const combo = activeCombo();
  if (!combo || !activeComboData) return;

  const arr = comboTargetArray();
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
    showToast(successMessage);
  }).catch((err) => {
    console.error('[Combo] saveReorderedCombo PUT failed:', err);
    showToast('Не удалось сохранить порядок: ' + (err && err.message ? err.message : err), { type: 'error', timeout: 6000 });
    loadComboModels();
  });
}

/* ---------- проверка модели мини-запросом через OmniRoute ---------- */

function comboTestModelId(target) {
  if (target.modelId) return String(target.modelId);
  const raw = target._raw;
  if (raw && typeof raw === 'object') {
    if (raw.model) return String(raw.model);
    if (raw.modelId) return String(raw.modelId);
    if (raw.id) return String(raw.id);
  }
  return String(target.display || '');
}

/** Мини-запрос к конкретной модели через OmniRoute: max_tokens 1,
 *  без кеша и памяти. Возвращает время ответа или кидает ошибку. */
async function testComboModel(modelId) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch('/omniroute/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OmniRoute-No-Cache': 'true' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
    });
  } catch (err) {
    const ms = Math.round(performance.now() - startedAt);
    const e = new Error(
      err && err.name === 'TimeoutError'
        ? 'таймаут ' + Math.round(MODEL_TEST_TIMEOUT_MS / 1000) + ' с'
        : 'нет ответа от OmniRoute',
    );
    e.ms = ms;
    throw e;
  }

  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { /* не JSON */ }
    const detail = payload && (payload.error && payload.error.message || payload.message)
      ? (payload.error.message || payload.message)
      : 'HTTP ' + response.status;
    const e = new Error(detail);
    e.ms = Math.round(performance.now() - startedAt);
    throw e;
  }

  // Ответ не читаем целиком — достаточно заголовков (латентность реального вызова)
  const latencyHeader = parseInt(response.headers.get('X-OmniRoute-Latency-Ms'), 10);
  const ms = Number.isFinite(latencyHeader) && latencyHeader > 0
    ? latencyHeader
    : Math.round(performance.now() - startedAt);
  // Освобождаем соединение — тело тестового ответа панель не нужна
  try { await response.body.cancel(); } catch { /* уже закрыт */ }
  return { ms, model: response.headers.get('X-OmniRoute-Model') || modelId };
}

async function checkComboModel(target, key) {
  const prev = comboTestResults.get(key);
  if (prev && prev.state === 'loading') return; // проверка уже идёт
  comboTestResults.set(key, { state: 'loading' });
  renderComboList();
  try {
    const res = await testComboModel(comboTestModelId(target));
    comboTestResults.set(key, { state: 'ok', ms: res.ms });
    showToast('Модель отвечает: ' + res.ms + ' мс');
  } catch (err) {
    comboTestResults.set(key, { state: 'err', ms: err.ms, detail: err.message });
    showToast('Проверка не удалась: ' + err.message, { type: 'error', timeout: 6000 });
  }
  renderComboList();
}

function renderComboList() {
  if (!$comboList) return; // элемент есть только на странице Combo
  $comboList.replaceChildren();
  const visibleModels = comboModels.concat(disabledComboModels);
  visibleModels.forEach((t, i) => {
    const key = comboTargetKey(t);
    const isDisabled = disabledComboTargets.has(key);
    const li = document.createElement('li');
    if (i === 0 && !isDisabled) li.classList.add('top');
    if (isDisabled) li.classList.add('is-disabled');
    li.draggable = !isDisabled;
    li.dataset.idx = String(i);
    li.dataset.key = key;

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

    // Кнопка проверки (иконка check-circle) всегда в DOM — иначе
    // высота ряда прыгает. Во время проверки скрыта, при ошибке
    // становится красным x-circle, при успехе рядом цифры «N мс».
    const testState = comboTestResults.get(key);
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn-icon combo-test-btn';
    testBtn.setAttribute('aria-label', 'Проверить модель ' + t.display);
    testBtn.title = 'Проверить модель тестовым запросом';
    if (testState && testState.state === 'loading') {
      testBtn.classList.add('combo-test-btn-hidden');
      testBtn.tabIndex = -1;
      testBtn.disabled = true;
    } else if (testState && testState.state === 'err') {
      testBtn.innerHTML = icon('x-circle');
      testBtn.classList.add('combo-test-err');
      testBtn.title = (testState.detail || 'Модель не ответила') + ' — проверить снова';
      testBtn.addEventListener('click', () => checkComboModel(t, key));
    } else {
      testBtn.innerHTML = icon('check-circle');
      if (testState && testState.state === 'ok') {
        testBtn.title = 'Модель ответила за ' + testState.ms + ' мс — проверить снова';
      }
      testBtn.addEventListener('click', () => checkComboModel(t, key));
    }
    li.appendChild(testBtn);

    if (testState && testState.state === 'loading') {
      const testBadge = document.createElement('span');
      testBadge.className = 'badge combo-test-badge combo-test-loading';
      testBadge.textContent = 'проверяю…';
      testBadge.title = 'Идёт проверка модели…';
      li.appendChild(testBadge);
    } else if (testState && testState.state === 'ok') {
      const msSpan = document.createElement('span');
      msSpan.className = 'combo-test-ms num combo-test-ok';
      msSpan.textContent = testState.ms + ' мс';
      msSpan.title = 'Модель ответила за ' + testState.ms + ' мс';
      li.appendChild(msSpan);
    }

    // У первой включённой модели переключателя нет — она всегда активна
    if (!(i === 0 && !isDisabled)) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'combo-switch';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(!isDisabled));
      toggle.setAttribute('aria-label',
        (isDisabled ? 'Включить модель ' : 'Выключить модель ') + t.display);
      toggle.title = isDisabled ? 'Включить модель' : 'Выключить модель';
      toggle.addEventListener('click', () => toggleComboModel(t));
      li.appendChild(toggle);
    }

    li.addEventListener('dragstart', (e) => {
      if (isDisabled) {
        e.preventDefault();
        return;
      }
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
      if (isDisabled || dragSrcIdx == null || dragSrcIdx === i) return;
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
      if (isDisabled || dragSrcIdx == null || dragSrcIdx === i) return;
      moveModel(dragSrcIdx, i);
    });

    if (isDisabled) {
      dragHandle.hidden = true;
    }

    /* Тач/перо: HTML5 DnD не срабатывает — эмулируем через Pointer Events.
       Старт — только за ручку, чтобы свайпы по строке листали страницу. */
    dragHandle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return; // мышь идёт через HTML5 DnD
      if (e.pointerType === 'pen' && e.button !== 0) return;
      startPointerDrag(e, i, li);
    });
    li.addEventListener('touchmove', (e) => {
      if (pointerDrag && e.cancelable) e.preventDefault();
    }, { passive: false });
    li.addEventListener('pointermove', (e) => {
      if (!pointerDrag || e.pointerType === 'mouse') return;
      movePointerGhost(e);
      updatePointerDropTarget(e);
    });
    li.addEventListener('pointerup', (e) => {
      if (!pointerDrag || e.pointerType === 'mouse') return;
      updatePointerDropTarget(e);
      endPointerDrag(true);
    });
    li.addEventListener('pointercancel', () => {
      if (!pointerDrag) return;
      endPointerDrag(false);
    });

    $comboList.appendChild(li);
  });
}

function renderComboDetails() {
  if (!comboModels.length && !disabledComboModels.length) {
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
    loadDisabledComboTargets();
    const loadedTargets = extractComboTargets(data);
    const savedDisabled = [...disabledComboTargets]
      .map((key) => disabledComboRaw.has(key) ? { key, raw: disabledComboRaw.get(key) } : null)
      .filter(Boolean)
      .map((item) => extractComboTargets({ models: [item.raw] })[0])
      .filter(Boolean);
    disabledComboModels = savedDisabled;
    comboModels = loadedTargets.filter((target) => !disabledComboTargets.has(comboTargetKey(target)));
    for (const target of loadedTargets) {
      const key = comboTargetKey(target);
      if (disabledComboTargets.has(key)) disabledComboRaw.set(key, target._raw);
    }
    disabledComboModels = [...disabledComboModels, ...loadedTargets.filter((target) => disabledComboTargets.has(comboTargetKey(target)) && !disabledComboModels.some((item) => comboTargetKey(item) === comboTargetKey(target)))];
    // Стратегия и число targets из шапки панели
    if ($comboStrategyBadge) {
      $comboStrategyBadge.textContent = data.strategy || '?';
      $comboStrategyBadge.hidden = !data.strategy;
    }
    if ($comboTargetsCount) {
      $comboTargetsCount.textContent = (comboModels.length + disabledComboModels.length)
        ? 'targets: ' + comboModels.length + ', выключено: ' + disabledComboModels.length
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
    // Восстановить активный, ��сли он ещё существует
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
    const detail = formatErrorDetail(err);
    comboError = 'Ошибка загрузки списка combo: ' + detail;
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
function formatErrorDetail(err) {
  let msg = err && err.message ? err.message : String(err);
  // Пытаемся извлечь статус и тело, если есть Response-подобный объект
  if (err && err.status !== undefined) {
    const statusText = err.statusText ? ' ' + err.statusText : '';
    msg += ' (статус: ' + err.status + statusText + ')';
  }
  if (err && err.body) {
    const bodyStr = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
    msg += ' Тело: ' + bodyStr;
  }
  // Если есть response и он ещё не обработан
  if (err && err.response && typeof err.response === 'object') {
    const resp = err.response;
    if (resp.status !== undefined) {
      const statusText = resp.statusText ? ' ' + resp.statusText : '';
      msg += ' (статус ответа: ' + resp.status + statusText + ')';
    }
    // Если тело не было извлечено, но есть promise, не пытаемся его читать здесь
  }
  return msg;
}

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
      const detail = formatErrorDetail(err);
      $comboRecentStatus.textContent = 'Не удалось загрузить последние запросы: ' + detail;
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

    const tdTokens = document.createElement('td');
    tdTokens.className = 'num-col';
    const tokens = document.createElement('span');
    tokens.className = 'num';
    tokens.textContent = formatTokensOf(row) || '—';
    const tokensHint = tokensTitle(row);
    if (tokensHint) tokens.title = tokensHint;
    tdTokens.appendChild(tokens);

    const tdStatus = document.createElement('td');
    tdStatus.className = 'num-col';
    const status = document.createElement('span');
    status.className = 'badge ' + statusClass(row.status, Boolean(row.error));
    status.textContent = statusText(row);
    if (row.error) status.title = extractErrorText(row.error);
    tdStatus.appendChild(status);

    tr.append(tdTime, tdCombo, tdModel, tdProvider, tdTokens, tdStatus);
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

function statusClass(status, hasError) {
  if (hasError) return 'status-err';
  if (status >= 200 && status < 300) return 'status-ok';
  if (status >= 400) return 'status-err';
  return 'status-other';
}

function extractErrorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.error) return extractErrorText(err.error);
  if (err.statusText) return err.statusText;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function statusText(row) {
  if (row.active) return '…';
  if (row.error) {
    const detail = extractErrorText(row.error);
    return detail || 'ошибка';
  }
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
