/* ============================================================
   AI Panel — диалог настроек (общий для всех страниц).

   Сохранение — один батч PUT /api/config (saveSettings):
   либо все ключи, либо ни один. Секреты write-only: пустое
   поле секрета означает «не изменять», а после успешной
   отправки поля очищаются — секреты не остаются в DOM.
   ============================================================ */

import { $id, on, ICO_CHECK, ICO_X } from './dom.js';
import { icon } from '../icons.js';
import { vaultGet, vaultSet, setKey, removeKey, getAgentRouterUserId, getAgRefreshToken, getOmniUrl, normalizeOmniUrl, saveSettings } from './settings.js';
import { providerRequest, omniFetch, COMBO_LIST_PATH, fetchGoogleTokenStatus, startGoogleAuth, pasteGoogleAuth, AG_ERROR_MESSAGES } from './api.js';
import { fmtUsd, dur } from './formatters.js';
import { renderAliasRows, collectAliasesFromUI } from './aliases.js';
import { closeTopbar } from './topbar.js';
import { emit } from './events.js';

let $dlg, $dlgKey, $dlgArKey, $dlgArUser, $dlgToggle, $dlgArToggle, $dlgSave, $dlgRemove, $dlgResult;

// Показ/скрытие полей выбранного в настройках провайдера
function renderDlgProviderFields() {
  const $sel = $id('dlg-provider');
  if (!$sel) return;
  const v = $sel.value;
  const $xkiro = $id('dlg-xkiro-fields');
  const $ar = $id('dlg-agentrouter-fields');
  const $ag = $id('dlg-ag-fields');
  if ($xkiro) $xkiro.hidden = v !== 'xkiro';
  if ($ar) $ar.hidden = v !== 'agentrouter';
  if ($ag) $ag.hidden = v !== 'antigravity';
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
    $exp.textContent = (prefix ? prefix + ' ' : '') + parts.join(', ') + '.';
    $exp.hidden = false;
  } catch { /* нет API — статусную строку не трогаем */ }
}

