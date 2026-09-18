/* ============================================================
   AI Panel — страница «Статистика»: карточка провайдера с окнами
   расхода, баланс AgentRouter, квоты Antigravity (Google AI Pro)
   и первые модели маршрутов.
   ============================================================ */

import { session, PROVIDER_FALLBACK } from '../session.js';
import { $id } from '../dom.js';
import { icon } from '../../icons.js';
import { setStatus, touchUpdated } from '../topbar.js';
import { showBanner, hideBanner } from '../banner.js';
import { providerRequest, fetchAntigravityQuota, AG_ERROR_MESSAGES, omniFetch, COMBO_LIST_PATH, COMBO_PATH } from '../api.js';
import { keyForProvider, getAgentRouterKey, getOpenRouterKey, vaultGet } from '../settings.js';
import { onEvent } from '../events.js';
import { start } from '../boot.js';
import { fmtUsd, compact, dur, num, pct, barClass, nextReleaseUtc, clockTime } from '../formatters.js';
import { extractComboTargets, combosFromResponse } from '../combos.js';
import { showToast } from '../toast.js';
import { evaluateAll } from '../notifications.js';

// Статичные элементы страницы — доступны на момент eval модуля
const $cards = $id('cards');
const $statsProvider = $id('stats-provider');
const $setup = $id('setup');
const $planBadge = $id('plan-badge');
const $walletBalance = $id('wallet-balance');
const $walletHeld = $id('wallet-held');
const $shortCard = $id('card-short');
const $longCard = $id('card-long');
const $freeCard = $id('card-free');
const $live = $id('live');
const $agSection = $id('antigravity-quota');
const $agCards = $id('ag-cards');
const $agHint = $id('ag-hint');
const $agBadge = $id('ag-status-badge');
const $agEmail = $id('ag-account-email');

// Состояние страницы (локальное)
let usage = null;
let fetchedAt = null;
let deadlineShort = null;
let deadlineLong = null;
let deadlineFree = null;
let antigravityQuota = null; // квоты Antigravity (модели Google AI Pro)
let antigravityEmail = '';   // email аккаунта Google (из сервера, после входа)
let agentRouterUsage = null; // последний ответ /api/providers/agentrouter/usage (для порогов)

// Множество id уведомлений, уже показанных в этой сессии — чтобы
// один и тот же тост не появлялся после каждой кнопки «Обновить».
// Дропается при перезагрузке страницы (сессия = текущий запуск).
const notified = new Set();

