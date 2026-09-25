/* ============================================================
   AI Panel — диалог настроек (общий для всех страниц).

   Настройки разбиты на табы; каждый раздел сохраняется своей
   кнопкой — отдельным батчем PUT /api/config (saveSettings):
   либо весь набор ключей раздела, либо ни один. Сервер мержит
   только переданные ключи, поэтому разделы независимы.
   Секреты write-only: пустое поле секрета означает «не изменять»,
   а после успешной отправки поля очищаются — секреты не остаются
   в DOM.
   ============================================================ */

import { $id, on, ICO_CHECK, ICO_X } from './dom.js';
import { icon } from '../icons.js';
import { vaultGet, vaultSet, setKey, removeKey, getAgentRouterUserId, getAgRefreshToken, getOmniUrls, normalizeOmniUrls, saveSettings } from './settings.js';
import { providerRequest, omniFetch, COMBO_LIST_PATH, fetchGoogleTokenStatus, startGoogleAuth, pasteGoogleAuth, AG_ERROR_MESSAGES } from './api.js';
import { fmtUsd, dur } from './formatters.js';
import { renderAliasRows, collectAliasesFromUI } from './aliases.js';
import { closeTopbar } from './topbar.js';
import { emit } from './events.js';

let $dlg, $dlgKey, $dlgArKey, $dlgOrKey, $dlgSeloraKey, $dlgExperientialKey, $dlgArUser, $dlgArReleases, $dlgToggle, $dlgArToggle, $dlgOrToggle, $dlgSeloraToggle, $dlgExperientialToggle, $dlgRemove;

// Табы диалога: каждый раздел — своя панель и своя кнопка сохранения
const DLG_TABS = [
  { tab: 'dlg-tab-provider', panel: 'dlg-panel-provider', result: 'dlg-result-provider', save: 'dlg-save-provider' },
  { tab: 'dlg-tab-omni', panel: 'dlg-panel-omni', result: 'dlg-result-omni', save: 'dlg-save-omni' },
  { tab: 'dlg-tab-notifications', panel: 'dlg-panel-notifications', result: 'dlg-result-notifications', save: 'dlg-save-notifications' },
  { tab: 'dlg-tab-aliases', panel: 'dlg-panel-aliases', result: 'dlg-result-aliases', save: 'dlg-save-aliases' },
];

// Переключение таба по паттерну ARIA tabs: aria-selected, hidden-панели,
// roving tabindex; выбор запоминается в хранилище как dlgTab
function selectDlgTab(tabId, { focus = false } = {}) {
  const idx = DLG_TABS.findIndex((t) => t.tab === tabId);
  if (idx < 0) return;
  for (let i = 0; i < DLG_TABS.length; i++) {
    const $tab = $id(DLG_TABS[i].tab);
    const $panel = $id(DLG_TABS[i].panel);
    if ($tab) {
      $tab.setAttribute('aria-selected', String(i === idx));
      $tab.tabIndex = i === idx ? 0 : -1;
    }
    if ($panel) $panel.hidden = i !== idx;
  }
  if (focus) {
    const $tab = $id(DLG_TABS[idx].tab);
    if ($tab) $tab.focus();
  }
  if (vaultGet('dlgTab') !== tabId) vaultSet('dlgTab', tabId);
}

