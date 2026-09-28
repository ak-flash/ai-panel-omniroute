/* ============================================================
   AI Panel — страница «Статистика»: карточка провайдера с окнами
   расхода, баланс AgentRouter, квоты Antigravity (Google AI Pro)
   и первые модели маршрутов.
   ============================================================ */

import { session, PROVIDER_FALLBACK } from '../session.js';
import { $id, span, GAP } from '../dom.js';
import { setStatus, touchUpdated } from '../topbar.js';
import { showBanner, hideBanner } from '../banner.js';
import { providerRequest } from '../api.js';
import { keyForProvider, vaultGetJson, vaultSet } from '../settings.js';
import { onEvent } from '../events.js';
import { rebootPage, start } from '../boot.js';
import { fmtUsd, compact, dur, num, pct, barClass } from '../formatters.js';
import { loadComboList, comboTargets } from '../combos.js';
import { createWalletCard } from '../cards/wallet-card.js';
import {
  loadAntigravityQuota,
  getQuota as getAntigravityQuota,
  tick as tickAntigravity,
} from '../cards/antigravity.js';
import { showToast } from '../toast.js';
import { renderRelease as renderAgentRouterRelease } from '../cards/agentrouter-release.js';
import { evaluateAll } from '../notifications.js';

// Статичные элементы страницы — доступны на момент eval модуля
const $cards = $id('cards');
const $statsProvider = $id('stats-provider');
const $statsProviderSelect = $id('stats-provider-select');
const $setup = $id('setup');
const $planBadge = $id('plan-badge');
const $walletBalance = $id('wallet-balance');
const $walletHeld = $id('wallet-held');
const $shortCard = $id('card-short');
const $longCard = $id('card-long');
const $freeCard = $id('card-free');
const $live = $id('live');
const $experientialCard = $id('experiential-card');

function hasProviderKey(id) {
  return Boolean(keyForProvider(id)) || session.providers.some(p => p.id === id && p.hasKey);
}

const isActiveProvider = id => session.activeProvider.id === id;

function renderExperientialCard(data) {
  if (!$experientialCard) return;
  $experientialCard.hidden = false;
  const error = $id('experiential-error');
  if (error) error.hidden = true;
  const plan = $id('experiential-plan');
  const planLabel = data.plan ? String(data.plan).trim() : '';
  if (plan) {
    plan.textContent = planLabel.toUpperCase();
    plan.hidden = !planLabel;
  }
  const balance = $id('experiential-balance');
  if (balance) {
    const value = (data.wallet || {}).balance_usd;
    const number = typeof value === 'string' ? parseFloat(value) : value;
    balance.textContent = Number.isFinite(number) ? fmtUsd(number) : '—';
  }
  const used = $id('experiential-used');
  if (used) used.textContent = Number(data.today_usd) > 0 ? fmtUsd(data.today_usd) : '—';
}

const loadExperientialCard = createWalletCard({
  id: 'experiential',
  name: 'Experiential Labs',
  cardId: 'experiential-card',
  errorId: 'experiential-error',
  errorPrefix: 'Не удалось получить статистику',
  hasKey: () => hasProviderKey('experiential'),
  isActive: () => isActiveProvider('experiential'),
  render: renderExperientialCard,
});

// Состояние страницы (локальное)
let usage = null;
let fetchedAt = null;
let deadlineShort = null;
let deadlineLong = null;
let deadlineFree = null;
let agentRouterUsage = null; // последний ответ /api/providers/agentrouter/usage (для порогов)

// Множество id уведомлений, уже показанных в этой сессии — чтобы
// один и тот же тост не появлялся после каждой кнопки «Обновить».
// Дропается при перезагрузке страницы (сессия = текущий запуск).
const notified = new Set();