function readThresholds() {
  try {
    const raw = vaultGet('notificationThresholds', '');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function checkNotifications() {
  const thresholds = readThresholds();
  if (!thresholds) return;
  const data = {
    xkiro: usage,
    agentrouter: agentRouterUsage,
    antigravity: antigravityQuota,
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
  document.getElementById(kind + '-pct').textContent =
    w.cap_usd ? Math.round(p) + '%' : '';

  card.querySelector('.stat-meta').textContent = dur(w.window_sec);
  card.querySelector('.stat-value').innerHTML =
    `<span class="val-used">${fmtUsd(w.spent_usd)}</span>` +
    ` <span class="val-sep">/</span> ` +
    `<span class="val-limit">${fmtUsd(w.cap_usd)}</span>`;

  const bar = card.querySelector('.bar-fill');
  const progress = card.querySelector('[role="progressbar"]');
  bar.style.width = p + '%';
  if (progress) {
    progress.setAttribute('aria-valuenow', String(Math.round(p)));
    progress.setAttribute(
      'aria-valuetext',
      `${fmtUsd(w.spent_usd)} из ${fmtUsd(w.cap_usd)}`,
    );
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
  document.getElementById('free-pct').textContent =
    limit != null ? Math.round(usedPct) + '%' : '';
  document.getElementById('free-value').innerHTML =
    limit == null
      ? `<span class="val-used">${compact(used)}</span>`
      : `<span class="val-used">${compact(used)}</span>` +
        ` <span class="val-sep">/</span> ` +
        `<span class="val-limit">${compact(limit)}</span>`;

  const bar = $freeCard.querySelector('.bar-fill');
  const progress = $freeCard.querySelector('[role="progressbar"]');
  bar.style.width = usedPct + '%';
  if (progress) {
    progress.setAttribute('aria-valuenow', String(Math.round(usedPct)));
    progress.setAttribute(
      'aria-valuetext',
      limit == null ? `${compact(used)} использовано` : `${compact(used)} из ${compact(limit)}`,
    );
  }
  bar.classList.remove('warn', 'danger');
  const cls = barClass(usedPct);
  if (cls) bar.classList.add(cls);

  deadlineFree = fetchedAt + (free.resets_in_sec || 0) * 1000;
  if (!free.resets_in_sec) {
    const now = new Date();
    deadlineFree = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
  }
  tickFree();
}

function renderUsage(data) {
  usage = data;
  fetchedAt = Date.now();

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
  windowShort = byKind.short || null;
  windowLong = byKind.long || null;
  setWindow('short', $shortCard);
  setWindow('long', $longCard);

  renderFreeTokens(data.free_tokens);

  setStatus('ok', '');
  touchUpdated();

  if ($live) {
    $live.textContent =
      'Баланс ' + fmtUsd(wallet.balance_usd) +
      ', план ' + (data.plan || 'PAYG');
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
async function loadAgentRouterCard() {
  const $card = $id('ar-card');
  if (!$card) return;
  const hasKey =
    Boolean(getAgentRouterKey()) ||
    session.providers.some((p) => p.id === 'agentrouter' && p.hasKey);
  if (!hasKey || session.activeProvider.id === 'agentrouter') {
    $card.hidden = true;
    renderAgentRouterRelease();
    return;
  }
  try {
    const data = await providerRequest('usage', {
      provider: { id: 'agentrouter', name: 'AgentRouter' },
    });
    agentRouterUsage = data;
    renderAgentRouterCard(data);
    checkNotifications();
  } catch (err) {
    $card.hidden = false;
    const $err = $id('ar-error');
    if ($err) {
      $err.hidden = false;
      $err.textContent =
        'Не удалось получить баланс — ' +
        (err && err.message ? err.message : String(err));
    }
  }
  // Видимость карточки окончательная — обновить строку с высвобождением
  renderAgentRouterRelease();
}

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
    todayEl.textContent = today !== null ? fmtUsd(today) : '—';
    if (today !== null) {
      todayEl.classList.toggle('val-used', today > 0);
    }
  }
}

/* ---------- AgentRouter: таймер высвобождения пула (Claude/GPT) ---------- */

// График приходит вместе с /api/config (vault) объектом
// { timezone, hoursUtc } — часы графика в UTC, якорь — Пекин.
let arReleaseHours = null; // ближайший график: непустой массив часов UTC
let arReleaseTz = '';      // якорный часовой пояс графика (для подписи)

function readAgentRouterReleases() {
  // Приоритет — локальная настройка из хранилища (свежее после сохранения,
  // даже если vaultCache ещё хранит старый agentrouterReleases с сервера)
  const raw = vaultGet('agentrouterReleaseHoursUtc');
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'hide') {
    arReleaseHours = null;
    arReleaseTz = '';
    return false;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const seen = new Set();
    for (const p of raw.split(',')) {
      const t = p.trim();
      if (!t) continue;
      const h = Number(t);
      if (Number.isInteger(h) && h >= 0 && h <= 23) seen.add(h);
    }
    if (seen.size) {
      arReleaseHours = [...seen].sort((a, b) => a - b);
      arReleaseTz = 'Asia/Shanghai';
      return true;
    }
  }
  const cfg = vaultGet('agentrouterReleases');
  const hours = cfg && Array.isArray(cfg.hoursUtc)
    ? cfg.hoursUtc.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    : [];
  arReleaseHours = hours.length ? hours : null;
  arReleaseTz = cfg && typeof cfg.timezone === 'string' ? cfg.timezone : '';
  return arReleaseHours !== null;
}

// Считает ближайшее высвобождение пула, показывает обратный отсчёт и
// локальное время (часовой пояс браузера). Дублируется в двух местах:
// карточка в полосе статистики (когда AgentRouter — активный провайдер)
// и строка в wallet-карточке AgentRouter (когда активен другой провайдер).
function renderAgentRouterRelease() {
  if (!readAgentRouterReleases()) { clearAgentRouterReleaseTimer(); return; }
  const ts = nextReleaseUtc(arReleaseHours, Date.now());
  if (ts === null) { clearAgentRouterReleaseTimer(); return; }

  // Отсчёт только до минут (с округлением вверх — никогда не «0 с»),
  // а секунды не нужны: таймер живёт от обновления страницы
  const remainMin = Math.max(1, Math.ceil((ts - Date.now()) / 60000));
  const countdown = dur(remainMin * 60);
  const localAt = clockTime(ts);

  // Расписание дня в локальном времени: для каждого часа UTC берём его
  // таймстамп сегодня и форматируем в часовом поясе браузера
  const d = new Date();
  const schedule = arReleaseHours.map((h) =>
    clockTime(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h)),
  );

  const isArActive = session.activeProvider.id === 'agentrouter';

  // Карточка в полосе статистики (AgentRouter активен)
  const $main = $id('card-ar-release');
  if ($main) {
    $main.hidden = !isArActive;
    if (isArActive) {
      $id('ar-release-value').textContent = countdown;
      $id('ar-release-sub').textContent =
        'в ' + localAt + ' · расписание: ' + schedule.join(', ');
    }
  }

  // Строка в wallet-карточке AgentRouter (когда активен другой провайдер)
  const $arCard = $id('ar-card');
  const $line = $id('ar-release');
  if ($line && $arCard && !$arCard.hidden && !isArActive) {
    $line.hidden = false;
    $id('ar-release-countdown').textContent = countdown;
    $id('ar-release-at').textContent =
      'в ' + localAt + ' · ' +
      (arReleaseTz ? arReleaseTz + ' · ' : '') +
      'локально ' + schedule.join(', ');
  } else if ($line) {
    $line.hidden = true;
  }
  scheduleAgentRouterReleaseNotify();
}

/* ---------- AgentRouter: браузерные уведомления о сбросе пула ---------- */

let arReleaseTimer = null;

function isAgentRouterReleaseNotifyEnabled() {
  const t = readThresholds();
  return Boolean(t && t.agentrouter && t.agentrouter.notify_on_release);
}

function clearAgentRouterReleaseTimer() {
  if (arReleaseTimer) {
    clearTimeout(arReleaseTimer);
    arReleaseTimer = null;
  }
}

function fireAgentRouterRelease() {
  const scheduleLabel = arReleaseHours ? arReleaseHours.map((h) => String(h).padStart(2, '0') + ':00 UTC').join(' / ') : '';
  const msg = 'Пул AgentRouter сброшен — лимиты обновлены' + (scheduleLabel ? ' (' + scheduleLabel + ')' : '');
  showToast(msg, { type: 'ok', timeout: 8000 });
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('AgentRouter — сброс пула', {
        body: 'Окна 10:00 / 19:00 по Пекину — лимиты обнулены',
        icon: '/favicon.svg',
        tag: 'agentrouter-release',
      });
    } catch {}
  }
  scheduleAgentRouterReleaseNotify();
  renderAgentRouterRelease();
}