// Стрелки/Home/End по таб-бару: выбор раздела + перенос фокуса
function onDlgTabsKeydown(e) {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
  const idx = DLG_TABS.findIndex((t) => document.activeElement && t.tab === document.activeElement.id);
  if (idx < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? DLG_TABS.length - 1
      : (idx + step + DLG_TABS.length) % DLG_TABS.length;
  selectDlgTab(DLG_TABS[next].tab, { focus: true });
}

// Статусная строка раздела (роль status, цвет ok/err)
function showResult($el, isErr, html) {
  if (!$el) return;
  $el.hidden = false;
  $el.className = 'dlg-result ' + (isErr ? 'err' : 'ok');
  $el.innerHTML = html;
}

// Показ/скрытие полей выбранного в настройках провайдера
function renderDlgProviderFields() {
  const $sel = $id('dlg-provider');
  if (!$sel) return;
  const v = $sel.value;
  const $xkiro = $id('dlg-xkiro-fields');
  const $ar = $id('dlg-agentrouter-fields');
  const $or = $id('dlg-openrouter-fields');
  const $selora = $id('dlg-selora-fields');
  const $experiential = $id('dlg-experiential-fields');
  const $ag = $id('dlg-ag-fields');
  if ($xkiro) $xkiro.hidden = v !== 'xkiro';
  if ($ar) $ar.hidden = v !== 'agentrouter';
  if ($or) $or.hidden = v !== 'openrouter';
  if ($selora) $selora.hidden = v !== 'selora';
  if ($experiential) $experiential.hidden = v !== 'experiential';
  if ($ag) $ag.hidden = v !== 'antigravity';
  // У Antigravity в диалоге нет ключа: токен задаётся входом через Google,
  // поэтому «Проверить и сохранить» и «Удалить ключ» здесь не показываем
  const noKeyFields = v === 'antigravity';
  const $save = $id('dlg-save-provider');
  const $remove = $id('dlg-remove');
  if ($save) $save.hidden = noKeyFields;
  if ($remove) $remove.hidden = noKeyFields;
}

// Обновляет статусную строку в форме Antigravity по данным сервера
// (сами токены клиенту не возвращаются — только флаги и время истечения)
async function refreshAgStatus(prefix) {
  const $exp = $id('dlg-ag-exp');
  if (!$exp) return;
  try {
    const s = await fetchGoogleTokenStatus();
    const parts = [];
    if (s.hasToken) parts.push(ICO_CHECK + ' Токен задан на сервере');
    else if (getAgRefreshToken()) parts.push('Связка в браузере — сервер обновит токен сам');
    else parts.push('Токен не задан');
    if (s.hasToken && s.tokenExpiresAt) {
      const remainSec = Math.floor((s.tokenExpiresAt - Date.now()) / 1000);
      parts.push(remainSec > 0
        ? 'истекает через ' + dur(remainSec)
        : (s.hasRefresh ? 'истёк — обновится автоматически' : 'истёк — войдите заново'));
    }
    if (s.hasRefresh) parts.push('автообновление включено');
    // innerHTML: parts содержат SVG-иконку ICO_CHECK, textContent показал бы её как текст.
    // Содержимое — только статические строки и числа, пользовательский ввод не интерполируется.
    $exp.innerHTML = (prefix ? prefix + ' ' : '') + parts.join(', ') + '.';
    $exp.hidden = false;
  } catch { /* нет API — статусную строку не трогаем */ }
}

function readNotificationThresholds() {
  try {
    const raw = vaultGet('notificationThresholds', '');
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

function fillNotificationFields(t) {
  const x = (t && t.xkiro) || {};
  const ar = (t && t.agentrouter) || {};
  const ag = (t && t.antigravity) || {};
  const set = (id, v) => { const el = $id(id); if (el) el.value = v == null ? '' : String(v); };
  set('dlg-th-xkiro-short', x.short_window_pct);
  set('dlg-th-xkiro-long', x.long_window_pct);
  set('dlg-th-ar-balance', ar.balance_below_usd);
  set('dlg-th-ag-remaining', ag.remaining_below_pct);
  const chk = $id('dlg-th-ar-release');
  if (chk) chk.checked = Boolean(ar.notify_on_release);
  updateArNotifyPermissionHint();
}

function updateArNotifyPermissionHint() {
  const $hint = $id('dlg-th-ar-notify-hint');
  const $btn = $id('dlg-th-ar-notify-enable');
  const chk = $id('dlg-th-ar-release');
  if (!$hint) return;
  const wants = chk ? chk.checked : false;
  if (!wants) {
    $hint.textContent = 'Тост при сбросе покажется внутри панели';
    if ($btn) $btn.hidden = true;
    return;
  }
  if (!('Notification' in window)) {
    $hint.textContent = 'Браузер не поддерживает уведомления';
    if ($btn) $btn.hidden = true;
    return;
  }
  const perm = Notification.permission;
  if (perm === 'granted') {
    $hint.textContent = 'Браузерные уведомления разрешены — придёт и вне вкладки';
    if ($btn) $btn.hidden = true;
  } else if (perm === 'denied') {
    $hint.textContent = 'Уведомления заблокированы в браузере — разрешите в настройках сайта';
    if ($btn) $btn.hidden = true;
  } else {
    $hint.textContent = 'Нажмите «Включить», чтобы разрешить уведомления браузера';
    if ($btn) $btn.hidden = false;
  }
}

async function enableArBrowserNotify() {
  if (!('Notification' in window)) return;
  try {
    const perm = await Notification.requestPermission();
    updateArNotifyPermissionHint();
    const $res = $id('dlg-result-notifications');
    if (perm === 'granted') showResult($res, false, 'Уведомления браузера разрешены');
    else if (perm === 'denied') showResult($res, true, 'Уведомления заблокированы');
  } catch { }
}

function collectNotificationFields() {
  const num = (id) => {
    const el = $id(id);
    if (!el) return undefined;
    const v = el.value.trim();
    if (v === '') return undefined;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  };
  const chk = $id('dlg-th-ar-release');
  const notifyOnRelease = chk ? chk.checked : false;
  const t = {
    xkiro: {
      short_window_pct: num('dlg-th-xkiro-short'),
      long_window_pct: num('dlg-th-xkiro-long'),
    },
    agentrouter: {
      balance_below_usd: num('dlg-th-ar-balance'),
      ...(notifyOnRelease ? { notify_on_release: true } : {}),
    },
    antigravity: {
      remaining_below_pct: num('dlg-th-ag-remaining'),
    },
  };
  // Дропаем пустые блоки: не указан ни один порог — порог-объект не
  // сохраняем (evaluateXKiro/Agent/Antigravity возвращают [] для undefined)
  for (const k of Object.keys(t)) {
    const block = t[k];
    if (!Object.values(block).some((v) => v != null)) delete t[k];
    else for (const f of Object.keys(block)) if (block[f] == null) delete block[f];
  }
  return t;
}

function openDialog() {
  $dlgKey.value = '';
  if ($dlgArKey) $dlgArKey.value = '';
  if ($dlgOrKey) $dlgOrKey.value = '';
  if ($dlgSeloraKey) $dlgSeloraKey.value = '';
  if ($dlgArUser) $dlgArUser.value = getAgentRouterUserId();
  if ($dlgArReleases) {
    // Легаси-значение 'hide' (от промежуточной версии) показываем как пустое
    const raw = vaultGet('agentrouterReleaseHoursUtc') || '';
    $dlgArReleases.value = raw === 'hide' ? '' : raw;
  }
  renderAliasRows();
  fillNotificationFields(readNotificationThresholds());
  const $omniUrls = $id('dlg-omni-urls');
  const $omniKey = $id('dlg-omni-key');
  if ($omniUrls) $omniUrls.value = getOmniUrls().join('\n');
  if ($omniKey) $omniKey.value = '';
  // Статус токена — с сервера (сами секреты клиенту не возвращаются)
  refreshAgStatus();
  // Статусные строки всех разделов — чистые
  for (const t of DLG_TABS) {
    const $res = $id(t.result);
    if ($res) { $res.hidden = true; $res.textContent = ''; }
  }
  // Восстанавливаем последнего выбранного в диалоге провайдера
  const $dlgProvider = $id('dlg-provider');
  if ($dlgProvider) {
    let savedDlgProvider = 'xkiro';
    try { savedDlgProvider = (vaultGet('dlgProvider') || '') || 'xkiro'; } catch { /* нет хранилища */ }
    $dlgProvider.value =
      savedDlgProvider === 'antigravity' || savedDlgProvider === 'agentrouter' || savedDlgProvider === 'openrouter' || savedDlgProvider === 'selora'
        ? savedDlgProvider
        : 'xkiro';
    renderDlgProviderFields();
  }
  // Восстанавливаем последний открытый раздел
  selectDlgTab(vaultGet('dlgTab') || DLG_TABS[0].tab);
  $dlg.showModal();
  closeTopbar();
}

// Добавление пустой строки сопоставления
function addAliasRow() {
  const list = $id('dlg-aliases-list');
  if (!list) return;
  const empty = list.querySelector('.hint');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'alias-row';
  const inId = document.createElement('input');
  inId.type = 'text';
  inId.placeholder = 'ID из OmniRoute';
  inId.dataset.aliasId = '__new_' + Date.now();
  const inName = document.createElement('input');
  inName.type = 'text';
  inName.placeholder = 'Имя';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-ghost';
  del.innerHTML = icon('x-mark');
  del.setAttribute('aria-label', 'Удалить');
  del.addEventListener('click', () => row.remove());
  row.append(inId, inName, del);
  list.appendChild(row);
  inId.focus();
}

// Вход через Google: открываем вкладку авторизации, после входа пользователь
// копирует адрес из адресной строки (loopback-redirect) и вставляет его
// в поле «Ссылка после входа» — сервер обменяет код на токены.
//
// Важно: открываем именно НОВУЮ ВКЛАДКУ (target '_blank'), а не popup-окно.
// Браузеры принудительно закрывают popup после редиректа на loopback, а
// вкладки — никогда, поэтому адрес остаётся доступен для копирования.
async function agLogin() {
  const $st = $id('dlg-ag-login-status');
  const setStatusLocal = (t) => { if ($st) $st.textContent = t; };
  // Вкладку открываем синхронно по клику (до await), иначе сработает
  // блокировщик всплывающих окон; адрес подставляем после ответа сервера.
  const tab = window.open('', '_blank');
  try {
    const url = await startGoogleAuth();
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    setStatusLocal('Открыта вкладка Google. После входа скопируйте адрес из адресной строки (http://127.0.0.1:…) и вставьте в поле ниже.');
    const $paste = $id('dlg-ag-paste');
    if ($paste) $paste.focus();
  } catch (err) {
    setStatusLocal('Ошибка: ' + (err && err.message ? err.message : err));
  }
}

// Основной flow: вставить ссылку, на которую ушёл браузер после входа в Google
async function agPaste() {
  const $st = $id('dlg-ag-login-status');
  const $inp = $id('dlg-ag-paste');
  if (!$inp || !$inp.value.trim()) return;
  try {
    if ($st) $st.textContent = 'Обмениваю код авторизации…';
    await pasteGoogleAuth($inp.value.trim());
    $inp.value = '';
    // Refresh уже сохранён сервером в SQLite (зашифровано).
    // Страницы, у которых есть блок квот (главная), перезагружают их
    // по событию и возвращают результат — он идёт в статусную строку.
    const results = await emit('antigravity:authorized');
    const q = results.find((r) => r != null) || null;
    if ($st) {
      $st.innerHTML = q && !q.error
        ? ICO_CHECK + ' Авторизация выполнена — квоты загружены'
        : 'Авторизация выполнена, но квоты не получены: ' +
        ((q && AG_ERROR_MESSAGES[q.error]) || (q && q.error) || 'неизвестная ошибка');
    }
    refreshAgStatus();
  } catch (err) {
    if ($st) $st.textContent = 'Ошибка: ' + (err && err.message ? err.message : err);
  }
}

// ---------- Раздел «Провайдер»: ключ + проверка ----------

async function saveProviderSettings() {
  const $dlgProviderSel = $id('dlg-provider');
  // Проверяем ключ того провайдера, который выбран в разделе
  const dlgProvider = $dlgProviderSel ? $dlgProviderSel.value : 'xkiro';
  const arUserCandidate = $dlgArUser ? $dlgArUser.value.trim() : '';

  // Секреты write-only: пустое поле означает «не изменять».
  // User ID не секретен и сохраняется всегда. Окна сброса — тоже
  // не секрет, сохраняем как строку «2,11» (пусто → дефолт провайдера).
  const rawArReleases = $dlgArReleases ? $dlgArReleases.value.trim() : '';
  // Валидация на клиенте до отправки, чтобы не уходить в 400
  if (rawArReleases) {
    const parts = rawArReleases.split(',');
    let bad = null;
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      const h = Number(t);
      if (!Number.isInteger(h) || h < 0 || h > 23) { bad = t; break; }
    }
    if (bad !== null) {
      showResult($id('dlg-result-provider'), true, 'Некорректные часы: «' + bad + '» — допустимы целые 0..23 через запятую');
      return;
    }
  }
  // Нормализуем «2, 11,2 » → «2,11» для сравнения с хранилищем.
  // Пусто → '' означает «скрыть» (клиент не показывает блок).
  let normalizedReleases = '';
  if (rawArReleases) {
    const seen = new Set();
    for (const p of rawArReleases.split(',')) {
      const t = p.trim();
      if (!t) continue;
      const h = Number(t);
      if (Number.isInteger(h) && h >= 0 && h <= 23) seen.add(h);
    }
    normalizedReleases = [...seen].sort((a, b) => a - b).join(',');
  }
  const storedReleases = String(vaultGet('agentrouterReleaseHoursUtc') || '').trim();
  const entries = { agentrouterUserId: arUserCandidate };
  // Отправляем окна только если изменились — сохраняет совместимость
  // с тестами, где поле остаётся пустым и не должно уходить в PUT
  if (normalizedReleases !== storedReleases) {
    const dlgProviderVal = $id('dlg-provider')?.value || '';
    const isArProviderActive = dlgProviderVal === 'agentrouter';
    if (isArProviderActive || rawArReleases) {
      entries.agentrouterReleaseHoursUtc = normalizedReleases;
    }
  }
  const xkiroCandidate = $dlgKey.value.trim();
  const arCandidate = $dlgArKey ? $dlgArKey.value.trim() : '';
  const orCandidate = $dlgOrKey ? $dlgOrKey.value.trim() : '';
  const seloraCandidate = $dlgSeloraKey ? $dlgSeloraKey.value.trim() : '';
  const experientialCandidate = $dlgExperientialKey ? $dlgExperientialKey.value.trim() : '';
  if (xkiroCandidate) entries.xkiroKey = xkiroCandidate;
  if (arCandidate) entries.agentrouterKey = arCandidate;
  if (orCandidate) entries.openrouterKey = orCandidate;
  if (seloraCandidate) entries.seloraKey = seloraCandidate;
  if (experientialCandidate) entries.experientialKey = experientialCandidate;

  const $res = $id('dlg-result-provider');
  const saved = await saveSettings(entries);
  if (!saved.ok) {
    showResult($res, true, 'Сохранить не удалось: ' + (saved.message || 'ошибка записи'));
    return;
  }

  // Секреты не оставляем в полях формы после отправки
  $dlgKey.value = '';
  if ($dlgArKey) $dlgArKey.value = '';
  if ($dlgOrKey) $dlgOrKey.value = '';
  if ($dlgSeloraKey) $dlgSeloraKey.value = '';
  if ($dlgExperientialKey) $dlgExperientialKey.value = '';
  emit('settings:changed');

  showResult($res, false, 'Сохранено.');
  const setLine = (line, isErr) => showResult($res, isErr, 'Сохранено.<br>' + line);
  const candidate = dlgProvider === 'agentrouter' ? arCandidate
    : dlgProvider === 'openrouter' ? orCandidate
      : dlgProvider === 'selora' ? seloraCandidate
        : dlgProvider === 'experiential' ? experientialCandidate
          : xkiroCandidate;
  if (dlgProvider === 'agentrouter') {
    if (candidate) {
      console.info('[AgentRouter] проверка токена…');
      setLine('AgentRouter: проверяю токен…', false);
      providerRequest('usage', { provider: { id: 'agentrouter', name: 'AgentRouter' }, key: candidate, userId: arUserCandidate })
        .then((data) => {
          const wallet = (data && data.wallet) || {};
          const bal = wallet.balance_usd ?? wallet.balance ?? 0;
          console.info('[AgentRouter] токен OK', data);
          setLine('AgentRouter ' + ICO_CHECK + ' токен работает — баланс: ' + fmtUsd(bal), false);
        })
        .catch((err) => {
          console.warn('[AgentRouter] проверка не прошла', err);
          setLine('AgentRouter ' + ICO_X + ' токен не прошёл проверку: ' + (err && err.message ? err.message : String(err)), true);
        });
    } else {
      // Пустое поле секрета = «не изменять»: ключ остаётся в хранилище.
      // Явно сообщаем об этом, чтобы пустое поле не выглядело как удаление
      const hasStored = vaultGet('hasAgentrouterKey');
      console.info('[AgentRouter] токен в поле пустой' + (hasStored ? ' — оставляю сохранённый' : ''));
      setLine(
        hasStored
          ? 'AgentRouter ' + ICO_CHECK + ' токен сохранён ранее — пустое поле его не меняет'
          : 'AgentRouter: токен не задан',
        false
      );
    }
  } else if (dlgProvider === 'xkiro') {
    if (candidate) {
      console.info('[xKiro] проверка ключа…');
      setLine('xKiro: проверяю ключ…', false);
      providerRequest('usage', { key: candidate })
        .then((data) => {
          const wallet = (data && data.wallet) || {};
          const bal = wallet.balance_usd ?? wallet.balance ?? 0;
          console.info('[xKiro] ключ OK', data);
          setLine('xKiro ' + ICO_CHECK + ' ключ работает — баланс: ' + fmtUsd(bal) + (data.plan ? ' · план: ' + data.plan : ''), false);
        })
        .catch((err) => {
          console.warn('[xKiro] проверка не прошла', err);
          let msg = 'xKiro ' + ICO_X + ' ключ не прошёл проверку: ' + (err && err.message ? err.message : String(err));
          if (err && err.status === 401) msg += ' — проверьте ключ';
          setLine(msg, true);
        });
    } else {
      const hasStored = vaultGet('hasXkiroKey');
      console.info('[xKiro] ключ в поле пустой' + (hasStored ? ' — оставляю сохранённый' : ''));
      setLine(
        hasStored
          ? 'xKiro ' + ICO_CHECK + ' ключ сохранён ранее — пустое поле его не меняет'
          : 'xKiro: ключ не задан',
        false
      );
    }
  } else if (dlgProvider === 'openrouter') {
    if (candidate) {
      console.info('[OpenRouter] проверка ключа…');
      setLine('OpenRouter: проверяю ключ…', false);
      providerRequest('usage', { provider: { id: 'openrouter', name: 'OpenRouter' }, key: candidate })
        .then((data) => {
          const wallet = (data && data.wallet) || {};
          const bal = wallet.balance_usd ?? wallet.balance ?? 0;
          console.info('[OpenRouter] ключ OK', data);
          setLine('OpenRouter ' + ICO_CHECK + ' ключ работает — баланс: ' + fmtUsd(bal) + (data.plan ? ' · ' + data.plan : ''), false);
        })
        .catch((err) => {
          console.warn('[OpenRouter] проверка не прошла', err);
          setLine('OpenRouter ' + ICO_X + ' ключ не прошёл проверку: ' + (err && err.message ? err.message : String(err)), true);
        });
    } else {
      const hasStored = vaultGet('hasOpenrouterKey');
      console.info('[OpenRouter] ключ в поле пустой' + (hasStored ? ' — оставляю сохранённый' : ''));
      setLine(
        hasStored
          ? 'OpenRouter ' + ICO_CHECK + ' ключ сохранён ранее — пустое поле его не меняет'
          : 'OpenRouter: ключ не задан',
        false
      );
    }
  } else if (dlgProvider === 'experiential') {
    if (candidate) {
      console.info('[Experiential Labs] проверка ключа…');
      setLine('Experiential Labs: проверяю ключ…', false);
      providerRequest('usage', { provider: { id: 'experiential', name: 'Experiential Labs' }, key: candidate })
        .then(() => setLine('Experiential Labs ' + ICO_CHECK + ' ключ работает', false))
        .catch((err) => setLine('Experiential Labs ' + ICO_X + ' ключ не прошёл проверку: ' + (err && err.message ? err.message : String(err)), true));
    } else {
      const hasStored = vaultGet('hasExperientialKey');
      setLine(hasStored ? 'Experiential Labs ' + ICO_CHECK + ' ключ сохранён ранее — пустое поле его не меняет' : 'Experiential Labs: ключ не задан', false);
    }
  } else if (dlgProvider === 'selora') {
    if (candidate) {
      console.info('[Selora] проверка ключа…');
      setLine('Selora: проверяю ключ…', false);
      providerRequest('usage', { provider: { id: 'selora', name: 'Selora' }, key: candidate })
        .then((data) => {
          const wallet = (data && data.wallet) || {};
          const bal = wallet.balance_usd ?? wallet.balance ?? 0;
          console.info('[Selora] ключ OK', data);
          setLine('Selora ' + ICO_CHECK + ' ключ работает — баланс: ' + fmtUsd(bal) + (data.plan ? ' · план: ' + data.plan : ''), false);
        })
        .catch((err) => {
          console.warn('[Selora] проверка не прошла', err);
          let msg = 'Selora ' + ICO_X + ' ключ не прошёл проверку: ' + (err && err.message ? err.message : String(err));
          if (err && err.status === 401) msg += ' — проверьте ключ';
          setLine(msg, true);
        });
    } else {
      const hasStored = vaultGet('hasSeloraKey');
      console.info('[Selora] ключ в поле пустой' + (hasStored ? ' — оставляю сохранённый' : ''));
      setLine(
        hasStored
          ? 'Selora ' + ICO_CHECK + ' ключ сохранён ранее — пустое поле его не меняет'
          : 'Selora: ключ не задан',
        false
      );
    }
  }
  // antigravity: токен живёт на сервере — проверять в диалоге нечего
}

// ---------- Раздел «OmniRoute»: адрес + ключ + проверка ----------

async function saveOmniSettings() {
  const $omniUrls = $id('dlg-omni-urls');
  const $omniKey = $id('dlg-omni-key');
  const list = normalizeOmniUrls($omniUrls ? $omniUrls.value : '');
  if ($omniUrls) $omniUrls.value = list.join('\n');
  const omniKeyValue = $omniKey ? $omniKey.value.trim() : '';

  // Запоминаем, какие адреса были до сохранения (чтобы очистить legacy,
  // если пользователь удалил старый адрес из списка)
  const previousUrls = getOmniUrls();
  const removedUrls = previousUrls.filter((u) => !list.includes(u));

  const entries = { omniUrls: list.join('\n') };
  // Если старый одиночный URL исчез из списка — очищаем его
  if (removedUrls.length > 0) {
    entries.omniUrl = '';
  }
  if (omniKeyValue) entries.omniKey = omniKeyValue;

  const $res = $id('dlg-result-omni');
  const saved = await saveSettings(entries);
  if (!saved.ok) {
    showResult($res, true, 'Сохранить не удалось: ' + (saved.message || 'ошибка записи'));
    return;
  }

  // Секрет не оставляем в поле формы после отправки
  if ($omniKey) $omniKey.value = '';
  emit('settings:changed');

  // Пустое поле ключа = «не изменять»: сообщаем, если ключ сохранён ранее
  const keyNote = !omniKeyValue && vaultGet('hasOmniKey')
    ? '<br>Ключ сохранён ранее — пустое поле его не меняет'
    : '';
  const renderLine = (line, isErr) => showResult($res, isErr, 'Сохранено.<br>' + line + keyNote);
  const summary = !list.length
    ? 'OmniRoute: не задан'
    : list.length === 1
      ? 'OmniRoute: ' + list[0] + ' — проверяю…'
      : 'OmniRoute: адресов ' + list.length + ' — проверяю…';
  renderLine(summary, false);

  // Фоновая проверка OmniRoute — уточняет строку результата
  if (list.length) {
    console.info('[OmniRoute] проверка', list);
    omniFetch(COMBO_LIST_PATH).then((data) => {
      const n = Array.isArray(data) ? data.length : Array.isArray(data.combos) ? data.combos.length : Array.isArray(data.data) ? data.data.length : 0;
      console.info('[OmniRoute] OK', data);
      renderLine('OmniRoute ' + ICO_CHECK + ' — доступно combo: ' + n + ' (адресов: ' + list.length + ')', false);
    }).catch((err) => {
      console.warn('[OmniRoute] проверка не прошла', err);
      const isErr = !(err && err.status === 400); // 400 без URL не считаем критичным
      renderLine('OmniRoute ' + ICO_X + ' — ' + (err && err.message ? err.message : String(err)), isErr);
    });
  }
}

// ---------- Раздел «Уведомления»: пороги ----------

async function saveNotificationSettings() {
  const $res = $id('dlg-result-notifications');
  // Пороги: собираем числа из полей, сериализуем JSON
  const saved = await saveSettings({ notificationThresholds: JSON.stringify(collectNotificationFields()) });
  if (!saved.ok) {
    showResult($res, true, 'Сохранить не удалось: ' + (saved.message || 'ошибка записи'));
    return;
  }
  emit('settings:changed');
  showResult($res, false, 'Сохранено.');
}

// ---------- Раздел «Сопоставление имён»: алиасы ----------

async function saveAliasSettings() {
  const $res = $id('dlg-result-aliases');
  const aliasMap = collectAliasesFromUI();
  const saved = await saveSettings({ aliases: JSON.stringify(Object.entries(aliasMap).filter(([id, name]) => id && name)) });
  if (!saved.ok) {
    showResult($res, true, 'Сохранить не удалось: ' + (saved.message || 'ошибка записи'));
    return;
  }
  emit('settings:changed');
  showResult($res, false, 'Сохранено.');
}

function removeDialogKey() {
  const $sel = $id('dlg-provider');
  const dlgProvider = $sel ? $sel.value : 'xkiro';
  if (dlgProvider === 'agentrouter') vaultSet('agentrouterKey', '');
  else if (dlgProvider === 'openrouter') vaultSet('openrouterKey', '');
  else if (dlgProvider === 'selora') vaultSet('seloraKey', '');
  else if (dlgProvider === 'experiential') vaultSet('experientialKey', '');
  else removeKey();
  $dlg.close();
  emit('settings:changed');
}

export function initSettingsDialog() {
  $dlg = $id('dlg');
  $dlgKey = $id('dlg-key');
  $dlgArKey = $id('dlg-agentrouter-key');
  $dlgOrKey = $id('dlg-openrouter-key');
  $dlgSeloraKey = $id('dlg-selora-key');
  $dlgExperientialKey = $id('dlg-experiential-key');
  $dlgArUser = $id('dlg-agentrouter-user');
  $dlgArReleases = $id('dlg-agentrouter-releases');
  $dlgToggle = $id('dlg-toggle');
  $dlgArToggle = $id('dlg-agentrouter-toggle');
  $dlgOrToggle = $id('dlg-openrouter-toggle');
  $dlgSeloraToggle = $id('dlg-selora-toggle');
  $dlgExperientialToggle = $id('dlg-experiential-toggle');
  $dlgRemove = $id('dlg-remove');
  if (!$dlg) return; // диалог есть на всех страницах, но проверимся

  on($id('setup-open-settings'), 'click', () => {
    const btn = $id('btn-settings');
    if (btn) btn.click();
  });

  on($id('btn-settings'), 'click', openDialog);

  on($id('dlg-alias-add'), 'click', addAliasRow);

  // Переключение полей провайдера в настройках
  on($id('dlg-provider'), 'change', () => {
    const $sel = $id('dlg-provider');
    if (!$sel) return;
    vaultSet('dlgProvider', $sel.value);
    renderDlgProviderFields();
  });

  on($dlgToggle, 'click', () => {
    $dlgKey.type = $dlgKey.type === 'password' ? 'text' : 'password';
  });

  // Показать/скрыть access-токен AgentRouter
  on($dlgArToggle, 'click', () => {
    if ($dlgArKey) $dlgArKey.type = $dlgArKey.type === 'password' ? 'text' : 'password';
  });

  // Показать/скрыть ключ OpenRouter
  on($dlgOrToggle, 'click', () => {
    if ($dlgOrKey) $dlgOrKey.type = $dlgOrKey.type === 'password' ? 'text' : 'password';
  });

  // Показать/скрыть ключ Selora
  on($dlgSeloraToggle, 'click', () => {
    if ($dlgSeloraKey) $dlgSeloraKey.type = $dlgSeloraKey.type === 'password' ? 'text' : 'password';
  });

  on($dlgExperientialToggle, 'click', () => {
    if ($dlgExperientialKey) $dlgExperientialKey.type = $dlgExperientialKey.type === 'password' ? 'text' : 'password';
  });

  on($id('dlg-th-ar-release'), 'change', updateArNotifyPermissionHint);
  on($id('dlg-th-ar-notify-enable'), 'click', enableArBrowserNotify);

  on($id('dlg-ag-login'), 'click', agLogin);
  on($id('dlg-ag-paste-btn'), 'click', agPaste);

  // Enter в поле вставки = «Применить»
  on($id('dlg-ag-paste'), 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const $btn = $id('dlg-ag-paste-btn');
      if ($btn) $btn.click();
    }
  });

  // Табы разделов: клик + стрелки (паттерн ARIA tabs)
  for (const t of DLG_TABS) {
    on($id(t.tab), 'click', () => selectDlgTab(t.tab));
  }
  on($dlg.querySelector('.dlg-tabs'), 'keydown', onDlgTabsKeydown);

  // Enter в поле ввода = «сохранить» текущего раздела, а не закрыть диалог
  on($dlg, 'keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'SELECT')) return;
    if (t.id === 'dlg-ag-paste') return; // у поля вставки своя обработка
    const panel = t.closest('.dlg-panel');
    if (!panel) return;
    const rec = DLG_TABS.find((x) => x.panel === panel.id);
    const $btn = rec ? $id(rec.save) : null;
    if ($btn && !$btn.hidden) {
      e.preventDefault();
      $btn.click();
    }
  });

  // Кнопка сохранения своего раздела
  const SAVE_HANDLERS = {
    'dlg-save-provider': saveProviderSettings,
    'dlg-save-omni': saveOmniSettings,
    'dlg-save-notifications': saveNotificationSettings,
    'dlg-save-aliases': saveAliasSettings,
  };
  for (const [id, handler] of Object.entries(SAVE_HANDLERS)) {
    on($id(id), 'click', handler);
  }

  on($dlgRemove, 'click', removeDialogKey);
}
