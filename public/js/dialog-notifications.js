/* ============================================================
   AI Panel — раздел «Уведомления» в диалоге настроек (P2-2).

   Пороги xKiro / AgentRouter / Antigravity и браузерные
   уведомления AgentRouter раньше жили прямо в dialog.js.
   Раздел не зависит от остальных настроек, поэтому вынесен
   отдельно: чтение порогов из хранилища, заполнение полей,
   сбор значений и запрос разрешения на уведомления.

   Статусная строка раздела рисуется общим showResult, который
   передаётся параметром — модуль не тянет за собой dialog.js.
   ============================================================ */

import { $id } from './dom.js';
import { vaultGet } from './settings.js';

/** Пороги из хранилища; пустой объект при отсутствии или битом JSON. */
export function readNotificationThresholds() {
  try {
    const raw = vaultGet('notificationThresholds', '');
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** Заполняет поля раздела сохранёнными порогами. */
export function fillNotificationFields(t) {
  const x = (t && t.xkiro) || {};
  const ar = (t && t.agentrouter) || {};
  const ag = (t && t.antigravity) || {};
  const set = (id, v) => {
    const el = $id(id);
    if (el) el.value = v == null ? '' : String(v);
  };
  set('dlg-th-xkiro-short', x.short_window_pct);
  set('dlg-th-xkiro-long', x.long_window_pct);
  set('dlg-th-ar-balance', ar.balance_below_usd);
  set('dlg-th-ag-remaining', ag.remaining_below_pct);
  const chk = $id('dlg-th-ar-release');
  if (chk) chk.checked = Boolean(ar.notify_on_release);
  updateArNotifyPermissionHint();
}

/** Подсказка о состоянии разрешения на браузерные уведомления. */
export function updateArNotifyPermissionHint() {
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

/**
 * Запрашивает разрешение на браузерные уведомления.
 * @param {(el: Element|null, isErr: boolean, message: string) => void} showResult
 *   рендер статусной строки раздела (живёт в dialog.js)
 */
export async function enableArBrowserNotify(showResult) {
  if (!('Notification' in window)) return;
  try {
    const perm = await Notification.requestPermission();
    updateArNotifyPermissionHint();
    const $res = $id('dlg-result-notifications');
    if (perm === 'granted') showResult($res, false, 'Уведомления браузера разрешены');
    else if (perm === 'denied') showResult($res, true, 'Уведомления заблокированы');
  } catch {}
}

/** Собирает пороги из полей; пустые блоки и поля дропаются. */
export function collectNotificationFields() {
  const num = id => {
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
    if (!Object.values(block).some(v => v != null)) delete t[k];
    else for (const f of Object.keys(block)) if (block[f] == null) delete block[f];
  }
  return t;
}
