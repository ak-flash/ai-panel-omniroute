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
import { extractComboTargets, combosFromResponse, applyAliases } from '../combos.js';
import { loadAliases } from '../aliases.js';
import { recentComboRows } from '../call-logs.js';
import { matchModel } from '../model-match.js';
import { showToast } from '../toast.js';
import { reorderItems, toComboIndex as mapComboIndex } from '../combo-order.js';
import { buildComboRow } from '../combo-row.js';
import { renderComboRecentTable } from '../combo-recent-view.js';
import { createComboModelCheck } from '../combo-model-check.js';
import { formatErrorDetail } from '../error-detail.js';

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

// Сколько последних combo-запросов показывать
const RECENT_LIMIT = 10;
// Сколько записей лога запросить у OmniRoute, чтобы выбрать из них combo-строки
const RECENT_FETCH_LIMIT = 200;
// Таймаут тестового запроса модели

// Состояние страницы Combo (локальное — другим страницам не нужно)
let combos = [];
let combosLoaded = false;
let comboError = null; // текст последней ошибки загрузки (не затирается рендером)
let activeComboId = null;
let comboModels = []; // массив target-объектов: { provider, model, display, weight }
let activeComboData = null; // полный объект combo с сервера для PUT
let disabledComboTargets = new Set();
let disabledComboRaw = new Map();
let disabledComboModels = [];
let comboLoadVersion = 0;
let comboWrites = Promise.resolve();

// Проверка моделей тестовым запросом: состояние и запуск — в модуле (P2-2)
const comboModelCheck = createComboModelCheck({
  onUpdate: () => renderComboList(),
  notify: showToast,
});

function queueComboWrite(task) {
  const write = comboWrites.then(task);
  comboWrites = write.catch(() => {});
  return write;
}

/** Сохраняет выбранную combo в хранилище сервера */
function saveActiveCombo() {
  vaultSet('comboActive', activeComboId || '');
}

function activeCombo() {
  return combos.find(c => c.id === activeComboId) || null;
}

function comboTargetKey(target) {
  const raw = target && target._raw;
  if (raw && typeof raw === 'object' && raw.id) return String(raw.id);
  return String((target && (target.key || target.modelId || target.display)) || '');
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
  } catch {
    /* повреждённая настройка — считаем все модели включёнными */
  }
}

