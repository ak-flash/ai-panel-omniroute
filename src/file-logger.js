'use strict';

// ============================================================
// Файловый лог приложения.
//
// Каждая запись — одна строка с ISO-таймстампом и уровнем —
// добавляется в файл и дублируется в консоль: при локальном
// запуске диагноз виден сразу, а история сохраняется между
// перезапусками (в отличие от консоли PM2/фона).
//
// Ошибки записи не роняют сервер: после первой неудачи файл
// больше не трогается, остаётся только консоль. Ротация простая:
// при превышении maxBytes файл переименовывается в <имя>.old
// (старый .old перезаписывается). Файл создаётся с правами 0600,
// каталог — 0700: в логе бывают адреса upstream и диагностика.


// ============================================================

const fs = require('fs');
const path = require('path');

// Общий лимит ротации для всех логгеров процесса (пишут в один файл)
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Создаёт файловый логгер.
 *
 * Возвращает обратно совместимую функцию log(...args) (уровень warn,
 * формат «таймстамп сообщение») с дополнительными методами
 * info/warn/error, которые добавляют уровень в запись, и
 * infoFile/warnFile/errorFile — только в файл, без консоли.
 *
 * opts:
 *   file     — путь к лог-файлу (пустой/undefined — только консоль)
 *   maxBytes — порог ротации (по умолчанию 50 МБ)
 *   mirror   — куда дублировать строки (по умолчанию console)
 */
function createFileLogger({ file, maxBytes = DEFAULT_MAX_BYTES, mirror = console } = {}) {
  let broken = false;

  function rotateIfNeeded() {
    try {
      if (fs.statSync(file).size <= maxBytes) return;
      fs.renameSync(file, file + '.old');
    } catch {}
  }

  // Форматирование аргументов в одну строку (общее для всех методов)
  function fmtArgs(args) {
    return args
      .map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object' && a !== null) {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      })
      .join(' ')
      .replace(/\r?\n/g, ' ');
  }

  // Запись строки в файл (без вывода в консоль). levelTag — '[INFO]'/'[WARN]'/''.
  function writeToFile(levelTag, body) {
    if (broken || !file) return;
    const line = (levelTag ? levelTag + ' ' : '') + body;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      rotateIfNeeded();
      fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', { mode: 0o600 });
    } catch {
      broken = true;
    }
  }

  // Запись в файл + дублирование в mirror (console)
  function writeLine(levelTag, args) {
    const body = fmtArgs(args);
    const line = (levelTag ? levelTag + ' ' : '') + body;
    if (mirror) {
      const fn = typeof mirror.warn === 'function' ? mirror.warn : null;
      if (fn) fn.call(mirror, line);
    }
    writeToFile(levelTag, body);
  }

  function log(...args) {
    writeLine('', args);
  }

  // Structured-уровни: добавляют тег уровня и дублируют в mirror.
  // .infoFile/.warnFile/.errorFile — пишут ТОЛЬКО в файл (без консоли).
  const LEVEL_TAG = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' };
  for (const level of Object.keys(LEVEL_TAG)) {
    const tag = LEVEL_TAG[level];
    log[level] = (...args) => {
      const body = fmtArgs(args);
      if (mirror) {
        const fn = typeof mirror[level] === 'function' ? mirror[level] : mirror.warn;
        if (typeof fn === 'function') fn.call(mirror, tag + ' ' + body);
      }
      writeToFile(tag, body);
    };
    log[level + 'File'] = (...args) => writeToFile(tag, fmtArgs(args));
  }
  // Alias: log.log — сама функция (для случаев, когда ожидают свойство)
  log.log = log;

  return log;
}

/**
 * Приводит логгер к одному интерфейсу: функция log(...args) уровня warn
 * с методами info/warn/error. Принимает файловый логгер, любую функцию
 * (в т.ч. связанную через bind — у неё нет методов), объект с методами
 * (console) или ничего — тогда пишет в console.
 */
function normalizeLog(logger) {
  const target = logger || console;
  const method = (level) =>
    typeof target[level] === 'function' ? (...args) => target[level](...args) : null;
  const base =
    typeof target === 'function'
      ? (...args) => target(...args)
      : method('warn') || ((...args) => console.warn(...args));
  const log = (...args) => base(...args);
  log.info = method('info') || base;
  log.warn = method('warn') || base;
  log.error = method('error') || base;
  return log;
}

module.exports = { createFileLogger, normalizeLog, DEFAULT_MAX_BYTES };
