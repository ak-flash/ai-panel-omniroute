/* ============================================================
   AI Panel — карточка квот Antigravity (модели Google AI Pro).

   Вынесена из pages/index.js: своё состояние (квоты и email),
   своя загрузка и своя отрисовка групп моделей (P2-2).
   Страница вызывает loadAntigravityQuota(), getQuota() и tick().
   ============================================================ */

import { $id, setIcon } from '../dom.js';
import { fetchAntigravityQuota, AG_ERROR_MESSAGES } from '../api.js';
import { dur } from '../formatters.js';

const $section = $id('antigravity-quota');
const $cards = $id('ag-cards');
const $hint = $id('ag-hint');
const $badge = $id('ag-status-badge');
const $email = $id('ag-account-email');

let quota = null; // последние квоты или { error }
let accountEmail = ''; // email аккаунта Google (с сервера, после входа)

/** Последний ответ квот — нужен странице для порогов уведомлений. */
export function getQuota() {
  return quota;
}
export async function loadAntigravityQuota() {
  if (!$section) return null;
  try {
    // Токен-эндпоинт — после квот: сервер в этот момент может успеть
    // восстановить email (backfill из Google userinfo после перезапуска)
    const [res, token] = await Promise.all([fetchAntigravityQuota(), fetchGoogleTokenStatusSafe()]);
    accountEmail = (token && token.email) || '';
    if (!res.ok) {
      quota = { error: res.data.error || 'provider_error' };
    } else {
      quota = res.data;
    }
  } catch {
    quota = { error: 'network' };
  }
  renderQuota();
  return quota;
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
    setIcon(meta, 'star', { class: 'ag-thinking-icon' });
    head.appendChild(meta);
  }
  main.appendChild(head);

  // Компактный прогресс остатка: полный и зелёный, при использовании
  // убывает и меняет цвет (remainingFraction → ширина).
  const rem = model.remainingFraction;

  // Проценты — сразу у прогресс-бара
  const barRow = document.createElement('div');
  barRow.className = 'ag-bar-row';

  const hasRem = Number.isFinite(rem);
  const exhausted = hasRem && rem <= 0;

  // Сколько осталось до восстановления квоты модели
  const remainSec = model.resetTime
    ? Math.floor((new Date(model.resetTime) - Date.now()) / 1000)
    : null;
  const resetText = remainSec !== null && remainSec > 0 ? dur(remainSec) : 'обновляется…';

  const bar = document.createElement('div');
  bar.className = 'bar-track ag-bar' + (exhausted ? ' exhausted' : '');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', `Остаток квоты ${model.name || model.id || ''}`.trim());
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  if (exhausted) {
    fill.style.width = '0%';
    bar.setAttribute('aria-valuenow', '0');
    bar.setAttribute('aria-valuetext', 'Квота истрачена');
  } else if (hasRem) {
    const remainingPct = Math.round(Math.min(100, Math.max(0, rem * 100)));
    fill.style.width = remainingPct + '%';
    bar.setAttribute('aria-valuenow', String(remainingPct));
    bar.setAttribute('aria-valuetext', `Осталось ${remainingPct}%`);
    const cls = agRemClass(rem);
    if (cls) fill.classList.add(cls);
  } else {
    // Нет данных от Google — трактуем как 0%, но без красного акцента
    fill.style.width = '0%';
    bar.setAttribute('aria-valuenow', '0');
    bar.setAttribute('aria-valuetext', 'Нет данных');
  }
  bar.appendChild(fill);
  barRow.appendChild(bar);

  const pctLabel = document.createElement('span');
  pctLabel.className = 'ag-pct' + (exhausted ? ' exhausted' : '');
  pctLabel.textContent = exhausted ? 'истрачено' : Math.round((hasRem ? rem : 0) * 100) + '%';
  barRow.appendChild(pctLabel);

  main.appendChild(barRow);

  // Когда квота кончилась или почти кончилась — время восстановления
  // прямо в карточке (группа при этом может быть свёрнута)
  if (remainSec !== null && (exhausted || rem < 0.25)) {
    const resetLine = document.createElement('div');
    resetLine.className = 'ag-card-reset' + (exhausted ? ' exhausted' : '');
    resetLine.appendChild(document.createTextNode('Сброс: '));
    const resetVal = document.createElement('span');
    resetVal.textContent = resetText;
    if (model.resetTime) resetVal.dataset.reset = String(new Date(model.resetTime).getTime());
    if (exhausted)
      resetVal.setAttribute('aria-label', 'Квота истрачена, восстановление через ' + resetText);
    resetLine.appendChild(resetVal);
    main.appendChild(resetLine);
  }

  card.appendChild(main);
  return card;
}