function checkNotifications() {
  const thresholds = vaultGetJson('notificationThresholds');
  if (!thresholds) return;
  const data = {
    xkiro: usage,
    agentrouter: agentRouterUsage,
    antigravity: getAntigravityQuota(),
  };
  for (const note of evaluateAll(data, thresholds)) {
    if (notified.has(note.id)) continue;
    notified.add(note.id);
    showToast(note.message, { type: note.level });
  }
}

// Бейдж имени провайдера в шапке карточки статистики. Сам выбор
// провайдера выполняется в boot() по сохранённому значению (statsProvider).
function renderProviderLabel() {
  if (!$statsProvider) return;
  const p = session.activeProvider || PROVIDER_FALLBACK;
  const name = p.name || p.id;
  if (p.site) {
    $statsProvider.textContent = '';
    const a = document.createElement('a');
    a.className = 'provider-site-link';
    a.href = p.site;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = name;
    $statsProvider.appendChild(a);
  } else {
    $statsProvider.textContent = name;
  }
  renderStatsProviderSelect();
}

/**
 * Селектор провайдера статистики (P3-2). Показываем только тех, у кого
 * есть ключ: выбор без ключа давал бы вечный баннер «проверьте ключ».
 */
function renderStatsProviderSelect() {
  if (!$statsProviderSelect) return;
  const list = session.providers.filter(p => keyForProvider(p.id) || p.hasKey);
  if (list.length < 2) {
    $statsProviderSelect.hidden = true;
    $statsProviderSelect.replaceChildren();
    return;
  }
  $statsProviderSelect.hidden = false;
  $statsProviderSelect.replaceChildren();
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    opt.selected = p.id === (session.activeProvider || {}).id;
    $statsProviderSelect.appendChild(opt);
  }
}

function initStatsProviderSelect() {
  if (!$statsProviderSelect) return;
  $statsProviderSelect.addEventListener('change', () => {
    const id = $statsProviderSelect.value;
    const p = session.providers.find(item => item.id === id);
    if (!p || (session.activeProvider && session.activeProvider.id === id)) return;
    session.activeProvider = p;
    void vaultSet('statsProvider', id).then(rebootPage);
  });
}

// Окна последнего ответа usage (используются setWindow)
let windowShort = null;
let windowLong = null;

function setWindow(kind, card) {
  const w = kind === 'short' ? windowShort : windowLong;
  if (!card || !w) {
    if (card) card.hidden = true;
    return;
  }

  const p = pct(w.spent_usd, w.cap_usd);
  document.getElementById(kind + '-pct').textContent = w.cap_usd ? Math.round(p) + '%' : '';

  card.querySelector('.stat-meta').textContent = dur(w.window_sec);
  card
    .querySelector('.stat-value')
    .replaceChildren(
      span('val-used', fmtUsd(w.spent_usd)),
      GAP(),
      span('val-sep', '/'),
      GAP(),
      span('val-limit', fmtUsd(w.cap_usd))
    );

  const bar = card.querySelector('.bar-fill');
  const progress = card.querySelector('[role="progressbar"]');
  bar.style.width = p + '%';
  if (progress) {
    progress.setAttribute('aria-valuenow', String(Math.round(p)));
    progress.setAttribute('aria-valuetext', `${fmtUsd(w.spent_usd)} из ${fmtUsd(w.cap_usd)}`);
  }
  bar.classList.remove('warn', 'danger');
  const cls = barClass(p);
  if (cls) bar.classList.add(cls);

  const deadline = fetchedAt + (w.resets_in_sec || 0) * 1000;
  if (kind === 'short') deadlineShort = deadline;
  else deadlineLong = deadline;

  tickWindow(kind);
}

function tickWindow(kind) {
  const el = document.getElementById(kind + '-reset');
  const deadline = kind === 'short' ? deadlineShort : deadlineLong;
  if (!el || !deadline) return;
  const remainSec = Math.floor((deadline - Date.now()) / 1000);
  el.textContent = remainSec <= 0 ? 'обновляется…' : dur(remainSec);
}