function openDialog() {
  $dlgKey.value = '';
  if ($dlgArKey) $dlgArKey.value = '';
  if ($dlgArUser) $dlgArUser.value = getAgentRouterUserId();
  renderAliasRows();
  const $omniUrl = $id('dlg-omni-url');
  const $omniKey = $id('dlg-omni-key');
  if ($omniUrl) $omniUrl.value = getOmniUrl();
  if ($omniKey) $omniKey.value = '';
  // Статус токена — с сервера (сами секреты клиенту не возвращаются)
  refreshAgStatus();
  $dlgResult.textContent = '';
  $dlgResult.hidden = true;
  // Восстанавливаем последнего выбранного в диалоге провайдера
  const $dlgProvider = $id('dlg-provider');
  if ($dlgProvider) {
    let savedDlgProvider = 'xkiro';
    try { savedDlgProvider = (vaultGet('dlgProvider') || '') || 'xkiro'; } catch { /* нет хранилища */ }
    $dlgProvider.value =
      savedDlgProvider === 'antigravity' || savedDlgProvider === 'agentrouter'
        ? savedDlgProvider
        : 'xkiro';
    renderDlgProviderFields();
  }
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

async function saveDialog() {
  const $omniUrl = $id('dlg-omni-url');
  const $omniKey = $id('dlg-omni-key');
  const $dlgProviderSel = $id('dlg-provider');
  // Проверяем ключ того провайдера, чья вкладка открыта в диалоге
  const dlgProvider = $dlgProviderSel ? $dlgProviderSel.value : 'xkiro';

  // Собираем всё сохраняемое заранее: батч уходит одним PUT /api/config
  const aliasMap = collectAliasesFromUI();
  const omniUrlRaw = $omniUrl ? $omniUrl.value.trim() : '';
  const omniUrlClean = normalizeOmniUrl(omniUrlRaw);
  if ($omniUrl && omniUrlClean !== omniUrlRaw) {
    // Показываем пользователю нормализованный адрес
    $omniUrl.value = omniUrlClean;
  }
  const omniKeyValue = $omniKey ? $omniKey.value.trim() : '';
  const xkiroCandidate = $dlgKey.value.trim();
  const arCandidate = $dlgArKey ? $dlgArKey.value.trim() : '';
  const arUserCandidate = $dlgArUser ? $dlgArUser.value.trim() : '';

  // Секреты write-only: пустое поле означает «не изменять».
  // User ID не секретен и сохраняется всегда.
  const entries = {
    aliases: JSON.stringify(Object.entries(aliasMap).filter(([id, name]) => id && name)),
    agentrouterUserId: arUserCandidate,
  };
  if ($omniUrl || $omniKey) entries.omniUrl = omniUrlClean;
  if (omniKeyValue) entries.omniKey = omniKeyValue;
  if (xkiroCandidate) entries.xkiroKey = xkiroCandidate;
  if (arCandidate) entries.agentrouterKey = arCandidate;
  const candidate = dlgProvider === 'agentrouter' ? arCandidate : xkiroCandidate;

  const saved = await saveSettings(entries);
  if (!saved.ok) {
    // Ошибку сохранения больше не глотаем — показываем в диалоге
    $dlgResult.hidden = false;
    $dlgResult.className = 'dlg-result err';
    $dlgResult.textContent = 'Сохранить не удалось: ' + (saved.message || 'ошибка записи');
    return;
  }

  // Секреты не оставляем в полях формы после отправки
  $dlgKey.value = '';
  if ($dlgArKey) $dlgArKey.value = '';
  if ($omniKey) $omniKey.value = '';

  $dlgResult.hidden = false;
  // Две строки результата: OmniRoute и провайдер — обновляются независимо
  let omniLine = omniUrlClean ? 'OmniRoute: ' + omniUrlClean + ' — проверяю…' : 'OmniRoute: не задан';
  let providerLine = '';
  const renderResult = (isErr) => {
    $dlgResult.className = isErr ? 'dlg-result err' : 'dlg-result ok';
    $dlgResult.innerHTML = 'Сохранено.<br>' + omniLine + (providerLine ? '<br>' + providerLine : '');
  };
  $dlgResult.className = 'dlg-result ok';
  $dlgResult.innerHTML = 'Сохранено.<br>' + omniLine;
  // Перерисовать страницу с новыми настройками (boot.js перезапустит init)
  emit('settings:changed');

  // Фоновая проверка OmniRoute — уточняет строку OmniRoute
  if (omniUrlClean) {
    console.info('[OmniRoute] проверка', omniUrlClean);
    omniFetch(COMBO_LIST_PATH).then((data) => {
      const n = Array.isArray(data) ? data.length : Array.isArray(data.combos) ? data.combos.length : Array.isArray(data.data) ? data.data.length : 0;
      console.info('[OmniRoute] OK', data);
      omniLine = 'OmniRoute ' + ICO_CHECK + ' ' + omniUrlClean + ' — доступно combo: ' + n;
      renderResult(false);
    }).catch((err) => {
      console.warn('[OmniRoute] проверка не прошла', err);
      omniLine = 'OmniRoute ' + ICO_X + ' ' + omniUrlClean + ' — ' + (err && err.message ? err.message : String(err));
      const isErr = !(err && err.status === 400); // 400 без URL не считаем критичным
      renderResult(isErr);
    });
  } else {
    renderResult(false);
  }
  const setProviderLine = (line, isErr) => { providerLine = line; renderResult(isErr); };
  if (dlgProvider === 'agentrouter') {
    if (candidate) {
      console.info('[AgentRouter] проверка токена…');
      setProviderLine('AgentRouter: проверяю токен…', false);
      providerRequest('usage', { provider: { id: 'agentrouter', name: 'AgentRouter' }, key: candidate, userId: arUserCandidate })
        .then((data) => {
          const wallet = (data && data.wallet) || {};
          const bal = wallet.balance_usd ?? wallet.balance ?? 0;
          console.info('[AgentRouter] токен OK', data);
          setProviderLine('AgentRouter ' + ICO_CHECK + ' токен работает — баланс: ' + fmtUsd(bal), false);
        })
        .catch((err) => {
          console.warn('[AgentRouter] проверка не прошла', err);
          const msg = 'AgentRouter ' + ICO_X + ' токен не прошёл проверку: ' + (err && err.message ? err.message : String(err));
          setProviderLine(msg, true);
        });
    } else {
      console.info('[AgentRouter] токен не задан');
      setProviderLine('AgentRouter: токен не задан', false);
    }
  } else if (dlgProvider === 'xkiro') {
    if (candidate) {
      console.info('[xKiro] проверка ключа…');
      setProviderLine('xKiro: проверяю ключ…', false);
      providerRequest('usage', { key: candidate })
        .then((data) => {
          const wallet = (data && data.wallet) || {};
          const bal = wallet.balance_usd ?? wallet.balance ?? 0;
          console.info('[xKiro] ключ OK', data);
          setProviderLine('xKiro ' + ICO_CHECK + ' ключ работает — баланс: ' + fmtUsd(bal) + (data.plan ? ' · план: ' + data.plan : ''), false);
        })
        .catch((err) => {
          console.warn('[xKiro] проверка не прошла', err);
          let msg = 'xKiro ' + ICO_X + ' ключ не прошёл проверку: ' + (err && err.message ? err.message : String(err));
          if (err && err.status === 401) msg += ' — проверьте ключ';
          setProviderLine(msg, true);
        });
    } else {
      console.info('[xKiro] ключ не задан');
      setProviderLine('xKiro: ключ не задан', false);
    }
  }
  // antigravity: токен живёт на сервере — проверять в диалоге нечего
}

function removeDialogKey() {
  const $sel = $id('dlg-provider');
  const dlgProvider = $sel ? $sel.value : 'xkiro';
  if (dlgProvider === 'agentrouter') vaultSet('agentrouterKey', '');
  else removeKey();
  $dlg.close();
  emit('settings:changed');
}

export function initSettingsDialog() {
  $dlg = $id('dlg');
  $dlgKey = $id('dlg-key');
  $dlgArKey = $id('dlg-agentrouter-key');
  $dlgArUser = $id('dlg-agentrouter-user');
  $dlgToggle = $id('dlg-toggle');
  $dlgArToggle = $id('dlg-agentrouter-toggle');
  $dlgSave = $id('dlg-save');
  $dlgRemove = $id('dlg-remove');
  $dlgResult = $id('dlg-result');
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

  on($dlgSave, 'click', saveDialog);
  on($dlgRemove, 'click', removeDialogKey);
}