// Порядок и состояние свёрнутости групп моделей Antigravity
const AG_GROUPS = [
  { key: 'claude', label: 'Claude', collapsed: true },
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
  const firstReset = models.find(m => m.resetTime);
  if (firstReset) {
    const reset = document.createElement('span');
    reset.className = 'ag-group-reset';
    const remainSec = Math.floor((new Date(firstReset.resetTime) - Date.now()) / 1000);
    reset.appendChild(document.createTextNode('Сброс: '));
    const resetVal = document.createElement('span');
    resetVal.textContent = dur(remainSec);
    resetVal.dataset.reset = String(new Date(firstReset.resetTime).getTime());
    reset.appendChild(resetVal);
    head.appendChild(reset);
  }
  if (group.key === 'claude') {
    const remaining = models.map(m => m.remainingFraction).filter(Number.isFinite);
    if (remaining.length) {
      const min = Math.min(...remaining);
      const percent = document.createElement('span');
      percent.className = 'ag-group-remaining' + (min >= 1 ? ' full' : '');
      percent.textContent = Math.round(min * 100) + '%';
      percent.title = 'Минимальный остаток квоты среди моделей Claude';
      head.appendChild(percent);
    }
  }
  const chev = document.createElement('span');
  chev.className = 'ag-chevron';
  chev.setAttribute('aria-hidden', 'true');
  setIcon(chev, 'chevron-down');
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

/** Обновляет только текст «Сброс: …» в квотах Antigravity, не перестраивая
 *  дерево (иначе тикер каждую минуту сворачивал бы раскрытые группы). */
export function tick() {
  if (!$cards) return;
  for (const el of $cards.querySelectorAll('[data-reset]')) {
    const at = Number(el.dataset.reset);
    if (!Number.isFinite(at)) continue;
    const remainSec = Math.floor((at - Date.now()) / 1000);
    const text = remainSec > 0 ? dur(remainSec) : 'обновляется…';
    if (el.textContent !== text) el.textContent = text;
  }
}

function renderQuota() {
  if (!$section) return;
  const q = quota;
  $cards.replaceChildren();
  $hint.hidden = true;
  if ($badge) $badge.textContent = '';

  // Email аккаунта — приходит с сервера после входа через Google
  if ($email) {
    const email = accountEmail || '';
    if (email) {
      $email.textContent = email;
      $email.hidden = false;
    } else $email.hidden = true;
  }

  if (!q) {
    $section.hidden = true;
    return;
  }
  $section.hidden = false;

  if (q.error) {
    if (q.error === 'no_token') {
      $section.hidden = true;
      return;
    }
    $hint.textContent = AG_ERROR_MESSAGES[q.error] || 'Ошибка загрузки квот.';
    $hint.hidden = false;
    if ($badge) $badge.textContent = 'нет данных';
    return;
  }

  const models = Array.isArray(q.models) ? q.models : [];

  if (!models.length) {
    $hint.textContent = 'Google не вернул данные по моделям.';
    $hint.hidden = false;
    return;
  }

  const grouped = {};
  for (const m of models) (grouped[agGroupOf(m)] ||= []).push(m);

  for (const g of AG_GROUPS) {
    const list = grouped[g.key];
    if (!list || !list.length) continue;
    $cards.appendChild(agGroupContainer(g, list));
  }
}