function tickFree() {
  const el = document.getElementById('free-reset');
  if (!el || !deadlineFree) return;
  const remainSec = Math.floor((deadlineFree - Date.now()) / 1000);
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
  document.getElementById('free-pct').textContent = limit != null ? Math.round(usedPct) + '%' : '';
  document
    .getElementById('free-value')
    .replaceChildren(
      span('val-used', compact(used)),
      ...(limit == null
        ? []
        : [GAP(), span('val-sep', '/'), GAP(), span('val-limit', compact(limit))])
    );

  const bar = $freeCard.querySelector('.bar-fill');
  const progress = $freeCard.querySelector('[role="progressbar"]');
  bar.style.width = usedPct + '%';
  if (progress) {
    progress.setAttribute('aria-valuenow', String(Math.round(usedPct)));
    progress.setAttribute(
      'aria-valuetext',
      limit == null ? `${compact(used)} использовано` : `${compact(used)} из ${compact(limit)}`
    );
  }
  bar.classList.remove('warn', 'danger');
  const cls = barClass(usedPct);
  if (cls) bar.classList.add(cls);

  deadlineFree = fetchedAt + (free.resets_in_sec || 0) * 1000;
  if (!free.resets_in_sec) {
    const now = new Date();
    deadlineFree = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  }
  tickFree();
}

function renderUsage(data) {
  usage = data;
  fetchedAt = Date.now();

  $cards.hidden = false;
  $setup.hidden = true;

  $planBadge.textContent = data.plan ? String(data.plan).toUpperCase() : 'payg';

  const wallet = data.wallet || {};
  $walletBalance.textContent = fmtUsd(wallet.balance_usd);
  const held = num(wallet.held_usd);
  $walletHeld.textContent = held > 0 ? 'В холде: ' + fmtUsd(held) : '';

  // API отдаёт окна массивом объектов с полем kind: 'short' | 'long'
  const list = Array.isArray(data.windows) ? data.windows : [];
  const byKind = Object.fromEntries(list.map(w => [w.kind, w]));
  windowShort = byKind.short || null;
  windowLong = byKind.long || null;
  setWindow('short', $shortCard);
  setWindow('long', $longCard);

  renderFreeTokens(data.free_tokens);

  setStatus('ok', '');
  touchUpdated();

  if ($live) {
    // Live-регион не должен повторно озвучивать баланс при каждом
    // обновлении страницы — только когда значение изменилось (P3-5)
    const announcement = 'Баланс ' + fmtUsd(wallet.balance_usd) + ', план ' + (data.plan || 'PAYG');
    if ($live.textContent !== announcement) $live.textContent = announcement;
  }
}

async function loadUsage() {
  setStatus('loading', 'Обновляю…');
  // Кнопка «Обновить» появляется вместе с topbar (partials.js) уже после
  // eval модуля — ищем в момент использования, а не на уровне модуля
  const btn = $id('btn-refresh');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }
  try {
    const data = await providerRequest('usage');
    renderUsage(data);
    checkNotifications();
    hideBanner();
  } catch (err) {
    setStatus('err', 'Ошибка');
    let msg = err && err.message ? err.message : String(err);
    if (err && err.status === 401) msg += ' — проверьте ключ';
    showBanner(msg);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }
}

/* ---------- AgentRouter: карточка баланса на главной ---------- */

