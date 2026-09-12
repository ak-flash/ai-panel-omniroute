'use strict';

// Юнит-тесты чистых форматтеров фронтенда (public/js/formatters.js,
// ES-модуль — импортируется динамически). Это логика, которую этап 5
// плана рефакторинга вынес из app.js в переиспользуемый модуль.

const test = require('node:test');
const assert = require('node:assert/strict');

let fmtUsd, compact, dur, num, pct, barClass, nextReleaseUtc, clockTime;

test.before(async () => {
  ({
    fmtUsd, compact, dur, num, pct, barClass, nextReleaseUtc, clockTime,
  } = await import('../public/js/formatters.js'));
});

test('fmtUsd: число и строка → $ с двумя знаками', () => {
  assert.equal(fmtUsd(12.5), '$12.50');
  assert.equal(fmtUsd('3.456'), '$3.46');
  assert.equal(fmtUsd(0), '$0.00');
});

test('fmtUsd: нечисловое значение → $0.00', () => {
  assert.equal(fmtUsd(undefined), '$0.00');
  assert.equal(fmtUsd(null), '$0.00');
  assert.equal(fmtUsd('abc'), '$0.00');
  assert.equal(fmtUsd(NaN), '$0.00');
});

test('fmtUsd: разделяет тысячи', () => {
  assert.equal(fmtUsd(1234567.89), '$1,234,567.89');
});

test('dur: секунды → минуты → часы → дни', () => {
  assert.equal(dur(45), '45 с');
  assert.equal(dur(60), '1 мин');
  assert.equal(dur(90), '1 мин 30 с');
  assert.equal(dur(3600), '1 ч');
  assert.equal(dur(5400), '1 ч 30 мин');
  assert.equal(dur(86400), '1 дн');
  assert.equal(dur(90000), '1 дн 1 ч');
});

test('dur: отрицательные и мусор → 0 с', () => {
  assert.equal(dur(-5), '0 с');
  assert.equal(dur(undefined), '0 с');
  assert.equal(dur('NaN'), '0 с');
});

test('pct: доля от cap, ограничена 0..100', () => {
  assert.equal(pct(50, 100), 50);
  assert.equal(pct('25', '200'), 12.5);
  assert.equal(pct(150, 100), 100);
  assert.equal(pct(-10, 100), 0);
});

test('pct: нулевой/невалидный cap → 0', () => {
  assert.equal(pct(50, 0), 0);
  assert.equal(pct(50, undefined), 0);
  assert.equal(pct(50, 'abc'), 0);
  assert.equal(pct('abc', 100), 0);
});

test('barClass: пороги warn/danger', () => {
  assert.equal(barClass(0), '');
  assert.equal(barClass(69.9), '');
  assert.equal(barClass(70), 'warn');
  assert.equal(barClass(89.9), 'warn');
  assert.equal(barClass(90), 'danger');
});

test('num: строка → число', () => {
  assert.equal(num('12.5'), 12.5);
  assert.equal(num(3), 3);
});

test('compact: компактная запись чисел (ru)', () => {
  // Intl для ru вставляет неразрывный пробел (U+00A0) перед суффиксом
  assert.match(compact(1500), /^1,5\s*тыс\.$/);
  assert.match(compact(2_000_000), /^2\s*млн$/);
});

test('nextReleaseUtc: ближайший час графика (UTC), кандидаты за сегодня', () => {
  // 2026-09-12 05:30 UTC → сегодня 08:00 UTC
  assert.equal(nextReleaseUtc([0, 8, 16], Date.UTC(2026, 8, 12, 5, 30)), Date.UTC(2026, 8, 12, 8));
  // 2026-09-12 20:00 UTC → завтра 00:00 UTC
  assert.equal(nextReleaseUtc([0, 8, 16], Date.UTC(2026, 8, 12, 20)), Date.UTC(2026, 8, 13, 0));
  // ровно в час высвобождения (08:00 UTC) → следующий слот в тот же день 16:00 UTC
  assert.equal(nextReleaseUtc([0, 8, 16], Date.UTC(2026, 8, 12, 8)), Date.UTC(2026, 8, 12, 16));
  // принимает и Date
  assert.equal(nextReleaseUtc([16], new Date(Date.UTC(2026, 8, 12, 10))), Date.UTC(2026, 8, 12, 16));
});

test('nextReleaseUtc: невалидные/пустые часы → null', () => {
  assert.equal(nextReleaseUtc(null), null);
  assert.equal(nextReleaseUtc([]), null);
  assert.equal(nextReleaseUtc([99]), null);
  assert.equal(nextReleaseUtc([0], 'не-число'), null);
});

test('clockTime: локальное время «чч:мм» и фолбэк для мусора', () => {
  // 2026-09-12 08:00 UTC → в часовом поясе MSEK (UTC+3) это 11:00
  const t = Date.UTC(2026, 8, 12, 8);
  const formatted = clockTime(t);
  assert.match(formatted, /^\d{2}:\d{2}$/);
  assert.equal(clockTime(undefined), '—');
  assert.equal(clockTime('abc'), '—');
});
