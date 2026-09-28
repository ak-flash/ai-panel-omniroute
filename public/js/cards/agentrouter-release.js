/* ============================================================
   AI Panel — таймер высвобождения пула AgentRouter.

   Расписание задаёт пользователь (agentrouterReleaseHoursUtc, часы
   UTC); модуль считает ближайший сброс, рисует обратный отсчёт в двух
   местах (карточка полосы статистики и строка в карточке баланса) и
   планирует браузерное уведомление. Вынесен из pages/index.js (P2-2).
   ============================================================ */

import { $id } from '../dom.js';
import { vaultGet, vaultGetJson } from '../settings.js';
import { session } from '../session.js';
import { dur, nextReleaseUtc, clockTime } from '../formatters.js';
import { showToast } from '../toast.js';

// График приходит вместе с /api/config (vault) объектом
// { timezone, hoursUtc } — часы графика в UTC, якорь — Пекин.
let arReleaseHours = null; // ближайший график: непустой массив часов UTC
let arReleaseTz = ''; // якорный часовой пояс графика (для подписи)

function readAgentRouterReleases() {
  // Отображение счётчика полностью определяется локальной настройкой
  // agentrouterReleaseHoursUtc: пусто = не задано → блок скрыт (дефолт
  // с сервера в agentrouterReleases для счётчика не показываем).
  const raw = vaultGet('agentrouterReleaseHoursUtc');
  if (typeof raw !== 'string' || !raw.trim()) {
    arReleaseHours = null;
    arReleaseTz = '';
    return false;
  }
  const seen = new Set();
  for (const p of raw.split(',')) {
    const t = p.trim();
    if (!t) continue;
    const h = Number(t);
    if (Number.isInteger(h) && h >= 0 && h <= 23) seen.add(h);
  }
  if (!seen.size) {
    arReleaseHours = null;
    arReleaseTz = '';
    return false;
  }
  arReleaseHours = [...seen].sort((a, b) => a - b);
  arReleaseTz = 'Asia/Shanghai';
  return true;
}

// Считает ближайшее высвобождение пула, показывает обратный отсчёт и
// локальное время (часовой пояс браузера). Дублируется в двух местах:
// карточка в полосе статистики (когда AgentRouter — активный провайдер)
// и строка в wallet-карточке AgentRouter (когда активен другой провайдер).
function hideAgentRouterReleaseElements() {
  const $main = $id('card-ar-release');
  if ($main) $main.hidden = true;
  const $line = $id('ar-release');
  if ($line) $line.hidden = true;
}
export function renderRelease() {
  if (!readAgentRouterReleases()) {
    clearAgentRouterReleaseTimer();
    hideAgentRouterReleaseElements();
    return;
  }
  const ts = nextReleaseUtc(arReleaseHours, Date.now());
  if (ts === null) {
    clearAgentRouterReleaseTimer();
    hideAgentRouterReleaseElements();
    return;
  }

  // Отсчёт только до минут (с округлением вверх — никогда не «0 с»),
  // а секунды не нужны: таймер живёт от обновления страницы
  const remainMin = Math.max(1, Math.ceil((ts - Date.now()) / 60000));
  const countdown = dur(remainMin * 60);
  const localAt = clockTime(ts);

  // Расписание дня в локальном времени: для каждого часа UTC берём его
  // таймстамп сегодня и форматируем в часовом поясе браузера
  const d = new Date();
  const schedule = arReleaseHours.map(h =>
    clockTime(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h))
  );

  const isArActive = session.activeProvider.id === 'agentrouter';

  // Карточка в полосе статистики (AgentRouter активен)
  const $main = $id('card-ar-release');
  if ($main) {
    $main.hidden = !isArActive;
    if (isArActive) {
      $id('ar-release-value').textContent = countdown;
      $id('ar-release-sub').textContent = 'в ' + localAt + ' · расписание: ' + schedule.join(', ');
    }
  }

  // Строка в wallet-карточке AgentRouter (когда активен другой провайдер)
  const $arCard = $id('ar-card');
  const $line = $id('ar-release');
  if ($line && $arCard && !$arCard.hidden && !isArActive) {
    $line.hidden = false;
    $id('ar-release-countdown').textContent = countdown;
    $id('ar-release-at').textContent =
      'в ' +
      localAt +
      ' · ' +
      (arReleaseTz ? arReleaseTz + ' · ' : '') +
      'локально ' +
      schedule.join(', ');
  } else if ($line) {
    $line.hidden = true;
  }
  scheduleAgentRouterReleaseNotify();
}

/* ---------- AgentRouter: браузерные уведомления о сбросе пула ---------- */

let arReleaseTimer = null;

function isAgentRouterReleaseNotifyEnabled() {
  const t = vaultGetJson('notificationThresholds');
  return Boolean(t && t.agentrouter && t.agentrouter.notify_on_release);
}

function clearAgentRouterReleaseTimer() {
  if (arReleaseTimer) {
    clearTimeout(arReleaseTimer);
    arReleaseTimer = null;
  }
}

function fireAgentRouterRelease() {
  const scheduleLabel = arReleaseHours
    ? arReleaseHours.map(h => String(h).padStart(2, '0') + ':00 UTC').join(' / ')
    : '';
  const msg =
    'Пул AgentRouter сброшен — лимиты обновлены' +
    (scheduleLabel ? ' (' + scheduleLabel + ')' : '');
  showToast(msg, { type: 'ok', timeout: 8000 });
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('AgentRouter — сброс пула', {
        // Расписание задаёт пользователь — подставляем его, а не 10:00/19:00
        body: scheduleLabel ? 'Окна ' + scheduleLabel + ' — лимиты обнулены' : 'Лимиты обнулены',
        icon: '/favicon.svg',
        tag: 'agentrouter-release',
      });
    } catch {}
  }
  scheduleAgentRouterReleaseNotify();
  renderRelease();
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