function scheduleAgentRouterReleaseNotify() {
  clearAgentRouterReleaseTimer();
  if (!isAgentRouterReleaseNotifyEnabled()) return;
  if (!readAgentRouterReleases()) return;
  const ts = nextReleaseUtc(arReleaseHours, Date.now());
  if (ts == null) return;
  const delay = ts - Date.now();
  if (delay < 0 || delay > 2147483647) return;
  arReleaseTimer = setTimeout(fireAgentRouterRelease, Math.max(0, delay));
}

/* ---------- OpenRouter: карточка баланса на главной ---------- */

async function loadOpenRouterCard() {
  const $card = $id('or-card');
  if (!$card) return;
  const hasKey =
    Boolean(getOpenRouterKey()) ||
    session.providers.some((p) => p.id === 'openrouter' && p.hasKey);
  if (!hasKey || session.activeProvider.id === 'openrouter') {
    $card.hidden = true;
    return;
  }
  try {
    const data = await providerRequest('usage', {
      provider: { id: 'openrouter', name: 'OpenRouter' },
    });
    renderOpenRouterCard(data);
  } catch (err) {
    $card.hidden = false;
    const $err = $id('or-error');
    if ($err) {
      $err.hidden = false;
      $err.textContent =
        'Не удалось получить баланс — ' +
        (err && err.message ? err.message : String(err));
    }
  }
}

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

/* ---------- Antigravity: квоты Google AI Pro ---------- */

async function loadAntigravityQuota() {
  if (!$agSection) return null;
  try {
    // Токен-эндпоинт — после квот: сервер в этот момент может успеть
    // восстановить email (backfill из Google userinfo после перезапуска)
    const [quota, token] = await Promise.all([
      fetchAntigravityQuota(),
      fetchGoogleTokenStatusSafe(),
    ]);
    antigravityEmail = (token && token.email) || '';
    if (!quota.ok) {
      antigravityQuota = { error: quota.data.error || 'provider_error' };
    } else {
      antigravityQuota = quota.data;
    }
  } catch {
    antigravityQuota = { error: 'network' };
  }
  renderAntigravityQuota();
  checkNotifications();
  return antigravityQuota;
}

async function fetchGoogleTokenStatusSafe() {
  try {
    const res = await fetch('/api/settings/google-token');
    return await res.json();
  } catch {
    return null;
  }
}

