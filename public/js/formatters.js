/* ============================================================
   AI Panel — чистые функции форматирования (без DOM).
   Покрываются юнит-тестами (test/formatters.test.js).
   ============================================================ */

export function fmtUsd(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return '$' + (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function compact(n) {
  return new Intl.NumberFormat('ru', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

export function dur(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  if (sec >= 86400) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    return h ? `${d} дн ${h} ч` : `${d} дн`;
  }
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} мин ${s} с` : `${m} мин`;
  }
  return `${sec} с`;
}

export function num(v) {
  return typeof v === 'string' ? parseFloat(v) : v;
}

export function pct(spent, cap) {
  spent = num(spent);
  cap = num(cap);
  if (!Number.isFinite(spent) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(100, Math.max(0, (spent / cap) * 100));
}

export function barClass(p) {
  if (p < 70) return '';
  if (p < 90) return 'warn';
  return 'danger';
}
