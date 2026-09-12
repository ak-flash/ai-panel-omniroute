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

/**
 * Ближайший момент высвобождения пула по часам в UTC (массив hoursUtc,
 * напр. [0, 8, 16]). Кандидаты сегодня до now откладываются на сутки
 * вперёд. Возвращает мс-таймстамп (UTC) или null, если часов нет.
 * Используется для таймера «до высвобождения пула AgentRouter».
 */
export function nextReleaseUtc(hoursUtc, now = Date.now()) {
  if (!Array.isArray(hoursUtc)) return null;
  const valid = hoursUtc.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (!valid.length) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return null;
  const d = new Date(nowMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let best = null;
  for (const h of valid) {
    let t = dayStart + h * 3600000;
    if (t <= nowMs) t += 86400000; // час уже прошёл сегодня — следующий завтра
    if (best === null || t < best) best = t;
  }
  return best;
}

/** Локальное время «чч:мм» (часовой пояс браузера) для мс-таймстампа. */
export function clockTime(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
