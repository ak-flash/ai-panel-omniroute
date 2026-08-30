/* ============================================================
   AI Panel — разбор call logs из OmniRoute API
   (GET /api/usage/call-logs). Общий код для страницы «Combo»:
   из строк логов достаём связку «запрошенная модель (combo) →
   реальная модель, которая обслужила запрос».

   Формат строки лога (mapSummaryRow в OmniRoute):
   {
     id, timestamp (ISO), method, path, status,
     model,            // реальная модель, которая ответила
     requestedModel,   // что просили (id combo или модели)
     comboName,        // имя combo, если запрос шёл через combo
     provider, providerDisplay, account,
     duration (ms), tokens: { in, out, … },
     error, active, …
   }
   ============================================================ */

/** Ответ может быть массивом или обёрнут в { logs } / { data } */
export function callLogsFromResponse(data) {
  if (!data || typeof data !== 'object') return [];
  return Array.isArray(data) ? data
    : Array.isArray(data.logs) ? data.logs
    : Array.isArray(data.data) ? data.data
    : [];
}

/** Строка лога относится к combo-запросу (прошла через combo-роутинг) */
export function isComboRow(row) {
  return Boolean(row && row.comboName);
}

/** Устойчивое имя реальной модели: model, затем requestedModel */
export function realModelOf(row) {
  if (!row) return '';
  const m = String(row.model || '').trim();
  if (m) return m;
  const req = String(row.requestedModel || '').trim();
  return req;
}

/** Что было запрошено: comboName (когда шло через combo), иначе requestedModel */
export function requestedOf(row) {
  if (!row) return '';
  if (isComboRow(row)) return String(row.comboName).trim();
  const req = String(row.requestedModel || '').trim();
  return req;
}

/**
 * Последние N combo-запросов: только строки с comboName,
 * отсортированные от новых к старым.
 * Активные (active: true) не показываем — у них ещё нет результата.
 */
export function recentComboRows(rows, limit = 10) {
  const list = callLogsFromResponse(rows)
    .filter((r) => isComboRow(r) && !r.active)
    .sort(byNewestFirst);
  return Number.isInteger(limit) && limit > 0 ? list.slice(0, limit) : list;
}

/** Сортировка от новых к старым по timestamp (ISO-строки сравниваются лексикографически) */
export function byNewestFirst(a, b) {
  const ta = Date.parse(a && a.timestamp) || 0;
  const tb = Date.parse(b && b.timestamp) || 0;
  return tb - ta;
}

/** «14:32» или «вчера 14:32» — краткая метка времени для таблицы */
export function formatCallLogTime(iso, now = new Date()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (sameDay) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return 'вчера ' + hm;
  const dd = pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1);
  return dd + ' ' + hm;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Сводка по строке лога: сколько раз какая реальная модель обслуживала combo */
export function modelUsageSummary(rows) {
  const counts = new Map();
  for (const r of rows) {
    const model = realModelOf(r);
    if (!model) continue;
    counts.set(model, (counts.get(model) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}
