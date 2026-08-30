'use strict';

// ============================================================
// Файловый лог диагностики провайдеров.
//
// Каждая запись — одна строка с ISO-таймстампом — добавляется в
// файл и дублируется в консоль: при локальном запуске диагноз
// виден сразу, а история сохраняется между перезапусками (в отличие
// от консоли PM2/фона).
//
// Ошибки записи не роняют сервер: после первой неудачи файл больше
// не трогается, остаётся только консоль. Ротация простая: при
// превышении maxBytes файл переименовывается в <имя>.old (старый
// .old перезаписывается).
// ============================================================

const fs = require('fs');
const path = require('path');

// 5 МБ — примерно 20-30 тысяч диагностических строк
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Создаёт функцию логирования с интерфейсом console.warn:
 *   log('...сообщение...', 'хвост')
 *
 * opts:
 *   file     — путь к лог-файлу (пустой/undefined — только консоль)
 *   maxBytes — порог ротации (по умолчанию 5 МБ)
 *   mirror   — куда дублировать строки (по умолчанию console.warn)
 */
function createFileLogger({ file, maxBytes = DEFAULT_MAX_BYTES, mirror = console } = {}) {
  let broken = false; // после первой ошибки записи файл больше не трогаем

  function rotateIfNeeded() {
    try {
      if (fs.statSync(file).size <= maxBytes) return;
      fs.renameSync(file, file + '.old');
    } catch {
      // Нет файла (первая запись) или не переименовался — запись ниже
      // всё равно попробует appending; проблемы увидит там же
    }
  }

  return function log(...args) {
    const line = args
      .map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object' && a !== null) {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      })
      .join(' ')
      // Одна строка на запись: переводы строк в теле заглушки ломают формат
      .replace(/\r?\n/g, ' ');

    if (mirror && typeof mirror.warn === 'function') mirror.warn(line);

    if (broken || !file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n');
    } catch {
      broken = true;
    }
  };
}

module.exports = { createFileLogger, DEFAULT_MAX_BYTES };
