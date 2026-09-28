export function statusClass(status, hasError) {
  if (hasError) return 'status-err';
  if (status >= 200 && status < 300) return 'status-ok';
  if (status >= 400) return 'status-err';
  return 'status-other';
}

export function extractErrorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.error) return extractErrorText(err.error);
  if (err.statusText) return err.statusText;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function statusText(row) {
  if (row.active) return '…';
  if (row.error) {
    const detail = extractErrorText(row.error);
    return detail || 'ошибка';
  }
  return String(row.status || '—');
}

export function pluralRequests(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запрос';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'запроса';
  return 'запросов';
}