// Цвет прогресса остатка: зелёный → жёлтый → красный при снижении остатка
function agRemClass(rem) {
  if (rem >= 0.5) return '';
  if (rem >= 0.25) return 'warn';
  return 'danger';
}

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
    meta.innerHTML = icon('star', { class: 'ag-thinking-icon' });
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
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `Остаток квоты ${model.name || model.id || ''}`.trim());
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  if (Number.isFinite(rem)) {
    const remainingPct = Math.round(Math.min(100, Math.max(0, rem * 100)));
    fill.style.width = remainingPct + '%';
    bar.setAttribute('aria-valuenow', String(remainingPct));
    bar.setAttribute('aria-valuetext', `Осталось ${remainingPct}%`);
    const cls = agRemClass(rem);
    if (cls) fill.classList.add(cls);
  } else {
    fill.style.width = '0%';
    bar.setAttribute('aria-valuetext', 'Нет данных');
  }
  bar.appendChild(fill);
  barRow.appendChild(bar);

  const pctLabel = document.createElement('span');
  pctLabel.className = 'ag-pct';
  pctLabel.textContent = Number.isFinite(rem)
    ? Math.round(rem * 100) + '%'
    : '—';
  barRow.appendChild(pctLabel);

  main.appendChild(barRow);
  card.appendChild(main);
  return card;
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
  chev.innerHTML = icon('chevron-down');
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
  const q = antigravityQuota;
  $agCards.replaceChildren();
  $agHint.hidden = true;
  if ($agBadge) $agBadge.textContent = '';

  // Email аккаунта — приходит с сервера после входа через Google
  if ($agEmail) {
    const email = antigravityEmail || '';
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

/* ---------- index: первые модели Combo ---------- */
async function loadIndexComboFirst() {
  const $sec = $id('index-combo'), $list = $id('index-combo-list'), $st = $id('index-combo-status');
  if (!$sec || !$list) return;
  if ($st) $st.textContent = 'Загружаю маршруты…';
  $sec.hidden = false;
  try {
    const data = await omniFetch(COMBO_LIST_PATH);
    const combos = combosFromResponse(data);
    if (!combos.length) { if ($st) $st.textContent = 'Маршруты не найдены.'; $list.replaceChildren(); return; }
    if ($st) $st.textContent = '';
    $list.replaceChildren();
    // для каждого combo берём первую модель: если поле models есть в списке — используем его, иначе догружаем детали
    for (const c of combos) {
      let first = null;
      let targets = extractComboTargets(c);
      if (!targets.length) {
        try { const detail = await omniFetch(COMBO_PATH(c.id)); targets = extractComboTargets(detail); } catch { /* нет деталей */ }
      }
      first = targets[0] || null;
      const li = document.createElement('div');
      li.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)';
      const name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;min-width:110px';
      name.textContent = c.name || c.id;
      const model = document.createElement('code');
      model.className = 'combo-model-id';
      model.style.cssText = 'font-size:13px;flex:1;overflow-wrap:anywhere';
      model.textContent = first ? first.display : '— нет моделей';
      const badge = document.createElement('span');
      badge.className = 'badge top';
      badge.textContent = 'первая';
      if (!first) badge.hidden = true;
      li.append(name, model, badge);
      $list.appendChild(li);
    }
    // убрать бордер у последнего
    if ($list.lastElementChild) $list.lastElementChild.style.borderBottom = 'none';
  } catch (err) {
    if ($st) $st.textContent = 'Не удалось загрузить маршруты: ' + (err.message || err);
  }
}

/* ---------- init & события ---------- */

export async function init() {
  renderProviderLabel();
  renderAgentRouterRelease();
  // Экран «Нужен ключ» — только если ключей нет ни у одного провайдера:
  // иначе селектор провайдера скрыт вместе с карточками и не переключиться
  const hasAnyKey =
    Boolean(keyForProvider(session.activeProvider.id)) ||
    session.activeProvider.hasKey ||
    session.providers.some((p) => keyForProvider(p.id) || p.hasKey);
  if (!hasAnyKey) {
    $cards.hidden = true;
    $setup.hidden = false;
    setStatus('idle', 'Нужен ключ');
    loadAntigravityQuota();
    loadAgentRouterCard();
    loadOpenRouterCard();
    loadIndexComboFirst();
    return;
  }

  $setup.hidden = true;
  // Полосу статистики показываем сразу (селектор провайдера должен быть
  // доступен и когда загрузка упала — например, у активного нет ключа)
  $cards.hidden = false;
  await loadUsage();
  loadAntigravityQuota();
  loadAgentRouterCard();
  loadOpenRouterCard();
  loadIndexComboFirst();
}

// Обновление всех блоков главной
function refreshAll() {
  loadUsage();
  loadAntigravityQuota();
  loadAgentRouterCard();
  loadOpenRouterCard();
  renderAgentRouterRelease();
}

// Кнопка «Обновить» создаётся при инъекции topbar (на eval модуля
// её ещё нет), поэтому клик ловим делегированием
document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('#btn-refresh')) refreshAll();
});

// Обновление при возврате на вкладку
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAll();
});

// После привязки Google в диалоге настроек — перезагрузить квоты
// (возвращаем результат: диалог показывает его в статусной строке)
onEvent('antigravity:authorized', () => loadAntigravityQuota());

// Настройки изменились (включая расписание и флаг уведомлений) — перепланируем
onEvent('settings:changed', () => renderAgentRouterRelease());

start();