// Показываем карточку, только если у AgentRouter есть токен; когда в
// полосе статистики уже выбран AgentRouter — прячем (не дублируем)
function renderAgentRouterCard(data) {
  const $card = $id('ar-card');
  if (!$card) return;
  $card.hidden = false;
  const $err = $id('ar-error');
  if ($err) $err.hidden = true;

  const balance = $id('ar-balance');
  if (balance) balance.textContent = fmtUsd((data.wallet || {}).balance_usd);

  const group = $id('ar-group');
  const planLabel = data.plan ? String(data.plan).trim() : '';
  // У new-api группа по умолчанию называется "default" — такую надпись не показываем
  if (group) {
    const show = planLabel && planLabel.toLowerCase() !== 'default';
    group.textContent = show ? planLabel.toUpperCase() : '';
    group.hidden = !show;
  }

  const todayEl = $id('ar-today');

  // Потребление за текущие сутки: стартовый баланс дня (снимок в 00:00) минус текущий.
  const dayBal = Number(data.day_balance_usd);
  const bal = Number((data.wallet || {}).balance_usd);
  const hasDay = Number.isFinite(dayBal) && Number.isFinite(bal) && dayBal > 0;
  const today = hasDay ? Math.max(0, dayBal - bal) : null;
  if (todayEl) {
    todayEl.textContent = today !== null && today > 0 ? fmtUsd(today) : '—';
    if (today !== null) {
      todayEl.classList.toggle('val-used', today > 0);
    }
  }
}

// Загрузчик карточки AgentRouter: при удаче кладём ответ в agentRouterUsage
// (пороги уведомлений), в любом случае пересчитываем строку высвобождения.
const loadAgentRouterCard = createWalletCard({
  id: 'agentrouter',
  name: 'AgentRouter',
  cardId: 'ar-card',
  errorId: 'ar-error',
  errorPrefix: 'Не удалось получить баланс',
  hasKey: () => hasProviderKey('agentrouter'),
  isActive: () => isActiveProvider('agentrouter'),
  render: renderAgentRouterCard,
  onLoaded: data => {
    agentRouterUsage = data;
    checkNotifications();
  },
  onSettled: () => renderAgentRouterRelease(),
});
/* ---------- OpenRouter: карточка баланса на главной ---------- */

function renderOpenRouterCard(data) {
  const $card = $id('or-card');
  if (!$card) return;
  $card.hidden = false;
  const $err = $id('or-error');
  if ($err) $err.hidden = true;

  const balance = $id('or-balance');
  if (balance) balance.textContent = fmtUsd((data.wallet || {}).balance_usd);

  const plan = $id('or-plan');
  const planLabel = data.plan ? String(data.plan).trim() : '';
  if (plan) {
    const show = planLabel && planLabel.toLowerCase() !== 'payg';
    plan.textContent = show ? planLabel.toUpperCase() : '';
    plan.hidden = !show;
  }

  const usedEl = $id('or-used');
  const used = Number(data.today_usd) || 0;
  if (usedEl) usedEl.textContent = used > 0 ? fmtUsd(used) : '—';
}

const loadOpenRouterCard = createWalletCard({
  id: 'openrouter',
  name: 'OpenRouter',
  cardId: 'or-card',
  errorId: 'or-error',
  errorPrefix: 'Не удалось получить баланс',
  hasKey: () => hasProviderKey('openrouter'),
  isActive: () => isActiveProvider('openrouter'),
  render: renderOpenRouterCard,
});

/* ---------- Selora: карточка баланса и окон на главной ---------- */

function renderSeloraCard(data) {
  const $card = $id('selora-card');
  if (!$card) return;
  $card.hidden = false;
  const $err = $id('selora-error');
  if ($err) $err.hidden = true;

  const balance = $id('selora-balance');
  if (balance) balance.textContent = fmtUsd((data.wallet || {}).balance_usd);

  const plan = $id('selora-plan');
  const planLabel = data.plan ? String(data.plan).trim() : '';
  if (plan) {
    plan.textContent = planLabel ? planLabel.toUpperCase() : '';
    plan.hidden = !planLabel;
  }

  // Окна: сессия (short) и неделя (long) — формат как в главной ленте
  const list = Array.isArray(data.windows) ? data.windows : [];
  const byKind = Object.fromEntries(list.map(w => [w.kind, w]));
  renderSeloraWindow(byKind.short, 'selora-session');
  renderSeloraWindow(byKind.long, 'selora-week');
}

