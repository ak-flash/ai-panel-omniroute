'use strict';

// Юнит-тесты чистых форматтеров фронтенда (public/js/formatters.js,
// ES-модуль — импортируется динамически). Это логика, которую этап 5
// плана рефакторинга вынес из app.js в переиспользуемый модуль.

const test = require('node:test');
const assert = require('node:assert/strict');

let fmtUsd, compact, dur, num, pct, barClass;

test.before(async () => {
  ({
    fmtUsd, compact, dur, num, pct, barClass,
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
