'use strict';

// Юнит-тесты файлового логгера (src/file-logger.js): формат строк,
// создание каталога, ротация по размеру, устойчивость к ошибкам записи.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileLogger } = require('../src/file-logger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-log-'));
}

test('пишет строку с таймстампом, создаёт каталог, дублирует в mirror', () => {
  const file = path.join(tmpDir(), 'logs', 'panel.log'); // каталог ещё нет
  const seen = [];
  const log = createFileLogger({ file, mirror: { warn: (l) => seen.push(l) } });

  log('[AgentRouter] тест:', 'тело заглушки');

  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[AgentRouter\] тест: тело заглушки\n$/);
  assert.deepEqual(seen, ['[AgentRouter] тест: тело заглушки']);
});

test('переводы строк в аргументах схлопываются — одна запись, одна строка', () => {
  const file = path.join(tmpDir(), 'panel.log');
  const log = createFileLogger({ file, mirror: { warn: () => {} } });

  log('строка1\nстрока2\r\nстрока3');

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.length, 2); // запись + завершающий перевод строки
  assert.match(lines[0], /строка1 строка2 строка3$/);
});

test('ротация: при превышении maxBytes файл уходит в .old', () => {
  const file = path.join(tmpDir(), 'panel.log');
  fs.writeFileSync(file, 'x'.repeat(40));
  const log = createFileLogger({ file, maxBytes: 32, mirror: { warn: () => {} } });

  log('свежая запись после ротации');

  assert.ok(fs.existsSync(file + '.old'), 'старый файл переименован');
  assert.equal(fs.readFileSync(file + '.old', 'utf8'), 'x'.repeat(40));
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /свежая запись после ротации$/m);
  assert.doesNotMatch(content, /x{10}/, 'новый файл начался с чистого листа');
});

test('ошибка записи не бросает: строка остаётся только в mirror', () => {
  const dir = tmpDir();
  // Файл там, где логгер попытается создать каталог — mkdir упадёт
  fs.writeFileSync(path.join(dir, 'blocked'), 'x');
  const file = path.join(dir, 'blocked', 'panel.log');
  const seen = [];
  const log = createFileLogger({ file, mirror: { warn: (l) => seen.push(l) } });

  assert.doesNotThrow(() => log('видно и без файла'));
  assert.deepEqual(seen, ['видно и без файла']);
  // После первой неудачи файл больше не трогается (broken-флаг)
  assert.doesNotThrow(() => log('и это тоже'));
  assert.equal(seen.length, 2);
});

test('без file — работает как обычная консольная функция', () => {
  const seen = [];
  const log = createFileLogger({ mirror: { warn: (l) => seen.push(l) } });
  log('только консоль');
  assert.deepEqual(seen, ['только консоль']);
});