const loadSeloraCard = createWalletCard({
  id: 'selora',
  name: 'Selora',
  cardId: 'selora-card',
  errorId: 'selora-error',
  errorPrefix: 'Не удалось получить статистику',
  hasKey: () => hasProviderKey('selora'),
  isActive: () => isActiveProvider('selora'),
  render: renderSeloraCard,
});

function renderSeloraWindow(w, prefix) {
  const $value = $id(prefix + '-value');
  if (!$value) return;
  if (!w) {
    $value.closest('.stat').hidden = true;
    return;
  }
  const $stat = $value.closest('.stat');
  $stat.hidden = false;

  const meta = $id(prefix + '-dur');
  if (meta) meta.textContent = dur(w.window_sec);

  $value.replaceChildren(
    span('val-used', fmtUsd(w.spent_usd)),
    GAP(),
    span('val-sep', '/'),
    GAP(),
    span('val-limit', w.cap_usd ? fmtUsd(w.cap_usd) : '∞')
  );

  const p = w.cap_usd ? pct(w.spent_usd, w.cap_usd) : 0;

  const pctEl = $id(prefix + '-pct');
  if (pctEl) pctEl.textContent = w.cap_usd ? Math.round(p) + '%' : 'без лимита';

  // Прогресс-бар — как в окнах xKiro (warn/danger по порогам)
  const bar = $id(prefix + '-bar');
  const progress = $id(prefix + '-progress');
  if (bar) {
    bar.style.width = p + '%';
    bar.classList.remove('warn', 'danger');
    const cls = barClass(p);
    if (cls) bar.classList.add(cls);
  }
  if (progress) {
    progress.setAttribute('aria-valuenow', String(Math.round(p)));
    progress.setAttribute(
      'aria-valuetext',
      w.cap_usd
        ? `${fmtUsd(w.spent_usd)} из ${fmtUsd(w.cap_usd)}`
        : `${fmtUsd(w.spent_usd)} без лимита`
    );
  }

  const reset = $id(prefix + '-reset');
  if (reset) {
    reset.textContent = (w.resets_in_sec || 0) > 0 ? dur(w.resets_in_sec) : 'обновляется…';
  }
}

/* ---------- index: первые модели Combo ---------- */
async function loadIndexComboFirst() {
  const $sec = $id('index-combo');
  const $list = $id('index-combo-list');
  const $st = $id('index-combo-status');
  const $count = $id('index-combo-count');
  if (!$sec || !$list) return;
  if ($st) {
    $st.className = 'index-combo-status is-loading';
    $st.textContent = 'Загружаю маршруты…';
  }
  $sec.hidden = false;
  try {
    const combos = await loadComboList();
    if ($count) {
      $count.textContent = String(combos.length);
      $count.hidden = false;
    }
    if (!combos.length) {
      if ($st) {
        $st.className = 'index-combo-status is-empty';
        $st.textContent =
          'Маршрутов пока нет. Создайте первый маршрут, чтобы выбрать порядок моделей.';
      }
      $list.replaceChildren();
      return;
    }
    if ($st) {
      $st.textContent = '';
      $st.className = 'index-combo-status';
    }
    $list.replaceChildren();
    // Для каждого combo показываем первую модель, которая примет запрос.
    for (const c of combos) {
      const first = comboTargets(c)[0] || null;
      const row = document.createElement('article');
      row.className = 'index-combo-row';
      const name = document.createElement('h3');
      name.className = 'index-combo-name';
      name.textContent = c.name || c.id;
      const model = document.createElement('code');
      model.className = 'combo-model-id index-combo-model';
      model.textContent = first ? first.display : 'Модель не выбрана';
      if (!first) row.classList.add('is-unconfigured');
      row.append(name, model);
      $list.appendChild(row);
    }
  } catch {
    if ($st) {
      $st.className = 'index-combo-status is-error';
      $st.textContent =
        'Не удалось загрузить маршруты. Откройте настройки маршрутов и проверьте подключение.';
    }
  }
}

