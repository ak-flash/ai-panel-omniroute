'use strict';

// Юнит-тесты реестра провайдеров (providers/index.js):
// чтение PROVIDERS, переменных <ID>_*, дубликаты и неизвестные id.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders } = require('../providers');

test('по умолчанию включён xKiro', () => {
  const list = loadProviders({});
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.id, 'xkiro');
  assert.equal(p.name, 'xKiro');
  assert.equal(p.upstream, 'https://api.xkiro.com');
  assert.equal(p.apiKey, '');
  assert.equal(p.authScheme, 'x-api-key');
});

test('PROVIDERS задаёт список, первый элемент — активный', () => {
  const list = loadProviders({ PROVIDERS: 'xkiro' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'xkiro');
});

test('переменные <ID>_* применяются к провайдеру', () => {
  const list = loadProviders({
    PROVIDERS: 'xkiro',
    XKIRO_NAME: 'Мой xKiro',
    XKIRO_API_URL: 'http://localhost:1234/',
    XKIRO_API_KEY: 'secret',
  });
  const p = list[0];
  assert.equal(p.name, 'Мой xKiro');
  assert.equal(p.upstream, 'http://localhost:1234'); // хвостовой / отрезан
  assert.equal(p.apiKey, 'secret');
});

test('неизвестный провайдер пропускается с предупреждением', () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const list = loadProviders({ PROVIDERS: 'foo,xkiro' });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'xkiro');
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('foo'));
});

test('дубли id схлопываются', () => {
  const list = loadProviders({ PROVIDERS: 'xkiro, xkiro ,XKIRO' });
  assert.equal(list.length, 1);
});

test('пустой/пробельный PROVIDERS → провайдер по умолчанию', () => {
  assert.equal(loadProviders({}).length, 1);
  assert.equal(loadProviders({ PROVIDERS: '' }).length, 1);
  assert.equal(loadProviders({ PROVIDERS: '   ' }).length, 1);
  assert.equal(loadProviders({ PROVIDERS: '' })[0].id, 'xkiro');
});

test('мусорный PROVIDERS без единого id → пустой список', () => {
  assert.equal(loadProviders({ PROVIDERS: ' , ' }).length, 0);
});
