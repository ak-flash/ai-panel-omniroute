/* ============================================================
   AI Panel — рендер таблицы «последние combo-запросы».

   Раньше эта разметка жила прямо в pages/combo.js (P2-2): там
   остаётся только загрузка данных, а построение строк вынесено
   сюда. Форматирование значений — в combo-recent-format.js
   и call-logs.js, модуль отвечает лишь за DOM.
   ============================================================ */

import {
  requestedOf,
  realModelOf,
  formatCallLogTime,
  formatTokensOf,
  tokensTitle,
} from './call-logs.js';
import {
  statusClass,
  extractErrorText,
  statusText,
  pluralRequests,
} from './combo-recent-format.js';

/**
 * @typedef {object} ComboRecentEls
 * @property {Element|null} recent   секция #combo-recent
 * @property {Element|null} status   #combo-recent-status
 * @property {Element|null} meta     #combo-recent-meta
 * @property {Element|null} body     #combo-recent-body (tbody)
 */

/**
 * Рисует таблицу последних combo-запросов. Пустой список показывает
 * подсказку.
 *
 * @param {Array<object>} rows строки логов (уже отобранные recentComboRows)
 * @param {ComboRecentEls} els
 */
export function renderComboRecentTable(rows, els) {
  const { recent, status, meta, body } = els;
  if (!recent || !body) return;

  if (!rows.length) {
    body.replaceChildren();
    if (status) {
      status.textContent =
        'Нет combo-запросов в логах OmniRoute — отправьте запрос через combo и обновите страницу.';
    }
    if (meta) meta.textContent = '';
    return;
  }

  if (status) status.textContent = '';
  if (meta) {
    meta.textContent = 'показано: ' + rows.length + ' ' + pluralRequests(rows.length);
  }

  body.replaceChildren();
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
    const badge = document.createElement('span');
    badge.className = 'badge ' + statusClass(row.status, Boolean(row.error));
    badge.textContent = statusText(row);
    if (row.error) badge.title = extractErrorText(row.error);
    tdStatus.appendChild(badge);

    tr.append(tdTime, tdCombo, tdModel, tdProvider, tdTokens, tdStatus);
    body.appendChild(tr);
  }
}