async function saveDisabledComboTargets(comboId, targets, rawTargets) {
  let data;
  try {
    data = JSON.parse(vaultGet(COMBO_DISABLED_CONFIG_KEY) || '{}') || {};
  } catch {
    data = {};
  }
  const saved = [...targets].map(key => ({ key, raw: rawTargets.get(key) }));
  if (saved.length) data[comboId] = saved;
  else delete data[comboId];
  const result = await vaultSet(COMBO_DISABLED_CONFIG_KEY, JSON.stringify(data));
  if (!result.ok) throw new Error('Не удалось сохранить список выключенных моделей');
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

/* --- Бейдж тарифа: каталог того провайдера, который отдаёт модель ------
   Маршрут может состоять из моделей разных провайдеров, а session.models
   — каталог провайдера, выбранного на странице «Модели». Поэтому ищем
   модель в каталоге её собственного провайдера, а session.models берём
   запасным вариантом. Каталоги кэшируем на время страницы. */
const catalogCache = new Map(); // id провайдера панели -> массив моделей
const catalogLoads = new Map(); // id провайдера панели -> промис загрузки

/** Провайдер панели, отдающий модель маршрута ('' — определить нельзя) */
function targetProviderId(target) {
  if (!target) return '';
  const full = String(target.modelId || '');
  const raw = String((target._raw && (target._raw.providerId || target._raw.provider)) || '');
  // Префикс берём из алиасированного полного id — так же, как строится display
  const candidates = [full ? applyAliases(full, loadAliases()) : '', full, raw];
  const withPrefix = candidates.find(s => s && s.includes('/')) || raw;
  const prefix = withPrefix.includes('/')
    ? withPrefix.slice(0, withPrefix.indexOf('/'))
    : withPrefix;
  const key = String(prefix).toLowerCase();
  if (!key) return '';
  const p = session.providers.find(
    x => x.id.toLowerCase() === key || String(x.name || '').toLowerCase() === key
  );
  return p ? p.id : '';
}

/** Модель маршрута для бейджа тарифа; при необходимости догружает каталог */
function findTargetModel(target) {
  const pid = targetProviderId(target);
  const own = pid ? catalogCache.get(pid) : null;
  const found = (own && matchModel(own, target.modelId)) || findModel(target.modelId);
  if (found) return found;
  // session.models — каталог modelsProvider, повторно его не грузим
  if (pid && (!session.modelsProvider || session.modelsProvider.id !== pid)) loadCatalog(pid);
  return null;
}

/** Догружает каталог провайдера (один раз) и перерисовывает список */
function loadCatalog(pid) {
  if (!pid || catalogCache.has(pid) || catalogLoads.has(pid)) return;
  const provider = session.providers.find(p => p.id === pid);
  if (!provider) return;
  const task = providerRequest('models', { provider })
    .then(d => {
      catalogCache.set(pid, Array.isArray(d.data) ? d.data : []);
    })
    .catch(() => {
      catalogCache.set(pid, []);
    })
    .then(() => {
      catalogLoads.delete(pid);
      renderComboList();
    });
  catalogLoads.set(pid, task);
}

let dragSrcIdx = null;
let pointerDrag = null;

/** Ключ строки, на которой сейчас фокус, — восстанавливаем после
 *  перерисовки списка (P3-5). */
let focusKey = null;

function captureFocusedKey() {
  if (!$comboList || !document.activeElement) return;
  const li = document.activeElement.closest ? document.activeElement.closest('li[data-key]') : null;
  focusKey = li ? li.dataset.key : null;
}

function restoreFocus() {
  const key = focusKey;
  focusKey = null;
  if (!key || !$comboList) return;
  const li = $comboList.querySelector('li[data-key="' + CSS.escape(key) + '"]');
  if (!li) return;
  const target = li.querySelector('button:not([disabled]):not([hidden])') || li;
  if (target.focus) target.focus();
}

/** Объявление новой позиции модели для скринридера (P3-5). */
let $orderLive = null;
function announceOrder(text) {
  if (!$comboList) return;
  if (!$orderLive) {
    $orderLive = document.createElement('p');
    $orderLive.className = 'visually-hidden';
    $orderLive.setAttribute('role', 'status');
    $orderLive.setAttribute('aria-live', 'polite');
    $comboList.parentNode.appendChild($orderLive);
  }
  $orderLive.textContent = text;
}

/** Индекс строки в общем списке (включённые + выключенные) → индекс
 *  в comboModels. Строка после блока выключенных переносится в конец. */
function toComboIndex(visibleIdx) {
  return mapComboIndex(visibleIdx, comboModels.length);
}

/** Переставляет модель с позиции from на позиции to и сохраняет порядок */
function moveModel(from, to) {
  if (from == null || to == null || from === to) return;
  const moved = comboModels[from];
  comboModels = reorderItems(comboModels, from, to);
  captureFocusedKey();
  renderComboList();
  restoreFocus();
  announceOrder(moved.display + ', позиция ' + (to + 1) + ' из ' + comboModels.length);
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
    'translate(' + (e.clientX - pointerDrag.offX) + 'px,' + (e.clientY - pointerDrag.offY) + 'px)';
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
  $comboList.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  if (commit) moveModel(toComboIndex(st.idx), toComboIndex(st.overIdx));
}

async function toggleComboModel(target) {
  const key = comboTargetKey(target);
  const isDisabled = disabledComboTargets.has(key);
  if (isDisabled) {
    disabledComboTargets.delete(key);
    disabledComboRaw.delete(key);
    const restored = disabledComboModels.find(item => comboTargetKey(item) === key) || target;
    disabledComboModels = disabledComboModels.filter(item => comboTargetKey(item) !== key);
    comboModels.push(restored);
  } else {
    if (comboModels.length <= 1) {
      showToast('Нельзя выключить последнюю включённую модель', { type: 'error' });
      return;
    }
    disabledComboTargets.add(key);
    disabledComboRaw.set(key, target._raw);
    comboModels = comboModels.filter(item => comboTargetKey(item) !== key);
    disabledComboModels.push(target);
  }

  renderComboDetails();
  const arr = comboTargetArray();
  if (!arr) return;
  arr.length = 0;
  comboModels.forEach(item => arr.push(item._raw));
  const comboId = activeComboId;
  const version = comboLoadVersion;
  const body = structuredClone(activeComboData);
  const disabledTargets = new Set(disabledComboTargets);
  const disabledRaw = new Map(disabledComboRaw);
  try {
    await queueComboWrite(async () => {
      await saveDisabledComboTargets(comboId, disabledTargets, disabledRaw);
      await omniFetch(COMBO_PATH(comboId), { method: 'PUT', body });
    });
    if (version === comboLoadVersion) {
      showToast(isDisabled ? 'Модель включена' : 'Модель выключена');
      $comboStatus.textContent = '';
    }
  } catch (err) {
    console.error('[Combo] toggle model failed:', err);
    if (version === comboLoadVersion) {
      showToast(
        'Не удалось изменить состояние модели: ' + (err && err.message ? err.message : err),
        { type: 'error', timeout: 6000 }
      );
      loadComboModels();
    }
  }
}

function comboTargetArray() {
  if (Array.isArray(activeComboData.models)) return activeComboData.models;
  if (Array.isArray(activeComboData.targets)) return activeComboData.targets;
  if (
    activeComboData.config &&
    activeComboData.config.auto &&
    Array.isArray(activeComboData.config.auto.candidatePool)
  ) {
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
  const reordered = comboModels.map(t => t._raw);
  if (reordered.some(r => r == null)) {
    console.warn('[Combo] saveReorderedCombo: some _raw entries are missing', reordered);
    return;
  }

  // Заменяем содержимое исходного массива in-place
  arr.length = 0;
  reordered.forEach(item => arr.push(item));

  const version = comboLoadVersion;
  const body = structuredClone(activeComboData);
  $comboStatus.textContent = 'Сохраняю порядок…';
  queueComboWrite(() => omniFetch(COMBO_PATH(combo.id), { method: 'PUT', body }))
    .then(() => {
      if (version !== comboLoadVersion) return;
      $comboStatus.textContent = '';
      showToast(successMessage);
    })
    .catch(err => {
      console.error('[Combo] saveReorderedCombo PUT failed:', err);
      if (version !== comboLoadVersion) return;
      showToast('Не удалось сохранить порядок: ' + (err && err.message ? err.message : err), {
        type: 'error',
        timeout: 6000,
      });
      loadComboModels();
    });
}

/** «targets: N, выключено: M» — считается по актуальным спискам. */
function updateTargetsCount() {
  if (!$comboTargetsCount) return;
  const total = comboModels.length + disabledComboModels.length;
  $comboTargetsCount.textContent = total
    ? 'targets: ' + comboModels.length + ', выключено: ' + disabledComboModels.length
    : '';
}

function renderComboList() {
  if (!$comboList) return; // элемент есть только на странице Combo
  // Счётчик targets живёт рядом со списком и обязан пересчитываться
  // при каждой перерисовке, иначе после выключения модели он врёт.
  updateTargetsCount();
  $comboList.replaceChildren();
  const visibleModels = comboModels.concat(disabledComboModels);
  visibleModels.forEach((t, i) => {
    const key = comboTargetKey(t);
    const isDisabled = disabledComboTargets.has(key);
    const { el: li, dragHandle } = buildComboRow({
      target: t,
      key,
      index: i,
      enabledCount: comboModels.length,
      disabled: isDisabled,
      model: findTargetModel(t),
      testState: comboModelCheck.get(key),
      handlers: {
        onCheck: () => comboModelCheck.run(t, key),
        onToggle: () => toggleComboModel(t),
      },
    });

    li.addEventListener('dragstart', e => {
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
      $comboList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      dragSrcIdx = null;
    });

    li.addEventListener('dragover', e => {
      if (isDisabled || dragSrcIdx == null || dragSrcIdx === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });

    li.addEventListener('drop', e => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (isDisabled || dragSrcIdx == null || dragSrcIdx === i) return;
      moveModel(toComboIndex(dragSrcIdx), toComboIndex(i));
    });

    /* Тач/перо: HTML5 DnD не срабатывает — эмулируем через Pointer Events.
       Старт — только за ручку, чтобы свайпы по строке листали страницу. */
    dragHandle.addEventListener('keydown', e => {
      if (isDisabled || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      moveModel(toComboIndex(i), toComboIndex(i + delta));
    });

    dragHandle.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return; // мышь идёт через HTML5 DnD
      if (e.pointerType === 'pen' && e.button !== 0) return;
      startPointerDrag(e, i, li);
    });
    li.addEventListener(
      'touchmove',
      e => {
        if (pointerDrag && e.cancelable) e.preventDefault();
      },
      { passive: false }
    );
    li.addEventListener('pointermove', e => {
      if (!pointerDrag || e.pointerType === 'mouse') return;
      movePointerGhost(e);
      updatePointerDropTarget(e);
    });
    li.addEventListener('pointerup', e => {
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
    updateTargetsCount();
    $comboStatus.textContent = 'Combo пуста или не содержит targets.';
    return;
  }

  $comboDetails.hidden = false;
  renderComboList();
}

let comboHeightAnimation = null;

async function loadComboModels() {
  const version = ++comboLoadVersion;
  const combo = activeCombo();
  if (!combo) return;

  const switching = !$comboDetails.hidden;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  comboHeightAnimation?.cancel();
  comboHeightAnimation = null;
  $comboDetails.classList.toggle('is-switching', switching);
  $comboDetails.inert = switching;
  $comboDetails.setAttribute('aria-busy', 'true');
  // Во время переключения сохраняем старый блок и не вставляем строку,
  // которая сдвинула бы badge и список вниз.
  $comboStatus.textContent = switching
    ? ''
    : 'Загружаю combo «' + (combo.name || combo.id) + '»…';
  const fadeOut = switching && !reducedMotion
    ? new Promise(resolve => setTimeout(resolve, 150))
    : Promise.resolve();
  try {
    const [data] = await Promise.all([omniFetch(COMBO_PATH(combo.id)), fadeOut]);
    if (version !== comboLoadVersion || combo.id !== activeComboId) return;
    activeComboData = data;
    loadDisabledComboTargets();
    const loadedTargets = extractComboTargets(data);
    const savedDisabled = [...disabledComboTargets]
      .map(key => (disabledComboRaw.has(key) ? { key, raw: disabledComboRaw.get(key) } : null))
      .filter(Boolean)
      .map(item => extractComboTargets({ models: [item.raw] })[0])
      .filter(Boolean);
    disabledComboModels = savedDisabled;
    comboModels = loadedTargets.filter(target => !disabledComboTargets.has(comboTargetKey(target)));
    for (const target of loadedTargets) {
      const key = comboTargetKey(target);
      if (disabledComboTargets.has(key)) disabledComboRaw.set(key, target._raw);
    }
    disabledComboModels = [
      ...disabledComboModels,
      ...loadedTargets.filter(
        target =>
          disabledComboTargets.has(comboTargetKey(target)) &&
          !disabledComboModels.some(item => comboTargetKey(item) === comboTargetKey(target))
      ),
    ];
    const previousHeight = $comboDetails.getBoundingClientRect().height;
    // Стратегия и число targets обновляются вместе, пока блок скрыт opacity.
    if ($comboStrategyBadge) {
      $comboStrategyBadge.textContent = data.strategy || '?';
      $comboStrategyBadge.hidden = !data.strategy;
    }
    renderComboDetails();
    if (!$comboDetails.hidden) $comboStatus.textContent = '';
    $comboDetails.inert = false;
    $comboDetails.setAttribute('aria-busy', 'false');
    if (switching && !$comboDetails.hidden && !reducedMotion) {
      const nextHeight = $comboDetails.getBoundingClientRect().height;
      if (previousHeight !== nextHeight) {
        comboHeightAnimation = $comboDetails.animate(
          [{ height: previousHeight + 'px' }, { height: nextHeight + 'px' }],
          { duration: 180, easing: 'ease-out' }
        );
      }
    }
    // Фиксируем opacity: 0 перед сменой класса даже при быстром ответе API.
    void $comboDetails.offsetHeight;
    requestAnimationFrame(() => {
      if (version === comboLoadVersion && combo.id === activeComboId) {
        $comboDetails.classList.remove('is-switching');
      }
    });
  } catch (err) {
    if (version !== comboLoadVersion || combo.id !== activeComboId) return;
    console.error('[Combo] loadComboModels failed:', err);
    $comboStatus.textContent = 'Ошибка загрузки combo: ' + (err && err.message ? err.message : err);
    $comboDetails.classList.remove('is-switching');
    $comboDetails.inert = false;
    $comboDetails.setAttribute('aria-busy', 'false');
    $comboDetails.hidden = true;
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
    if (!combos.some(c => c.id === activeComboId)) {
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
  if (!combos.some(c => c.id === id)) return;
  if (activeComboId === id) return;
  activeComboId = id;
  comboLoadVersion++;
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
    renderComboRecentTable(rows, {
      recent: $comboRecent,
      status: $comboRecentStatus,
      meta: $comboRecentMeta,
      body: $comboRecentBody,
    });
  } catch (err) {
    console.error('[Combo] loadComboRecent failed:', err);
    if ($comboRecentStatus) {
      const detail = formatErrorDetail(err);
      $comboRecentStatus.textContent = 'Не удалось загрузить последние запросы: ' + detail;
    }
    if ($comboRecentBody) $comboRecentBody.replaceChildren();
    if ($comboRecentMeta) $comboRecentMeta.textContent = '';
  }
}

export async function init() {
  try {
    activeComboId = vaultGet('comboActive') || '';
  } catch {
    /* нет хранилища */
  }
  renderComboControls();
  setStatus('loading', 'Обновляю…');
  // Страница показывается сразу, данные combo догружаются сами (P3-1):
  // иначе экран оставался пустым до ответа OmniRoute.
  void Promise.resolve()
    .then(loadCombos)
    .then(() => {
      loadComboRecent();
      // Каталог моделей провайдера «Модели» — запасной источник для
      // бейджей тарифа; каталоги остальных провайдеров догружает
      // findTargetModel
      return providerRequest('models', { provider: session.modelsProvider })
        .then(data => {
          session.models = data.data || [];
          renderComboList();
        })
        .catch(() => {
          /* бейджи необязательны */
        });
    });
}

/* ---------- события (привязываются один раз) ---------- */

on($comboSelect, 'change', () => selectCombo($comboSelect.value));

on($comboRefresh, 'click', () => {
  loadCombos();
  loadComboRecent();
});

start();