/* ---------- init & события ---------- */

export async function init() {
  renderProviderLabel();
  initStatsProviderSelect();
  renderAgentRouterRelease();
  // Экран «Нужен ключ» — только если ключей нет ни у одного провайдера:
  // иначе селектор провайдера скрыт вместе с карточками и не переключиться
  const hasAnyKey =
    Boolean(keyForProvider(session.activeProvider.id)) ||
    session.activeProvider.hasKey ||
    session.providers.some(p => keyForProvider(p.id) || p.hasKey);
  if (!hasAnyKey) {
    $cards.hidden = true;
    $setup.hidden = false;
    setStatus('idle', 'Нужен ключ');
    loadAntigravityQuota();
    loadAgentRouterCard();
    loadOpenRouterCard();
    loadSeloraCard();
    loadExperientialCard();
    loadIndexComboFirst();
    return;
  }

  $setup.hidden = true;
  // Полосу статистики показываем сразу (селектор провайдера должен быть
  // доступен и когда загрузка упала — например, у активного нет ключа)
  $cards.hidden = false;
  // Страница не ждёт провайдеров: карточка помечается «загружается» и
  // догружается сама (P3-1) — иначе самый медленный ответ держал весь
  // экран в is-booting на 20–30 секунд.
  $cards.classList.add('is-loading');
  void Promise.resolve()
    .then(loadUsage)
    .finally(() => $cards.classList.remove('is-loading'));
  loadAntigravityQuota();
  loadAgentRouterCard();
  loadOpenRouterCard();
  loadSeloraCard();
  loadExperientialCard();
  loadIndexComboFirst();
}

// Обновление всех блоков главной
function refreshAll() {
  loadUsage();
  loadAntigravityQuota();
  loadAgentRouterCard();
  loadOpenRouterCard();
  loadSeloraCard();
  loadExperientialCard();
  renderAgentRouterRelease();
}

// Кнопка «Обновить» создаётся при инъекции topbar (на eval модуля
// её ещё нет), поэтому клик ловим делегированием
document.addEventListener('click', e => {
  if (e.target instanceof Element && e.target.closest('#btn-refresh')) refreshAll();
});

// Обновление при возврате на вкладку — не чаще раза в минуту и не
// поверх уже идущей загрузки: иначе быстрые переключения вкладок
// давали до семи запросов к провайдерам подряд (P3-3)
const FOCUS_REFRESH_MIN_MS = 60000;
let lastFocusRefresh = 0;
let refreshInFlight = false;

function refreshOnFocus() {
  if (refreshInFlight) return;
  const now = Date.now();
  if (now - lastFocusRefresh < FOCUS_REFRESH_MIN_MS) return;
  lastFocusRefresh = now;
  refreshInFlight = true;
  // refreshAll не возвращает промис — ждём паузу кадра, чтобы новые
  // вызовы не наложились на текущий веер запросов
  setTimeout(() => {
    refreshInFlight = false;
  }, 0);
  refreshAll();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshOnFocus();
});

// Тикер обратных отсчётов: окна расхода, квоты Antigravity и таймер
// пула AgentRouter показывают время до сброса — раз в минуту (P3-3)
setInterval(() => {
  tickWindow('short');
  tickWindow('long');
  tickFree();
  tickAntigravity();
  renderAgentRouterRelease();
}, 60000);

// После привязки Google в диалоге настроек — перезагрузить квоты
// (возвращаем результат: диалог показывает его в статусной строке)
onEvent('antigravity:authorized', () => loadAntigravityQuota());

// Настройки изменились (включая расписание и флаг уведомлений) — перепланируем
onEvent('settings:changed', () => renderAgentRouterRelease());

start();
