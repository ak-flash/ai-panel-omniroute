'use strict';

// Юнит-тесты разбора call logs из OmniRoute API
// (public/js/call-logs.js, ES-модуль — импортируется динамически).
// Логика вынесена из DOM-кода страницы «Combo», чтобы тестировать
// чисто: какие строки относятся к combo, какая модель реально
// ответила, сортировка и сводка.

const test = require('node:test');
const assert = require('node:assert/strict');

let callLogsFromResponse, isComboRow, realModelOf, requestedOf,
  recentComboRows, byNewestFirst, formatCallLogTime, modelUsageSummary;

test.before(async () => {
  ({
    callLogsFromResponse,
    isComboRow,
    realModelOf,
    requestedOf,
    recentComboRows,
    byNewestFirst,
    formatCallLogTime,
    modelUsageSummary,
  } = await import('../public/js/call-logs.js'));
});

// ----- callLogsFromResponse: обёртки ответа -----

test('callLogsFromResponse: голый массив', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(callLogsFromResponse(rows), rows);
});

test('callLogsFromResponse: { logs: [...] }', () => {
  const rows = [{ id: 'a' }];
  assert.deepEqual(callLogsFromResponse({ logs: rows }), rows);
});

test('callLogsFromResponse: { data: [...] }', () => {
  const rows = [{ id: 'a' }];
  assert.deepEqual(callLogsFromResponse({ data: rows }), rows);
});

test('callLogsFromResponse: пустой/null ответ → []', () => {
  assert.deepEqual(callLogsFromResponse(null), []);
  assert.deepEqual(callLogsFromResponse({}), []);
  assert.deepEqual(callLogsFromResponse({ logs: null }), []);
});

// ----- isComboRow -----

test('isComboRow: строка с comboName — combo', () => {
  assert.equal(isComboRow({ comboName: 'auto/claude' }), true);
});

test('isComboRow: строка без comboName — не combo', () => {
  assert.equal(isComboRow({ requestedModel: 'claude-sonnet-4' }), false);
  assert.equal(isComboRow({ comboName: null }), false);
  assert.equal(isComboRow({}), false);
  assert.equal(isComboRow(null), false);
});

// ----- realModelOf -----

test('realModelOf: берёт model, если есть', () => {
  assert.equal(realModelOf({ model: 'claude-opus-4-7', requestedModel: 'auto/claude' }), 'claude-opus-4-7');
});

test('realModelOf: fallback на requestedModel, когда model пуст', () => {
  assert.equal(realModelOf({ requestedModel: 'auto/claude' }), 'auto/claude');
  assert.equal(realModelOf({ model: '', requestedModel: 'auto/claude' }), 'auto/claude');
  assert.equal(realModelOf({ model: null }), '');
  assert.equal(realModelOf({}), '');
});

// ----- requestedOf -----

test('requestedOf: combo-строка возвращает comboName', () => {
  assert.equal(requestedOf({ comboName: 'auto/claude', model: 'claude-opus-4-7' }), 'auto/claude');
});

test('requestedOf: не-combo возвращает requestedModel', () => {
  assert.equal(requestedOf({ requestedModel: 'claude-sonnet-4' }), 'claude-sonnet-4');
  assert.equal(requestedOf({}), '');
});

// ----- recentComboRows: фильтр + сортировка + лимит -----

const NOW_MS = Date.UTC(2026, 7, 30, 12, 0, 0); // 2026-08-30T12:00:00Z

function row(id, minutesAgo, combo, model, opts = {}) {
  const ts = new Date(NOW_MS - minutesAgo * 60000).toISOString();
  return { id, timestamp: ts, comboName: combo, model, ...opts };
}

test('recentComboRows: только combo-строки, без active, новые первыми', () => {
  const rows = [
    row('a', 1, 'auto/claude', 'claude-opus-4-7'),
    row('b', 5, 'auto/coding', 'gpt-5'),
    { id: 'c', timestamp: new Date(NOW_MS - 2000).toISOString(), requestedModel: 'claude-sonnet-4', comboName: null }, // не combo
    { id: 'd', timestamp: new Date(NOW_MS - 3000).toISOString(), comboName: 'auto/coding', model: 'gpt-5', active: true }, // активный
  ];
  const result = recentComboRows(rows, 10);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'a'); // 1 мин назад — новее
  assert.equal(result[1].id, 'b'); // 5 мин назад
});

test('recentComboRows: лимит обрезает', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(row('r' + i, i + 1, 'auto/claude', 'claude-opus-4-7'));
  }
  assert.equal(recentComboRows(rows, 3).length, 3);
  assert.equal(recentComboRows(rows, 3)[0].id, 'r0'); // 1 мин назад — новее
});

test('recentComboRows: обёртка { logs } раскрывается', () => {
  const rows = [row('a', 1, 'auto/claude', 'claude-opus-4-7')];
  assert.equal(recentComboRows({ logs: rows }, 10).length, 1);
});

test('recentComboRows: нет combo-строк → пусто', () => {
  const rows = [{ id: 'a', requestedModel: 'claude', comboName: null }];
  assert.deepEqual(recentComboRows(rows, 10), []);
});

// ----- byNewestFirst -----

test('byNewestFirst: новая запись раньше старой (отрицательное число)', () => {
  const a = { timestamp: '2026-08-30T12:00:00Z' };
  const b = { timestamp: '2026-08-30T11:00:00Z' };
  assert.ok(byNewestFirst(a, b) < 0); // a новее → < 0
  assert.ok(byNewestFirst(b, a) > 0);
  assert.equal(byNewestFirst(a, a), 0);
});

// ----- formatCallLogTime -----

test('formatCallLogTime: сегодня → только ЧЧ:ММ', () => {
  const now = new Date(2026, 7, 30, 14, 0); // локальное 14:00
  const iso = new Date(2026, 7, 30, 9, 32).toISOString();
  assert.equal(formatCallLogTime(iso, now), '09:32');
});

test('formatCallLogTime: вчера → «вчера ЧЧ:ММ»', () => {
  const now = new Date(2026, 7, 30, 14, 0);
  const iso = new Date(2026, 7, 29, 18, 5).toISOString();
  assert.equal(formatCallLogTime(iso, now), 'вчера 18:05');
});

test('formatCallLogTime: позавчера → ДД.ММ ЧЧ:ММ', () => {
  const now = new Date(2026, 7, 30, 14, 0);
  const iso = new Date(2026, 7, 28, 7, 15).toISOString();
  assert.equal(formatCallLogTime(iso, now), '28.08 07:15');
});

test('formatCallLogTime: невалидная дата → пустая строка', () => {
  assert.equal(formatCallLogTime('not-a-date'), '');
  assert.equal(formatCallLogTime(null), '');
  assert.equal(formatCallLogTime(undefined), '');
});

// ----- modelUsageSummary -----

test('modelUsageSummary: считает сколько раз каждая модель ответила', () => {
  const rows = [
    row('a', 1, 'auto/claude', 'claude-opus-4-7'),
    row('b', 2, 'auto/claude', 'claude-opus-4-7'),
    row('c', 3, 'auto/claude', 'gpt-5'),
    row('d', 4, 'auto/claude', 'claude-opus-4-7'),
  ];
  const summary = modelUsageSummary(rows);
  assert.equal(summary.length, 2);
  assert.deepEqual(summary[0], { model: 'claude-opus-4-7', count: 3 });
  assert.deepEqual(summary[1], { model: 'gpt-5', count: 1 });
});

test('modelUsageSummary: пустой ввод → []', () => {
  assert.deepEqual(modelUsageSummary([]), []);
});

test('modelUsageSummary: строки без model пропускаются', () => {
  const rows = [
    { comboName: 'auto', model: '', requestedModel: '' },
    { comboName: 'auto', model: 'gpt-5' },
  ];
  const summary = modelUsageSummary(rows);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].model, 'gpt-5');
});
